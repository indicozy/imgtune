import { describe, expect, it } from "vitest";
import { encode } from "../src/encode.js";
import { calibrationOffset, confirmMatch, encodedSizeAt, matchLocalQuality, matchLocalQualityExhaustive } from "../src/calibrate.js";
import type { RawImage } from "../src/ssim.js";
import { gradientNoise } from "./image-fixtures.js";

const tiny: RawImage = { data: new Uint8ClampedArray(4), width: 1, height: 1 };

/** Stub encoder whose byte size is quality * 1000. */
const bytesEqualQuality = (async (_ref: RawImage, _format: "avif" | "webp", quality: number) => ({
  bytes: quality * 1000,
  decoded: tiny,
  buffer: Buffer.alloc(0),
})) as typeof encode;

describe("calibrationOffset", () => {
  it("matches the cdn byte size to a local quality and returns cdnQuality minus that quality", async () => {
    const result = await calibrationOffset(
      [{ ref: tiny, format: "avif", cdnQuality: 85, cdnBytes: 75000 }],
      { encode: bytesEqualQuality },
    );
    expect(result).toEqual({ offset: 10, n: 1 });
  });

  it("takes the median of per-sample offsets, averaging the middle pair for even n", async () => {
    const result = await calibrationOffset(
      [
        { ref: tiny, format: "avif", cdnQuality: 85, cdnBytes: 75000 },
        { ref: tiny, format: "avif", cdnQuality: 95, cdnBytes: 75000 },
      ],
      { encode: bytesEqualQuality },
    );
    expect(result).toEqual({ offset: 15, n: 2 });
  });

  it("returns undefined without samples", async () => {
    expect(await calibrationOffset([])).toBeUndefined();
  });

  it("works with the real encoder on a synthetic image", async () => {
    const ref = gradientNoise(96, 96, 4, 31);
    const target = (await encode(ref, "webp", 70, "cdn")).bytes;
    const result = await calibrationOffset([{ ref, format: "webp", cdnQuality: 70, cdnBytes: target }]);
    expect(result?.n).toBe(1);
    expect(Math.abs(result!.offset)).toBeLessThanOrEqual(10);
  });
});

// The coarse-to-fine match must choose exactly what the one-by-one scan chooses, whenever bytes do not fall as quality
// rises. Random curves (with flat runs, which create ties) and random targets check that, and the non-monotone case falls
// back to the scan.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A byte curve for qualities 1..100: non-decreasing, with flat runs when `flat` is set, or with a dip when `dip` is set. */
function curveOf(seed: number, { flat, dip }: { flat: boolean; dip: boolean }): number[] {
  const rand = prng(seed);
  const bytes = [0];
  let value = 1000 + Math.floor(rand() * 5000);
  for (let q = 1; q <= 100; q++) {
    const step = flat && rand() < 0.4 ? 0 : Math.floor(rand() * 900);
    value += step;
    bytes[q] = value;
  }
  if (dip) {
    const at = 20 + Math.floor(rand() * 70);
    bytes[at] = Math.max(0, bytes[at] - 2000);
  }
  return bytes;
}

async function countingEnc(curve: number[]): Promise<{ enc: typeof encode; calls: { n: number } }> {
  const calls = { n: 0 };
  const enc = (async (_ref: RawImage, _format: "avif" | "webp", quality: number) => {
    calls.n++;
    return { bytes: curve[quality], decoded: tiny, buffer: Buffer.alloc(0) };
  }) as typeof encode;
  return { enc, calls };
}

describe("matchLocalQuality (coarse to fine)", () => {
  it("chooses exactly what the one-by-one scan chooses on random monotone curves, with ties", async () => {
    let checked = 0;
    let fewer = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const curve = curveOf(seed, { flat: seed % 2 === 0, dip: false });
      const target = Math.floor(prng(seed * 7)() * (curve[100] + 2000));
      const fast = await countingEnc(curve);
      const scan = await countingEnc(curve);
      const q = await matchLocalQuality(encodedSizeAt(tiny, "avif", fast.enc), target);
      const expected = await matchLocalQualityExhaustive(encodedSizeAt(tiny, "avif", scan.enc), target);
      expect(q).toBe(expected.q);
      checked++;
      if (fast.calls.n < scan.calls.n) fewer++;
    }
    expect(checked).toBe(300);
    expect(fewer).toBeGreaterThan(250);
  });

  it("falls back to the one-by-one scan when the bytes fall along the probes", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const curve = curveOf(seed, { flat: false, dip: true });
      const target = Math.floor(prng(seed * 13)() * curve[100]);
      const fast = await countingEnc(curve);
      const scan = await countingEnc(curve);
      expect(await matchLocalQuality(encodedSizeAt(tiny, "webp", fast.enc), target)).toBe((await matchLocalQualityExhaustive(encodedSizeAt(tiny, "webp", scan.enc), target)).q);
    }
  });

  it("encodes fewer qualities than the scan: 17 coarse and 8 refine before, about half now", async () => {
    const curve = curveOf(5, { flat: false, dip: false });
    const { enc, calls } = await countingEnc(curve);
    await matchLocalQuality(encodedSizeAt(tiny, "avif", enc), curve[60]);
    expect(calls.n).toBeLessThanOrEqual(16);
  });
});

describe("confirmMatch", () => {
  it("finds the match of matchLocalQuality from a guess a few qualities away, on monotone curves", async () => {
    let confirmed = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const curve = curveOf(seed, { flat: seed % 2 === 0, dip: false });
      const target = Math.floor(prng(seed * 7)() * (curve[100] + 2000));
      const { enc } = await countingEnc(curve);
      const sizeAt = encodedSizeAt(tiny, "avif", enc);
      const expected = await matchLocalQuality(sizeAt, target);
      for (const guess of [expected - 2, expected, expected + 1]) {
        const got = await confirmMatch(guess, sizeAt, target);
        if (got !== undefined) {
          expect(got).toBe(expected);
          confirmed++;
        }
      }
    }
    // Every non-flat curve (the odd seeds) is confirmed; flat runs of equal bytes are left to the full match.
    expect(confirmed).toBeGreaterThanOrEqual(3 * 100);
  });

  it("gives no confirmation when the walk leaves the step budget or the target is above or below every quality", async () => {
    const curve = curveOf(3, { flat: false, dip: false });
    const { enc } = await countingEnc(curve);
    const sizeAt = encodedSizeAt(tiny, "avif", enc);
    expect(await confirmMatch(50, sizeAt, curve[10])).toBeUndefined();
    expect(await confirmMatch(10, sizeAt, curve[90], 2)).toBeUndefined();
    expect(await confirmMatch(100, sizeAt, curve[100] * 2)).toBeUndefined();
  });
});
