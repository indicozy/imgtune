import { afterEach, describe, expect, it, vi } from "vitest";

type Timing = typeof import("../src/timing.js");

async function load(flag: string): Promise<Timing> {
  vi.stubEnv("IMGTUNE_TIMING", flag);
  vi.resetModules();
  return import("../src/timing.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("timing (IMGTUNE_TIMING off)", () => {
  it("calls straight through and records nothing", async () => {
    const t = await load("");
    expect(t.TIMING_ENABLED).toBe(false);
    expect(t.measure("step", () => 3)).toBe(3);
    t.count("things", 5);
    expect(t.timingPhases()).toEqual({});
    expect(t.timingCounters()).toEqual({});
    expect(t.renderTiming()).toEqual([]);
  });
});

describe("timing (IMGTUNE_TIMING=1)", () => {
  it("records sync and async steps, awaiting the promise before timing it", async () => {
    const t = await load("1");
    expect(t.TIMING_ENABLED).toBe(true);
    expect(t.measure("sync", () => 3)).toBe(3);
    const value = await t.measure("async", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 4;
    });
    expect(value).toBe(4);
    const phases = t.timingPhases();
    expect(phases.sync.calls).toBe(1);
    expect(phases.async.calls).toBe(1);
    expect(phases.async.ms).toBeGreaterThanOrEqual(15);
  });

  it("counts by name and renders phases and counts", async () => {
    const t = await load("1");
    t.count("encode calls");
    t.count("encode calls", 2);
    t.measure("encode avif", () => undefined);
    expect(t.timingCounters()).toEqual({ "encode calls": 3 });
    const text = t.renderTiming().join("\n");
    expect(text).toContain("encode avif");
    expect(text).toContain("encode calls");
  });

  it("resetTiming clears phases and counts", async () => {
    const t = await load("1");
    t.count("x");
    t.measure("y", () => undefined);
    t.resetTiming();
    expect(t.timingPhases()).toEqual({});
    expect(t.timingCounters()).toEqual({});
  });
});
