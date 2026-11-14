import { describe, expect, it } from "vitest";
import { formatHeldFit, formatLinear } from "../src/layout.js";
import { deriveSizes } from "../src/sizes.js";
import { offsetPx, wholePx } from "../src/px.js";

describe("whole-px rounding of proposed sizes", () => {
  it("rounds a px length up, so the chosen candidate still covers the need", () => {
    expect(wholePx(190.04)).toBe(191);
    expect(wholePx(190)).toBe(190);
    expect(wholePx(190.0000000001)).toBe(190);
  });

  it("rounds a signed offset in the direction that keeps the value at or above the fit", () => {
    expect(offsetPx(10.2)).toBe(11);
    expect(offsetPx(-20.4)).toBe(-20);
    expect(offsetPx(-20)).toBe(-20);
  });

  it("prints a constant with a fractional px as whole px", () => {
    expect(formatLinear({ a: 0, b: 190.04 })).toBe("191px");
  });

  it("prints a calc() offset as whole px in the covering direction", () => {
    expect(formatLinear({ a: 0.5, b: 10.2 })).toBe("calc(50vw + 11px)");
    expect(formatLinear({ a: 0.5, b: -20.4 })).toBe("calc(50vw - 20px)");
    expect(formatHeldFit({ a: 0.5, b: 10.2 }, 390, 1440)).toMatch(/ \+ 11px\)$/);
  });

  it("prints the derived sizes of a measured group as whole px", () => {
    const value = deriveSizes([
      { viewportWidth: 390, renderedWidth: 190.04, mobile: true },
      { viewportWidth: 400, renderedWidth: 190.04, mobile: true },
    ]);
    expect(value).not.toMatch(/\.\d/);
    expect(value).toBe("191px");
  });
});
