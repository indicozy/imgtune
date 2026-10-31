import { encode } from "./encode.js";
import type { SearchDeps } from "./search.js";
import type { RawImage } from "./ssim.js";
import { mapLimit } from "./concurrency.js";

type Format = "avif" | "webp";

/** Median of a list (middle pair averaged for even n); 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface CalibrationSample {
  ref: RawImage;
  format: Format;
  cdnQuality: number;
  cdnBytes: number;
}

/** Encodes in flight during the match: the sharp threadpool's default size. */
const MATCH_CONCURRENCY = 4;

/**
 * Nearest local `cdn` quality to `cdnBytes`: coarse scan 20..100 step 5, then refine +-4 step 1 within 1..100. The sizes
 * of each pass are encoded a few at a time; the best is then taken in the order the qualities are listed, so a tie goes to
 * the earlier one, as a one-by-one scan would have it.
 */
async function matchLocalQuality(ref: RawImage, format: Format, cdnBytes: number, enc: typeof encode): Promise<number> {
  const sizeAt = async (q: number) => (await enc(ref, format, q, "cdn")).bytes;
  let best = 20;
  let bestDiff = Infinity;
  const pick = (qs: number[], sizes: number[]) => {
    qs.forEach((q, i) => {
      const diff = Math.abs(sizes[i] - cdnBytes);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = q;
      }
    });
  };
  const coarseQs: number[] = [];
  for (let q = 20; q <= 100; q += 5) coarseQs.push(q);
  pick(coarseQs, await mapLimit(coarseQs, MATCH_CONCURRENCY, sizeAt));
  const coarse = best;
  // Multiples of 5 were covered by the coarse scan.
  const refineQs: number[] = [];
  for (let q = Math.max(1, coarse - 4); q <= Math.min(100, coarse + 4); q++) {
    if (q % 5 !== 0) refineQs.push(q);
  }
  pick(refineQs, await mapLimit(refineQs, MATCH_CONCURRENCY, sizeAt));
  return best;
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
    const localMatch = await matchLocalQuality(s.ref, s.format, s.cdnBytes, enc);
    offsets.push(s.cdnQuality - localMatch);
  }
  return { offset: Math.round(median(offsets)), n: offsets.length };
}
