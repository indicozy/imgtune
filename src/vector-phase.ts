// The vector phase of a scan: after every page is measured, the flat still rasters of all pages (fix.vector, see
// vector-art.ts) are ranked by their bytes per view, and the heaviest ones within --svg-budget are traced and checked.
// Each unique URL is traced once per run. Its numbers are kept in the result cache, keyed by the content hash, so a
// rescan does not score it again. A passing SVG is written to the scan's svg/ folder. Nothing here throws: a failure
// becomes the record's notChecked reason, and the scan always finishes.

import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { mapLimit } from "./concurrency.js";
import type { ImageRecord } from "./images.js";
import type { PageResult } from "./remote.js";
import { CACHE_VERSION, contentHash, type ResultCache } from "./result-cache.js";
import { measure } from "./timing.js";
import {
  VECTOR_BAR,
  VECTOR_CAP_MS,
  VECTOR_MIN_SAVING,
  VECTORIZER_VERSION,
  loadVectorizer,
  svgBytes,
  svgFidelity,
  traceSvg,
  type VectorFix,
  type VectorNotChecked,
} from "./vector-art.js";

/** The note printed once when the vectorizer is missing: what installing it adds. */
export const VECTOR_NOTE = "install @neplex/vectorizer to check vector art";
/** Images traced at once. */
export const VECTOR_CONCURRENCY = 4;
/** The folder of the traced SVGs, under the scan's folder. */
export const VECTOR_SVG_DIR = "svg";
/** Bumped when the trace settings change, so the cached numbers of the old settings are not read. */
const TRACE_VERSION = "poster-1";

/** What the phase found for one URL. */
export interface VectorOutcome {
  svgBytes?: number;
  score?: number;
  badPixelShare?: number;
  passed?: boolean;
  tracedFile?: string;
  notChecked?: VectorNotChecked;
}

/** The outcomes of one run, by the URL of the image. */
export interface VectorRun {
  byUrl: Map<string, VectorOutcome>;
  /** The note for the run (the missing vectorizer), when there is one. */
  note?: string;
}

export interface VectorPhaseOptions {
  /** --svg-budget: the most URLs traced. 0 traces none. */
  budget: number;
  /** A --survey scan: nothing is traced. */
  survey: boolean;
  /** Quality checks on (not --no-quality): nothing is traced without them. */
  quality: boolean;
  /** The scan's folder, absolute: the svg/ folder is written under it. */
  outDir: string;
  /** The project folder: a traced file is named relative to it. */
  cwd: string;
  cache?: ResultCache;
  log: (line: string) => void;
}

export interface VectorDeps {
  /** The served bytes of a URL, or undefined when they cannot be read. */
  fetch: (url: string) => Promise<Buffer | undefined>;
}

/** The numbers a trace leaves in the cache: no SVG, which is far larger than an entry. */
interface CachedNumbers {
  svgBytes: number;
  score: number;
  badPixelShare: number;
  passed: boolean;
}

const TIMED_OUT = Symbol("timed out");

/**
 * The served bytes of the flat images, as the browser got them, for the vector check: the check traces the file the page
 * used, not a fresh download. Bounded: it keeps the `capacity` largest files seen (the ones the budget would trace), so
 * the memory is the budget times a file, whatever the site has. A URL it does not keep is fetched instead.
 */
export class FlatBuffers {
  private readonly entries = new Map<string, { buffer: Buffer; bytes: number }>();

  constructor(private readonly capacity: number) {}

  /** Keeps `buffer` for `url` when it is among the `capacity` largest seen so far. */
  offer(url: string, buffer: Buffer | undefined, bytes: number): void {
    if (this.capacity <= 0 || buffer === undefined || this.entries.has(url)) return;
    if (this.entries.size < this.capacity) {
      this.entries.set(url, { buffer, bytes });
      return;
    }
    let smallest: string | undefined;
    for (const [key, entry] of this.entries) {
      if (smallest === undefined || entry.bytes < (this.entries.get(smallest)?.bytes ?? Infinity)) smallest = key;
    }
    if (smallest !== undefined && bytes > (this.entries.get(smallest)?.bytes ?? 0)) {
      this.entries.delete(smallest);
      this.entries.set(url, { buffer, bytes });
    }
  }

  get(url: string): Buffer | undefined {
    return this.entries.get(url)?.buffer;
  }
}

/** The bytes per page view of an image: the mean over its viewports. */
export function perViewBytesOf(record: ImageRecord): number {
  return record.perViewport.reduce((sum, p) => sum + p.servedBytes, 0) / Math.max(1, record.perViewport.length);
}

/** The flat images of the pages, one per URL, heaviest first. A record without a URL cannot be traced and is left out. */
function candidatesOf(pages: PageResult[]): { url: string; id: string; perView: number }[] {
  const byUrl = new Map<string, { url: string; id: string; perView: number }>();
  for (const page of pages) {
    for (const record of page.images ?? []) {
      if (record.fix.vector === undefined || record.current.src === undefined) continue;
      const url = record.current.src;
      const perView = perViewBytesOf(record);
      const known = byUrl.get(url);
      if (known === undefined || perView > known.perView) byUrl.set(url, { url, id: known?.id ?? record.id, perView });
    }
  }
  return [...byUrl.values()].sort((a, b) => b.perView - a.perView || a.url.localeCompare(b.url));
}

/** Runs the vector check over the flat images of the pages (see the file comment). */
export async function runVectorPhase(pages: PageResult[], opts: VectorPhaseOptions, deps: VectorDeps): Promise<VectorRun> {
  const byUrl = new Map<string, VectorOutcome>();
  const candidates = candidatesOf(pages);
  if (candidates.length === 0) return { byUrl };
  const skip = opts.survey ? "survey" : !opts.quality ? "quality off" : opts.budget === 0 ? "svg-budget 0" : undefined;
  if (skip !== undefined) {
    for (const c of candidates) byUrl.set(c.url, { notChecked: skip });
    return { byUrl };
  }
  if ((await loadVectorizer()) === undefined) {
    for (const c of candidates) byUrl.set(c.url, { notChecked: "vectorizer not installed" });
    return { byUrl, note: VECTOR_NOTE };
  }
  const chosen = candidates.slice(0, opts.budget);
  for (const c of candidates.slice(opts.budget)) byUrl.set(c.url, { notChecked: "over --svg-budget" });
  opts.log(`vector: tracing ${chosen.length} of ${candidates.length} flat image(s) (--svg-budget ${opts.budget})`);
  const traced = await mapLimit(chosen, VECTOR_CONCURRENCY, async (c) => [c.url, await traceOne(c.url, c.id, opts, deps)] as const);
  for (const [url, outcome] of traced) byUrl.set(url, outcome);
  const passed = traced.filter(([, o]) => o.passed === true).length;
  opts.log(`vector: ${passed} of ${traced.length} traced image(s) pass at SSIMULACRA2 ${VECTOR_BAR} (half size)`);
  return { byUrl };
}

/** One URL: its numbers from the cache, or traced and scored within VECTOR_CAP_MS. Never throws. */
async function traceOne(url: string, id: string, opts: VectorPhaseOptions, deps: VectorDeps): Promise<VectorOutcome> {
  const buffer = await deps.fetch(url).catch(() => undefined);
  if (buffer === undefined) return { notChecked: "trace failed" };
  const key = `vector|${CACHE_VERSION}|${contentHash(buffer)}|${VECTORIZER_VERSION}|${TRACE_VERSION}|bar${VECTOR_BAR}`;
  const cached = await opts.cache?.getJson<CachedNumbers>(key);
  let numbers = isCachedNumbers(cached) ? cached : undefined;
  let svg: string | undefined;
  if (numbers === undefined) {
    // The cap aborts the trace itself (the vectorizer stops, and stops using CPU); the score is dropped with it.
    const controller = new AbortController();
    const traced = await within(
      measure("vector: trace and score", () => measureOne(buffer, controller.signal)),
      VECTOR_CAP_MS,
      controller,
    );
    if (traced === TIMED_OUT) return { notChecked: "timeout" };
    if (traced === undefined) return { notChecked: "trace failed" };
    numbers = traced.numbers;
    svg = traced.svg;
    await opts.cache?.putJson(key, numbers);
  } else if (numbers.passed) {
    // The numbers say it passes, but its file is written from a trace: a trace is cheap, the score is not repeated.
    const controller = new AbortController();
    const traced = await within(traceSvg(buffer, controller.signal), VECTOR_CAP_MS, controller);
    if (traced === TIMED_OUT) return { notChecked: "timeout" };
    if (traced === undefined) return { notChecked: "trace failed" };
    svg = traced;
  }
  const outcome: VectorOutcome = { svgBytes: numbers.svgBytes, score: numbers.score, badPixelShare: numbers.badPixelShare, passed: numbers.passed };
  if (!numbers.passed) return outcome;
  if (svg === undefined) return { notChecked: "trace failed" };
  try {
    const dir = join(opts.outDir, VECTOR_SVG_DIR);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.svg`);
    await writeFileAtomic(file, svg, { root: opts.outDir });
    // Relative to the project folder when the file is inside it; absolute otherwise (a scan into another folder).
    const named = relative(opts.cwd, file);
    return { ...outcome, tracedFile: named.startsWith("..") ? file : named };
  } catch {
    return { notChecked: "trace failed" };
  }
}

/** The trace of an image and its numbers: the SVG, its brotli size, and the fidelity against the served bytes. */
async function measureOne(buffer: Buffer, signal: AbortSignal): Promise<{ svg: string; numbers: CachedNumbers } | undefined> {
  const svg = await traceSvg(buffer, signal);
  if (svg === undefined || signal.aborted) return undefined;
  const bytes = svgBytes(svg);
  const fidelity = await svgFidelity(buffer, svg);
  const passed = fidelity.score >= VECTOR_BAR && bytes <= buffer.length * (1 - VECTOR_MIN_SAVING);
  return { svg, numbers: { svgBytes: bytes, score: Math.round(fidelity.score * 10) / 10, badPixelShare: fidelity.badPixelShare, passed } };
}

/**
 * The value, or TIMED_OUT when it is not ready in `ms` (the controller is then aborted, so the work stops), or undefined when
 * it fails.
 */
async function within<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T | typeof TIMED_OUT | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, ms);
  });
  try {
    return await Promise.race([work.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isCachedNumbers(value: unknown): value is CachedNumbers {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isFinite(v.svgBytes) &&
    Number.isFinite(v.score) &&
    Number.isFinite(v.badPixelShare) &&
    typeof v.passed === "boolean"
  );
}

/**
 * A page with the phase's outcomes written into its flat images' fix.vector. The saving of a passing SVG is the served bytes
 * per view minus the SVG's, averaged over the page's viewports (as the other savings are). The record's claimed saving is
 * the larger of the raster fix and the SVG; the SVG wins only when it is larger, and the raster fix stays as the fallback.
 */
export function applyVector(page: PageResult, run: VectorRun): PageResult {
  const flat = (page.images ?? []).some((record) => record.fix.vector !== undefined);
  if (!flat) return page;
  const viewportCount = Math.max(1, page.viewports.length);
  const images = (page.images ?? []).map((record): ImageRecord => {
    const vector = record.fix.vector;
    if (vector === undefined) return record;
    const outcome = record.current.src !== undefined ? run.byUrl.get(record.current.src) : undefined;
    const next: VectorFix = { ...vector, ...(outcome ?? { notChecked: "trace failed" as const }) };
    if (outcome?.passed === true && outcome.svgBytes !== undefined) {
      const svg = outcome.svgBytes;
      const saved = record.perViewport.reduce((sum, p) => sum + Math.max(0, p.servedBytes - svg), 0) / viewportCount;
      next.savedPerView = Math.round(saved);
      if (saved > record.fix.bytes.saved) {
        next.wins = true;
        return {
          ...record,
          fix: { ...record.fix, vector: next, bytes: { saved: Math.round(saved), addedForSharpness: record.fix.bytes.addedForSharpness } },
        };
      }
    }
    return { ...record, fix: { ...record.fix, vector: next } };
  });
  const hasNote = images.some((record) => record.fix.vector !== undefined);
  return { ...page, images, ...(run.note !== undefined && hasNote ? { vectorNote: run.note } : {}) };
}
