import { describe, expect, it } from "vitest";
import { lcpImagesOf, lcpLinesOf, lcpViewportsOf } from "../src/lcp.js";
import type { ImageRecord, ImagePerViewport } from "../src/images.js";
import type { PageResult, ViewportReport } from "../src/remote.js";

function perViewport(viewport: string, lcp: boolean | undefined, servedBytes: number): ImagePerViewport {
  return { viewport, dpr: 2, renderedCssPx: 390, neededPx: 780, servedBytes, undersized: false, loaded: true, ...(lcp === undefined ? {} : { lcp }) };
}

function record(id: string, lcpAt: string[], overrides: { file?: string; line?: number; kind?: ImageRecord["kind"] } = {}): ImageRecord {
  return {
    id,
    ...(overrides.kind !== undefined ? { kind: overrides.kind } : {}),
    page: "https://shop.example/",
    locator: { component: ["Hero"], file: overrides.file, line: overrides.line, selector: "body > img", classes: "", loader: "plain-img" },
    tunable: { width: true, quality: true },
    current: { srcsetCandidates: [] },
    perViewport: [perViewport("iphone-15", lcpAt.includes("iphone-15"), 400 * 1024), perViewport("desktop", lcpAt.includes("desktop"), 500 * 1024)],
    lcpViewports: lcpAt,
    fix: { bytes: { saved: 288 * 1024, addedForSharpness: 0, sizes: 120 * 1024, quality: 168 * 1024 } },
    evidence: { rung: "measured-page", notes: [] },
  };
}

function page(images: ImageRecord[], lcp: Record<string, ViewportReport["lcp"]>): PageResult {
  const perViewportReports: Record<string, ViewportReport> = {};
  for (const [name, kind] of Object.entries(lcp)) {
    perViewportReports[name] = { imageBytes: 0, exactSaved: 0, estSaved: 0, sharpnessGrowth: 0, images: [], ...(kind !== undefined ? { lcp: kind } : {}) };
  }
  return {
    url: "https://shop.example/",
    host: "shop.example",
    scannedAt: new Date(0).toISOString(),
    imgtuneVersion: "test",
    metric: "ssimulacra2",
    delta: 2,
    viewports: Object.keys(lcp),
    status: "ok",
    nextjs: false,
    perViewport: perViewportReports,
    groups: [],
    counts: { images: images.length, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
    images,
  };
}

describe("lcpLinesOf", () => {
  it("names the LCP image, the viewports it is at, its served bytes and what a fix saves", () => {
    const result = page([record("hero", ["iphone-15"], { file: "components/hero.tsx", line: 42 })], { "iphone-15": "image", desktop: "image" });
    expect(lcpLinesOf(result)).toEqual([
      "LCP image (iphone-15): components/hero.tsx:42, 400 KB served, 288 KB fixable (exact 120 KB, est. 168 KB)",
    ]);
  });

  it("says a skipped LCP image is not measured, with the reason, rather than 0 KB served", () => {
    const vector = record("logo", ["iphone-15"], { file: "components/Logo.tsx", line: 3 });
    vector.perViewport[0] = { ...vector.perViewport[0], skipped: "vector", servedBytes: 0 };
    expect(lcpLinesOf(page([vector], { "iphone-15": "image", desktop: "image" }))).toEqual([
      "LCP image (iphone-15): components/Logo.tsx:3, not measured (vector)",
    ]);
  });

  it("says the LCP is not an image where its element is another one", () => {
    const result = page([record("other", [])], { "iphone-15": "other", desktop: "other" });
    expect(lcpLinesOf(result)).toEqual(["LCP is not an image (iphone-15, desktop)"]);
  });

  it("is empty when the LCP was not read (an old scan)", () => {
    const result = page([record("old", [])], {});
    expect(lcpLinesOf(result)).toEqual([]);
  });

  it("quotes the page's own names through the given function", () => {
    const result = page([record("hero", ["desktop"])], { desktop: "image" });
    expect(lcpLinesOf(result, (text) => `<${text}>`)[0]).toMatch(/^LCP image \(<desktop>\): <Hero>, /);
  });

  it("leaves a CSS background out of the LCP images", () => {
    const result = page([record("bg", ["desktop"], { kind: "css-background" })], { desktop: "image" });
    expect(lcpImagesOf(result)).toEqual([]);
  });

  it("reads the viewports of a record from its per-viewport flags", () => {
    expect(lcpViewportsOf(record("x", ["desktop"]))).toEqual(["desktop"]);
  });
});
