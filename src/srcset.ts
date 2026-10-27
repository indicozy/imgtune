/**
 * Predicts which srcset candidate next/image offers for a given `sizes` (or fixed width).
 * Port of `getWidths` in next/dist/shared/lib/get-img-props.js (Next 16.2.6).
 */

export interface NextImageConfig {
  deviceSizes: number[];
  imageSizes: number[];
}

export interface NextCandidates {
  widths: number[];
  /** "w": the browser picks by slot width; "x": the browser picks by device pixel ratio. */
  kind: "w" | "x";
}

export function nextCandidates(
  images: NextImageConfig,
  sizes: string | undefined,
  width?: number,
): NextCandidates {
  const deviceSizes = [...images.deviceSizes].sort((a, b) => a - b);
  const allSizes = [...deviceSizes, ...images.imageSizes].sort((a, b) => a - b);

  if (sizes) {
    const viewportWidthRe = /(^|\s)(1?\d?\d)vw/g;
    const percentSizes: number[] = [];
    for (let match; (match = viewportWidthRe.exec(sizes)); ) {
      percentSizes.push(parseInt(match[2]));
    }
    if (percentSizes.length) {
      const smallestRatio = Math.min(...percentSizes) * 0.01;
      return {
        widths: allSizes.filter((s) => s >= deviceSizes[0] * smallestRatio),
        kind: "w",
      };
    }
    return { widths: allSizes, kind: "w" };
  }

  if (typeof width !== "number") {
    return { widths: deviceSizes, kind: "w" };
  }

  const widths = [...new Set([width, width * 2].map((w) => allSizes.find((p) => p >= w) || allSizes[allSizes.length - 1]))];
  return { widths, kind: "x" };
}

/** The candidate widths next/image may offer for these props. */
export function nextWidths(images: NextImageConfig, sizes: string | undefined, width?: number): number[] {
  return nextCandidates(images, sizes, width).widths;
}

/** For `kind: "x"` candidates the browser picks by DPR: the 1x entry, or the 2x entry on high-DPR screens. */
export function pickForX(widths: number[], dpr: number): number {
  return widths[dpr >= 2 && widths.length > 1 ? 1 : 0];
}

/** For `kind: "w"` candidates: smallest width >= slotCssPx * dpr, else the largest. */
export function pickCandidate(widths: number[], slotCssPx: number, dpr: number): number {
  if (widths.length === 0) throw new RangeError("pickCandidate: no candidate widths");
  const sorted = [...widths].sort((a, b) => a - b);
  const target = slotCssPx * dpr;
  return sorted.find((w) => w >= target) ?? sorted[sorted.length - 1];
}
