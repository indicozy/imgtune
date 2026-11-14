// Result cache for the resource analyzers. The phase (phase.ts) opens a scope per page analysis; an analyzer asks for an
// expensive value by key, and the value comes from the run's result cache when it is there, else it is computed and
// stored. Without a cache (--no-cache) a value is still computed once per scope.
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ResultCache } from "../result-cache.js";

interface Scope {
  cache: ResultCache | undefined;
  memo: Map<string, unknown>;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Runs `fn` with a fresh scope over the run's cache (undefined: no disk cache). */
export function withResourceScope<T>(cache: ResultCache | undefined, fn: () => Promise<T>): Promise<T> {
  return scopes.run({ cache, memo: new Map() }, fn);
}

/** The value for `key`: memoised in the scope, read from the result cache, else computed and stored. Never throws by itself. */
export async function cachedValue<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  const fullKey = `resources:v1:${key}`;
  if (scope?.memo.has(fullKey)) return scope.memo.get(fullKey) as T;
  const stored = scope?.cache ? await scope.cache.getJson<T>(fullKey) : undefined;
  if (stored !== undefined) {
    scope?.memo.set(fullKey, stored);
    return stored;
  }
  const value = await compute();
  scope?.memo.set(fullKey, value);
  await scope?.cache?.putJson(fullKey, value);
  return value;
}

/** A short digest of a buffer or text, for cache keys. */
export function digestOf(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
