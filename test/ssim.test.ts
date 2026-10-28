import { existsSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ssim, ssimDetailed, type RawImage } from "../src/ssim.js";
import { decodeRgba, gradientNoise, rawToPng, withNoise } from "./image-fixtures.js";

// Optional parity check against Optiq's dist/quality.js. Set OPTIQ_QUALITY to that file's
// absolute path (e.g. OPTIQ_QUALITY=/path/to/optiq/dist/quality.js pnpm test). The Optiq
// tests are skipped when the variable is unset or the file does not exist.
const OPTIQ_QUALITY = process.env.OPTIQ_QUALITY ?? "";
const optiqAvailable = OPTIQ_QUALITY !== "" && existsSync(OPTIQ_QUALITY);

type OptiqQuality = { ssim(reference: RawImage, test: RawImage): { ssim: number; y: number; cb: number; cr: number; activeShare: number; alpha?: number } };
const optiq: OptiqQuality | undefined = optiqAvailable
  ? ((await import(/* @vite-ignore */ OPTIQ_QUALITY)) as OptiqQuality)
  : undefined;

describe("ssim", () => {
  it("scores identical images as 1", async () => {
    const img = gradientNoise(256, 192, 0, 1);
    expect(ssim(img, img)).toBe(1);
  });

  it("scores an image against itself with Gaussian noise sigma=10 below 0.95", () => {
    const img = gradientNoise(256, 192, 0, 2);
    const noisy = withNoise(img, 10, 3);
    expect(ssim(img, noisy)).toBeLessThan(0.95);
  });

  it("ssimDetailed exposes the channel scores and combined value", () => {
    const img = gradientNoise(64, 64, 0, 4);
    const detail = ssimDetailed(img, withNoise(img, 8, 5));
    expect(detail.ssim).toBeLessThan(1);
    expect(detail.y).toBeGreaterThan(0);
    expect(detail.activeShare).toBeGreaterThan(0);
    expect(detail.alpha).toBeUndefined();
  });

  it("throws on mismatched dimensions", () => {
    expect(() => ssim(gradientNoise(32, 32, 0, 6), gradientNoise(32, 16, 0, 6))).toThrow(/equal dimensions/);
  });

  it.skipIf(!optiqAvailable)("matches Optiq dist/quality.js within 1e-9 on fixture PNG vs JPEG q40", async () => {
    const original = gradientNoise(256, 192, 12, 7);
    const pngBuf = await rawToPng(original);
    const jpegBuf = await sharp(pngBuf).jpeg({ quality: 40 }).toBuffer();
    const reference = await decodeRgba(pngBuf);
    const test = await decodeRgba(jpegBuf);

    const ours = ssim(reference, test);
    const theirs = optiq!.ssim(reference, test).ssim;
    expect(Math.abs(ours - theirs)).toBeLessThan(1e-9);
    expect(ours).toBeLessThan(1);
  });

  it.skipIf(!optiqAvailable)("matches Optiq within 1e-9 on alpha images (alpha-plane lower bound path)", async () => {
    const original = gradientNoise(128, 96, 8, 8, true);
    const reference = await decodeRgba(await rawToPng(original));
    const test = await decodeRgba(await sharp(await rawToPng(withNoise(original, 6, 9))).webp({ quality: 50 }).toBuffer());

    const ours = ssimDetailed(reference, test);
    const theirs = optiq!.ssim(reference, test);
    expect(Math.abs(ours.ssim - theirs.ssim)).toBeLessThan(1e-9);
    expect(Math.abs(ours.y - theirs.y)).toBeLessThan(1e-9);
    expect(Math.abs((ours.alpha ?? NaN) - (theirs.alpha ?? NaN))).toBeLessThan(1e-9);
  });
});
