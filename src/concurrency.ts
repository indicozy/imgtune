/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Results keep the order of `items`. After a call rejects, no
 * further item starts; calls already running finish, and the first rejection is thrown once they have all settled.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`mapLimit: limit must be a positive integer, got ${limit}`);
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
  return results;
}

/** Like mapLimit, but every item's outcome is kept: a fulfilled value or the rejection reason, in the order of `items`. */
export async function settleLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<({ ok: true; value: R } | { ok: false; error: unknown })[]> {
  return mapLimit(items, limit, async (item, index) => {
    try {
      return { ok: true as const, value: await fn(item, index) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
}
