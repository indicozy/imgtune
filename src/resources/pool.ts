// A bounded pool for the resource jobs of a scan. A job is started in phase 1 (while the next pages are measured) and read
// back when its page is analysed. `admit` waits until fewer than `limit` jobs are pending, so the jobs in flight, and the
// page data they hold, stay bounded. A job that throws is reported and gives undefined: it never fails its page or the others.
export class ResourcePool {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly limit: number,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`ResourcePool limit must be a positive integer, got ${limit}`);
  }

  /** Resolves when a slot is free. Call before start, so the number of pending jobs never exceeds the limit. */
  async admit(): Promise<void> {
    while (this.pending.size >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Starts a job now (after admit). The returned promise resolves to the job's value, or undefined when it throws. */
  start<T>(job: () => Promise<T>): Promise<T | undefined> {
    const run = (async (): Promise<T | undefined> => {
      try {
        return await job();
      } catch (error) {
        this.onError(error);
        return undefined;
      }
    })();
    this.pending.add(run);
    void run.finally(() => {
      this.pending.delete(run);
      this.waiters.shift()?.();
    });
    return run;
  }

  /** Resolves once every started job has settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** The number of jobs not yet settled. */
  get size(): number {
    return this.pending.size;
  }
}
