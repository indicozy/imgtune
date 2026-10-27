import { encode, type EncoderProfile } from "./encode.js";
import { ssim, type RawImage } from "./ssim.js";

/** Test seams: default to the real encoder and SSIM. */
export interface SearchDeps {
  encode?: typeof encode;
  ssim?: typeof ssim;
}

/** Lowest quality the search will consider, per format (in the profile's own quality scale). */
const FLOOR: Record<"avif" | "webp", number> = { avif: 25, webp: 40 };

/**
 * Bisect downward from `start` for the lowest quality whose SSIM stays at or above `threshold`.
 *
 * Sequence: encode `start`; if it fails, return `start` (never raise quality). Otherwise the floor is treated as
 * unknown-but-assumed-failing (the floor itself is not probed, which keeps the encode count within 6 for the
 * 85 -> 25 range at tolerance 5). While `hi - lo > tolerance`, probe `mid = floor((lo + hi) / 2)`: a pass moves `hi`
 * down, a fail moves `lo` up. Returns `hi`, the lowest known passing quality.
 */
export async function minPassingQuality(
  ref: RawImage,
  format: "avif" | "webp",
  start: number,
  profile: EncoderProfile,
  threshold: number,
  tolerance: number,
  deps: SearchDeps = {},
): Promise<number> {
  const enc = deps.encode ?? encode;
  const score = deps.ssim ?? ssim;
  const passes = async (q: number): Promise<boolean> => {
    const { decoded } = await enc(ref, format, q, profile);
    return score(ref, decoded) >= threshold;
  };

  if (!(await passes(start))) return start;

  let hi = start;
  let lo = Math.min(FLOOR[format], start);
  const gap = Math.max(tolerance, 1);
  while (hi - lo > gap) {
    const mid = Math.floor((lo + hi) / 2);
    if (await passes(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Nearest-rank percentile: sort ascending, take the value at index ceil(p * n) - 1. */
export function componentQuality(perSample: number[], percentile = 0.95): number {
  if (perSample.length === 0) throw new Error("componentQuality: no samples");
  const sorted = [...perSample].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  return sorted[index];
}

/**
 * Map a local search result onto the quality the project should use.
 * `next-default`: round up to a multiple of 5 (Next's own scale is used directly by the local stand-in).
 * `cdn`: add the calibrated offset; without an offset there is no change to propose.
 * The result is always clamped to `[1, current]`, so a proposal never raises quality above today's.
 */
export function toTargetQuality(
  localQ: number,
  offset: number | undefined,
  profile: EncoderProfile,
  current: number,
): number | undefined {
  let target: number;
  if (profile === "next-default") {
    target = Math.ceil(localQ / 5) * 5;
  } else {
    if (offset === undefined) return undefined;
    target = localQ + offset;
  }
  return Math.min(current, Math.max(1, target));
}
