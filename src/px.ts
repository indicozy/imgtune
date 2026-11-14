// Whole-px rounding of a proposed sizes value. A fitted length is rounded in the direction that keeps the chosen srcset
// candidate covering the need: a length up, a plus offset up, and a minus offset down in magnitude (so the value is not
// below the fit). A `sizes` value like 190.04px is never printed.

/** A px length as whole px, rounded up (190.04 -> 191). */
export function wholePx(px: number): number {
  return Math.ceil(px - 1e-9);
}

/** A signed px offset of a calc(): a plus offset rounded up, a minus offset rounded down in magnitude. */
export function offsetPx(b: number): number {
  return b < 0 ? -Math.floor(-b + 1e-9) : Math.ceil(b - 1e-9);
}
