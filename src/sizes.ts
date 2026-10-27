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

/**
 * Derives a `sizes` value from measured rendered widths across viewports.
 * Points with no rendered width (hidden, unscrolled) are ignored; returns undefined when none remain.
 */
export function deriveSizes(points: SizePoint[]): string | undefined {
  const measured = points.filter((p) => p.renderedWidth >= 1);
  const mobile = expressionFor(measured.filter((p) => p.mobile));
  const desktop = expressionFor(measured.filter((p) => !p.mobile));

  if (mobile && desktop) return `(max-width: ${MOBILE_MAX_WIDTH}px) ${mobile}, ${desktop}`;
  return mobile ?? desktop;
}
