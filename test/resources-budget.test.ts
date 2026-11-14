// The resource run's shared work (src/resources/cache.ts): a heavy step is computed once per run by its content key, and
// once the --resource-time budget is spent, a step that is not known yet is not computed at all.
import { describe, expect, it } from "vitest";
import { heavyValue, newResourceRun, withResourceScope } from "../src/resources/cache.js";

describe("heavy resource work", () => {
  it("computes a keyed step once for the run, however many times it is asked", async () => {
    const run = newResourceRun(60_000);
    let calls = 0;
    const compute = async () => {
      calls++;
      return { bytes: 42 };
    };
    await withResourceScope(undefined, async () => {
      expect(await heavyValue("k", compute)).toEqual({ bytes: 42 });
      expect(await heavyValue("k", compute)).toEqual({ bytes: 42 });
    }, run);
    expect(calls).toBe(1);
  });

  it("does not compute a new step once the budget is spent, and still returns a known one", async () => {
    const run = newResourceRun(0);
    let calls = 0;
    await withResourceScope(undefined, async () => {
      expect(await heavyValue("new", async () => ++calls)).toBeUndefined();
      expect(calls).toBe(0);
    }, run);
    // A value computed while the budget lasted stays known after it is spent.
    const spent = newResourceRun(60_000);
    await withResourceScope(undefined, async () => {
      expect(await heavyValue("early", async () => 7)).toBe(7);
    }, spent);
    spent.spentMs = spent.budgetMs;
    await withResourceScope(undefined, async () => {
      expect(await heavyValue("early", async () => 99)).toBe(7);
      expect(await heavyValue("late", async () => 99)).toBeUndefined();
    }, spent);
  });

  it("charges the time a step takes to the budget", async () => {
    const run = newResourceRun(60_000);
    await withResourceScope(undefined, () => heavyValue("slow", () => new Promise((resolve) => setTimeout(() => resolve(1), 30))), run);
    expect(run.spentMs).toBeGreaterThanOrEqual(25);
  });

  it("drops a failed step from the memo, so a later ask computes it again", async () => {
    const run = newResourceRun(60_000);
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts === 1) throw new Error("encode failed");
      return "ok";
    };
    await withResourceScope(undefined, async () => {
      await expect(heavyValue("flaky", flaky)).rejects.toThrow("encode failed");
      expect(await heavyValue("flaky", flaky)).toBe("ok");
    }, run);
    expect(attempts).toBe(2);
  });
});
