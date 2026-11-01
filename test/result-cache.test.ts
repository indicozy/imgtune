import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheScope, ResultCache, trimCache } from "../src/result-cache.js";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "imgtune-cache-"));
}

describe("ResultCache", () => {
  it("returns what was stored, under the same key only", async () => {
    const cache = new ResultCache(await freshDir());
    expect(await cache.get("k1")).toBeUndefined();
    await cache.put("k1", 0.123456789);
    expect(await cache.get("k1")).toBe(0.123456789);
    expect(await cache.get("k2")).toBeUndefined();
  });

  it("ignores corrupt, foreign or oversized entries, and non-numbers", async () => {
    const dir = await freshDir();
    const cache = new ResultCache(dir);
    await cache.put("k", 42);
    const name = (await readdir(dir))[0];
    await writeFile(join(dir, name), "{not json");
    expect(await cache.get("k")).toBeUndefined();
    await writeFile(join(dir, name), JSON.stringify({ k: "other", v: 1 }));
    expect(await cache.get("k")).toBeUndefined();
    await writeFile(join(dir, name), JSON.stringify({ k: "k", v: "1e9" }));
    expect(await cache.get("k")).toBeUndefined();
    await writeFile(join(dir, name), JSON.stringify({ k: "k", v: 1, pad: "x".repeat(5000) }));
    expect(await cache.get("k")).toBeUndefined();
    await writeFile(join(dir, name), JSON.stringify({ k: "k", v: 7 }));
    expect(await cache.get("k")).toBe(7);
  });

  it("does not store non-finite numbers", async () => {
    const dir = await freshDir();
    const cache = new ResultCache(dir);
    await cache.put("nan", Number.NaN);
    await cache.put("inf", Number.POSITIVE_INFINITY);
    expect(await cache.get("nan")).toBeUndefined();
    expect(await readdir(dir)).toHaveLength(0);
  });

  it("trims the oldest entries by modification time when over the limit", async () => {
    const dir = await freshDir();
    const cache = new ResultCache(dir, 1_000_000);
    for (const key of ["a", "b", "c"]) await cache.put(key, 1);
    const names = await readdir(dir);
    const base = Date.now();
    const times = new Map<string, number>();
    for (const [i, name] of names.entries()) {
      const t = new Date(base - (names.length - i) * 60_000);
      times.set(name, t.getTime());
      await utimes(join(dir, name), t, t);
    }
    const size = (await stat(join(dir, names[0]))).size;
    // A limit of 2.5 entries: trimming goes to 90% of it (2.25 entries), so one entry must go, and the oldest one does.
    const result = await trimCache(dir, Math.floor(size * 2.5));
    expect(result.removed).toBe(1);
    const left = await readdir(dir);
    expect(left).toHaveLength(2);
    const oldest = [...times.entries()].sort((x, y) => x[1] - y[1])[0][0];
    expect(left).not.toContain(oldest);
  });

  it("leaves files that are not cache entries alone", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "notes.txt"), "keep me");
    await new ResultCache(dir, 1).put("x", 1);
    await trimCache(dir, 0);
    expect(await readdir(dir)).toEqual(["notes.txt"]);
  });
});

describe("cacheScope", () => {
  it("separates originals, widths, scorers, encoders and tool versions", () => {
    const a = Buffer.from("original a");
    const b = Buffer.from("original b");
    const base = cacheScope(a, 480, "cpu", "sharp 0.35.5 vips 8.18.7");
    expect(cacheScope(a, 480, "cpu", "sharp 0.35.5 vips 8.18.7")).toBe(base);
    expect(cacheScope(b, 480, "cpu", "sharp 0.35.5 vips 8.18.7")).not.toBe(base);
    expect(cacheScope(a, 481, "cpu", "sharp 0.35.5 vips 8.18.7")).not.toBe(base);
    expect(cacheScope(a, 480, "gpu:RTX 4060", "sharp 0.35.5 vips 8.18.7")).not.toBe(base);
    expect(cacheScope(a, 480, "cpu", "sharp 0.36.0 vips 8.18.7")).not.toBe(base);
  });
});
