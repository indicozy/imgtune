import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encode, loadReference } from "../src/encode.js";
import { gradientNoise, rawToPng } from "./image-fixtures.js";

const original = await rawToPng(gradientNoise(480, 320, 10, 11));

describe("loadReference", () => {
  it("downscales to the requested width with RGBA output and never upscales", async () => {
    const ref = await loadReference(original, 240);
    expect(ref.width).toBe(240);
    expect(ref.height).toBe(160);
    expect(ref.data.length).toBe(240 * 160 * 4);

    const small = await loadReference(original, 2000);
    expect(small.width).toBe(480);
  });
});

describe("encode", () => {
  it("AVIF q30 is smaller than q80 and both decode to the reference size", async () => {
    const ref = await loadReference(original, 240);
    const low = await encode(ref, "avif", 30, "cdn");
    const high = await encode(ref, "avif", 80, "cdn");
    expect(low.bytes).toBeLessThan(high.bytes);
    for (const r of [low, high]) {
      expect(r.decoded.width).toBe(ref.width);
      expect(r.decoded.height).toBe(ref.height);
      expect(r.decoded.data.length).toBe(ref.data.length);
    }
  });

  it("returns WebP decoded to the reference size", async () => {
    const ref = await loadReference(original, 240);
    const r = await encode(ref, "webp", 75, "next-default");
    expect(r.decoded.width).toBe(ref.width);
    expect(r.decoded.height).toBe(ref.height);
    expect(r.buffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("next-default AVIF at q85 equals sharp AVIF quality 65 effort 3 byte length", async () => {
    const ref = await loadReference(original, 240);
    const r = await encode(ref, "avif", 85, "next-default");
    const expected = await sharp(ref.data, { raw: { width: ref.width, height: ref.height, channels: 4 } })
      .avif({ quality: 65, effort: 3 })
      .toBuffer();
    expect(r.bytes).toBe(expected.length);
  });
});
