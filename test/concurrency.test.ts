import { describe, expect, it } from "vitest";
import { mapLimit, settleLimit } from "../src/concurrency.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapLimit", () => {
  it("keeps the input order even when calls finish out of order", async () => {
    const out = await mapLimit([30, 5, 20, 1], 4, async (ms, i) => {
      await wait(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1"]);
  });

  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      running++;
      peak = Math.max(peak, running);
      await wait(5);
      running--;
    });
    expect(peak).toBe(3);
  });

  it("returns an empty list for no items and rejects a bad limit", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    await expect(mapLimit([1], 0, async () => 1)).rejects.toThrow(RangeError);
  });

  it("starts no new item after a rejection, and throws the first error", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5], 2, async (item) => {
        started.push(item);
        await wait(item === 1 ? 1 : 10);
        if (item === 1) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
    expect(started).not.toContain(5);
  });
});

describe("settleLimit", () => {
  it("keeps every outcome in order, failures included", async () => {
    const out = await settleLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("two");
      return n * 10;
    });
    expect(out.map((o) => (o.ok ? o.value : (o.error as Error).message))).toEqual([10, "two", 30]);
  });
});
