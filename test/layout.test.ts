import { describe, expect, it } from "vitest";
import {
  breakpointBetween,
  deriveSizesFromLayout,
  formatLinear,
  linearAt,
  sameStructure,
  slotAt,
  withinTolerance,
  type FormulaPoint,
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

const img = (overrides: Partial<LayoutNode> = {}): LayoutNode => node({ tag: "img", ...overrides });
const html = (vw: number): LayoutNode => node({ tag: "html", width: vw });

// ---------------------------------------------------------------------------------------------------------------------
// A small CSS evaluator for the values this module prints: length, vw, calc(), min(), max(), clamp().
// ---------------------------------------------------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?(?:px|vw)?|[A-Za-z]+|[()+*/,-]/g) ?? [];
}

/** The value of one CSS width expression at a viewport width. */
function evalCss(text: string, vw: number): number {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const take = (): string => tokens[pos++];
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = take() === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek() === "*" || peek() === "/") v = take() === "*" ? v * factor() : v / factor();
    return v;
  };
  const args = (): number[] => {
    const out: number[] = [];
    take(); // (
    out.push(expr());
    while (peek() === ",") {
      take();
      out.push(expr());
    }
    take(); // )
    return out;
  };
  const factor = (): number => {
    const t = take();
    if (t === "(") {
      const v = expr();
      take();
      return v;
    }
    if (t === "calc") return args()[0];
    if (t === "min") return Math.min(...args());
    if (t === "max") return Math.max(...args());
    if (t === "clamp") {
      const [lo, value, hi] = args();
      return Math.max(lo, Math.min(value, hi));
    }
    if (t.endsWith("vw")) return (parseFloat(t) * vw) / 100;
    if (t.endsWith("px")) return parseFloat(t);
    return parseFloat(t);
  };
  return expr();
}

/** The value a sizes string gives at a viewport width: its first branch whose media condition holds. */
function sizesAt(sizes: string, vw: number): number {
  // Split on the commas outside parentheses.
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of sizes) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  for (const part of parts) {
    const m = /^\(max-width: (\d+)px\) (.*)$/.exec(part);
    if (m) {
      if (vw <= Number(m[1])) return evalCss(m[2], vw);
    } else {
      return evalCss(part, vw);
    }
  }
  throw new Error(`no branch of ${sizes} applies at ${vw}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Chains of a page at one viewport, built from the widths a browser would report
// ---------------------------------------------------------------------------------------------------------------------

/** An image filling a block wrapper with `padding` px on each side, in the viewport. */
function paddedChain(vw: number, padding: number): LayoutNode[] {
  const inner = vw - 2 * padding;
  return [img({ width: inner }), node({ width: inner, paddingX: 2 * padding }), html(vw)];
}

/**
 * A wrapper with max-width, centred (auto margins), with `padding` px each side; the image fills it. Border-box sizing
 * caps the border box, content-box sizing caps the content.
 */
function centredChain(vw: number, max: number, padding: number, borderBox: boolean): LayoutNode[] {
  const content = borderBox ? Math.min(vw, max) - 2 * padding : Math.min(vw - 2 * padding, max);
  return [img({ width: content }), node({ width: content, maxWidth: max, paddingX: 2 * padding, borderBox }), html(vw)];
}

/** An image in one of `span` columns of a grid of `cols` equal tracks with `gap`, in a wrapper with 24 px of padding. */
function gridChain(vw: number, cols: number, span: number, gap: number): LayoutNode[] {
  const wrapper = vw - 48;
  const item = ((wrapper - gap * (cols - 1)) * span) / cols + gap * (span - 1);
  const grid = node({ display: "grid", gridCols: cols, gridUniform: true, gap, width: wrapper });
  return [img({ width: item }), node({ width: item, gridSpan: span }), grid, node({ width: wrapper, paddingX: 48 }), html(vw)];
}

/** The same set of viewport chains for a scenario, with the widths the browser rendered. */
function points(vws: number[], chainAt: (vw: number) => LayoutNode[]): FormulaPoint[] {
  return vws.map((vw) => {
    const chain = chainAt(vw);
    return { viewportWidth: vw, renderedWidth: chain[0].width, slot: slotAt(chain, vw) };
  });
}

const PHONES_AND_DESKTOP = [375, 390, 412, 430, 768, 1024, 1280, 1440];

// ---------------------------------------------------------------------------------------------------------------------
// slotAt: the structural rules
// ---------------------------------------------------------------------------------------------------------------------

describe("slotAt: structural rules", () => {
  it("a block that fills the viewport gives 100vw", () => {
    const walk = slotAt([img({ width: 390 }), node({ width: 390 }), html(390)], 390)!;
    expect(formatLinear(walk.linear)).toBe("100vw");
  });

  it("a padded wrapper subtracts its padding", () => {
    expect(formatLinear(slotAt(paddedChain(390, 16), 390)!.linear)).toBe("calc(100vw - 32px)");
  });

  it("a centred max-width wrapper gives min(vw - padding, max-width), content-box sizing", () => {
    const walk = (vw: number) => linearAt(slotAt(centredChain(vw, 1280, 16, false), vw)!.linear, vw);
    expect(walk(390)).toBe(390 - 32);
    expect(walk(1440)).toBe(1280);
    // The edge the naive min(vw, max) - padding gets wrong: the padding is taken before the cap.
    expect(walk(1300)).toBe(Math.min(1300 - 32, 1280));
  });

  it("a centred max-width wrapper with border-box sizing caps the border box", () => {
    const walk = (vw: number) => linearAt(slotAt(centredChain(vw, 1280, 16, true), vw)!.linear, vw);
    expect(walk(390)).toBe(390 - 32);
    expect(walk(1440)).toBe(1280 - 32);
    expect(walk(1300)).toBe(1280 - 32);
  });

  it("a max-width that follows the viewport (not binding at any viewport) keeps one branch", () => {
    // The body's computed max-width equals the viewport width at every viewport: it never binds.
    const chainAt = (vw: number) => [img({ width: vw - 32 }), node({ width: vw - 32, paddingX: 32 }), node({ tag: "body", width: vw, maxWidth: vw }), html(vw)];
    const result = deriveSizesFromLayout(points(PHONES_AND_DESKTOP, chainAt))!;
    expect(result.branches).toHaveLength(1);
    expect(result.value).toBe("calc(100vw - 32px)");
    expect(result.basis).toBe("layout-formula");
  });

  it("a grid child takes its column span, with the gaps between the columns", () => {
    const half = slotAt(gridChain(1440, 12, 6, 24), 1440)!;
    expect(formatLinear(half.linear)).toBe("calc(50vw - 36px)");
    expect(linearAt(half.linear, 390)).toBeCloseTo(((390 - 48 - 24 * 11) * 6) / 12 + 24 * 5, 6);
  });

  it("a grid child spanning every column (grid-column: 1 / -1) takes the whole grid", () => {
    expect(formatLinear(slotAt(gridChain(1440, 12, 12, 24), 1440)!.linear)).toBe("calc(100vw - 48px)");
  });

  it("a block child with a percentage width takes that share of its parent", () => {
    const chain = [img({ width: 720 }), node({ width: 720 }), node({ width: 1440, tag: "section" }), html(1440)];
    expect(formatLinear(slotAt(chain, 1440)!.linear)).toBe("50vw");
  });

  it("a row flex child with a percentage basis takes that share of its container", () => {
    const chain = [
      img({ width: 720 }),
      node({ width: 720, flexBasis: "50%", flexGrow: 0 }),
      node({ display: "flex", flexDirection: "row", width: 1440, gap: 0 }),
      html(1440),
    ];
    expect(formatLinear(slotAt(chain, 1440)!.linear)).toBe("50vw");
  });

  it("a row flex child with a fixed px basis that does not grow is a constant", () => {
    const chain = (vw: number) => [
      img({ width: 200 }),
      node({ width: 200, flexBasis: "200px", flexGrow: 0 }),
      node({ display: "flex", flexDirection: "row", width: vw }),
      html(vw),
    ];
    expect(formatLinear(slotAt(chain(390), 390)!.linear)).toBe("200px");
    expect(formatLinear(slotAt(chain(1440), 1440)!.linear)).toBe("200px");
  });

  it("a flex child that grows beside a fixed sibling takes the rest of the row (measured share)", () => {
    const chain = (vw: number) => [
      img({ width: vw - 100 }),
      node({ width: vw - 100, flexBasis: "auto", flexGrow: 1 }),
      node({ display: "flex", flexDirection: "row", width: vw }),
      html(vw),
    ];
    const at390 = slotAt(chain(390), 390)!;
    const at1440 = slotAt(chain(1440), 1440)!;
    // The share is measured, so the signature matches but the coefficients are the viewport's own.
    expect(at390.signature).toBe(at1440.signature);
    expect(linearAt(at390.linear, 390)).toBeCloseTo(290, 0);
    expect(linearAt(at1440.linear, 1440)).toBeCloseTo(1340, 0);
  });

  it("an image's own max-width caps its slot once the viewport is wide enough", () => {
    const chain = (vw: number) => [img({ width: 300, maxWidth: 300 }), node({ width: vw }), html(vw)];
    expect(formatLinear(slotAt(chain(1440), 1440)!.linear)).toBe("300px");
    expect(linearAt(slotAt(chain(390), 390)!.linear, 390)).toBeCloseTo(300, 0);
  });

  it("an empty chain has no walk", () => {
    expect(slotAt([], 390)).toBeUndefined();
  });

  it("a width set by the box, not the file (aspect-ratio), keeps its own width at every viewport", () => {
    // A 300 px wide box (height and aspect-ratio give the width) in a full-width wrapper: the file's shape is not used.
    const chain = (vw: number) => [img({ width: 300 }), node({ width: vw }), html(vw)];
    const rendered = [390, 768, 1440].map((vw) => ({
      viewportWidth: vw,
      renderedWidth: 300,
      slot: slotAt(chain(vw), vw),
    }));
    const result = deriveSizesFromLayout(rendered)!;
    expect(result.basis).toBe("measured-max");
    expect(result.value).toBe("300px");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// deriveSizesFromLayout: branches, fallbacks and the safety rules
// ---------------------------------------------------------------------------------------------------------------------

describe("deriveSizesFromLayout", () => {
  it("one formula branch when every viewport has the same structure", () => {
    const result = deriveSizesFromLayout(points(PHONES_AND_DESKTOP, (vw) => paddedChain(vw, 16)))!;
    expect(result.value).toBe("calc(100vw - 32px)");
    expect(result.basis).toBe("layout-formula");
    expect(result.branches).toHaveLength(1);
  });

  it("a centred max-width wrapper gives a formula below the cap and the cap above it, each its own branch", () => {
    const result = deriveSizesFromLayout(points(PHONES_AND_DESKTOP, (vw) => centredChain(vw, 1280, 16, true)))!;
    expect(result.basis).toBe("layout-formula");
    expect(result.value).toBe("(max-width: 1280px) calc(100vw - 32px), 1248px");
    for (const vw of PHONES_AND_DESKTOP) {
      expect(sizesAt(result.value, vw)).toBeGreaterThanOrEqual(Math.min(vw - 32, 1248) - 0.5);
    }
  });

  it("a grid's column span is a formula, the same at phone and desktop widths", () => {
    const result = deriveSizesFromLayout(points(PHONES_AND_DESKTOP, (vw) => gridChain(vw, 12, 6, 24)))!;
    expect(result.value).toBe("calc(50vw - 36px)");
    expect(result.basis).toBe("layout-formula");
  });

  it("two grids of different column counts split at a media condition", () => {
    const chainAt = (vw: number) => (vw < 768 ? gridChain(vw, 1, 1, 0) : gridChain(vw, 12, 6, 24));
    const result = deriveSizesFromLayout(points(PHONES_AND_DESKTOP, chainAt))!;
    expect(result.basis).toBe("layout-formula");
    expect(result.branches).toHaveLength(2);
    expect(result.value).toMatch(/^\(max-width: \d+px\) calc\(100vw - 48px\), calc\(50vw - 36px\)$/);
    for (const vw of PHONES_AND_DESKTOP) {
      expect(sizesAt(result.value, vw)).toBeGreaterThanOrEqual(chainAt(vw)[0].width - 0.5);
    }
  });

  it("a fitted branch is used when no formula matches the rendered widths, and is held outside its range", () => {
    // A flex sibling of fixed width: the share is vw - 100 px, which the measured ratio gives only per viewport.
    const chainAt = (vw: number) => [
      img({ width: vw - 100 }),
      node({ width: vw - 100, flexBasis: "auto", flexGrow: 1 }),
      node({ display: "flex", flexDirection: "row", width: vw }),
      html(vw),
    ];
    const result = deriveSizesFromLayout(points([390, 768, 1024, 1440], chainAt))!;
    expect(result.basis).toBe("fit");
    expect(result.value).toBe("calc(1 * clamp(390px, 100vw, 1440px) - 100px)");
    // Held below the smallest and above the largest measured viewport: never decreasing, never below the largest width.
    expect(sizesAt(result.value, 320)).toBe(290);
    expect(sizesAt(result.value, 1440)).toBe(1340);
    expect(sizesAt(result.value, 2560)).toBe(1340);
    for (const vw of [390, 768, 1024, 1440]) {
      expect(sizesAt(result.value, vw)).toBeGreaterThanOrEqual(vw - 100 - 0.5);
    }
  });

  it("a fit that never increases falls back to the largest measured width", () => {
    const slot = { linear: { a: 0.5, b: 0 }, signature: "same" };
    const decreasing: FormulaPoint[] = [
      { viewportWidth: 390, renderedWidth: 400, slot },
      { viewportWidth: 768, renderedWidth: 300, slot },
      { viewportWidth: 1440, renderedWidth: 200, slot },
    ];
    const result = deriveSizesFromLayout(decreasing)!;
    expect(result.basis).toBe("measured-max");
    expect(result.value).toBe("400px");
  });

  it("a formula that holds at one viewport only is not confirmed and falls back to the measured width", () => {
    const single = points([390], (vw) => paddedChain(vw, 16));
    expect(deriveSizesFromLayout(single)!.basis).toBe("measured-max");
    expect(deriveSizesFromLayout(single)!.value).toBe("358px");
  });

  it("a viewport where the image is not rendered gets no requirement", () => {
    const pts = [
      ...points([390, 1440], (vw) => paddedChain(vw, 16)),
      { viewportWidth: 768, renderedWidth: 0, slot: slotAt(paddedChain(768, 900), 768) },
    ];
    const result = deriveSizesFromLayout(pts)!;
    expect(result.value).toBe("calc(100vw - 32px)");
    expect(result.basis).toBe("layout-formula");
  });

  it("returns undefined when no viewport rendered the image", () => {
    expect(deriveSizesFromLayout([{ viewportWidth: 390, renderedWidth: 0 }])).toBeUndefined();
  });

  it("interleaved branches fall back for the whole image, never to a wrong formula", () => {
    const pts: FormulaPoint[] = [
      ...points([390], (vw) => paddedChain(vw, 16)),
      ...points([768], (vw) => paddedChain(vw, 40)),
      ...points([1440], (vw) => paddedChain(vw, 16)),
      ...points([1024], (vw) => paddedChain(vw, 40)),
    ];
    const result = deriveSizesFromLayout(pts)!;
    expect(result.basis).toBe("measured-max");
    expect(result.branches).toHaveLength(1);
    expect(sizesAt(result.value, 390)).toBeGreaterThanOrEqual(358 - 0.5);
  });

  it("never gives a value below a measured width at any measured viewport", () => {
    const scenarios: ((vw: number) => LayoutNode[])[] = [
      (vw) => paddedChain(vw, 16),
      (vw) => centredChain(vw, 1280, 16, true),
      (vw) => centredChain(vw, 1280, 16, false),
      (vw) => gridChain(vw, 12, 4, 16),
    ];
    for (const chainAt of scenarios) {
      const pts = points(PHONES_AND_DESKTOP, chainAt);
      const result = deriveSizesFromLayout(pts)!;
      for (const p of pts) expect(sizesAt(result.value, p.viewportWidth)).toBeGreaterThanOrEqual(p.renderedWidth - 0.5);
    }
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
    const a = gridChain(1440, 12, 6, 24);
    const b = gridChain(390, 12, 6, 24).map((n) => ({ ...n, classes: "x" }));
    expect(sameStructure(a, b)).toBe(true);
    expect(sameStructure(a, gridChain(1440, 4, 2, 24))).toBe(false);
  });
});
