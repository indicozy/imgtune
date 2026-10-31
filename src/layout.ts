// Layout chains and the CSS `sizes` value derived from them. Pure: no DOM, no network. The browser side (remote.ts) records
// a chain per image and viewport; this module walks the chain down from the viewport to the image and states the image's
// width as a linear function of the viewport width (a * vw + b). The function is checked against the widths the browser
// rendered, branch by branch, and printed as CSS.

/** One ancestor (or the image itself) as the browser laid it out. Widths and spacing are CSS px. */
export interface LayoutNode {
  tag: string;
  /** Up to three class names, space-separated. */
  classes: string;
  /** Computed content-box width. */
  width: number;
  /** max-width in px; undefined when none or a percentage (a percentage is the containing block's own width). */
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
  /** True when every grid track is the same width (display grid only). */
  gridUniform?: boolean;
  /** Columns this node spans in its grid parent (1 when none is set). */
  gridSpan?: number;
  /** column-gap in px (grid and flex containers). */
  gap?: number;
  flexDirection?: string;
  /** flex-basis as computed: "auto", "120px" or "50%". */
  flexBasis?: string;
  /** flex-grow as computed. */
  flexGrow?: number;
  /** box-sizing is border-box: max-width then caps the border box, not the content box. */
  borderBox?: boolean;
}

/** The chain of one image at one viewport: the image first, the root last. */
export interface LayoutChainData {
  nodes: LayoutNode[];
  /** Ancestors that do not constrain width (display: contents, inline wrappers), each with its reason. */
  skipped: string[];
  /** True when the walk stopped at the depth cap before reaching the root. */
  truncated: boolean;
}

/** A width in CSS px as a linear function of the viewport width: `a` times the viewport, plus `b` px. */
export interface Linear {
  a: number;
  b: number;
}

/** Where a sizes value came from, weakest first: a measured maximum, a fitted line, or the layout formula. */
export type SizesBasis = "layout-formula" | "fit" | "measured-max";

/**
 * The walk of one chain at one viewport: the width as a linear function, and the structure it came from. The structure
 * (which caps bind, the grid arithmetic, which steps were measured) is the key a branch groups viewports by, so a
 * measured share that changes with the viewport stays in one branch and is fitted there.
 */
export interface SlotWalk {
  linear: Linear;
  signature: string;
}

/** Rounding of the coefficients: the printed value is the value the check uses. */
const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** The width at a viewport, in CSS px, never negative. */
export function linearAt(l: Linear, vw: number): number {
  return Math.max(0, l.a * vw + l.b);
}

const scale = (l: Linear, k: number): Linear => ({ a: l.a * k, b: l.b * k });
const shift = (l: Linear, px: number): Linear => ({ a: l.a, b: l.b - px });

/** The expression capped at `max` at this viewport: the expression while it is at most the cap, else the cap. */
function capAt(l: Linear, max: number, vw: number): Linear {
  return l.a * vw + l.b <= max ? l : { a: 0, b: max };
}

/**
 * The width of the image's box at a viewport, from its chain (the image first, the root last). The root is laid out in
 * the viewport (100vw); each node takes its containing block's width as its own share, then its margins, its max-width
 * (which caps the content box, or the border box with border-box sizing) and its padding and border.
 *
 * A child's share of its parent's content box is, in order: the grid's span arithmetic when the grid's tracks are equal;
 * the measured share (child's margin box over the parent's content box) for a flex row child, a grid of unequal tracks,
 * or a block child that does not fill its parent; a fixed px share for a flex child with a px basis that does not grow;
 * and the whole parent for a block child that fills it or is capped by a max-width (the cap is then the node's own rule).
 * Undefined when a step has no rule and no measured share.
 */
export function slotAt(nodes: LayoutNode[], vw: number): SlotWalk | undefined {
  if (nodes.length === 0) return undefined;
  const top = [...nodes].reverse();
  let state: Linear = { a: 1, b: 0 };
  const steps: string[] = [];
  for (let k = 0; k < top.length; k++) {
    const node = top[k];
    if (k > 0) {
      const share = shareOf(top[k - 1], node, state);
      if (share === undefined) return undefined;
      state = share.linear;
      steps.push(share.step);
    }
    const content = contentOf(node, state, vw);
    state = content.linear;
    steps.push(content.step);
  }
  return { linear: { a: round(state.a, 4), b: round(state.b, 2) }, signature: steps.join(" ") };
}

/** The content box of a node, from its containing block's width. */
function contentOf(node: LayoutNode, containing: Linear, vw: number): { linear: Linear; step: string } {
  const borderBox = node.borderBox === true;
  let avail = shift(containing, node.marginX + (borderBox ? 0 : node.paddingX + node.borderX));
  // The step names the constants too, so a breakpoint that changes a padding or a cap starts a new branch.
  let step = `${node.marginX}/${node.paddingX}/${node.borderX}${borderBox ? "b" : ""}`;
  if (node.maxWidth !== undefined) {
    const capped = capAt(avail, node.maxWidth, vw);
    // The side of the cap that is active at this viewport: the expression ("m") or the cap itself ("M").
    step += `/${capped === avail ? "m" : "M"}${node.maxWidth}`;
    avail = capped;
  }
  if (borderBox) avail = shift(avail, node.paddingX + node.borderX);
  return { linear: avail, step: `content ${step}` };
}

/** The margin box of a child, as a share of its parent's content box. */
function shareOf(parent: LayoutNode, child: LayoutNode, parentContent: Linear): { linear: Linear; step: string } | undefined {
  // A capped box takes the whole parent (margins are auto); its own rule in contentOf applies the cap.
  if (child.maxWidth !== undefined) return { linear: parentContent, step: "capped" };
  const outer = child.width + child.paddingX + child.borderX + child.marginX;
  if (parent.display === "grid" && (parent.gridCols ?? 0) > 1 && parent.gridUniform === true) {
    const cols = parent.gridCols as number;
    const span = Math.max(1, Math.min(cols, child.gridSpan ?? 1));
    const gap = parent.gap ?? 0;
    // (parent - gap * (cols - 1)) * span / cols + gap * (span - 1)
    const linear = shift(scale(shift(parentContent, gap * (cols - 1)), span / cols), -gap * (span - 1));
    return { linear, step: `grid ${cols}/${span}/${gap}` };
  }
  if (parent.width <= 0) return undefined;
  if (parent.display === "flex" && (parent.flexDirection ?? "row").startsWith("row")) {
    const basis = /^([\d.]+)px$/.exec(child.flexBasis ?? "");
    if (basis && Number(basis[1]) > 0 && (child.flexGrow ?? 0) === 0) return { linear: { a: 0, b: outer }, step: `px ${outer}` };
  }
  if (Math.abs(outer - parent.width) <= 1) return { linear: parentContent, step: "fill" };
  return { linear: scale(parentContent, round(outer / parent.width, 4)), step: "share" };
}

/** The CSS of a coefficient pair: a plain length, or one calc(). */
export function formatLinear(l: Linear): string {
  const vwPercent = round(l.a * 100, 2);
  const px = round(l.b, 2);
  if (vwPercent === 0) return `${Math.max(0, px)}px`;
  if (px === 0) return `${vwPercent}vw`;
  return `calc(${vwPercent}vw ${px < 0 ? "-" : "+"} ${Math.abs(px)}px)`;
}

/** A fitted line held outside the range it was measured in: the viewport is clamped to [lo, hi] (CSS clamp()). */
export function formatHeldFit(l: Linear, lo: number, hi: number): string {
  if (Math.abs(l.a) < 1e-9) return formatLinear({ a: 0, b: l.b });
  const b = round(l.b, 2);
  return `calc(${round(l.a, 4)} * clamp(${Math.round(lo)}px, 100vw, ${Math.round(hi)}px) ${b < 0 ? "-" : "+"} ${Math.abs(b)}px)`;
}

/** The value of a held fit at a viewport: the line at the viewport clamped to [lo, hi]. */
export function heldFitAt(l: Linear, lo: number, hi: number, vw: number): number {
  return linearAt(l, Math.min(Math.max(vw, lo), hi));
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
  /** The image's chain walked at this viewport (undefined: a step had no rule). */
  slot?: SlotWalk;
}

/** One media branch of a sizes value: the viewports it covers, its value and where the value came from. */
export interface SizesBranch {
  /** Smallest and largest measured viewport width in the branch. */
  lo: number;
  hi: number;
  /** The CSS value (a length or a calc()/max()/clamp() of one). */
  value: string;
  basis: SizesBasis;
  /** The media condition that selects the branch ("default" for the last one). */
  condition: string;
}

export interface SizesResult {
  /** The sizes value: its branches joined, the last one unconditioned. */
  value: string;
  /** The weakest basis of its branches. */
  basis: SizesBasis;
  branches: SizesBranch[];
}

const BASIS_ORDER: SizesBasis[] = ["measured-max", "fit", "layout-formula"];
const weakest = (bases: SizesBasis[]): SizesBasis => bases.reduce((a, b) => (BASIS_ORDER.indexOf(a) <= BASIS_ORDER.indexOf(b) ? a : b));

/** Least-squares line through the points (viewport width, rendered width); undefined when the viewports do not vary. */
function fitLine(points: { x: number; y: number }[]): Linear | undefined {
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.x, 0);
  const sy = points.reduce((s, p) => s + p.y, 0);
  const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return undefined;
  const a = (n * sxy - sx * sy) / denom;
  return { a, b: (sy - a * sx) / n };
}

/**
 * The sizes value of one image from its measured points, per media branch. Points with the same linear function form one
 * branch when their viewports are contiguous (a branch of one viewport is not a formula). A branch takes, in order:
 * the layout formula when it matches every rendered width of the branch; else a line fitted to the branch, held outside
 * its measured range (clamp) with the branch's largest width as a floor above it, when the line never decreases and
 * matches; else the largest rendered width of the branch as a constant. A branch never falls below its measured widths.
 * Undefined when no point was rendered, or when the branches overlap (then the whole image is fitted or held at its maximum).
 */
export function deriveSizesFromLayout(points: FormulaPoint[]): SizesResult | undefined {
  const measured = points.filter((p) => p.renderedWidth >= 1).sort((a, b) => a.viewportWidth - b.viewportWidth);
  if (measured.length === 0) return undefined;

  const groups = new Map<string, FormulaPoint[]>();
  for (const p of measured) {
    const key = p.slot ? p.slot.signature : `unexplained:${p.viewportWidth}`;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  let ordered = [...groups.values()].sort((a, b) => a[0].viewportWidth - b[0].viewportWidth);
  const overlap = ordered.some((g, i) => i + 1 < ordered.length && g[g.length - 1].viewportWidth >= ordered[i + 1][0].viewportWidth);
  if (overlap) ordered = [measured];

  const branches: SizesBranch[] = ordered.map((group): SizesBranch => {
    const lo = group[0].viewportWidth;
    const hi = group[group.length - 1].viewportWidth;
    const widest = Math.ceil(Math.max(...group.map((p) => p.renderedWidth)));
    const distinct = new Set(group.map((p) => p.viewportWidth)).size;
    // The formula of the branch: the first viewport's. One viewport confirms only a constant (a cap or a px share).
    const formula = !overlap && group[0].slot ? group[0].slot.linear : undefined;
    const confirmed = distinct >= 2 || formula?.a === 0;
    if (formula && confirmed && group.every((p) => withinTolerance(linearAt(formula, p.viewportWidth), p.renderedWidth))) {
      return { lo, hi, value: formatLinear(formula), basis: "layout-formula", condition: "" };
    }
    const fitted = distinct >= 2 && !overlap ? fitLine(group.map((p) => ({ x: p.viewportWidth, y: p.renderedWidth }))) : undefined;
    // The line is checked with the coefficients it is printed with.
    const line = fitted && { a: round(fitted.a, 4), b: round(fitted.b, 2) };
    if (line && line.a > 1e-9) {
      const held = (vw: number) => heldFitAt(line, lo, hi, vw);
      if (group.every((p) => withinTolerance(held(p.viewportWidth), p.renderedWidth))) {
        const top = held(hi);
        const value = formatHeldFit(line, lo, hi);
        return {
          lo,
          hi,
          value: top < widest - 0.5 ? `max(${value}, ${widest}px)` : value,
          basis: "fit",
          condition: "",
        };
      }
    }
    return { lo, hi, value: `${widest}px`, basis: "measured-max", condition: "" };
  });

  // Adjacent branches with the same value are one branch: the media condition would change nothing.
  const merged: SizesBranch[] = [];
  for (const branch of branches) {
    const last = merged[merged.length - 1];
    if (last && last.value === branch.value) {
      last.hi = branch.hi;
      last.basis = weakest([last.basis, branch.basis]);
    } else merged.push({ ...branch });
  }
  merged.forEach((branch, i) => {
    branch.condition = i + 1 < merged.length ? `(max-width: ${breakpointBetween(branch.hi, merged[i + 1].lo)}px)` : "default";
  });
  branches.splice(0, branches.length, ...merged);
  const value =
    branches.length === 1
      ? branches[0].value
      : branches.map((b) => (b.condition === "default" ? b.value : `${b.condition} ${b.value}`)).join(", ");
  return { value, basis: weakest(branches.map((b) => b.basis)), branches };
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
      n.gridSpan === m.gridSpan &&
      n.gap === m.gap &&
      n.flexDirection === m.flexDirection &&
      n.flexBasis === m.flexBasis &&
      n.borderBox === m.borderBox
    );
  });
}
