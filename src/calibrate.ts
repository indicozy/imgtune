import { encode } from "./encode.js";
import type { SearchDeps } from "./search.js";
import type { RawImage } from "./ssim.js";
import { mapLimit } from "./concurrency.js";
import { count } from "./timing.js";

type Format = "avif" | "webp";

/** Median of a list (middle pair averaged for even n); 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The bytes of the local `cdn` encode of `ref` at each quality, by the encoder given (counted as calibration encodes). */
export function encodedSizeAt(ref: RawImage, format: Format, enc: typeof encode): SizeAt {
  return async (q) => {
    count("calibrate encodes");
    return (await enc(ref, format, q, "cdn")).bytes;
  };
}

export interface CalibrationSample {
  ref: RawImage;
  format: Format;
  cdnQuality: number;
  cdnBytes: number;
}

/** Encodes in flight during the match: the sharp threadpool's default size. */
const MATCH_CONCURRENCY = 4;
/** The coarse pass: qualities 20, 25, ..., 100. */
const COARSE: readonly number[] = Array.from({ length: 17 }, (_, i) => 20 + 5 * i);

/** The refine pass for a coarse best `c`: the qualities within 4 of it that the coarse pass did not cover. */
export function refineQualities(c: number): number[] {
  const out: number[] = [];
  for (let q = Math.max(1, c - 4); q <= Math.min(100, c + 4); q++) {
    if (q % 5 !== 0) out.push(q);
  }
  return out;
}

/** The bytes of the local `cdn` encode of one reference at a quality. */
export type SizeAt = (q: number) => Promise<number>;

/** Bytes at each quality, memoised for one match: each quality is looked up at most once. */
class Sizes {
  private readonly known = new Map<number, number>();

  constructor(private readonly encodeAt: SizeAt) {}

  get(q: number): number | undefined {
    return this.known.get(q);
  }

  /** Encodes the qualities not yet known, a few at a time. */
  async ensure(qs: readonly number[]): Promise<void> {
    const missing = qs.filter((q, i) => !this.known.has(q) && qs.indexOf(q) === i);
    const sizes = await mapLimit(missing, MATCH_CONCURRENCY, (q) => this.encodeAt(q));
    missing.forEach((q, i) => this.known.set(q, sizes[i]));
  }
}

/** The one-by-one nearest: the lowest-index quality of `qs` whose bytes are closest to `target` (ties to the earlier). */
async function nearestExhaustive(qs: readonly number[], target: number, sizes: Sizes): Promise<{ q: number; diff: number }> {
  await sizes.ensure(qs);
  let best = qs[0];
  let bestDiff = Infinity;
  for (const q of qs) {
    const diff = Math.abs((sizes.get(q) as number) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = q;
    }
  }
  return { q: best, diff: bestDiff };
}

/** Up to `width` probe indices splitting [a, b] into equal parts (all of them when the range is that small). */
function probesIn(a: number, b: number, width: number): number[] {
  const len = b - a + 1;
  if (len <= width) return Array.from({ length: len }, (_, i) => a + i);
  return Array.from({ length: width }, (_, j) => a + Math.floor(((j + 1) * len) / (width + 1)));
}

/**
 * The nearest quality of `qs` (ascending) to `target` by bytes, reproducing nearestExhaustive. Bytes are assumed not to
 * fall as quality rises, so the first quality at or above `target` is found by a parallel search (MATCH_CONCURRENCY
 * probes a round), and the answer is that one or the one just below it, with ties to the lower quality. Probes that
 * contradict the assumption (bytes falling along `qs`) make the result `verified: false`: the caller then scans all of
 * `qs`, as before.
 */
async function nearestAlongMonotone(
  qs: readonly number[],
  target: number,
  sizes: Sizes,
): Promise<{ q: number; diff: number; verified: boolean }> {
  const n = qs.length;
  const bytesAt = (i: number): number => sizes.get(qs[i]) as number;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const probes = probesIn(lo, hi - 1, MATCH_CONCURRENCY);
    await sizes.ensure(probes.map((i) => qs[i]));
    let nextLo = lo;
    let nextHi = hi;
    for (const i of probes) {
      if (bytesAt(i) >= target) nextHi = Math.min(nextHi, i);
      else nextLo = Math.max(nextLo, i + 1);
    }
    if (nextLo > nextHi) return { q: qs[0], diff: Infinity, verified: false };
    lo = nextLo;
    hi = nextHi;
  }
  // lo is the first index with bytes >= target (n: none). Its neighbour below, lo - 1, was probed below target.
  const upper = lo < n ? lo : undefined;
  const lower = lo > 0 ? lo - 1 : undefined;
  let pick: number;
  let diff: number;
  if (upper !== undefined && (lower === undefined || bytesAt(upper) - target < target - bytesAt(lower))) {
    // The upper one is the lowest index of its bytes: every lower index is below the target.
    pick = upper;
    diff = bytesAt(upper) - target;
  } else {
    // The lower one wins (or ties). The lower one is defined here: with no upper one, the lower one is the last quality.
    const at = bytesAt(lower as number);
    pick = lower as number;
    if (pick > 0) {
      // A tie with an equal-bytes quality below it goes to the lowest of them, so find where that run of bytes starts.
      await sizes.ensure([qs[pick - 1]]);
      if (bytesAt(pick - 1) === at) {
        let a = 0;
        let b = pick;
        while (a < b) {
          const mid = (a + b) >> 1;
          await sizes.ensure([qs[mid]]);
          if (bytesAt(mid) >= at) b = mid;
          else a = mid + 1;
        }
        pick = a;
      }
    }
    diff = target - at;
  }
  // Every probe must agree with the assumption: sorted by quality, the bytes must not fall.
  const known = qs.map((q, i) => [i, sizes.get(q)] as const).filter(([, s]) => s !== undefined);
  for (let i = 1; i < known.length; i++) {
    if ((known[i][1] as number) < (known[i - 1][1] as number)) return { q: qs[pick], diff, verified: false };
  }
  return { q: qs[pick], diff, verified: true };
}

/**
 * Nearest local `cdn` quality to `cdnBytes`: coarse scan 20..100 step 5, then refine +-4 step 1 within 1..100. The
 * qualities of each pass are searched in parallel rather than all encoded (see nearestAlongMonotone); a tie goes to the
 * earlier quality (coarse before refine, lower before higher), as a one-by-one scan would have it.
 */
export async function matchLocalQuality(sizeAt: SizeAt, cdnBytes: number): Promise<number> {
  const sizes = new Sizes(sizeAt);
  const coarse = await nearestAlongMonotone(COARSE, cdnBytes, sizes);
  if (!coarse.verified) return (await matchLocalQualityExhaustive(sizeAt, cdnBytes)).q;
  const c = coarse.q;
  const refine = await nearestAlongMonotone(refineQualities(c), cdnBytes, sizes);
  if (!refine.verified) return (await matchLocalQualityExhaustive(sizeAt, cdnBytes)).q;
  // The refine pass replaces the coarse best only when strictly closer.
  return refine.diff < coarse.diff ? refine.q : c;
}

/**
 * The match of matchLocalQuality, found from a guess `start` at another encoder's bytes and confirmed by probes of the
 * encoder given: the search walks from `start` to the two qualities that bracket the target (the bytes below it at one,
 * at or above it at the next). Under the monotone assumption the match is then the nearer of the two (a tie goes to the
 * lower), which is what matchLocalQuality returns. Undefined when the walk takes more than `maxSteps` steps, when the
 * pick is below 16 (matchLocalQuality searches only 16 to 24 around its coarse point 20, so a lower match is not its
 * answer), or when the pick has an equal-bytes neighbour (a tie that matchLocalQuality breaks by its coarse point): the
 * caller must run the full match then.
 */
export async function confirmMatch(start: number, sizeAt: SizeAt, cdnBytes: number, maxSteps = 4): Promise<number | undefined> {
  const memo = new Map<number, Promise<number>>();
  const bytesAt = (q: number) => {
    let value = memo.get(q);
    if (value === undefined) {
      value = sizeAt(q);
      memo.set(q, value);
    }
    return value;
  };
  let q = Math.min(100, Math.max(2, start));
  let steps = 0;
  // Walk to the bracket: lower = bytes at q - 1 (below the target), upper = bytes at q (at or above it).
  while ((await bytesAt(q)) < cdnBytes) {
    if (q >= 100 || ++steps > maxSteps) return undefined;
    q++;
  }
  while ((await bytesAt(q - 1)) >= cdnBytes) {
    if (q - 1 < 2 || ++steps > maxSteps) return undefined;
    q--;
  }
  const upper = await bytesAt(q);
  const lower = await bytesAt(q - 1);
  const pick = upper - cdnBytes < cdnBytes - lower ? q : q - 1;
  // A pick on a flat run (equal bytes next to it) is a tie that matchLocalQuality breaks by its coarse point: the full match.
  if (pick < 16 || pick > 99) return undefined;
  const bytesPick = pick === q ? upper : lower;
  if ((await bytesAt(pick - 1)) === bytesPick || (await bytesAt(pick + 1)) === bytesPick) return undefined;
  return pick;
}

/** The previous match: every coarse and refine quality is encoded and the nearest is taken. Used when the search cannot verify. */
export async function matchLocalQualityExhaustive(sizeAt: SizeAt, cdnBytes: number): Promise<{ q: number; diff: number }> {
  const sizes = new Sizes(sizeAt);
  const coarse = await nearestExhaustive(COARSE, cdnBytes, sizes);
  const refine = await nearestExhaustive(refineQualities(coarse.q), cdnBytes, sizes);
  return refine.diff < coarse.diff ? refine : coarse;
}

/**
 * Median offset between the CDN's quality and the local `cdn`-profile quality that gives the same byte size.
 * `offset_i = cdnQuality_i - localMatch_i`; the result is the median, rounded. Returns `undefined` when there are
 * no samples.
 */
export async function calibrationOffset(
  samples: CalibrationSample[],
  deps: SearchDeps = {},
): Promise<{ offset: number; n: number } | undefined> {
  if (samples.length === 0) return undefined;
  const enc = deps.encode ?? encode;
  const offsets: number[] = [];
  for (const s of samples) {
    const localMatch = await matchLocalQuality(encodedSizeAt(s.ref, s.format, enc), s.cdnBytes);
    offsets.push(s.cdnQuality - localMatch);
  }
  return { offset: Math.round(median(offsets)), n: offsets.length };
}
