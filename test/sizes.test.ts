import { describe, expect, it } from "vitest";
import {
  deriveSizeBranches,
  deriveSizes,
  isSingleValue,
  joinSizeBranches,
  overlaySizes,
  sizesSlotAt,
  sizesValueAt,
} from "../src/sizes.js";

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

describe("deriveSizeBranches and joinSizeBranches", () => {
  it("splits the mobile and desktop expressions and joins them back to deriveSizes", () => {
    const points = [mobile(375, 167.5), mobile(430, 195), desktop(1440, 220)];
    const branches = deriveSizeBranches(points);
    expect(branches).toEqual({ mobile: "calc(50vw - 20px)", desktop: "220px" });
    expect(joinSizeBranches(branches)).toBe(deriveSizes(points));
  });

  it("leaves the missing branch undefined and joins the other one without a media condition", () => {
    expect(deriveSizeBranches([desktop(1440, 220)])).toEqual({ mobile: undefined, desktop: "220px" });
    expect(joinSizeBranches({ desktop: "220px" })).toBe("220px");
    expect(joinSizeBranches({})).toBeUndefined();
  });

  it("joins two branches under the 768px media condition", () => {
    expect(joinSizeBranches({ mobile: "33vw", desktop: "280px" })).toBe("(max-width: 768px) 33vw, 280px");
  });

  it("emits one expression when the mobile and desktop branches are equal", () => {
    expect(deriveSizes([mobile(375, 33), desktop(1440, 33)])).toBe("33px");
    expect(joinSizeBranches({ mobile: "33px", desktop: "33px" })).toBe("33px");
  });
});

describe("sizesSlotAt", () => {
  it("evaluates a plain vw width at the viewport", () => {
    expect(sizesSlotAt("33vw", 1440)).toBeCloseTo(475.2, 5);
  });

  it("evaluates a px width whatever the viewport", () => {
    expect(sizesSlotAt("280px", 393)).toBe(280);
  });

  it("evaluates calc(Nvw ± Mpx) and never goes below zero", () => {
    expect(sizesSlotAt("calc(50vw - 20px)", 375)).toBeCloseTo(167.5, 5);
    expect(sizesSlotAt("calc(50vw + 8px)", 430)).toBeCloseTo(223, 5);
    expect(sizesSlotAt("calc(1vw - 20px)", 375)).toBe(0);
  });

  it("takes the first branch whose media condition holds", () => {
    const sizes = "(max-width: 768px) calc(50vw - 20px), 280px";
    expect(sizesSlotAt(sizes, 375)).toBeCloseTo(167.5, 5);
    expect(sizesSlotAt(sizes, 1440)).toBe(280);
  });

  it("uses max-width inclusively at the breakpoint", () => {
    const sizes = "(max-width: 768px) 33vw, 280px";
    expect(sizesSlotAt(sizes, 768)).toBeCloseTo(253.44, 5);
    expect(sizesSlotAt(sizes, 769)).toBe(280);
  });

  it("honours min-width conditions", () => {
    const sizes = "(min-width: 1024px) 25vw, 100vw";
    expect(sizesSlotAt(sizes, 1440)).toBeCloseTo(360, 5);
    expect(sizesSlotAt(sizes, 800)).toBe(800);
  });

  it("is undefined when no branch matches or a branch is unsupported", () => {
    expect(sizesSlotAt("(min-width: 1024px) 25vw", 800)).toBeUndefined();
    expect(sizesSlotAt("(orientation: landscape) 50vw", 800)).toBeUndefined();
    expect(sizesSlotAt("calc(50vw * 2)", 800)).toBeUndefined();
    expect(sizesSlotAt("(max-width: 768px) 33vw, bogus", 800)).toBeUndefined();
  });
});

describe("sizesValueAt", () => {
  it("returns the raw value of the first matching branch", () => {
    const sizes = "(max-width: 768px) calc(50vw - 20px), 280px";
    expect(sizesValueAt(sizes, 375)).toBe("calc(50vw - 20px)");
    expect(sizesValueAt(sizes, 1440)).toBe("280px");
    expect(sizesValueAt("33vw", 1440)).toBe("33vw");
  });

  it("is undefined when the value is unsupported", () => {
    expect(sizesValueAt("(orientation: landscape) 50vw", 800)).toBeUndefined();
  });
});

describe("isSingleValue and overlaySizes", () => {
  it("is true only for one unconditioned width value", () => {
    expect(isSingleValue("33vw")).toBe(true);
    expect(isSingleValue("calc(50vw - 20px)")).toBe(true);
    expect(isSingleValue("(max-width: 768px) 33vw, 280px")).toBe(false);
    expect(isSingleValue("(orientation: landscape) 50vw")).toBe(false);
  });

  it("gives the corrected value in the branch's own range and the current value elsewhere", () => {
    expect(overlaySizes("mobile", "175px", "(max-width: 768px) 33vw, 280px")).toBe(
      "(max-width: 768px) 175px, (max-width: 768px) 33vw, 280px",
    );
    expect(overlaySizes("desktop", "200px", "(max-width: 768px) 33vw, 280px")).toBe(
      "(min-width: 769px) 200px, (max-width: 768px) 33vw, 280px",
    );
  });
});
