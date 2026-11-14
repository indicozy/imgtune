// Favicons and apple-touch-icons. A favicon over FAVICON_BYTES, or an apple-touch-icon over APPLE_BYTES, is flagged. The
// fix is a re-encode at the size the browser uses (32 px for a favicon, 180 px for apple-touch), and the saving is the
// real size of that re-encode (sharp, PNG). An ICO is read through its largest PNG frame. Favicons are fetched once per
// site, so every title says "per first visit".
import sharp from "sharp";
import type { PageContext, ResourceAnalyzer, ResourceFinding, ResourceRecord } from "./types.js";
import { cachedValue, digestOf } from "./cache.js";

export const FAVICON_BYTES = 10 * 1024;
export const APPLE_BYTES = 30 * 1024;
/** The largest icon response read at all (an icon this size is already the problem). */
export const ICON_READ_MAX = 1024 * 1024;
const FAVICON_PX = 32;
const APPLE_PX = 180;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/** The icon roles the page declares, by absolute URL: apple-touch for an apple-touch-icon link, else favicon. */
export function roleOf(ctx: PageContext, url: string): "favicon" | "apple-touch" | undefined {
  const link = ctx.icons.find((icon) => icon.href === url);
  if (link !== undefined) return /apple-touch/i.test(link.rel) ? "apple-touch" : "favicon";
  if (/\/favicon\.ico$/i.test(new URL(url).pathname)) return "favicon";
  return undefined;
}

/** The largest PNG frame of an ICO file, or undefined when it has none (BMP-only icons are not decoded). */
export function largestPngFrame(ico: Buffer): Buffer | undefined {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) return undefined;
  const count = ico.readUInt16LE(4);
  let best: { area: number; data: Buffer } | undefined;
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    if (at + 16 > ico.length) break;
    const w = ico[at] === 0 ? 256 : ico[at];
    const h = ico[at + 1] === 0 ? 256 : ico[at + 1];
    const size = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    if (offset + size > ico.length || size < 8) continue;
    const data = ico.subarray(offset, offset + size);
    if (!data.subarray(0, 4).equals(PNG_MAGIC)) continue;
    if (best === undefined || w * h > best.area) best = { area: w * h, data };
  }
  return best?.data;
}

/** The image the browser decodes from an icon response: the PNG frame of an ICO, else the body itself. */
function decodableOf(record: ResourceRecord, body: Buffer): Buffer | undefined {
  const isIco = record.contentType === "image/x-icon" || record.contentType === "image/vnd.microsoft.icon" || body.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]));
  if (!isIco) return body;
  return largestPngFrame(body);
}

interface Reencode {
  bytes: number;
  width: number;
  height: number;
}

/** The PNG of the icon at `px` square, and its width and height before (the source's size from the decoder). */
async function reencode(image: Buffer, px: number): Promise<Reencode & { sourceWidth: number; sourceHeight: number }> {
  const key = `favicon:png:${px}:${digestOf(image)}`;
  return cachedValue(key, async () => {
    const meta = await sharp(image).metadata();
    const out = await sharp(image).resize(px, px, { fit: "cover" }).png({ compressionLevel: 9 }).toBuffer();
    return { bytes: out.length, width: px, height: px, sourceWidth: meta.width ?? 0, sourceHeight: meta.height ?? 0 };
  });
}

export const wantsRecord = (r: ResourceRecord): boolean =>
  r.status >= 200 &&
  r.status < 300 &&
  r.contentType.startsWith("image/") &&
  r.bytes <= ICON_READ_MAX &&
  (r.contentType.includes("icon") || /favicon|apple-touch-icon/i.test(r.url) || /\.ico(?:[?#]|$)/i.test(r.url));

export const analyzer: ResourceAnalyzer = {
  kind: "favicon",
  wants: wantsRecord,
  async analyze(records: ResourceRecord[], ctx: PageContext): Promise<ResourceFinding[]> {
    try {
      const findings: ResourceFinding[] = [];
      for (const r of records) {
        if (r.body === undefined) continue;
        const role = roleOf(ctx, r.url);
        if (role === undefined) continue;
        const threshold = role === "apple-touch" ? APPLE_BYTES : FAVICON_BYTES;
        if (r.bytes <= threshold) continue;
        const px = role === "apple-touch" ? APPLE_PX : FAVICON_PX;
        const label = role === "apple-touch" ? "apple-touch-icon" : "favicon";
        const path = new URL(r.url).pathname;
        const isSvg = r.contentType === "image/svg+xml";
        const frame = isSvg ? undefined : decodableOf(r, r.body);
        let measured: (Reencode & { sourceWidth: number; sourceHeight: number }) | undefined;
        if (frame !== undefined) {
          try {
            measured = await reencode(frame, px);
          } catch {
            measured = undefined;
          }
        }
        const source = measured !== undefined && measured.sourceWidth > 0 ? `${measured.sourceWidth}x${measured.sourceHeight}` : "unreadable";
        const saved = measured === undefined ? 0 : Math.max(0, r.bytes - measured.bytes);
        const fix: string[] = [];
        if (isSvg) {
          fix.push("serve it as an optimised SVG (svgo, default preset) or a 32 px PNG; an SVG icon scales at every size");
        } else {
          fix.push(
            measured !== undefined
              ? `replace with a ${px}x${px} PNG (sharp resize ${px}, fit cover, PNG compression 9): ${kb(measured.bytes)} (from ${kb(r.bytes)})`
              : `replace with a ${px}x${px} PNG: the file is not decodable here (an ICO with no PNG frame, or not an image)`,
          );
          if (role === "favicon") fix.push(`or an SVG favicon when the logo is vector: <link rel="icon" type="image/svg+xml" href="/icon.svg">`);
        }
        fix.push(`point the <link rel="${role === "apple-touch" ? "apple-touch-icon" : "icon"}"> at the new file; it is fetched once per site, on a first visit`);
        findings.push({
          id: `favicon:${digestOf(r.url).slice(0, 16)}`,
          kind: "favicon",
          url: r.url,
          bytes: r.bytes,
          savedBytes: saved,
          estimate: false,
          title: `${label} ${path}: ${source}${isSvg ? " SVG" : ""}, ${kb(r.bytes)} per first visit${measured !== undefined ? `; a ${px} px PNG is ${kb(measured.bytes)}` : ""}`,
          fix,
          details: { role, source, px, bytes: r.bytes, rebuiltBytes: measured?.bytes ?? null },
        });
      }
      return findings;
    } catch {
      return [];
    }
  },
};
