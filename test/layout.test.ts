import { describe, expect, it } from "vitest";
import {
  breakpointBetween,
  deriveSizesFormula,
  evalExpr,
  formatSizes,
  sameStructure,
  slotExpr,
  withinTolerance,
  type LayoutNode,
} from "../src/layout.js";

/** A synthetic chain node: block-level, no spacing, unless overridden. */
const node = (overrides: Partial<LayoutNode> = {}): LayoutNode => ({
  tag: "div",
  classes: "",
  width: 0,
  paddingX: 0,
  borderX: 0,
  marginX: 0,
  display: "block",
  ...overrides,
});

const img = (overrides: Partial<LayoutNode> = {}): LayoutNode => node({ tag: "img", display: "inline", ...overrides });
const html = node({ tag: "html" });

/** The slot of an image in a grid container, with the image wrapped in one grid item. */
function gridChain(gridCols: number, gap: number, container: Partial<LayoutNode> = {}): LayoutNode[] {
  return [img(), node({ tag: "div" }), node({ tag: "div", display: "grid", gridCols, gap, ...container }), html];
}

describe("slotExpr and formatSizes (synthetic chains)", () => {
  it("a single column in a full-width flow gives 100vw", () => {
    const nodes = [img(), node({ tag: "figure" }), node({ tag: "main" }), html];
    expect(formatSizes(slotExpr(nodes)!)).toBe("100vw");
  });

  it("a padded container subtracts its padding", () => {
    const nodes = [img(), node({ paddingX: 32 }), html];
    expect(formatSizes(slotExpr(nodes)!)).toBe("calc(100vw - 32px)");
  });

  it("the body margin is subtracted before the children", () => {
    const nodes = [img(), node({ tag: "main" }), node({ tag: "body", marginX: 16 }), html];
    expect(formatSizes(slotExpr(nodes)!)).toBe("calc(100vw - 16px)");
  });

  it("a 2-column grid with a 16px gap, in a 1280px container with 16px padding", () => {
    const expr = slotExpr(gridChain(2, 16, { maxWidth: 1280, paddingX: 32 }))!;
    expect(formatSizes(expr)).toBe("calc((min(100vw, 1280px) - 32px - 16px) / 2)");
    expect(evalExpr(expr, 1440)).toBe(616);
    expect(evalExpr(expr, 1280)).toBe(616);
  });

  it("a 3-column grid with a 16px gap in the same container", () => {
    const expr = slotExpr(gridChain(3, 16, { maxWidth: 1280, paddingX: 32 }))!;
    expect(formatSizes(expr)).toBe("calc((min(100vw, 1280px) - 32px - 32px) / 3)");
    expect(evalExpr(expr, 1440)).toBe((1280 - 32 - 32) / 3);
  });

  it("a 4-column grid with a 16px gap in a full-width container", () => {
    const expr = slotExpr(gridChain(4, 16))!;
    expect(formatSizes(expr)).toBe("calc((100vw - 48px) / 4)");
    expect(evalExpr(expr, 390)).toBe((390 - 48) / 4);
  });

  it("a max-width that binds gives min(100vw, max) and stays at the max above it", () => {
    const nodes = [img(), node({ maxWidth: 1280 }), html];
    const expr = slotExpr(nodes)!;
    expect(formatSizes(expr)).toBe("min(100vw, 1280px)");
    expect(evalExpr(expr, 390)).toBe(390);
    expect(evalExpr(expr, 1440)).toBe(1280);
  });

  it("a row flex container gives its child the child's percentage basis", () => {
    const nodes = [img(), node({ flexBasis: "50%" }), node({ display: "flex", flexDirection: "row" }), html];
    const expr = slotExpr(nodes)!;
    expect(formatSizes(expr)).toBe("calc((100vw) / 2)");
    expect(evalExpr(expr, 390)).toBe(195);
  });

  it("a row flex container with a gap accounts for the gaps between its children", () => {
    // Three children at 33.333%: two 16px gaps.
    const nodes = [img(), node({ flexBasis: "33.333333%" }), node({ display: "flex", flexDirection: "row", gap: 16 }), html];
    const expr = slotExpr(nodes)!;
    expect(evalExpr(expr, 400)).toBeCloseTo((400 - 32) * 0.33333333, 0);
  });

  it("the image's own max-width caps the slot", () => {
    const nodes = [img({ maxWidth: 300 }), node(), html];
    expect(formatSizes(slotExpr(nodes)!)).toBe("min(100vw, 300px)");
  });

  it("an empty chain has no expression", () => {
    expect(slotExpr([])).toBeUndefined();
  });
});

describe("deriveSizesFormula", () => {
  it("one branch when every viewport prints the same expression", () => {
    const expr = slotExpr(gridChain(2, 16, { maxWidth: 1280, paddingX: 32 }))!;
    const points = [375, 390, 1280, 1440].map((vw) => ({
      viewportWidth: vw,
      renderedWidth: evalExpr(expr, vw),
      expr,
    }));
    expect(deriveSizesFormula(points)).toBe("calc((min(100vw, 1280px) - 32px - 16px) / 2)");
  });

  it("two branches when a mobile single column meets a desktop 2-column grid", () => {
    const mobile = slotExpr([img(), node({ paddingX: 32 }), html])!;
    const desktop = slotExpr(gridChain(2, 16, { maxWidth: 1280, paddingX: 32 }))!;
    const points = [
      { viewportWidth: 375, renderedWidth: 343, expr: mobile },
      { viewportWidth: 390, renderedWidth: 358, expr: mobile },
      { viewportWidth: 1280, renderedWidth: 616, expr: desktop },
      { viewportWidth: 1440, renderedWidth: 616, expr: desktop },
    ];
    expect(deriveSizesFormula(points)).toBe(
      `(max-width: 640px) calc(100vw - 32px), calc((min(100vw, 1280px) - 32px - 16px) / 2)`,
    );
  });

  it("returns undefined when a measured width is off by more than the tolerance", () => {
    const expr = slotExpr([img(), node({ paddingX: 32 }), html])!;
    const points = [{ viewportWidth: 390, renderedWidth: 300, expr }];
    expect(deriveSizesFormula(points)).toBeUndefined();
  });

  it("returns undefined when the branches of two expressions interleave", () => {
    const a = slotExpr([img(), node({ paddingX: 32 }), html])!;
    const b = slotExpr([img(), node({ paddingX: 16 }), html])!;
    const points = [
      { viewportWidth: 375, renderedWidth: 343, expr: a },
      { viewportWidth: 390, renderedWidth: 374, expr: b },
      { viewportWidth: 1440, renderedWidth: 1424, expr: a },
    ];
    expect(deriveSizesFormula(points)).toBeUndefined();
  });

  it("ignores points that were not rendered", () => {
    const expr = slotExpr([img(), node(), html])!;
    const points = [
      { viewportWidth: 375, renderedWidth: 0, expr: slotExpr([img(), node({ paddingX: 300 }), html])! },
      { viewportWidth: 390, renderedWidth: 390, expr },
    ];
    expect(deriveSizesFormula(points)).toBe("100vw");
  });
});

describe("withinTolerance", () => {
  it("accepts a value never below the measured width and within 2% or 4 px above it", () => {
    expect(withinTolerance(101.5, 100)).toBe(true);
    expect(withinTolerance(104, 100)).toBe(true);
    expect(withinTolerance(99.7, 100)).toBe(true);
  });

  it("refuses a value below the measured width or too far above it", () => {
    expect(withinTolerance(99, 100)).toBe(false);
    expect(withinTolerance(106, 100)).toBe(false);
    expect(withinTolerance(1025, 1000)).toBe(false);
    expect(withinTolerance(1019, 1000)).toBe(true);
    expect(withinTolerance(undefined, 100)).toBe(false);
  });
});

describe("breakpointBetween", () => {
  it("snaps to a known breakpoint inside the gap, else takes the midpoint", () => {
    expect(breakpointBetween(430, 1280)).toBe(640);
    expect(breakpointBetween(800, 1000)).toBe(900);
    expect(breakpointBetween(768, 1024)).toBe(768);
  });
});

describe("sameStructure", () => {
  it("ignores widths and classes, and sees a changed column count", () => {
    const a = gridChain(2, 16, { maxWidth: 1280, paddingX: 32, width: 616 });
    const b = gridChain(2, 16, { maxWidth: 1280, paddingX: 32, width: 900, classes: "x" });
    expect(sameStructure(a, b)).toBe(true);
    expect(sameStructure(a, gridChain(3, 16, { maxWidth: 1280, paddingX: 32 }))).toBe(false);
  });
});
