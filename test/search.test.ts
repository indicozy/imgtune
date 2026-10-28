import { describe, expect, it } from "vitest";
import { encode, type EncoderProfile } from "../src/encode.js";
import { componentQuality, minPassingQuality, toTargetQuality } from "../src/search.js";
import { ssim, type RawImage } from "../src/ssim.js";
import { gradientNoise } from "./image-fixtures.js";

/** Stub encoder whose "decoded" image carries the quality, and a score that is exactly quality / 100. */
function qualityStub(log: number[]) {
  return {
    encode: (async (_ref: RawImage, _format: "avif" | "webp", quality: number) => {
      log.push(quality);
      return { bytes: quality, decoded: { data: Uint8ClampedArray.of(quality), width: 1, height: 1 }, buffer: Buffer.alloc(0) };
    }) as typeof encode,
    score: (_ref: RawImage, test: RawImage) => test.data[0] / 100,
  };
}

const dummy: RawImage = { data: new Uint8ClampedArray(4), width: 1, height: 1 };

describe("minPassingQuality", () => {
  it("bisects to the lowest passing quality within tolerance, probing 85 55 70 62 58", async () => {
    const log: number[] = [];
    const result = await minPassingQuality(dummy, "avif", 85, "cdn", 0.6, 5, qualityStub(log));
    expect(log).toEqual([85, 55, 70, 62, 58]);
    expect(result).toBe(62);
    expect(result - 60).toBeLessThanOrEqual(5);
  });

  it("returns start without searching when start itself fails", async () => {
    const log: number[] = [];
    expect(await minPassingQuality(dummy, "webp", 85, "next-default", 0.9, 5, qualityStub(log))).toBe(85);
    expect(log).toEqual([85]);
  });

  it("stops at the format floor when every quality passes (avif floor 25)", async () => {
    const log: number[] = [];
    const result = await minPassingQuality(dummy, "avif", 85, "cdn", 0, 5, qualityStub(log));
    expect(result).toBeGreaterThanOrEqual(25);
    expect(result).toBeLessThanOrEqual(30);
    expect(Math.min(...log)).toBeGreaterThanOrEqual(25);
  });

  it("uses at most 6 real encodes and returns a passing quality within tolerance of the lowest passing one", async () => {
    const ref = gradientNoise(128, 128, 6, 21);
    const scores = new Map<number, number>();
    for (let q = 40; q <= 85; q++) {
      const { decoded } = await encode(ref, "webp", q, "next-default");
      scores.set(q, ssim(ref, decoded));
    }
    const threshold = (scores.get(60)! + scores.get(61)!) / 2;
    const firstPassing = Math.min(...[...scores.keys()].filter((q) => scores.get(q)! >= threshold));

    let encodes = 0;
    const counted = (async (r: RawImage, f: "avif" | "webp", q: number, p: EncoderProfile) => {
      encodes++;
      return encode(r, f, q, p);
    }) as typeof encode;
    const result = await minPassingQuality(ref, "webp", 85, "next-default", threshold, 5, { encode: counted, score: ssim });
    expect(scores.get(result)!).toBeGreaterThanOrEqual(threshold);
    expect(result - firstPassing).toBeGreaterThanOrEqual(0);
    expect(result - firstPassing).toBeLessThanOrEqual(5);
    expect(encodes).toBeLessThanOrEqual(6);
  });
});

describe("componentQuality", () => {
  it("returns the nearest-rank 95th percentile of ten values", () => {
    expect(componentQuality([50, 55, 60, 65, 70, 75, 80, 85, 90, 95], 0.95)).toBe(95);
  });

  it("uses the nearest-rank index ceil(p * n) - 1", () => {
    expect(componentQuality([10, 20, 30, 40], 0.5)).toBe(20);
    expect(componentQuality([10, 20, 30, 40], 0.51)).toBe(30);
  });

  it("defaults to 0.95 and sorts its input", () => {
    expect(componentQuality([95, 50, 90, 55, 60, 65, 70, 75, 80, 85])).toBe(95);
  });

  it("throws on an empty sample", () => {
    expect(() => componentQuality([])).toThrow();
  });
});

describe("toTargetQuality", () => {
  it("rounds next-default up to a multiple of 5 without an offset", () => {
    expect(toTargetQuality(52, undefined, "next-default", 85)).toBe(55);
    expect(toTargetQuality(55, undefined, "next-default", 85)).toBe(55);
  });

  it("adds the offset for cdn", () => {
    expect(toTargetQuality(52, 10, "cdn", 85)).toBe(62);
  });

  it("returns undefined for cdn without an offset", () => {
    expect(toTargetQuality(52, undefined, "cdn", 85)).toBeUndefined();
  });

  it("never returns more than the current quality or less than 1", () => {
    expect(toTargetQuality(80, 10, "cdn", 85)).toBe(85);
    expect(toTargetQuality(84, undefined, "next-default", 82)).toBe(82);
    expect(toTargetQuality(3, -10, "cdn", 85)).toBe(1);
  });
});
