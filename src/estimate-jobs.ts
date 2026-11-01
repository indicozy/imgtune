// The estimate jobs of a scan run: the local resize estimates (est.) of plain images and CSS backgrounds, and the quality
// samples (est.), are computed once per unique job across the whole run, not once per page. A scan has two phases. In the
// first, every page is measured and its estimate requests are collected here (EstimateRegistry.collector): a request is a
// key (what the estimate depends on: the image's content hash or URL, the width, the format, ...) and the job that computes
// it. Then every unique job runs once (EstimateRegistry.run), and each page reads its results back (reader) and is
// analysed again with them, so the numbers are those of a page analysed alone. A job whose largest possible saving is
// under ESTIMATE_MIN_SAVING_BYTES is not run at all.

import { mapLimit } from "./concurrency.js";
import { countGpuFallbacks } from "./gpu.js";
import { contentHash } from "./result-cache.js";

/**
 * A job whose largest possible saving is under this many bytes is not run. An estimate never saves more than the bytes of
 * the file it acts on (a resize or a re-encode of it), so a file this small cannot save this much; the job is counted as
 * skipped instead.
 */
export const ESTIMATE_MIN_SAVING_BYTES = 2048;

/**
 * Where a page reads its estimates from. The collector stores the request and returns undefined (the page's numbers are
 * provisional); the reader returns the job's result, or undefined when there is none (skipped, failed, or never requested).
 */
export interface EstimateStore {
  get<T>(key: string, maxSaving: number, job: () => Promise<T>): Promise<T | undefined>;
  /** An intermediate result shared by the jobs of the run (see EstimateRegistry.memo). */
  memo<T>(key: string, compute: () => Promise<T>): Promise<T>;
}

/** Counts of the run's estimate jobs: the requests of all pages, the unique jobs they name, and the unique jobs skipped. */
export interface EstimateCounts {
  requests: number;
  unique: number;
  skipped: number;
}

interface Job {
  maxSaving: number;
  run: () => Promise<unknown>;
}

interface Outcome {
  value: unknown;
  fallbacks: number;
}

const hashes = new WeakMap<Buffer, string>();

/** The content hash of a buffer, computed once per buffer object. */
export function hashOf(buffer: Buffer): string {
  let hash = hashes.get(buffer);
  if (hash === undefined) {
    hash = contentHash(buffer);
    hashes.set(buffer, hash);
  }
  return hash;
}

export class EstimateRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly outcomes = new Map<string, Outcome>();
  private readonly memos = new Map<string, Promise<unknown>>();
  private requests = 0;
  private skipped = 0;
  private ran = false;

  /** The store of a page being measured: it records the request and gives no value yet. The first request of a key names its job. */
  collector(): EstimateStore {
    return {
      get: async <T>(key: string, maxSaving: number, job: () => Promise<T>): Promise<T | undefined> => {
        if (this.ran) throw new Error("EstimateRegistry: a request after the jobs ran");
        this.requests++;
        if (!this.jobs.has(key)) this.jobs.set(key, { maxSaving, run: job });
        return undefined;
      },
      memo: <T>(key: string, compute: () => Promise<T>): Promise<T> => this.memo(key, compute),
    };
  }

  /**
   * The store of a page being analysed after the jobs ran: it reads the results of its keys. Each key it reads adds the
   * CPU fallbacks of that job to `tally` (the page's own count of them, see countGpuFallbacks).
   */
  reader(tally: { fallbacks: number }): EstimateStore {
    return {
      get: async <T>(key: string): Promise<T | undefined> => {
        const outcome = this.outcomes.get(key);
        if (outcome === undefined) return undefined;
        tally.fallbacks += outcome.fallbacks;
        return outcome.value as T | undefined;
      },
      memo: <T>(key: string, compute: () => Promise<T>): Promise<T> => this.memo(key, compute),
    };
  }

  /**
   * Shares one intermediate result of several jobs (such as a bisection over the same file) across them: `compute` runs
   * once per key for the whole run.
   */
  memo<T>(key: string, compute: () => Promise<T>): Promise<T> {
    let pending = this.memos.get(key);
    if (pending === undefined) {
      pending = compute();
      this.memos.set(key, pending);
    }
    return pending as Promise<T>;
  }

  /** Runs every collected job once, `limit` at a time. A job under the threshold is skipped; a job that throws gives no value. */
  async runJobs(limit: number): Promise<void> {
    this.ran = true;
    const list = [...this.jobs.entries()];
    await mapLimit(list, limit, async ([key, job]) => {
      if (job.maxSaving < ESTIMATE_MIN_SAVING_BYTES) {
        this.skipped++;
        return;
      }
      const run = await countGpuFallbacks(() => job.run().catch(() => undefined));
      this.outcomes.set(key, { value: run.value, fallbacks: run.fallbacks });
    });
  }

  counts(): EstimateCounts {
    return { requests: this.requests, unique: this.jobs.size, skipped: this.skipped };
  }
}

/**
 * Analyses with the run's estimates: `analyse` runs once to collect the requests of its jobs, the jobs run once each, and
 * `analyse` runs again to read the results. For one page (a single scan or a test) this is the two phases of a whole run.
 * Also gives the CPU fallbacks of the jobs it read.
 */
export async function withEstimates<T>(analyse: (store: EstimateStore) => Promise<T>, limit: number): Promise<{ value: T; fallbacks: number }> {
  const registry = new EstimateRegistry();
  await analyse(registry.collector());
  await registry.runJobs(limit);
  const tally = { fallbacks: 0 };
  const value = await analyse(registry.reader(tally));
  return { value, fallbacks: tally.fallbacks };
}

/** The buffer of `pool` with the same bytes as `buffer` (the first one kept), so one file held by many pages is held once. */
export function internBuffer(pool: Map<string, Buffer>, buffer: Buffer): Buffer {
  const hash = hashOf(buffer);
  const found = pool.get(hash);
  if (found !== undefined) return found;
  pool.set(hash, buffer);
  return buffer;
}
