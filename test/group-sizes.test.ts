import { describe, expect, it } from "vitest";
import { bandLine, fitSizes, lineValue, maxPerWidth, MAX_CLAUSES, sizesHolds, type SizePoint } from "../src/group-sizes.js";
import { sizesSlotAt } from "../src/sizes.js";

/** Rendered widths of a card that is half the viewport minus a 20 px gutter (a calc the fit should find). */
const halfMinus20 = (width: number): SizePoint => ({ width, rendered: width / 2 - 20 });

describe("maxPerWidth", () => {
  it("keeps the largest rendered width per viewport width, ascending", () => {
    expect(
      maxPerWidth([
        { width: 390, rendered: 150 },
        { width: 375, rendered: 130 },
        { width: 390, rendered: 175 },
        { width: 430, rendered: 0 },
      ]),
    ).toEqual([
      { width: 375, rendered: 130 },
      { width: 390, rendered: 175 },
    ]);
  });
});

describe("bandLine", () => {
  it("finds a vw and px line that holds every measured point, and prints it rounded", () => {
    const line = bandLine([halfMinus20(375), halfMinus20(390), halfMinus20(412), halfMinus20(430)]);
    expect(line?.value).toBe("calc(50vw - 20px)");
  });

  it("refuses a line that sits more than the larger of 2% or 4 px above a measured width", () => {
    // A slope through two far-apart points overshoots the middle one.
    expect(bandLine([{ width: 375, rendered: 100 }, { width: 430, rendered: 100 }, { width: 1440, rendered: 900 }])).toBeUndefined();
  });

  it("refuses a flat or falling line", () => {
    expect(bandLine([{ width: 375, rendered: 200 }, { width: 1440, rendered: 200 }])).toBeUndefined();
    expect(bandLine([{ width: 375, rendered: 300 }, { width: 1440, rendered: 200 }])).toBeUndefined();
  });
});

describe("lineValue", () => {
  it("prints a plain vw, or a calc with a signed px", () => {
    expect(lineValue(33.3, 0)).toBe("33.3vw");
    expect(lineValue(50, -20)).toBe("calc(50vw - 20px)");
    expect(lineValue(50, 8)).toBe("calc(50vw + 8px)");
  });
});

describe("fitSizes", () => {
  it("fits one line across the mobile viewports and a breakpoint to a constant on desktop", () => {
    const points: SizePoint[] = [
      halfMinus20(375),
      halfMinus20(390),
      halfMinus20(412),
      halfMinus20(430),
      { width: 1280, rendered: 260 },
      { width: 1440, rendered: 260 },
    ];
    const fit = fitSizes(points);
    expect(fit?.constant).toBe(false);
    expect(fit?.value).toBe("(max-width: 640px) calc(50vw - 20px), 260px");
    expect(fit?.clauses).toBe(2);
    expect(sizesHolds(fit!.value, points)).toBe(true);
  });

  it("never gives a value below a measured width at any measured viewport", () => {
    // Noisy measurements: a line that fits one band exactly would sit under the outlier, so the band is constant.
    const points: SizePoint[] = [
      { width: 375, rendered: 180 },
      { width: 390, rendered: 240 },
      { width: 412, rendered: 190 },
      { width: 430, rendered: 205 },
      { width: 1280, rendered: 400 },
      { width: 1440, rendered: 420 },
    ];
    const fit = fitSizes(points)!;
    expect(sizesHolds(fit.value, points)).toBe(true);
    for (const p of points) expect(sizesSlotAt(fit.value, p.width)).toBeGreaterThanOrEqual(p.rendered);
  });

  it("uses the constant ceiling when the viewports give no line", () => {
    const fit = fitSizes([
      { width: 375, rendered: 100 },
      { width: 430, rendered: 100 },
      { width: 1440, rendered: 100 },
    ]);
    expect(fit?.value).toBe("100px");
    expect(fit?.fitted).toBe(0);
  });

  it("keeps the value at four clauses or fewer", () => {
    const points: SizePoint[] = [
      { width: 375, rendered: 100 },
      { width: 390, rendered: 220 },
      { width: 640, rendered: 90 },
      { width: 768, rendered: 300 },
      { width: 1024, rendered: 90 },
      { width: 1280, rendered: 400 },
      { width: 1440, rendered: 120 },
    ];
    const fit = fitSizes(points)!;
    expect(fit.clauses).toBeLessThanOrEqual(MAX_CLAUSES);
    expect(fit.value.split(", ").length).toBeLessThanOrEqual(MAX_CLAUSES);
    expect(sizesHolds(fit.value, points)).toBe(true);
  });

  it("returns nothing for no measurement", () => {
    expect(fitSizes([])).toBeUndefined();
    expect(fitSizes([{ width: 390, rendered: 0 }])).toBeUndefined();
  });
});
