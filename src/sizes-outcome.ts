// The predicted outcome of a proposed `sizes` value, per viewport: the srcset candidate the browser would pick under the
// proposed sizes (the smallest candidate at or above the device pixels the proposed width needs) against the file that is
// served now. A sizes proposal whose outcome costs at least as many bytes as it saves, on images that were not undersized,
// is not a saving: it is dropped and the record says why ("no saving: ..."). Bytes of the candidates come from the scan's
// fetcher (each URL once). Pure apart from the bytes callback; mutates the records' fix.

import { rightCandidate } from "./remote.js";
import { sizesSlotAt } from "./sizes.js";
import type { ImageRecord } from "./images.js";

/** The bytes of a candidate file (undefined when it cannot be read): the scan's fetcher, or a test double. */
export type BytesOf = (url: string) => Promise<number | undefined>;

/** The outcome of one proposed sizes value over the viewports the image rendered at. */
export interface SizesOutcome {
  /** Bytes per view the proposed sizes save (served file bigger than the proposed choice), summed and divided by the views. */
  saved: number;
  /** Bytes per view the proposed sizes add on images that were not undersized before (no sharpness fix to pay for them). */
  grew: number;
  /** The viewports where the proposed sizes pick a larger file on an image that was not undersized. */
  biggerAt: string[];
  /** The viewports where the proposed sizes pick a larger file on an undersized image: a sharpness fix, kept. */
  sharpAt: string[];
}

/**
 * The proposed sizes' outcome for one record. Undefined when a viewport cannot be judged (no decoded size of the served file,
 * no parsed srcset, or a candidate that cannot be read): the record then keeps the numbers the scan measured.
 */
export async function sizesOutcomeOf(
  record: ImageRecord,
  widths: Map<string, number>,
  viewportCount: number,
  bytesOf: BytesOf,
): Promise<SizesOutcome | undefined> {
  const proposed = record.fix.sizes?.value;
  const candidates = record.current.srcsetCandidates;
  if (proposed === undefined || candidates.length < 2) return undefined;
  let saved = 0;
  let grew = 0;
  const biggerAt: string[] = [];
  const sharpAt: string[] = [];
  for (const p of record.perViewport) {
    if (p.renderedCssPx <= 0 || p.skipped !== undefined || p.servedPx === undefined || !(p.servedBytes > 0)) continue;
    const vw = widths.get(p.viewport);
    if (vw === undefined) return undefined;
    const slot = sizesSlotAt(proposed, vw);
    if (slot === undefined) return undefined;
    const chosen = rightCandidate(candidates, Math.ceil(slot * p.dpr));
    // The file served now is the candidate of the served width; the same width is the same file.
    if (chosen.width === p.servedPx) continue;
    const bytes = await bytesOf(chosen.url);
    if (bytes === undefined) return undefined;
    if (bytes < p.servedBytes) saved += p.servedBytes - bytes;
    else if (bytes > p.servedBytes) {
      if (p.undersized) sharpAt.push(p.viewport);
      else {
        grew += bytes - p.servedBytes;
        biggerAt.push(p.viewport);
      }
    }
  }
  return { saved: saved / viewportCount, grew: grew / viewportCount, biggerAt, sharpAt };
}

/**
 * Applies the predicted outcome to each record that proposes a changed sizes value. A proposal that saves more than it adds
 * keeps its saving (the sizes part is the predicted one; the quality part is unchanged). A proposal that adds at least as
 * many bytes as it saves, or saves nothing, is dropped: its `fix.sizes` is removed and `fix.noSaving` says why.
 */
export async function applySizesOutcome(
  records: ImageRecord[],
  widths: Map<string, number>,
  viewportCount: number,
  bytesOf: BytesOf,
): Promise<void> {
  for (const record of records) {
    const fix = record.fix;
    if (fix.sizes === undefined || fix.sizes.value === record.current.sizes) continue;
    const outcome = await sizesOutcomeOf(record, widths, viewportCount, bytesOf);
    if (outcome === undefined) continue;
    const quality = fix.bytes.quality ?? 0;
    // A sharpness fix (the larger file is for an undersized image) is kept whatever its bytes: its cost is the sharpness bytes.
    const sharp = outcome.sharpAt.length > 0;
    if (sharp || (outcome.saved > outcome.grew && outcome.saved > 0)) {
      fix.bytes = { ...fix.bytes, sizes: outcome.saved, quality, saved: outcome.saved + quality };
      if (outcome.grew > 0) {
        record.evidence.notes.push(
          `sizes: the proposed value saves ${Math.round(outcome.saved)} B/view and adds ${Math.round(outcome.grew)} B/view at ${outcome.biggerAt.join(", ")} (not a sharpness fix; reported, not netted)`,
        );
      }
      continue;
    }
    const reason =
      outcome.grew > 0
        ? `no saving: proposed sizes ${fix.sizes.value} picks larger candidates at ${outcome.biggerAt.join(", ")}`
        : `no saving: proposed sizes ${fix.sizes.value} pick files of the same size as now`;
    delete fix.sizes;
    fix.noSaving = reason;
    fix.bytes = { ...fix.bytes, saved: quality, sizes: 0, quality };
    record.evidence.notes.push(reason);
  }
}
