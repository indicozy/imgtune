import sharp from "sharp";
import type { RawImage } from "../src/ssim.js";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian sample via Box-Muller. */
function gaussian(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/** RGBA gradient plus Gaussian noise (sigma in 8-bit levels), fully opaque unless `alpha` is set. */
export function gradientNoise(width: number, height: number, sigma: number, seed: number, alpha = false): RawImage {
  const next = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const n = () => sigma * gaussian(next);
      data[p] = clamp((x * 255) / (width - 1) + n());
      data[p + 1] = clamp((y * 255) / (height - 1) + n());
      data[p + 2] = clamp(((x + y) * 255) / (width + height - 2) + n());
      data[p + 3] = alpha ? clamp(255 - (x * 255) / (width - 1)) : 255;
    }
  }
  return { data, width, height };
}

export function withNoise(img: RawImage, sigma: number, seed: number): RawImage {
  const next = rng(seed);
  const data = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      data[i + c] = Math.min(255, Math.max(0, Math.round(img.data[i + c] + sigma * gaussian(next))));
    }
    data[i + 3] = img.data[i + 3];
  }
  return { data, width: img.width, height: img.height };
}

export async function decodeRgba(buf: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

export function rawToPng(img: RawImage): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).png().toBuffer();
}
