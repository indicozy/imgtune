import { describe, expect, it } from "vitest";
import { deriveSizes } from "../src/sizes.js";

const mobile = (viewportWidth: number, renderedWidth: number) => ({
  viewportWidth,
  renderedWidth,
  mobile: true,
});
const desktop = (viewportWidth: number, renderedWidth: number) => ({
  viewportWidth,
  renderedWidth,
  mobile: false,
});

describe("deriveSizes", () => {
  it("fits calc(50vw - 20px) for the shop grid and combines it with a desktop px width", () => {
    const points = [
      mobile(375, 167.5),
      mobile(390, 175),
      mobile(412, 186),
      mobile(430, 195),
      desktop(1440, 220),
    ];
    expect(deriveSizes(points)).toBe("(max-width: 768px) calc(50vw - 20px), 220px");
  });

  it("emits calc with a plus sign for a positive intercept", () => {
    const points = [mobile(375, 195.5), mobile(430, 223)];
    // w = 0.5 * vw + 8
    expect(deriveSizes(points)).toBe("calc(50vw + 8px)");
  });

  it("emits 100vw for full-width mobile images", () => {
    const points = [mobile(375, 375), mobile(390, 390), mobile(430, 430)];
    expect(deriveSizes(points)).toBe("100vw");
  });

  it("emits a fixed px width when the mobile image does not scale with the viewport", () => {
    const points = [mobile(375, 160), mobile(390, 160), mobile(430, 160)];
    expect(deriveSizes(points)).toBe("160px");
  });

  it("falls back to the ceiling of the largest width when only one viewport is measured", () => {
    expect(deriveSizes([mobile(375, 167.2)])).toBe("168px");
  });

  it("uses the largest rendered width for the px form when several instances share a viewport", () => {
    expect(deriveSizes([desktop(1440, 220), desktop(1440, 221.4), desktop(1440, 219)])).toBe(
      "222px",
    );
  });

  it("ignores zero-width points (hidden or unscrolled images)", () => {
    const points = [mobile(375, 0), mobile(390, 0.4), mobile(430, 0), desktop(1440, 220)];
    expect(deriveSizes(points)).toBe("220px");
  });

  it("returns undefined when every point is zero width", () => {
    expect(deriveSizes([mobile(375, 0), desktop(1440, 0)])).toBeUndefined();
  });

  it("returns undefined for no points", () => {
    expect(deriveSizes([])).toBeUndefined();
  });

  it("drops mobile points that do not fit a line within 2 px and falls back to the ceiling of max width", () => {
    const points = [mobile(375, 100), mobile(390, 300), mobile(430, 150)];
    expect(deriveSizes(points)).toBe("300px");
  });
});
