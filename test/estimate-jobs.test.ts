// The estimate jobs of a scan run (see estimate-jobs.ts): the keys that identify a job, the write-back of each job's result to
// every page that asked for it, and the skip threshold.
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { ESTIMATE_MIN_SAVING_BYTES, EstimateRegistry, internBuffer, withEstimates, type EstimateStore } from "../src/estimate-jobs.js";
import { CACHE_VERSION, resizeScope } from "../src/result-cache.js";
import { IMGTUNE_VERSION } from "../src/version.js";
import { matchedQuality, matchedQualityOf, MATCH_MAX_PIXELS, qualityJobKey, resizedEstimate } from "../src/remote.js";

const bigEnough = ESTIMATE_MIN_SAVING_BYTES;

describe("resizeScope (the key of a resize estimate)", () => {
  it("is the same for the same bytes, format and target width, and differs when any of them differs", () => {
    const a = Buffer.from("same bytes");
    const b = Buffer.from("same bytes");
    const other = Buffer.from("other bytes");
    expect(resizeScope(a, "jpeg", 320)).toBe(resizeScope(b, "jpeg", 320));
    expect(resizeScope(a, "jpeg", 320)).not.toBe(resizeScope(other, "jpeg", 320));
    expect(resizeScope(a, "jpeg", 320)).not.toBe(resizeScope(a, "webp", 320));
    expect(resizeScope(a, "jpeg", 320)).not.toBe(resizeScope(a, "jpeg", 321));
  });

  it("names the tool and the cache version, so an old entry is never reused", () => {
    const key = resizeScope(Buffer.from("x"), "avif", 100);
    expect(key).toContain(`imgtune ${IMGTUNE_VERSION}`);
    expect(key).toContain(`cache ${CACHE_VERSION}`);
  });
});

describe("qualityJobKey (the key of a quality sample)", () => {
  const right = { url: "https://x.example/a.avif", bytes: 40_000, width: 800, height: 600, format: "avif", buffer: Buffer.alloc(40_000, 1) };
  const key = (over: Partial<typeof right> & { current?: number; deltas?: number[]; scorer?: string; original?: string } = {}) => {
    const { current = 75, deltas = [2], scorer = "cpu", original = "https://x.example/orig.jpg", ...rest } = over;
    return qualityJobKey(original, { ...right, ...rest }, scorer, current, deltas);
  };

  it("is the same for the same original, served file, width, scorer and quality", () => {
    expect(key()).toBe(key({ buffer: Buffer.alloc(40_000, 1) }));
  });

  it("differs for each input the estimate depends on", () => {
    const base = key();
    expect(key({ original: "https://x.example/other.jpg" })).not.toBe(base);
    expect(key({ buffer: Buffer.alloc(40_000, 2) })).not.toBe(base);
    expect(key({ width: 801 })).not.toBe(base);
    expect(key({ format: "webp" })).not.toBe(base);
    expect(key({ bytes: 40_001 })).not.toBe(base);
    expect(key({ current: 80 })).not.toBe(base);
    expect(key({ deltas: [2, 4] })).not.toBe(base);
    expect(key({ scorer: "gpu:RTX" })).not.toBe(base);
  });
});

describe("EstimateRegistry", () => {
  it("runs a job once for all the pages that ask for its key, and gives every one the result", async () => {
    const registry = new EstimateRegistry();
    let runs = 0;
    const job = async () => {
      runs++;
      return 1234;
    };
    const pageA = registry.collector();
    const pageB = registry.collector();
    expect(await pageA.get("k", bigEnough + 10, job)).toBeUndefined();
    expect(await pageB.get("k", bigEnough + 10, job)).toBeUndefined();
    expect(registry.counts()).toEqual({ requests: 2, unique: 1, skipped: 0 });

    await registry.runJobs(2);
    expect(runs).toBe(1);
    const tallyA = { fallbacks: 0 };
    const tallyB = { fallbacks: 0 };
    expect(await registry.reader(tallyA).get("k", bigEnough + 10, job)).toBe(1234);
    expect(await registry.reader(tallyB).get("k", bigEnough + 10, job)).toBe(1234);
    expect(runs).toBe(1);
  });

  it("does not run a job whose largest possible saving is under the threshold, and counts it skipped", async () => {
    const registry = new EstimateRegistry();
    let runs = 0;
    const job = async () => {
      runs++;
      return 1;
    };
    const store = registry.collector();
    await store.get("small", bigEnough - 1, job);
    await store.get("edge", bigEnough, job);
    expect(registry.counts()).toEqual({ requests: 2, unique: 2, skipped: 0 });
    await registry.runJobs(1);
    expect(runs).toBe(1);
    expect(registry.counts()).toEqual({ requests: 2, unique: 2, skipped: 1 });
    expect(await registry.reader({ fallbacks: 0 }).get("small", bigEnough - 1, job)).toBeUndefined();
    expect(await registry.reader({ fallbacks: 0 }).get("edge", bigEnough, job)).toBe(1);
  });

  it("gives no value to a job that throws, and does not stop the other jobs", async () => {
    const registry = new EstimateRegistry();
    const store = registry.collector();
    await store.get("bad", bigEnough, async () => {
      throw new Error("encode failed");
    });
    await store.get("good", bigEnough, async () => "ok");
    await registry.runJobs(2);
    expect(await registry.reader({ fallbacks: 0 }).get("bad", bigEnough, async () => "")).toBeUndefined();
    expect(await registry.reader({ fallbacks: 0 }).get("good", bigEnough, async () => "")).toBe("ok");
  });

  it("refuses a request made after the jobs ran", async () => {
    const registry = new EstimateRegistry();
    await registry.runJobs(1);
    await expect(registry.collector().get("late", bigEnough, async () => 1)).rejects.toThrow(/after the jobs ran/);
  });

  it("shares a memo across the jobs of one run", async () => {
    const registry = new EstimateRegistry();
    let computed = 0;
    const store = registry.collector();
    const shared = () => store.memo("match", async () => ++computed);
    expect(await shared()).toBe(1);
    expect(await shared()).toBe(1);
    expect(computed).toBe(1);
  });
});

describe("withEstimates (one page, its two passes)", () => {
  it("collects the requests of the first pass and reads their results in the second", async () => {
    let jobRuns = 0;
    const { value, fallbacks } = await withEstimates(async (store) => {
      const got = await store.get("k", bigEnough, async () => {
        jobRuns++;
        return "estimate";
      });
      return got ?? "provisional";
    }, 2);
    expect(jobRuns).toBe(1);
    expect(value).toBe("estimate");
    expect(fallbacks).toBe(0);
  });
});

describe("write-back to every page", () => {
  it("gives two pages that share a file the same estimate from one job, and each page keeps its own other numbers", async () => {
    const shared = Buffer.alloc(bigEnough + 100, 7);
    let runs = 0;
    // A page's analysis: its own number, plus the estimate of the shared file, read through the store as analysePage does.
    const analyse = (own: number, store: EstimateStore) =>
      store
        .get(resizeScope(shared, "png", 100), shared.length, async () => {
          runs++;
          return 4096;
        })
        .then((est) => ({ own, est: est ?? null }));

    const registry = new EstimateRegistry();
    const provisional = [await analyse(1, registry.collector()), await analyse(2, registry.collector())];
    expect(provisional.map((p) => p.est)).toEqual([null, null]);
    await registry.runJobs(2);
    expect(runs).toBe(1);
    const finals = [await analyse(1, registry.reader({ fallbacks: 0 })), await analyse(2, registry.reader({ fallbacks: 0 }))];
    expect(runs).toBe(1);
    expect(finals).toEqual([
      { own: 1, est: 4096 },
      { own: 2, est: 4096 },
    ]);
  });
});

describe("the number-preserving split of resizedEstimate", () => {
  it("gives the same bytes with the bisection's quality passed in as when it is computed", async () => {
    const png = await sharp({ create: { width: 640, height: 400, channels: 3, background: "#4a7" } }).jpeg({ quality: 95 }).toBuffer();
    const quality = await matchedQuality(png, "jpeg");
    expect(quality).toBeGreaterThanOrEqual(1);
    const computed = await resizedEstimate(png, "jpeg", 160);
    const passed = await resizedEstimate(png, "jpeg", 160, quality);
    expect(passed?.bytes).toBe(computed?.bytes);
    expect(await matchedQuality(png, "gif")).toBeUndefined();
  });

  it("gives no estimate to a lossy file over MATCH_MAX_PIXELS, and still one to a PNG", async () => {
    const side = Math.ceil(Math.sqrt(MATCH_MAX_PIXELS + 1));
    const big = await sharp({ create: { width: side, height: side, channels: 3, background: "#835" } }).jpeg({ quality: 80 }).toBuffer();
    expect(await matchedQuality(big, "jpeg")).toBeUndefined();
    expect(await resizedEstimate(big, "jpeg", 200)).toBeUndefined();
    const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#835" } }).png().toBuffer();
    expect(await resizedEstimate(png, "png", 100)).toBeDefined();
  });

  it("matches a lossy file over MATCH_MAX_PIXELS approximately, and an exact match below it", async () => {
    const side = Math.ceil(Math.sqrt(MATCH_MAX_PIXELS + 1));
    const big = await sharp({ create: { width: side, height: side, channels: 3, background: "#835" } }).jpeg({ quality: 80 }).toBuffer();
    const approx = await matchedQualityOf(big, "jpeg");
    expect(approx).toMatchObject({ approx: true });
    expect(approx?.quality).toBeGreaterThanOrEqual(1);
    const estimate = await resizedEstimate(big, "jpeg", 200, approx?.quality);
    expect(estimate?.bytes).toBeGreaterThan(0);
    const small = await sharp({ create: { width: 640, height: 400, channels: 3, background: "#4a7" } }).jpeg({ quality: 95 }).toBuffer();
    expect(await matchedQualityOf(small, "jpeg")).toEqual({ quality: await matchedQuality(small, "jpeg"), approx: false });
    expect(await matchedQualityOf(small, "gif")).toBeUndefined();
  });
});

describe("internBuffer", () => {
  it("returns the first buffer seen for the same bytes, and keeps a different one apart", () => {
    const pool = new Map<string, Buffer>();
    const first = Buffer.from("same");
    const second = Buffer.from("same");
    expect(internBuffer(pool, first)).toBe(first);
    expect(internBuffer(pool, second)).toBe(first);
    const other = Buffer.from("other");
    expect(internBuffer(pool, other)).toBe(other);
  });
});
