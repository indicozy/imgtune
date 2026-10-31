// Layout chains and the CSS `sizes` formula derived from them. Pure: no DOM, no network. The browser side (remote.ts)
// records a chain per image and viewport; this module turns the chain into the width of the image's slot as an
// expression of 100vw, checks it against the widths the browser actually rendered, and prints it as CSS.

/** One ancestor (or the image itself) as the browser laid it out. Widths and spacing are CSS px. */
export interface LayoutNode {
  tag: string;
  /** Up to three class names, space-separated. */
  classes: string;
  /** Computed content-box width. */
  width: number;
  /** max-width in px; undefined when none or a percentage. */
  maxWidth?: number;
  /** padding-left + padding-right. */
  paddingX: number;
  /** border-left + border-right. */
  borderX: number;
  /** margin-left + margin-right; 0 for a node centred by its max-width (its margins are auto). */
  marginX: number;
  display: string;
  /** Tracks in grid-template-columns (display grid only; 0 for none). */
  gridCols?: number;
  /** column-gap in px (grid and flex containers). */
  gap?: number;
  flexDirection?: string;
  /** flex-basis as computed: "auto", "120px" or "50%". */
  flexBasis?: string;
}

/** The chain of one image at one viewport: the image first, the root last. */
export interface LayoutChainData {
  nodes: LayoutNode[];
  /** Ancestors that do not constrain width (display: contents, inline wrappers), each with its reason. */
  skipped: string[];
  /** True when the walk stopped at the depth cap before reaching the root. */
  truncated: boolean;
}

/** A width expression: the slot of an image in CSS px, as a function of the viewport width. */
export type Expr =
  | { kind: "vw" }
  | { kind: "px"; value: number }
  | { kind: "min"; a: Expr; b: Expr }
  | { kind: "sub"; a: Expr; px: number }
  | { kind: "frac"; a: Expr; gap: number; num: number; den: number };

const VW: Expr = { kind: "vw" };

const round2 = (value: number): string => String(Math.round(value * 100) / 100);

function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b);
}

/** (a - gap) * num / den, with num/den reduced. */
function frac(a: Expr, gap: number, num: number, den: number): Expr {
  const reduce = Number.isInteger(num) && Number.isInteger(den);
  const g = reduce ? gcd(num, den) || 1 : 1;
  const n = num / g;
  const d = den / g;
  if (n === d && gap === 0) return a;
  return { kind: "frac", a, gap, num: n, den: d };
}

function sub(a: Expr, px: number): Expr {
  return px === 0 ? a : { kind: "sub", a, px };
}

const minOf = (a: Expr, b: Expr): Expr => ({ kind: "min", a, b });

/** The expression as CSS, without the outer calc(). */
export function printExpr(e: Expr): string {
  switch (e.kind) {
    case "vw":
      return "100vw";
    case "px":
      return `${round2(e.value)}px`;
    case "min":
      return `min(${printExpr(e.a)}, ${printExpr(e.b)})`;
    case "sub":
      return `${printExpr(e.a)} - ${round2(e.px)}px`;
    case "frac": {
      const inner = e.gap > 0 ? `${printExpr(e.a)} - ${round2(e.gap)}px` : printExpr(e.a);
      return e.num === 1 ? `(${inner}) / ${e.den}` : `(${inner}) * ${e.num} / ${e.den}`;
    }
  }
}

/** The expression as a `sizes` value: a plain length or min() stands alone; anything else is one calc(). */
export function formatSizes(e: Expr): string {
  if (e.kind === "vw" || e.kind === "px" || e.kind === "min") return printExpr(e);
  return `calc(${printExpr(e)})`;
}

/** The expression's value at a viewport width, in CSS px (never negative). */
export function evalExpr(e: Expr, vw: number): number {
  switch (e.kind) {
    case "vw":
      return vw;
    case "px":
      return e.value;
    case "min":
      return Math.min(evalExpr(e.a, vw), evalExpr(e.b, vw));
    case "sub":
      return Math.max(0, evalExpr(e.a, vw) - e.px);
    case "frac":
      return Math.max(0, ((evalExpr(e.a, vw) - e.gap) * e.num) / e.den);
  }
}

const pct = (basis: string | undefined): number | undefined => {
  const m = /^([\d.]+)%$/.exec(basis ?? "");
  return m ? Number(m[1]) : undefined;
};

/**
 * The width of the image's slot, from its chain (the image first, the root last). Walking from the root down: each
 * ancestor takes its margin, then its max-width, then its padding and border; a grid container divides its content
 * among its columns (less the gaps); a row flex container gives each child its percentage of the content. The image's
 * own max-width caps the result. Undefined for an empty chain.
 */
export function slotExpr(nodes: LayoutNode[]): Expr | undefined {
  if (nodes.length === 0) return undefined;
  const top = [...nodes].reverse();
  let expr: Expr = VW;
  for (let i = 0; i < top.length - 1; i++) {
    const node = top[i];
    const child = top[i + 1];
    expr = sub(expr, node.marginX);
    if (node.maxWidth !== undefined) expr = minOf(expr, { kind: "px", value: node.maxWidth });
    expr = sub(expr, node.paddingX + node.borderX);
    const gap = node.gap ?? 0;
    if (node.display === "grid" && (node.gridCols ?? 0) > 1) {
      const cols = node.gridCols as number;
      expr = frac(expr, gap * (cols - 1), 1, cols);
    } else if (node.display === "flex" && (node.flexDirection ?? "row").startsWith("row")) {
      const basis = child.flexBasis ?? "auto";
      const percent = pct(basis);
      if (percent !== undefined && percent > 0) {
        const count = Math.max(1, Math.round(100 / percent));
        expr = frac(expr, gap * (count - 1), percent, 100);
      } else if (/^[\d.]+px$/.test(basis)) {
        expr = { kind: "px", value: parseFloat(basis) };
      }
    }
  }
  const img = top[top.length - 1];
  if (img.maxWidth !== undefined) expr = minOf(expr, { kind: "px", value: img.maxWidth });
  return expr;
}

/**
 * Whether a formula or fitted value is acceptable at one measured point: never below the rendered width (0.5 px for
 * rounding), and within the larger of 2% or 4 px of it.
 */
export function withinTolerance(value: number | undefined, measured: number): boolean {
  if (value === undefined) return false;
  if (value < measured - 0.5) return false;
  return value - measured <= Math.max(0.02 * measured, 4);
}

/** Breakpoints a media branch snaps to when one lies between two measured groups. */
const KNOWN_BREAKPOINTS = [640, 768, 1024, 1280];

/** The width a media condition switches at, between the last viewport of one group and the first of the next. */
export function breakpointBetween(lo: number, hi: number): number {
  return KNOWN_BREAKPOINTS.find((b) => b >= lo && b < hi) ?? Math.floor((lo + hi) / 2);
}

export interface FormulaPoint {
  viewportWidth: number;
  renderedWidth: number;
  /** The slot expression of this viewport's chain. */
  expr: Expr;
}

/**
 * The `sizes` value of one image from its per-viewport slot expressions. Viewports whose expressions print the same form
 * one branch; the branches must cover disjoint ranges of viewport width, and each switch point becomes a media condition.
 * Undefined when the branches interleave, or when the value misses a measured width (see withinTolerance): the caller
 * then falls back to a fitted or measured value.
 */
export function deriveSizesFormula(points: FormulaPoint[]): string | undefined {
  const measured = points.filter((p) => p.renderedWidth >= 1);
  if (measured.length === 0) return undefined;
  const groups = new Map<string, { expr: Expr; min: number; max: number }>();
  for (const p of measured) {
    const key = printExpr(p.expr);
    const group = groups.get(key);
    if (group) {
      group.min = Math.min(group.min, p.viewportWidth);
      group.max = Math.max(group.max, p.viewportWidth);
    } else {
      groups.set(key, { expr: p.expr, min: p.viewportWidth, max: p.viewportWidth });
    }
  }
  const ordered = [...groups.values()].sort((a, b) => a.min - b.min);
  for (let i = 0; i + 1 < ordered.length; i++) {
    if (ordered[i].max >= ordered[i + 1].min) return undefined;
  }
  const branches = ordered.map((g, i) => ({
    expr: g.expr,
    maxWidth: i + 1 < ordered.length ? breakpointBetween(g.max, ordered[i + 1].min) : undefined,
  }));
  const valueAt = (vw: number): number | undefined => {
    const branch = branches.find((b) => b.maxWidth === undefined || vw <= b.maxWidth);
    return branch ? evalExpr(branch.expr, vw) : undefined;
  };
  if (!measured.every((p) => withinTolerance(valueAt(p.viewportWidth), p.renderedWidth))) return undefined;
  if (branches.length === 1) return formatSizes(branches[0].expr);
  return branches
    .map((b) => (b.maxWidth === undefined ? formatSizes(b.expr) : `(max-width: ${b.maxWidth}px) ${formatSizes(b.expr)}`))
    .join(", ");
}

/** Whether two chains have the same structure at every ancestor, ignoring widths and class names. */
export function sameStructure(a: LayoutNode[], b: LayoutNode[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((n, i) => {
    const m = b[i];
    return (
      n.tag === m.tag &&
      n.display === m.display &&
      n.maxWidth === m.maxWidth &&
      n.paddingX === m.paddingX &&
      n.borderX === m.borderX &&
      n.marginX === m.marginX &&
      n.gridCols === m.gridCols &&
      n.gap === m.gap &&
      n.flexDirection === m.flexDirection &&
      n.flexBasis === m.flexBasis
    );
  });
}
