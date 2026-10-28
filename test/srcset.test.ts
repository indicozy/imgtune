import { describe, expect, it } from "vitest";
import { nextCandidates, nextWidths, pickCandidate, pickForX } from "../src/srcset.js";

const SHOP = {
  deviceSizes: [320, 375, 414, 480, 640, 750, 828, 1080, 1125, 1170, 1179, 1200, 1242, 1284, 1290, 1320, 1440, 1920],
  imageSizes: [16, 32, 48, 64, 96, 128, 144, 192, 256, 384],
};

const SHOP_33VW_WIDTHS = [
  128, 144, 192, 256, 320, 375, 384, 414, 480, 640, 750, 828, 1080, 1125, 1170, 1179, 1200, 1242, 1284, 1290,
  1320, 1440, 1920,
];

describe("nextWidths (port of next/dist/shared/lib/get-img-props getWidths)", () => {
  it("sizes 33vw keeps sizes at or above the smallest device size times 0.33", () => {
    expect(nextWidths(SHOP, "33vw")).toEqual(SHOP_33VW_WIDTHS);
    expect(nextWidths(SHOP, "33vw")).toHaveLength(23);
  });

  it("sizes without any vw term keeps every candidate", () => {
    const all = [...SHOP.deviceSizes, ...SHOP.imageSizes].sort((a, b) => a - b);
    expect(nextWidths(SHOP, "100px")).toEqual(all);
  });

  it("calc(50vw - 20px) does not match the vw regex, so every candidate is kept", () => {
    const all = [...SHOP.deviceSizes, ...SHOP.imageSizes].sort((a, b) => a - b);
    expect(nextWidths(SHOP, "calc(50vw - 20px)")).toEqual(all);
  });

  it("takes the smallest vw term when several appear in a media-query sizes", () => {
    // smallest vw term is 20 -> threshold 320 * 0.2 = 64
    expect(nextWidths(SHOP, "(max-width: 768px) 50vw, 20vw")).toEqual([
      64, 96, 128, 144, 192, 256, 320, 375, 384, 414, 480, 640, 750, 828, 1080, 1125, 1170, 1179, 1200, 1242,
      1284, 1290, 1320, 1440, 1920,
    ]);
  });

  it("with no sizes and no width returns deviceSizes (kind w)", () => {
    expect(nextCandidates(SHOP, undefined)).toEqual({ widths: SHOP.deviceSizes, kind: "w" });
  });

  it("with a fixed width returns the two density candidates (kind x)", () => {
    expect(nextCandidates(SHOP, undefined, 100)).toEqual({ widths: [128, 256], kind: "x" });
  });

  it("with a fixed width of 1 returns a single candidate (kind x)", () => {
    expect(nextCandidates(SHOP, undefined, 1)).toEqual({ widths: [16], kind: "x" });
  });

  it("with a width above every candidate clamps to the largest", () => {
    expect(nextCandidates(SHOP, undefined, 1500).widths).toEqual([1920]);
  });
});

describe("pickCandidate and pickForX", () => {
  it("picks the smallest candidate at or above slot × DPR", () => {
    expect(pickCandidate(SHOP_33VW_WIDTHS, 175, 3)).toBe(640);
  });

  it("picks the largest candidate when none is large enough", () => {
    expect(pickCandidate([128, 256, 640], 1000, 2)).toBe(640);
  });

  it("does not depend on the order of the widths", () => {
    expect(pickCandidate([1920, 640, 128], 175, 3)).toBe(640);
  });

  it("picks widths[0] for DPR 1 and widths[1] for DPR 2 with kind x", () => {
    expect(pickForX([128, 256], 1)).toBe(128);
    expect(pickForX([128, 256], 2)).toBe(256);
    expect(pickForX([128, 256], 3)).toBe(256);
  });

  it("keeps widths[0] for DPR 2 when only one candidate exists", () => {
    expect(pickForX([16], 2)).toBe(16);
  });
});
