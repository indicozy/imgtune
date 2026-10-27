import sharp, { type Sharp } from "sharp";
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

/**
 * Encode the reference pixels with a local stand-in for the server encoder and decode the result back to RGBA.
 * `next-default` mirrors Next 16's optimizer (next/dist/server/image-optimizer.js ~883-891: AVIF quality
 * max(q-20, 1) with effort 3, WebP quality q). `cdn` is a generic stand-in (AVIF effort 4, WebP defaults).
 */
export async function encode(
  ref: RawImage,
  format: "avif" | "webp",
  quality: number,
  profile: EncoderProfile,
): Promise<{ bytes: number; decoded: RawImage; buffer: Buffer }> {
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
  const buffer = await encoder.toBuffer();
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    bytes: buffer.length,
    decoded: { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height },
    buffer,
  };
}
