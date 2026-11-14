import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { brotliSize } from "./brotli.js";
import { digestOf, heavyValue } from "./cache.js";
import sharp from "sharp";
import { readZip, type ZipEntry } from "./zip.js";
import type { PageContext, ResourceAnalyzer, ResourceFinding, ResourceRecord } from "./types.js";

/** Embedded rasters per animation the analyzer decodes (largest first). The rest are skipped. */
const MAX_RASTERS = 24;
/** Lottie precision savings below both thresholds are noise and not reported. */
const PRECISION_MIN_BYTES = 1024;
const PRECISION_MIN_SHARE = 0.05;
/** A dotLottie repack is reported only when it saves this much of the served bytes. */
const DOTLOTTIE_MIN_BYTES = 1024;
const DOTLOTTIE_MIN_SHARE = 0.1;
/** Overhead per zip entry (local header, central directory entry, name). */
const ZIP_ENTRY_OVERHEAD = 80;
const WEBP_QUALITY = 80;
/** A raster re-encode is reported when it saves this much, or when it also downscales. Below that it is noise. */
const RASTER_MIN_BYTES = 1024;
const RASTER_MIN_SHARE = 0.1;
const DATA_IMAGE = /^data:image\/([a-z0-9.+-]+);base64,/i;

export interface LottieAnimation {
  v?: string;
  fr?: number;
  ip?: number;
  op?: number;
  w?: number;
  h?: number;
  layers: unknown[];
  assets?: unknown[];
  [key: string]: unknown;
}

interface Box {
  w: number;
  h: number;
}

/** Parses a Lottie animation: JSON with `v` and an array `layers`. Returns undefined for anything else. */
export function parseAnimation(buf: Buffer): LottieAnimation | undefined {
  try {
    const json = JSON.parse(buf.toString("utf8")) as unknown;
    if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
    const o = json as Record<string, unknown>;
    if (typeof o.v !== "string" || !Array.isArray(o.layers)) return undefined;
    return o as LottieAnimation;
  } catch {
    return undefined;
  }
}

/** Layers of the animation, counting the layers of precomposition assets too. */
export function countLayers(anim: LottieAnimation): number {
  let n = anim.layers.length;
  for (const asset of anim.assets ?? []) {
    const layers = (asset as { layers?: unknown }).layers;
    if (Array.isArray(layers)) n += layers.length;
  }
  return n;
}

/** Frame rate, duration in seconds and the composition size. */
export function animationStats(anim: LottieAnimation): { fps?: number; seconds?: number; w?: number; h?: number } {
  const fps = typeof anim.fr === "number" && anim.fr > 0 ? anim.fr : undefined;
  const span = typeof anim.op === "number" && typeof anim.ip === "number" ? anim.op - anim.ip : undefined;
  const seconds = fps !== undefined && span !== undefined && span > 0 ? span / fps : undefined;
  return {
    ...(fps !== undefined ? { fps } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(typeof anim.w === "number" ? { w: anim.w } : {}),
    ...(typeof anim.h === "number" ? { h: anim.h } : {}),
  };
}

/** Rounds every number in the tree to three decimals. Strings (including data URIs) are untouched. */
export function roundNumbers(value: unknown): unknown {
  // "+ 0" turns a rounded -0 back into 0, so the output has no negative zeros.
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1000) / 1000 + 0 : value;
  if (Array.isArray(value)) return value.map(roundNumbers);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = roundNumbers(v);
    return out;
  }
  return value;
}

/** Width to encode an embedded raster at: its composition size times the display scale, never above its source width. */
export function rasterTargetWidth(assetWidth: number, sourceWidth: number, anim: LottieAnimation, box: Box | undefined): number {
  const cw = anim.w ?? assetWidth;
  const ch = anim.h ?? assetWidth;
  const scale = box !== undefined && cw > 0 && ch > 0 ? Math.min(box.w / cw, box.h / ch) : 1;
  const wanted = Math.round(assetWidth * scale);
  return Math.max(1, Math.min(sourceWidth, wanted));
}

function deflateSize(buf: Buffer): number {
  return deflateRawSync(buf, { level: 9 }).length;
}

function shortHash(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 10);
}

function stripQuery(url: string): string {
  return url.replace(/[?#].*$/, "");
}

function sameResource(a: string | undefined, b: string, pageUrl: string): boolean {
  if (a === undefined) return false;
  try {
    return stripQuery(new URL(a, pageUrl).href) === stripQuery(new URL(b, pageUrl).href);
  } catch {
    return false;
  }
}

/** The display box of an animation on the page (CSS size times DPR), when the page shows it by this URL. */
function displayBox(url: string, ctx: PageContext): { box: Box; selector?: string } | undefined {
  const hit = ctx.lottie.find((l) => sameResource(l.src, url, ctx.url));
  if (hit === undefined || hit.width <= 0 || hit.height <= 0) return undefined;
  const dpr = ctx.viewport.dpr || 1;
  return { box: { w: hit.width * dpr, h: hit.height * dpr }, selector: hit.selector };
}

interface RasterFix {
  index: number;
  id: string;
  fromFormat: string;
  fromW: number;
  fromH: number;
  fromBytes: number;
  toW: number;
  toBytes: number;
  /** Bytes saved: base64 text for an embedded data URI, file bytes for an archive entry. */
  savedBytes: number;
}

const kb = (n: number): string => `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;

/**
 * Whether a re-encode is worth reporting: it must shrink the file, and either downscale it or save a real share of it.
 * A WebP or AVIF source that keeps its size is already lossy and modern: a second lossy pass gains nothing.
 */
export function rasterWorthIt(fromFormat: string, srcBytes: number, dstBytes: number, downscaled: boolean): boolean {
  if (dstBytes >= srcBytes) return false;
  if (downscaled) return true;
  if (fromFormat === "webp" || fromFormat === "avif") return false;
  return srcBytes - dstBytes >= RASTER_MIN_BYTES && srcBytes - dstBytes >= srcBytes * RASTER_MIN_SHARE;
}

/** Decodes and re-encodes embedded data-URI rasters at the display size. Animated sources are skipped. */
async function rasterFixes(anim: LottieAnimation, box: Box | undefined): Promise<RasterFix[]> {
  const assets = (anim.assets ?? [])
    .map((a, index) => ({ a: a as { id?: unknown; w?: unknown; p?: unknown }, index }))
    .filter(({ a }) => typeof a.p === "string" && DATA_IMAGE.test(a.p))
    .sort((x, y) => (y.a.p as string).length - (x.a.p as string).length)
    .slice(0, MAX_RASTERS);
  const out: RasterFix[] = [];
  for (const { a, index } of assets) {
    try {
      const p = a.p as string;
      const fmt = (DATA_IMAGE.exec(p)?.[1] ?? "").toLowerCase();
      const src = Buffer.from(p.slice(p.indexOf(",") + 1), "base64");
      const meta = await sharp(src, { limitInputPixels: 100_000_000 }).metadata();
      if (meta.width === undefined || meta.height === undefined || (meta.pages ?? 1) > 1) continue;
      const assetW = typeof a.w === "number" && a.w > 0 ? a.w : meta.width;
      const toW = rasterTargetWidth(assetW, meta.width, anim, box);
      // The re-encode is heavy and depends on the source and the target width: once per run, and skipped once the budget is spent.
      const webp = await heavyValue(`lottie:raster:${digestOf(src)}:${toW}`, async () => {
        const out = await sharp(src, { limitInputPixels: 100_000_000 }).resize({ width: toW, withoutEnlargement: true }).webp({ quality: WEBP_QUALITY }).toBuffer();
        return out.toString("base64");
      });
      if (webp === undefined) continue;
      const webpBytes = Buffer.from(webp, "base64");
      const prefix = "data:image/webp;base64,";
      const newLen = prefix.length + Math.ceil(webpBytes.length / 3) * 4;
      const savedBytes = p.length - newLen;
      if (!rasterWorthIt(fmt, src.length, webpBytes.length, toW < meta.width)) continue;
      const id = typeof a.id === "string" || typeof a.id === "number" ? String(a.id) : String(index);
      out.push({
        index,
        id,
        fromFormat: fmt,
        fromW: meta.width,
        fromH: meta.height,
        fromBytes: src.length,
        toW,
        toBytes: webpBytes.length,
        savedBytes,
      });
    } catch {
      // A raster sharp cannot read is left alone.
    }
  }
  return out;
}

function rasterFinding(
  url: string,
  bytes: number,
  fixes: RasterFix[],
  box: Box | undefined,
  selector: string | undefined,
  inArchive: boolean,
): ResourceFinding | undefined {
  const saved = fixes.reduce((s, f) => s + f.savedBytes, 0);
  if (fixes.length === 0 || saved <= 0) return undefined;
  const name = basename(url);
  const label = inArchive ? "image file" : "embedded raster";
  const shownAt = box !== undefined ? ` shown at ${Math.round(box.w)}×${Math.round(box.h)} px` : "";
  const fix = fixes.slice(0, 5).map((f) =>
    inArchive
      ? `file ${f.id}: ${f.fromFormat} ${f.fromW}×${f.fromH} (${kb(f.fromBytes)}) → WebP q${WEBP_QUALITY} at ${f.toW} px wide (${kb(f.toBytes)}): ` +
        `sharp(src).resize({ width: ${f.toW}, withoutEnlargement: true }).webp({ quality: ${WEBP_QUALITY} }), then replace the file and its images/ entry`
      : `asset ${f.id}: ${f.fromFormat} ${f.fromW}×${f.fromH} (${kb(f.fromBytes)}) → WebP q${WEBP_QUALITY} at ${f.toW} px wide (${kb(f.toBytes)}): ` +
        `sharp(src).resize({ width: ${f.toW}, withoutEnlargement: true }).webp({ quality: ${WEBP_QUALITY} }), ` +
        `then set assets[${f.index}].p to data:image/webp;base64,…`,
  );
  if (fixes.length > 5) fix.push(`and ${fixes.length - 5} more ${label}s`);
  return {
    id: `lottie:${shortHash(url)}:raster`,
    kind: "lottie",
    url,
    bytes,
    savedBytes: saved,
    estimate: false,
    title: `lottie ${name}: ${fixes.length} ${label}${fixes.length === 1 ? "" : "s"}${shownAt}, re-encode to WebP saves ${kb(saved)}`,
    fix,
    details: {
      rasters: fixes.map((f) => ({ asset: f.id, from: f.fromFormat, width: f.fromW, height: f.fromH, bytes: f.fromBytes, toWidth: f.toW, toBytes: f.toBytes })),
      ...(box !== undefined ? { displayBox: box } : {}),
    },
    ...(selector !== undefined ? { locator: { selector } } : {}),
  };
}

function basename(url: string): string {
  const path = stripQuery(url);
  return path.slice(path.lastIndexOf("/") + 1) || url;
}

/** Numbers rounded to three decimals, minified, measured with brotli against the served body. */
function precisionFinding(url: string, body: Buffer, anim: LottieAnimation): ResourceFinding | undefined {
  const trimmed = Buffer.from(JSON.stringify(roundNumbers(anim)));
  const served = brotliSize(body);
  const after = brotliSize(trimmed);
  const saved = served.bytes - after.bytes;
  if (saved < PRECISION_MIN_BYTES || saved < body.length * PRECISION_MIN_SHARE) return undefined;
  return {
    id: `lottie:${shortHash(url)}:precision`,
    kind: "lottie",
    url,
    bytes: body.length,
    savedBytes: saved,
    estimate: served.estimate || after.estimate,
    title: `lottie ${basename(url)}: round numbers to 3 decimals and minify, brotli ${kb(served.bytes)} → ${kb(after.bytes)}`,
    fix: [
      "re-save the export with numbers rounded to 3 decimals and no indentation (JSON.stringify of the parsed file with rounded numbers)",
      "play the animation before and after; 3 decimals is below one pixel at any normal display size",
    ],
    details: { servedBrotli: served.bytes, trimmedBrotli: after.bytes },
  };
}

/** Estimated size of the same animation repacked as .lottie (zip, deflate) with each embedded raster as a file. */
async function dotLottieFinding(
  url: string,
  body: Buffer,
  anim: LottieAnimation,
  rasters: { index: number; bytes: Buffer; ext: string }[],
): Promise<ResourceFinding | undefined> {
  const served = brotliSize(body);
  const copy = JSON.parse(JSON.stringify(anim)) as LottieAnimation;
  const byIndex = new Map(rasters.map((r) => [r.index, r]));
  (copy.assets ?? []).forEach((a, i) => {
    const r = byIndex.get(i);
    if (r === undefined) return;
    const asset = a as { u?: string; p?: string; id?: unknown };
    asset.u = "images/";
    asset.p = `image_${i}.${r.ext}`;
  });
  let est = deflateSize(Buffer.from(JSON.stringify(copy))) + ZIP_ENTRY_OVERHEAD;
  for (const r of rasters) est += deflateSize(r.bytes) + ZIP_ENTRY_OVERHEAD;
  const saved = served.bytes - est;
  if (saved < DOTLOTTIE_MIN_BYTES || saved < body.length * DOTLOTTIE_MIN_SHARE) return undefined;
  return {
    id: `lottie:${shortHash(url)}:dotlottie`,
    kind: "lottie",
    url,
    bytes: body.length,
    savedBytes: saved,
    estimate: true,
    title: `lottie ${basename(url)}: repack as .lottie (zip) ~${kb(est)} vs ${kb(served.bytes)} brotli JSON`,
    fix: [
      `pack the animation as a .lottie file (zip with deflate): animations/${basename(url).replace(/\.json$/i, "")}.json and images/ for the ${rasters.length} embedded raster${rasters.length === 1 ? "" : "s"}, binary instead of base64`,
      "serve it as application/zip or application/octet-stream; the players load .lottie directly",
      "if the embedded rasters are also re-encoded (see the raster finding), the two savings overlap; take the larger one",
    ],
    details: { estimatedDotLottie: est, servedBrotli: served.bytes, embeddedRasters: rasters.length },
  };
}

function overlayFix(anim: LottieAnimation, box: Box | undefined): string[] {
  const lines: string[] = [];
  const stats = animationStats(anim);
  const size = stats.w !== undefined && stats.h !== undefined ? `${stats.w}×${stats.h}` : "unknown size";
  lines.push(`composition ${size}, ${countLayers(anim)} layers${stats.fps !== undefined ? `, ${stats.fps} fps` : ""}${stats.seconds !== undefined ? `, ${stats.seconds.toFixed(1)} s` : ""}`);
  if (box !== undefined && stats.w !== undefined && stats.h !== undefined) {
    const scale = Math.min(box.w / stats.w, box.h / stats.h);
    if (scale < 0.5) {
      lines.push(
        `shown at ${Math.round(box.w)}×${Math.round(box.h)} px, a quarter of its composition or less: export at the display size, or render a video/animated AVIF for this size`,
      );
    }
  }
  return lines;
}

async function analyzeJson(record: ResourceRecord, body: Buffer, anim: LottieAnimation, ctx: PageContext): Promise<ResourceFinding[]> {
  const url = record.url;
  const shown = displayBox(url, ctx);
  const box = shown?.box;
  const stats = animationStats(anim);
  const rasters = await rasterFixes(anim, box);
  const findings: ResourceFinding[] = [];
  const statLine = [
    `${kb(body.length)} JSON`,
    `${countLayers(anim)} layers`,
    stats.fps !== undefined ? `${stats.fps} fps` : undefined,
    stats.seconds !== undefined ? `${stats.seconds.toFixed(1)} s` : undefined,
  ].filter(Boolean).join(", ");
  findings.push({
    id: `lottie:${shortHash(url)}`,
    kind: "lottie",
    url,
    bytes: body.length,
    savedBytes: 0,
    estimate: false,
    title: `lottie ${basename(url)}: ${statLine}`,
    fix: overlayFix(anim, box),
    details: {
      layers: countLayers(anim),
      ...(stats.fps !== undefined ? { fps: stats.fps } : {}),
      ...(stats.seconds !== undefined ? { seconds: stats.seconds } : {}),
      ...(stats.w !== undefined ? { width: stats.w, height: stats.h } : {}),
      embeddedRasters: rasters.length,
      ...(box !== undefined ? { displayBox: box } : {}),
    },
    ...(shown?.selector !== undefined ? { locator: { selector: shown.selector } } : {}),
  });
  const raster = rasterFinding(url, body.length, rasters, box, shown?.selector, false);
  if (raster) findings.push(raster);
  // The precision trim re-serialises and brotli-sizes the JSON: once per run by content and URL, and not once the budget is spent.
  const precisionValue = await heavyValue(`lottie:precision:${digestOf(body)}:${url}`, async () => precisionFinding(url, body, anim) ?? null);
  const precision = precisionValue ?? undefined;
  if (precision) findings.push(precision);
  const embedded = (anim.assets ?? [])
    .map((a, index) => ({ index, p: (a as { p?: unknown }).p }))
    .filter((a): a is { index: number; p: string } => typeof a.p === "string" && DATA_IMAGE.test(a.p))
    .map((a) => {
      const ext = (DATA_IMAGE.exec(a.p)?.[1] ?? "png").toLowerCase().replace("jpeg", "jpg");
      return { index: a.index, bytes: Buffer.from(a.p.slice(a.p.indexOf(",") + 1), "base64"), ext };
    });
  const repack = await dotLottieFinding(url, body, anim, embedded);
  if (repack) findings.push(repack);
  return findings;
}

async function analyzeDotLottie(record: ResourceRecord, body: Buffer, ctx: PageContext): Promise<ResourceFinding[]> {
  const url = record.url;
  const shown = displayBox(url, ctx);
  const box = shown?.box;
  const entries = readZip(body);
  const animations: { entry: ZipEntry; anim: LottieAnimation; data: Buffer }[] = [];
  const images: ZipEntry[] = [];
  const findings: ResourceFinding[] = [];
  for (const entry of entries) {
    if (/^animations\/[^/]+\.json$/i.test(entry.name)) {
      const data = entry.data();
      const anim = data !== undefined ? parseAnimation(data) : undefined;
      if (data !== undefined && anim !== undefined) animations.push({ entry, anim, data });
    } else if (/^images\/[^/]+\.(png|jpe?g|webp)$/i.test(entry.name)) {
      images.push(entry);
    }
  }
  if (animations.length === 0) return [];
  const first = animations[0]!.anim;
  const stats = animationStats(first);
  const totalLayers = animations.reduce((s, a) => s + countLayers(a.anim), 0);
  const statLine = [
    `${kb(body.length)} zip`,
    `${animations.length} animation${animations.length === 1 ? "" : "s"}`,
    `${totalLayers} layers`,
    stats.fps !== undefined ? `${stats.fps} fps` : undefined,
    stats.seconds !== undefined ? `${stats.seconds.toFixed(1)} s` : undefined,
    images.length > 0 ? `${images.length} image file${images.length === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean).join(", ");
  findings.push({
    id: `lottie:${shortHash(url)}`,
    kind: "lottie",
    url,
    bytes: body.length,
    savedBytes: 0,
    estimate: false,
    title: `lottie ${basename(url)} (.lottie): ${statLine}`,
    fix: overlayFix(first, box),
    details: { animations: animations.length, layers: totalLayers, images: images.length },
    ...(shown?.selector !== undefined ? { locator: { selector: shown.selector } } : {}),
  });

  // Image files inside the archive: decode, re-encode at the display size, compare with the stored size.
  const fixes: RasterFix[] = [];
  for (const entry of images.slice(0, MAX_RASTERS)) {
    try {
      const src = entry.data();
      if (src === undefined) continue;
      const meta = await sharp(src, { limitInputPixels: 100_000_000 }).metadata();
      if (meta.width === undefined || meta.height === undefined || (meta.pages ?? 1) > 1) continue;
      const toW = rasterTargetWidth(meta.width, meta.width, first, box);
      const webp = await sharp(src, { limitInputPixels: 100_000_000 }).resize({ width: toW, withoutEnlargement: true }).webp({ quality: WEBP_QUALITY }).toBuffer();
      const saved = entry.compressedSize - webp.length;
      if (!rasterWorthIt(meta.format ?? "", entry.compressedSize, webp.length, toW < meta.width)) continue;
      fixes.push({
        index: fixes.length,
        id: entry.name,
        fromFormat: meta.format ?? "image",
        fromW: meta.width,
        fromH: meta.height,
        fromBytes: entry.compressedSize,
        toW,
        toBytes: webp.length,
        savedBytes: saved,
      });
    } catch {
      // Unreadable image: left alone.
    }
  }
  const raster = rasterFinding(url, body.length, fixes, box, shown?.selector, true);
  if (raster) findings.push(raster);

  // Stored (uncompressed) JSON entries, and the precision of each animation measured with deflate.
  let storedSaved = 0;
  let precisionSaved = 0;
  for (const entry of entries) {
    if (entry.method === 0 && /\.json$/i.test(entry.name) && entry.size >= 1024) {
      const data = entry.data();
      if (data !== undefined) storedSaved += entry.size - deflateSize(data);
    }
  }
  for (const a of animations) {
    const before = deflateSize(a.data);
    const after = deflateSize(Buffer.from(JSON.stringify(roundNumbers(a.anim))));
    precisionSaved += before - after;
  }
  if (storedSaved >= PRECISION_MIN_BYTES) {
    findings.push({
      id: `lottie:${shortHash(url)}:stored`,
      kind: "lottie",
      url,
      bytes: body.length,
      savedBytes: storedSaved,
      estimate: false,
      title: `lottie ${basename(url)}: JSON entries stored without compression, deflate saves ${kb(storedSaved)}`,
      fix: ["pack the .lottie with deflate (method 8) for the animations/*.json entries"],
    });
  }
  if (precisionSaved >= PRECISION_MIN_BYTES && precisionSaved >= body.length * PRECISION_MIN_SHARE) {
    findings.push({
      id: `lottie:${shortHash(url)}:precision`,
      kind: "lottie",
      url,
      bytes: body.length,
      savedBytes: precisionSaved,
      estimate: false,
      title: `lottie ${basename(url)}: round numbers to 3 decimals and minify, deflate saves ${kb(precisionSaved)}`,
      fix: [
        "re-save each animations/*.json with numbers rounded to 3 decimals and no indentation, then re-zip with deflate",
        "play the animation before and after; 3 decimals is below one pixel at any normal display size",
      ],
    });
  }
  return findings;
}

function isDotLottie(r: ResourceRecord): boolean {
  return /\.lottie(?:[?#]|$)/i.test(r.url) || (r.body !== undefined && r.body.length > 4 && r.body.readUInt32LE(0) === 0x04034b50 && /zip|octet-stream/.test(r.contentType));
}

export const analyzer: ResourceAnalyzer = {
  kind: "lottie",
  wants(r: ResourceRecord): boolean {
    if (r.bytes < 512) return false;
    if (/\.lottie(?:[?#]|$)/i.test(r.url)) return true;
    if (/json/.test(r.contentType) || /\.json(?:[?#]|$)/i.test(r.url)) return true;
    return false;
  },
  async analyze(records: ResourceRecord[], ctx: PageContext): Promise<ResourceFinding[]> {
    const out: ResourceFinding[] = [];
    const seen = new Set<string>();
    for (const r of records) {
      if (r.body === undefined || seen.has(r.url)) continue;
      seen.add(r.url);
      try {
        if (isDotLottie(r)) {
          out.push(...(await analyzeDotLottie(r, r.body, ctx)));
          continue;
        }
        const anim = parseAnimation(r.body);
        if (anim === undefined) continue;
        out.push(...(await analyzeJson(r, r.body, anim, ctx)));
      } catch {
        // Never throws: a broken animation yields no findings.
      }
    }
    return out;
  },
};
