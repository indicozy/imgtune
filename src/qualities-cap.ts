// The `images.qualities` cap (next/image). Every quality value a next/image usage asks for must be listed in
// next.config's `images.qualities`, and each listed value multiplies the cached variants. This clusters the per-image
// quality targets of a scan's next/image images, across its pages, into at most N values. A target is mapped UP to the
// smallest chosen value that is not below it, so the SSIMULACRA2 bar the target was found at still holds.
// Pure: no measurement. The est. quality saving of a mapped image is scaled, not re-estimated, and marked approx.

import type { ImageRecord } from "./images.js";
import type { PageResult } from "./remote.js";

export const DEFAULT_MAX_QUALITIES = 2;
export const MIN_MAX_QUALITIES = 1;
export const MAX_MAX_QUALITIES = 4;
/** The loader name of next/image in the scan records (locate.ts loaderName). */
export const NEXT_LOADER = "next-default";

/** One image as the cap sees it: its current quality, its target, and the est. quality saving per view at the target. */
export interface QualityCapUnit {
  id: string;
  /** The quality the image is served at now (next/image's `q`, or the default 75). */
  current: number;
  /** The quality the image's group needs (the max of its scored targets, per served format). */
  target: number;
  /** The est. quality saving per page view at `target`, in bytes. */
  saved: number;
}

/**
 * The est. quality saving of an image at the quality `value` it is capped to (never below its target). At the target it is
 * the measured saving. Between the target and the current quality the bytes are taken as linear: saved * (current - value)
 * / (current - target). Above the current quality the image is raised, and the same line gives a negative saving (the
 * bytes it adds). An image whose target is its current quality has no quality saving beyond its target.
 */
export function savedAt(unit: Pick<QualityCapUnit, "current" | "target" | "saved">, value: number): number {
  if (value < unit.target) return 0;
  if (value === unit.target) return unit.saved;
  if (unit.current <= unit.target) return 0;
  return (unit.saved * (unit.current - value)) / (unit.current - unit.target);
}

/** The smallest chosen value that is not below `target`. `values` is sorted ascending and its last value is >= every target. */
export function finalQuality(unit: Pick<QualityCapUnit, "target">, values: number[]): number {
  return values.find((v) => v >= unit.target) ?? values[values.length - 1];
}

/** Every combination of `k` items, in order. */
function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i <= items.length - k; i++) {
    for (const rest of combinations(items.slice(i + 1), k - 1)) out.push([items[i], ...rest]);
  }
  return out;
}

/** The units that share a current quality and a target, with their savings summed (the saving is linear in it). */
interface QualityPair {
  current: number;
  target: number;
  saved: number;
}

function pairsOf(units: QualityCapUnit[]): QualityPair[] {
  const byKey = new Map<string, QualityPair>();
  for (const u of units) {
    const key = `${u.current}|${u.target}`;
    const pair = byKey.get(key) ?? { current: u.current, target: u.target, saved: 0 };
    pair.saved += u.saved;
    byKey.set(key, pair);
  }
  return [...byKey.values()];
}

export interface QualityCapResult {
  /** The chosen values, ascending: the `images.qualities` list. Its largest value is the largest target. */
  values: number[];
  /** The value an image is capped to (see finalQuality). */
  finalFor: (unit: Pick<QualityCapUnit, "target">) => number;
  /** The est. quality saving kept (net of any raise), and the total at the per-image targets. */
  kept: number;
  total: number;
}

/**
 * The list of at most `maxValues` qualities that keeps the most est. saving. The candidates are the distinct targets, so
 * every value is one a group asked for; the largest target is always in the list, so every image has a value to map up
 * to. Ties keep the smaller list, then the lower values. Undefined without units.
 */
export function capQualities(units: QualityCapUnit[], maxValues: number): QualityCapResult | undefined {
  if (units.length === 0) return undefined;
  const limit = Math.max(MIN_MAX_QUALITIES, Math.min(MAX_MAX_QUALITIES, Math.floor(maxValues)));
  const pairs = pairsOf(units);
  const targets = [...new Set(units.map((u) => u.target))].sort((a, b) => a - b);
  const top = targets[targets.length - 1];
  const others = targets.slice(0, -1);
  let best: { chosen: number[]; kept: number } | undefined;
  for (let k = 1; k <= Math.min(limit, targets.length); k++) {
    for (const combo of combinations(others, k - 1)) {
      const chosen = [...combo, top];
      const kept = pairs.reduce((sum, p) => sum + savedAt(p, finalQuality(p, chosen)), 0);
      // Strictly better only: among ties the first found wins (the smaller list, then the lower values).
      if (best === undefined || kept > best.kept + 1e-9) best = { chosen, kept };
    }
  }
  if (best === undefined) return undefined;
  const chosen = best.chosen;
  return {
    values: chosen,
    finalFor: (unit) => finalQuality(unit, chosen),
    kept: best.kept,
    total: units.reduce((sum, u) => sum + u.saved, 0),
  };
}

/** The plan of a site: the list, and for each next/image record that has a target, the value it moves to and its est. saving. */
export interface QualityCapPlan {
  values: number[];
  /** Per record id: the value the image is capped to, the raw target it came from, and its scaled est. quality saving. */
  byRecord: Map<string, { to: number; from: number; saved: number }>;
  /** The records the cap covered (next/image images with a target). */
  images: number;
  /** Est. quality saving per view kept by the cap, and the same at the per-image targets (bytes). */
  kept: number;
  total: number;
  maxValues: number;
}

/** The next/image records of a scan's pages that the cap covers: a target and a current quality. */
function unitsOf(results: PageResult[]): { units: QualityCapUnit[]; ids: string[] } {
  const units: QualityCapUnit[] = [];
  const ids: string[] = [];
  for (const result of results) {
    // A page that did not measure (blocked, failed, broken) has no records to cap.
    if (result.status !== undefined && result.status !== "ok") continue;
    for (const record of result.images ?? []) {
      const unit = unitOf(record);
      if (unit !== undefined) {
        units.push(unit);
        ids.push(record.id);
      }
    }
  }
  return { units, ids };
}

/** One record as a unit: a next/image image (not a CSS background) with a current quality and a target for its format. */
export function unitOf(record: ImageRecord): QualityCapUnit | undefined {
  if (record.kind === "css-background" || record.locator.loader !== NEXT_LOADER) return undefined;
  const served = record.current.format;
  const current = record.current.quality;
  const target = served !== undefined ? record.fix.quality?.perFormat[served] : undefined;
  if (current === undefined || target === undefined) return undefined;
  // The quality part of the saving: the record's own, or what the saving has beyond the sizes part.
  const quality = record.fix.bytes.quality ?? record.fix.bytes.saved - (record.fix.bytes.sizes ?? 0);
  return { id: record.id, current, target, saved: Math.max(0, quality) };
}

/**
 * The site-level plan over a scan's pages: at most `maxValues` values (default 2, 1 to 4), and each next/image record
 * mapped to one of them. Undefined when no page has a next/image image with a quality target.
 */
export function planQualityCap(results: PageResult[], maxValues: number = DEFAULT_MAX_QUALITIES): QualityCapPlan | undefined {
  const { units, ids } = unitsOf(results);
  const cap = capQualities(units, maxValues);
  if (cap === undefined) return undefined;
  const byRecord = new Map<string, { to: number; from: number; saved: number }>();
  let kept = 0;
  units.forEach((unit, i) => {
    const to = cap.finalFor(unit);
    const saved = savedAt(unit, to);
    kept += saved;
    byRecord.set(ids[i], { to, from: unit.target, saved });
  });
  return { values: cap.values, byRecord, images: units.length, kept, total: cap.total, maxValues };
}

/** The site-level hint line: `next.config: images.qualities: [75, 90]`, with the share of est. saving kept. */
export function qualitiesLine(plan: QualityCapPlan): string {
  const head = `next.config: images.qualities: [${plan.values.join(", ")}]  (at most ${plan.maxValues} value(s) for ${plan.images} next/image image(s)`;
  if (plan.total <= 0) return `${head})`;
  const share = Math.round((100 * plan.kept) / plan.total);
  return `${head}; approx. est. kept ${share}% of the per-image quality saving)`;
}
