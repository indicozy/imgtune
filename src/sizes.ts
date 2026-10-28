/** A measured rendered image at one viewport width. */
export interface SizePoint {
  viewportWidth: number;
  renderedWidth: number;
  mobile: boolean;
}

/** Mobile/desktop split used in the emitted media query. */
const MOBILE_MAX_WIDTH = 768;
/** Max residual (px) for a mobile/desktop group to count as a linear fit. */
const FIT_TOLERANCE_PX = 2;

interface Line {
  a: number;
  b: number;
}

/** Ordinary least squares of renderedWidth on viewportWidth; null when the fit is degenerate. */
function fitLine(points: SizePoint[]): Line | null {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sx += p.viewportWidth;
    sy += p.renderedWidth;
    sxx += p.viewportWidth * p.viewportWidth;
    sxy += p.viewportWidth * p.renderedWidth;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const a = (n * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / n;
  return { a, b };
}

/** CSS width expression for one group of points (mobile or desktop). */
function expressionFor(points: SizePoint[]): string | undefined {
  if (points.length === 0) return undefined;

  const maxWidth = Math.max(...points.map((p) => p.renderedWidth));
  const distinctViewports = new Set(points.map((p) => p.viewportWidth)).size;
  const line = distinctViewports >= 2 ? fitLine(points) : null;

  if (line) {
    const { a, b } = line;
    const maxResidual = Math.max(...points.map((p) => Math.abs(p.renderedWidth - (a * p.viewportWidth + b))));
    if (maxResidual <= FIT_TOLERANCE_PX) {
      if (a * 100 < 1) return `${Math.round(maxWidth)}px`;
      if (Math.abs(b) < 1) return `${Math.round(a * 100)}vw`;
      return b < 0
        ? `calc(${Math.round(a * 100)}vw - ${Math.round(-b)}px)`
        : `calc(${Math.round(a * 100)}vw + ${Math.round(b)}px)`;
    }
  }

  return `${Math.ceil(maxWidth)}px`;
}

/** The width expression of each media branch; a branch with no measured point is undefined. */
export interface SizeBranches {
  mobile?: string;
  desktop?: string;
}

/**
 * Derives the mobile and desktop width expressions from measured rendered widths across viewports.
 * Points with no rendered width (hidden, unscrolled) are ignored.
 */
export function deriveSizeBranches(points: SizePoint[]): SizeBranches {
  const measured = points.filter((p) => p.renderedWidth >= 1);
  return { mobile: expressionFor(measured.filter((p) => p.mobile)), desktop: expressionFor(measured.filter((p) => !p.mobile)) };
}

/** Joins the branches into one `sizes` value; undefined when neither is set. */
export function joinSizeBranches({ mobile, desktop }: SizeBranches): string | undefined {
  if (mobile && desktop) return `(max-width: ${MOBILE_MAX_WIDTH}px) ${mobile}, ${desktop}`;
  return mobile ?? desktop;
}

/**
 * Derives a `sizes` value from measured rendered widths across viewports.
 * Points with no rendered width (hidden, unscrolled) are ignored; returns undefined when none remain.
 */
export function deriveSizes(points: SizePoint[]): string | undefined {
  return joinSizeBranches(deriveSizeBranches(points));
}

/** A `sizes` value with a supported width, e.g. `33vw`, `280px` or `calc(50vw - 20px)`. */
const WIDTH_RE = /^(\d+(?:\.\d+)?)(px|vw)$/;
const CALC_RE = /^calc\(\s*(\d+(?:\.\d+)?)vw\s*([+-])\s*(\d+(?:\.\d+)?)px\s*\)$/;
/** A leading `(max-width: Npx)` or `(min-width: Npx)` condition of one comma-separated branch. */
const CONDITION_RE = /^\((max|min)-width:\s*(\d+(?:\.\d+)?)px\)\s*/;

interface SizesBranch {
  condition?: { kind: "max" | "min"; px: number };
  value: string;
}

/** The branches of a `sizes` value, or undefined when any branch is outside the supported forms. */
function parseSizes(sizes: string): SizesBranch[] | undefined {
  const branches: SizesBranch[] = [];
  for (const raw of sizes.split(",")) {
    const text = raw.trim();
    const condition = CONDITION_RE.exec(text);
    const value = condition ? text.slice(condition[0].length) : text;
    if (!WIDTH_RE.test(value) && !CALC_RE.test(value)) return undefined;
    branches.push({
      condition: condition ? { kind: condition[1] as "max" | "min", px: Number(condition[2]) } : undefined,
      value,
    });
  }
  return branches.length > 0 ? branches : undefined;
}

/** Whether `sizes` is a value this module understands: comma-separated branches of the supported forms only. */
export function isSizesValue(sizes: string): boolean {
  return parseSizes(sizes) !== undefined;
}

/** The first branch whose condition holds at `viewportWidth`, as its raw width value. */
export function sizesValueAt(sizes: string, viewportWidth: number): string | undefined {
  const branches = parseSizes(sizes);
  if (!branches) return undefined;
  const match = branches.find(({ condition }) => {
    if (!condition) return true;
    return condition.kind === "max" ? viewportWidth <= condition.px : viewportWidth >= condition.px;
  });
  return match?.value;
}

/** The CSS px width the `sizes` value gives at `viewportWidth`; undefined when unsupported or no branch matches. */
export function sizesSlotAt(sizes: string, viewportWidth: number): number | undefined {
  const value = sizesValueAt(sizes, viewportWidth);
  if (value === undefined) return undefined;
  const width = WIDTH_RE.exec(value);
  if (width) return width[2] === "vw" ? (Number(width[1]) / 100) * viewportWidth : Number(width[1]);
  const calc = CALC_RE.exec(value) as RegExpExecArray;
  const base = (Number(calc[1]) / 100) * viewportWidth;
  return Math.max(0, calc[2] === "+" ? base + Number(calc[3]) : base - Number(calc[3]));
}
