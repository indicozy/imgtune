import { encode, type EncoderProfile } from "./encode.js";
import type { Scorer } from "./metric.js";
import { ssim, type RawImage } from "./ssim.js";
import { count } from "./timing.js";

/**
 * Test seams: the real encoder, and the plain SSIM as scorer. Production passes the configured metric's scorer.
 */
export interface SearchDeps {
  encode?: typeof encode;
  score?: Scorer;
  /**
   * The score of the local encode at a quality, when the caller has it already (the result cache). Set, it replaces the
   * encode-and-score of each probe; the probes and their order are the same either way.
   */
  scoreAt?: (quality: number) => Promise<number>;
}

/** Lowest quality the search will consider, per format (in the profile's own quality scale). */
const FLOOR: Record<"avif" | "webp", number> = { avif: 25, webp: 40 };

/** What a bisection found: its quality, the window's failing end, and whether its start passed. */
export interface BisectResult {
  /** The lowest known passing quality (the start when the start itself fails). */
  quality: number;
  /** The window's failing end: a quality probed and failed. Undefined when none failed (the floor is assumed failing). */
  failed?: number;
  /** False when the start failed: the search returned it without probing anything below. */
  startPassed: boolean;
}

/**
 * Bisect downward from `start` for the lowest quality whose score stays at or above `threshold` (on the metric's scale).
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
  return (await bisectQuality(ref, format, start, profile, threshold, tolerance, deps)).quality;
}

/**
 * The bisection of minPassingQuality, with the window it ends in (see BisectResult). The probes and their order are the
 * same; the window tells a caller which two qualities decided the answer, so a search at another effort can be checked
 * at those two only (see confirmBisect).
 */
export async function bisectQuality(
  ref: RawImage,
  format: "avif" | "webp",
  start: number,
  profile: EncoderProfile,
  threshold: number,
  tolerance: number,
  deps: SearchDeps = {},
): Promise<BisectResult> {
  const enc = deps.encode ?? encode;
  const score = deps.score ?? ssim;
  const passes = async (q: number): Promise<boolean> => {
    count("bisect probes");
    if (deps.scoreAt) return (await deps.scoreAt(q)) >= threshold;
    const { decoded } = await enc(ref, format, q, profile);
    return (await score(ref, decoded)) >= threshold;
  };
  count("bisect searches");

  if (!(await passes(start))) return { quality: start, startPassed: false };

  let hi = start;
  let lo = Math.min(FLOOR[format], start);
  let failed: number | undefined;
  const gap = Math.max(tolerance, 1);
  while (hi - lo > gap) {
    const mid = Math.floor((lo + hi) / 2);
    if (await passes(mid)) hi = mid;
    else {
      lo = mid;
      failed = mid;
    }
  }
  return { quality: hi, failed, startPassed: true };
}

/**
 * Whether a bisection's answer also holds for another encoder, given `passes`, its pass/fail at a quality. The answer
 * is the same when the other encoder's outcomes are the same at the two qualities that decided it: the start (when it
 * failed), otherwise the answer passes and the window's failing end (when one was probed) fails. Under the monotone
 * assumption the bisection makes, every other probe of the path then gives the same outcome too.
 */
export async function confirmBisect(result: BisectResult, passes: (quality: number) => Promise<boolean>): Promise<boolean> {
  if (!result.startPassed) return !(await passes(result.quality));
  if (!(await passes(result.quality))) return false;
  return result.failed === undefined || !(await passes(result.failed));
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
