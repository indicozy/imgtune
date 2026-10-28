import { createHash } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import { LruCache } from "./lru.js";
import type { RawImage } from "./ssim.js";

sharp.concurrency(4);

export type EncoderProfile = "next-default" | "cdn";

/** Decode the original, auto-rotate, downscale to `width` (never upscale) and return 8-bit RGBA pixels. */
export async function loadReference(original: Buffer, width: number): Promise<RawImage> {
  const { data, info } = await sharp(original)
    .rotate()
    .resize(width, undefined, { kernel: "lanczos3", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/** Content hash of a decoded image: its pixels and size. Equal pixels, however they were produced, share one hash. */
export function pixelsKey(img: RawImage): string {
  return createHash("sha1")
    .update(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength))
    .update(`${img.width}x${img.height}`)
    .digest("hex");
}

/** Compressed encodes of this process, by pixels, format, quality and profile. Only the bytes are kept. */
const ENCODE_CACHE_MAX = 500;
const encodeCache = new LruCache<string, Promise<Buffer>>(ENCODE_CACHE_MAX);
const encodeStats = { hits: 0, misses: 0 };

async function decodeRgba(buffer: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

async function encodeBuffer(ref: RawImage, format: "avif" | "webp", quality: number, profile: EncoderProfile): Promise<Buffer> {
  const source = sharp(ref.data, { raw: { width: ref.width, height: ref.height, channels: 4 } });
  let encoder: Sharp;
  if (format === "avif") {
    encoder =
      profile === "next-default"
        ? source.avif({ quality: Math.max(quality - 20, 1), effort: 3 })
        : source.avif({ quality, effort: 4 });
  } else {
    encoder = source.webp({ quality });
  }
  return encoder.toBuffer();
}

/**
 * Encode the reference pixels with a local stand-in for the server encoder and decode the result back to RGBA.
 * `next-default` mirrors Next 16's optimizer (next/dist/server/image-optimizer.js ~883-891: AVIF quality
 * max(q-20, 1) with effort 3, WebP quality q). `cdn` is a generic stand-in (AVIF effort 4, WebP defaults).
 *
 * Shared by every caller in the process: an encode of the same pixels at the same format, quality and profile is done
 * once, so a second usage with the same original never re-encodes. The pixels of a reference are fixed by its original
 * and width, so they key the cache.
 */
export async function encode(
  ref: RawImage,
  format: "avif" | "webp",
  quality: number,
  profile: EncoderProfile,
): Promise<{ bytes: number; decoded: RawImage; buffer: Buffer }> {
  const key = `${pixelsKey(ref)}|${format}|${quality}|${profile}`;
  let pending = encodeCache.get(key);
  if (pending) encodeStats.hits++;
  else {
    encodeStats.misses++;
    pending = encodeBuffer(ref, format, quality, profile);
    encodeCache.set(key, pending);
    pending.catch(() => encodeCache.delete(key));
  }
  const buffer = await pending;
  return { bytes: buffer.length, decoded: await decodeRgba(buffer), buffer };
}

/** Encodes run and cache hits served since the last clear. */
export function encodeCacheStats(): { hits: number; misses: number } {
  return { ...encodeStats };
}

/** Forgets the cached encodes and zeroes the counters. For tests. */
export function clearEncodeCache(): void {
  encodeCache.clear();
  encodeStats.hits = 0;
  encodeStats.misses = 0;
}
