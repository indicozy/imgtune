import { describe, expect, it } from "vitest";
import { encode } from "../src/encode.js";
import { calibrationOffset } from "../src/calibrate.js";
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
