import { createHash } from "node:crypto";
import sharp from "sharp";
import { optimize } from "svgo";
import { brotliSize } from "./brotli.js";
import { score } from "../metric.js";
import type { RawImage } from "../ssim.js";
import type { PageContext, ResourceAnalyzer, ResourceFinding, ResourceRecord } from "./types.js";

/** SVGs under this size are not worth an optimiser pass. */
const MIN_BYTES = 2048;
/** SVGs over this size are skipped: the pass and the render would take too long for the phase budget. */
const MAX_BYTES = 5 * 1024 * 1024;
/** A finding needs at least this share of the brotli size saved by SVGO. */
const MIN_SAVING_SHARE = 0.2;
/** Fidelity bar: SSIMULACRA2 of the optimised render against the original, both at half of RENDER_PX. */
export const FIDELITY_BAR = 70;
const RENDER_PX = 512;
const SCORE_PX = 256;
/** Embedded rasters: `<image href="data:image/…;base64,…">`. */
const EMBEDDED_RASTER = /<image\b[^>]*?\s(?:xlink:)?href\s*=\s*["']data:image\/([a-z0-9.+-]+);base64,([^"']*)["']/gi;

const kb = (n: number): string => `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
const shortHash = (url: string): string => createHash("sha1").update(url).digest("hex").slice(0, 10);
const basename = (url: string): string => {
  const path = url.replace(/[?#].*$/, "");
  return path.slice(path.lastIndexOf("/") + 1) || url;
};

/** Optimises with the default preset at floatPrecision 2 (the plan's setting; the fidelity check guards it). */
export function optimizeSvg(text: string): string {
  const result = optimize(text, {
    multipass: false,
    plugins: [{ name: "preset-default", params: { floatPrecision: 2 } }],
  });
  return result.data;
}

function scaleTo(w: number, h: number, px: number): { width: number; height: number } {
  const k = px / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Rasterises the SVG so its longer side is `px` pixels (aspect kept), RGBA, non-premultiplied. */
async function render(svg: Buffer, px: number, size?: { width: number; height: number }): Promise<RawImage & { width: number; height: number }> {
  const meta = await sharp(svg, { density: 72 }).metadata();
  const intrinsicW = meta.width && meta.width > 0 ? meta.width : 300;
  const intrinsicH = meta.height && meta.height > 0 ? meta.height : 300;
  const target = size ?? scaleTo(intrinsicW, intrinsicH, px);
  // The density makes the SVG rasterise at the target width directly, so the downscale is small.
  const density = Math.min(3000, Math.max(1, Math.round((72 * target.width) / intrinsicW)));
  const { data, info } = await sharp(svg, { density })
    .resize(target.width, target.height, { fit: "fill", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/** Downscales a raw RGBA image to `px` on the longer side. */
async function half(img: RawImage & { width: number; height: number }, px: number): Promise<RawImage & { width: number; height: number }> {
  const size = scaleTo(img.width, img.height, px);
  const { data, info } = await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(size.width, size.height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/** SSIMULACRA2 of the optimised SVG against the original, both rendered at RENDER_PX and compared at SCORE_PX. */
export async function fidelity(original: Buffer, optimised: Buffer): Promise<number> {
  const ref = await render(original, RENDER_PX);
  const test = await render(optimised, RENDER_PX, { width: ref.width, height: ref.height });
  const [a, b] = await Promise.all([half(ref, SCORE_PX), half(test, SCORE_PX)]);
  return score("ssimulacra2", a, b);
}

function embeddedRasters(text: string): { format: string; bytes: number }[] {
  const out: { format: string; bytes: number }[] = [];
  for (const m of text.matchAll(EMBEDDED_RASTER)) {
    const b64 = m[2] ?? "";
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    out.push({ format: (m[1] ?? "").toLowerCase(), bytes: Math.floor((b64.length * 3) / 4) - padding });
  }
  return out;
}

async function analyzeOne(record: ResourceRecord, body: Buffer): Promise<ResourceFinding[]> {
  const url = record.url;
  const name = basename(url);
  const id = `svg:${shortHash(url)}`;
  const findings: ResourceFinding[] = [];
  const text = body.toString("utf8");

  const rasters = embeddedRasters(text);
  if (rasters.length > 0) {
    const total = rasters.reduce((s, r) => s + r.bytes, 0);
    findings.push({
      id: `${id}:raster`,
      kind: "svg",
      url,
      bytes: body.length,
      savedBytes: 0,
      estimate: false,
      title: `svg ${name}: ${rasters.length} embedded raster${rasters.length === 1 ? "" : "s"}, ${kb(total)} decoded`,
      fix: [
        "replace each embedded raster with a separate file at its display size (AVIF or WebP, see the image hints), or redraw it as vector",
        "an embedded data URI costs about a third more than the file it holds",
      ],
      details: { rasters: rasters.map((r) => ({ format: r.format, bytes: r.bytes })) },
    });
  }

  const optimised = optimizeSvg(text);
  const before = brotliSize(body);
  const after = brotliSize(Buffer.from(optimised));
  const saved = before.bytes - after.bytes;
  if (saved < before.bytes * MIN_SAVING_SHARE) return findings;

  const quality = await fidelity(body, Buffer.from(optimised));
  if (!(quality >= FIDELITY_BAR)) return findings;

  findings.unshift({
    id,
    kind: "svg",
    url,
    bytes: body.length,
    savedBytes: saved,
    estimate: false,
    title: `svg ${name}: SVGO (floatPrecision 2) ${kb(body.length)} → ${kb(optimised.length)}, brotli ${kb(before.bytes)} → ${kb(after.bytes)}, render SSIMULACRA2 ${quality.toFixed(1)}`,
    fix: [
      `npx svgo --precision=2 <file>.svg -o <file>.min.svg  (default preset; check the render at display size)`,
      `expected brotli ${kb(after.bytes)} (now ${kb(before.bytes)}); serve the optimised file, keep the original under version control`,
    ],
    details: {
      rawBefore: body.length,
      rawAfter: optimised.length,
      brotliBefore: before.bytes,
      brotliAfter: after.bytes,
      ssimulacra2: quality,
      ...(before.estimate || after.estimate ? { brotliEstimate: true } : {}),
    },
  });
  return findings;
}

export const analyzer: ResourceAnalyzer = {
  kind: "svg",
  wants(r: ResourceRecord): boolean {
    if (r.bytes < MIN_BYTES || r.bytes > MAX_BYTES) return false;
    return /image\/svg\+xml/.test(r.contentType) || (/\.svg(?:[?#]|$)/i.test(r.url) && /xml|octet-stream/.test(r.contentType));
  },
  async analyze(records: ResourceRecord[], _ctx: PageContext): Promise<ResourceFinding[]> {
    const out: ResourceFinding[] = [];
    const seen = new Set<string>();
    for (const r of records) {
      if (r.body === undefined || seen.has(r.url)) continue;
      seen.add(r.url);
      try {
        out.push(...(await analyzeOne(r, r.body)));
      } catch {
        // Never throws: an SVG that svgo or sharp cannot handle yields no findings.
      }
    }
    return out;
  },
};
