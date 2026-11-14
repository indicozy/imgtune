// The resource pool (src/resources/pool.ts): bounded admission, ordering of results, failure isolation.
import { describe, expect, it } from "vitest";
import { ResourcePool } from "../src/resources/pool.js";

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("ResourcePool", () => {
  it("never has more jobs pending than its limit, and admits the next one only when a slot frees", async () => {
    const pool = new ResourcePool(2);
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await tick(ms);
      log.push(`end ${name}`);
      return name;
    };
    await pool.admit();
    const a = pool.start(job("a", 30));
    await pool.admit();
    const b = pool.start(job("b", 5));
    expect(pool.size).toBe(2);
    let admittedThird = false;
    const third = pool.admit().then(() => {
      admittedThird = true;
    });
    await tick(1);
    expect(admittedThird).toBe(false);
    await third.then(() => undefined);
    expect(admittedThird).toBe(true);
    expect(pool.size).toBeLessThanOrEqual(2);
    pool.start(job("c", 1));
    expect(await b).toBe("b");
    expect(await a).toBe("a");
    await pool.drain();
    expect(pool.size).toBe(0);
    // c was admitted only after b ended (the first slot to free).
    expect(log.indexOf("start c")).toBeGreaterThan(log.indexOf("end b"));
  });

  it("gives each job its own result, in whatever order they finish", async () => {
    const pool = new ResourcePool(3);
    const results = await Promise.all(
      [40, 5, 20].map(async (ms, i) => {
        await pool.admit();
        return pool.start(async () => {
          await tick(ms);
          return `page ${i}`;
        });
      }),
    );
    expect(results).toEqual(["page 0", "page 1", "page 2"]);
  });

  it("isolates a failing job: it gives undefined, reports the error, and the others still run", async () => {
    const errors: unknown[] = [];
    const pool = new ResourcePool(2, (error) => errors.push(error));
    await pool.admit();
    const bad = pool.start(async () => {
      throw new Error("analysis failed");
    });
    await pool.admit();
    const good = pool.start(async () => "fine");
    expect(await bad).toBeUndefined();
    expect(await good).toBe("fine");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("analysis failed");
  });

  it("rejects a limit below one", () => {
    expect(() => new ResourcePool(0)).toThrow(RangeError);
    expect(() => new ResourcePool(1.5)).toThrow(RangeError);
  });
});

describe("pageResourceJob (the page's resource analysis, started once)", () => {
  it("reads the observations once however often the job is asked, and gives undefined for a page without resources", async () => {
    const { pageResourceJob } = await import("../src/remote.js");
    const ctx = { pageUrl: "https://site.example/", deps: {}, fetcher: {}, allowPrivate: false, thirdParty: undefined } as never;
    let reads = 0;
    const observations = [{ viewport: { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false }, resources: undefined }] as never[];
    const job = pageResourceJob(ctx, async () => {
      reads++;
      return observations;
    });
    expect(await job()).toBeUndefined();
    expect(await job()).toBeUndefined();
    expect(reads).toBe(1);
  });

  it("gives undefined, and does not throw, when the observations cannot be read", async () => {
    const { pageResourceJob } = await import("../src/remote.js");
    const job = pageResourceJob({ pageUrl: "https://site.example/" } as never, async () => {
      throw new Error("staged file is missing");
    });
    expect(await job()).toBeUndefined();
  });
});
