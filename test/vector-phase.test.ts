// The vector phase (vector-phase.ts): which flat images are traced, the budget, the skips with their reasons, the one
// trace per URL, and how a passing SVG changes the record's claimed saving.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ResultCache } from "../src/result-cache.js";
import { parseScanArgs, DEFAULT_SVG_BUDGET } from "../src/remote.js";
import type { ImageRecord } from "../src/images.js";
import type { PageResult } from "../src/remote.js";
import { applyVector, FlatBuffers, runVectorPhase, type VectorRun } from "../src/vector-phase.js";
import { VECTOR_BAR, traceSvg } from "../src/vector-art.js";
import { gradientNoise, rawToPng } from "./image-fixtures.js";

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">
<rect width="600" height="200" fill="#ffffff"/><circle cx="100" cy="100" r="70" fill="#e4572e"/>
<rect x="200" y="60" width="330" height="80" rx="14" fill="#29335c"/></svg>`;

/** A flat image record at one viewport, served at `bytes` per view. */
function flatRecord(id: string, src: string, bytes: number, saved = 0): ImageRecord {
  return {
    id,
    page: "https://site.test/",
    locator: { component: [], selector: "img", classes: "", loader: "plain-img" },
    tunable: { width: true, quality: true },
    current: { src, srcsetCandidates: [], format: "png" },
    perViewport: [
      { viewport: "desktop", domIndex: 0, dpr: 1, renderedCssPx: 600, neededPx: 600, servedBytes: bytes, undersized: false, loaded: true, lcp: false },
    ],
    fix: { bytes: { saved, addedForSharpness: 0, sizes: 0, quality: saved }, vector: { flatness: { uniqueColors: 4, top16Share: 1, alphaBinaryShare: 1, flat: true } } },
    evidence: { rung: "measured", notes: [] },
  } as unknown as ImageRecord;
}

function pageOf(images: ImageRecord[], url = "https://site.test/"): PageResult {
  return { url, host: "site.test", viewports: ["desktop"], images } as unknown as PageResult;
}

describe("parseScanArgs --svg-budget", () => {
  it("takes 0 to 1000, and the default is 50", () => {
    expect(parseScanArgs(["https://site.test/", "--svg-budget", "0"]).svgBudget).toBe(0);
    expect(parseScanArgs(["https://site.test/", "--svg-budget", "1000"]).svgBudget).toBe(1000);
    expect(parseScanArgs(["https://site.test/"]).svgBudget).toBeUndefined();
    expect(DEFAULT_SVG_BUDGET).toBe(50);
    expect(() => parseScanArgs(["https://site.test/", "--svg-budget", "1001"])).toThrow(/--svg-budget/);
    expect(() => parseScanArgs(["https://site.test/", "--svg-budget", "-1"])).toThrow(/--svg-budget/);
  });
});

describe("applyVector", () => {
  const run = (byUrl: Record<string, VectorRun["byUrl"] extends Map<string, infer O> ? O : never>): VectorRun => ({ byUrl: new Map(Object.entries(byUrl)) });

  it("leaves a page without flat images as it is", () => {
    const page = pageOf([]);
    expect(applyVector(page, run({}))).toBe(page);
  });

  it("claims the SVG's saving when it is larger than the raster fix, and keeps the raster fix as the fallback", () => {
    const record = flatRecord("a", "https://site.test/a.png", 9000, 1000);
    const out = applyVector(pageOf([record]), run({ "https://site.test/a.png": { svgBytes: 2000, score: 77, badPixelShare: 0.01, passed: true, tracedFile: "svg/a.svg" } }));
    const image = out.images?.[0] as ImageRecord;
    expect(image.fix.vector?.wins).toBe(true);
    expect(image.fix.vector?.savedPerView).toBe(7000);
    expect(image.fix.bytes.saved).toBe(7000);
    expect(image.fix.bytes.sizes).toBeUndefined();
    expect(image.fix.vector?.tracedFile).toBe("svg/a.svg");
  });

  it("keeps the raster saving when it is larger, and still records the SVG", () => {
    const record = flatRecord("b", "https://site.test/b.png", 9000, 8000);
    const out = applyVector(pageOf([record]), run({ "https://site.test/b.png": { svgBytes: 2000, score: 77, badPixelShare: 0.01, passed: true } }));
    const image = out.images?.[0] as ImageRecord;
    expect(image.fix.vector?.wins).toBeUndefined();
    expect(image.fix.bytes.saved).toBe(8000);
    expect(image.fix.vector?.passed).toBe(true);
  });

  it("gives a flat image with no outcome the reason trace failed", () => {
    const record = flatRecord("c", "https://site.test/c.png", 9000);
    const out = applyVector(pageOf([record]), run({}));
    expect((out.images?.[0] as ImageRecord).fix.vector?.notChecked).toBe("trace failed");
  });

  it("writes the vectorizer note on a page with flat images only", () => {
    const flat = pageOf([flatRecord("d", "https://site.test/d.png", 9000)]);
    expect(applyVector(flat, { byUrl: new Map(), note: "install @neplex/vectorizer to check vector art" }).vectorNote).toMatch(/install @neplex\/vectorizer/);
    expect(applyVector(pageOf([]), { byUrl: new Map(), note: "x" }).vectorNote).toBeUndefined();
  });
});

describe("runVectorPhase", () => {
  let dir = "";
  let logo: Buffer;
  let logoB: Buffer;
  let logoC: Buffer;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-vector-phase-"));
    logo = await sharp(Buffer.from(LOGO_SVG)).png().toBuffer();
    logoB = await sharp(Buffer.from(LOGO_SVG.replace("#e4572e", "#2e8bd9"))).png().toBuffer();
    logoC = await sharp(Buffer.from(LOGO_SVG.replace("#29335c", "#1f7a3d"))).png().toBuffer();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const base = (over: Partial<Parameters<typeof runVectorPhase>[1]> = {}) => ({
    budget: 50,
    survey: false,
    quality: true,
    outDir: join(dir, "scan"),
    cwd: dir,
    log: () => undefined,
    ...over,
  });
  const served: Record<string, Buffer> = {};

  it("skips with the reason: a survey, no quality, a budget of 0", async () => {
    const pages = [pageOf([flatRecord("s", "https://site.test/s.png", 9000)])];
    const fetch = vi.fn(async (url: string) => served[url]);
    expect((await runVectorPhase(pages, base({ survey: true }), { fetch })).byUrl.get("https://site.test/s.png")).toEqual({ notChecked: "survey" });
    expect((await runVectorPhase(pages, base({ quality: false }), { fetch })).byUrl.get("https://site.test/s.png")).toEqual({ notChecked: "quality off" });
    expect((await runVectorPhase(pages, base({ budget: 0 }), { fetch })).byUrl.get("https://site.test/s.png")).toEqual({ notChecked: "svg-budget 0" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("traces the heaviest images within the budget, once per URL, and says why the rest were not", async () => {
    served["https://site.test/big.png"] = logo;
    served["https://site.test/mid.png"] = logoB;
    served["https://site.test/small.png"] = logoC;
    const pages = [
      pageOf([flatRecord("1", "https://site.test/big.png", 9000), flatRecord("2", "https://site.test/mid.png", 7000)], "https://site.test/p1"),
      pageOf([flatRecord("3", "https://site.test/big.png", 9000), flatRecord("4", "https://site.test/small.png", 3000)], "https://site.test/p2"),
    ];
    const fetch = vi.fn(async (url: string) => served[url]);
    const run = await runVectorPhase(pages, base({ budget: 2 }), { fetch });
    expect(fetch.mock.calls.filter(([url]) => url === "https://site.test/big.png")).toHaveLength(1);
    expect(run.byUrl.get("https://site.test/big.png")?.passed).toBe(true);
    expect(run.byUrl.get("https://site.test/mid.png")?.passed).toBe(true);
    expect(run.byUrl.get("https://site.test/small.png")).toEqual({ notChecked: "over --svg-budget" });
    const big = run.byUrl.get("https://site.test/big.png");
    expect(big?.score).toBeGreaterThanOrEqual(VECTOR_BAR);
    expect(big?.svgBytes).toBeGreaterThan(0);
    expect(big?.tracedFile).toMatch(/^scan\/svg\/1\.svg$/);
    expect(await readFile(join(dir, "scan", "svg", "1.svg"), "utf8")).toMatch(/<svg/);
  });

  it("does not write a file for an image that does not pass", async () => {
    const noisy = await rawToPng(gradientNoise(200, 150, 12, 3));
    served["https://site.test/noisy.png"] = noisy;
    const fetch = vi.fn(async (url: string) => served[url]);
    const run = await runVectorPhase([pageOf([flatRecord("n", "https://site.test/noisy.png", noisy.length)])], base(), { fetch });
    const outcome = run.byUrl.get("https://site.test/noisy.png");
    expect(outcome?.passed).not.toBe(true);
    expect(outcome?.tracedFile).toBeUndefined();
    expect(outcome?.notChecked).toBeUndefined();
  });

  it("says vectorizer not installed, with the note, when the vectorizer cannot load", async () => {
    vi.resetModules();
    vi.doMock("@neplex/vectorizer", () => {
      throw new Error("missing");
    });
    const mod = await import("../src/vector-phase.js");
    const fetch = vi.fn(async () => logo);
    const run = await mod.runVectorPhase([pageOf([flatRecord("m", "https://site.test/m.png", 9000)])], base(), { fetch });
    expect(run.byUrl.get("https://site.test/m.png")).toEqual({ notChecked: "vectorizer not installed" });
    expect(run.note).toBe(mod.VECTOR_NOTE);
    expect(fetch).not.toHaveBeenCalled();
    vi.doUnmock("@neplex/vectorizer");
    vi.resetModules();
  });

  it("keeps the numbers in the result cache, keyed by the content, and reads them back", async () => {
    const cache = new ResultCache(join(dir, "cache"));
    const pages = [pageOf([flatRecord("k", "https://site.test/k.png", logo.length)])];
    const fetch = vi.fn(async () => logo);
    const first = await runVectorPhase(pages, base({ cache }), { fetch });
    const second = await runVectorPhase(pages, base({ cache }), { fetch });
    expect(second.byUrl.get("https://site.test/k.png")?.score).toBe(first.byUrl.get("https://site.test/k.png")?.score);
    expect(second.byUrl.get("https://site.test/k.png")?.passed).toBe(true);
  });

  it("traceSvg of the same logo is the same as the phase's SVG (the trace is deterministic)", async () => {
    const a = await traceSvg(logo);
    const b = await traceSvg(logo);
    expect(a).toBe(b);
  });
});

describe("FlatBuffers: the browser's bytes for the vector check", () => {
  it("keeps the largest files up to its capacity, and gives back what it kept", () => {
    const store = new FlatBuffers(2);
    const a = Buffer.from("a");
    const b = Buffer.from("b");
    const c = Buffer.from("c");
    store.offer("https://site.test/a.png", a, 100);
    store.offer("https://site.test/b.png", b, 300);
    store.offer("https://site.test/c.png", c, 50); // smaller than both: not kept
    expect(store.get("https://site.test/a.png")).toBe(a);
    expect(store.get("https://site.test/b.png")).toBe(b);
    expect(store.get("https://site.test/c.png")).toBeUndefined();
    store.offer("https://site.test/d.png", c, 200); // larger than a: a goes
    expect(store.get("https://site.test/a.png")).toBeUndefined();
    expect(store.get("https://site.test/d.png")).toBe(c);
  });

  it("keeps nothing with no capacity, and nothing for an absent buffer", () => {
    const none = new FlatBuffers(0);
    none.offer("https://site.test/a.png", Buffer.from("a"), 100);
    expect(none.get("https://site.test/a.png")).toBeUndefined();
    const store = new FlatBuffers(1);
    store.offer("https://site.test/b.png", undefined, 100);
    expect(store.get("https://site.test/b.png")).toBeUndefined();
  });

  it("traces the browser's bytes when they are kept, and does not fetch them", async () => {
    const logo = await sharp(Buffer.from(LOGO_SVG)).png().toBuffer();
    const store = new FlatBuffers(5);
    store.offer("https://site.test/k.png", logo, logo.length);
    const fetch = vi.fn(async () => undefined);
    const run = await runVectorPhase(
      [pageOf([flatRecord("k", "https://site.test/k.png", logo.length)])],
      { budget: 5, survey: false, quality: true, outDir: join(tmpdir(), "imgtune-flatbuf-test"), cwd: tmpdir(), log: () => undefined },
      { fetch: async (url) => store.get(url) ?? (await fetch(url)) },
    );
    expect(run.byUrl.get("https://site.test/k.png")?.passed).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await rm(join(tmpdir(), "imgtune-flatbuf-test"), { recursive: true, force: true });
  });
});
