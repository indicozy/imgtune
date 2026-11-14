// The resource analyzers' heavy work, shared across the run. A heavy step (a brotli-11 encode, a WOFF2 encode, a re-encode, an
// SVGO run, a sample encode) asks for its value by a key that holds the content (a digest), so a resource that two viewports
// or two pages load is computed once. The values are kept in the run's memo (in process) and in the result cache (across
// runs, when the cache is on). The run's resource budget (--resource-time) bounds the time spent computing them: once it is
// spent, a step that is not already known is not computed, and the caller reports the item as not measured.
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ResultCache } from "../result-cache.js";
import { measure } from "../timing.js";

/** The default time budget of the heavy resource work per run, in milliseconds (the spec: 60 s total). */
export const DEFAULT_RESOURCE_BUDGET_MS = 60_000;

/** The state one scan run shares: the memo of the heavy values and the time they took against the budget. */
export interface ResourceRun {
  budgetMs: number;
  spentMs: number;
  memo: Map<string, Promise<unknown>>;
}

/** A fresh run state with the given budget (default DEFAULT_RESOURCE_BUDGET_MS). */
export function newResourceRun(budgetMs: number = DEFAULT_RESOURCE_BUDGET_MS): ResourceRun {
  return { budgetMs, spentMs: 0, memo: new Map() };
}

interface Scope {
  cache: ResultCache | undefined;
  run: ResourceRun;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Runs `fn` with the run's state (a fresh one when none is given) and the run's result cache (undefined: no disk cache). */
export function withResourceScope<T>(cache: ResultCache | undefined, fn: () => Promise<T>, run: ResourceRun = newResourceRun()): Promise<T> {
  return scopes.run({ cache, run }, fn);
}

/**
 * The value for `key`: memoised for the run, read from the result cache, else computed (and stored). Undefined only when the
 * value is not known and the budget is spent (`budgeted` true); `compute` is then not run. Never throws by itself.
 */
export async function heavyValue<T>(key: string, compute: () => Promise<T>, budgeted = true): Promise<T | undefined> {
  const scope = scopes.getStore();
  const run = scope?.run ?? newResourceRun();
  const fullKey = `resources:v1:${key}`;
  const known = run.memo.get(fullKey);
  if (known !== undefined) return (await known) as T;
  if (budgeted && run.spentMs >= run.budgetMs) return undefined;
  const pending = (async (): Promise<T> => {
    const stored = scope?.cache ? await scope.cache.getJson<T>(fullKey) : undefined;
    if (stored !== undefined) return stored;
    const start = performance.now();
    const value = await measure("resources heavy", compute);
    run.spentMs += performance.now() - start;
    await scope?.cache?.putJson(fullKey, value);
    return value;
  })();
  run.memo.set(fullKey, pending);
  try {
    return await pending;
  } catch (error) {
    run.memo.delete(fullKey);
    throw error;
  }
}

/** The value for `key` with no budget (always computed once per run). The cheap steps use this. */
export function cachedValue<T>(key: string, compute: () => Promise<T>): Promise<T> {
  return heavyValue(key, compute, false) as Promise<T>;
}

/** A short digest of a buffer or text, for cache keys. */
export function digestOf(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
