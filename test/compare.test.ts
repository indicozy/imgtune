import { describe, expect, it } from "vitest";
import type { ImageRecord, ImagePerViewport } from "../src/images.js";
import type { MeasuredPage } from "../src/locate-join.js";
import { compareScans, parseCompareArgs, pairImages, renderCompare } from "../src/compare.js";

/** A synthetic record: one image on one page, served at `bytes` on each of the given viewports. */
function image(id: string, opts: { bytes: number; views?: string[]; undersized?: boolean; src?: string; alt?: string; file?: string }): ImageRecord {
  const views = opts.views ?? ["iphone-15", "desktop"];
  // The srcset is the image's own path at two widths, as a real srcset is: the id is not part of it.
  const base = (opts.src ?? "https://shop.example/a.jpg").split("?")[0];
  const src = `${base}?w=640`;
  const perViewport: ImagePerViewport[] = views.map((viewport) => ({
    viewport,
    dpr: 2,
    renderedCssPx: 300,
    neededPx: 600,
    servedBytes: opts.bytes,
    undersized: opts.undersized === true,
    loaded: true,
  }));
  return {
    id,
    page: "https://shop.example/bags",
    locator: {
      component: ["Card"],
      selector: "img",
      classes: "",
      loader: "next-default",
      urlPattern: "/a.jpg",
      alt: opts.alt,
      file: opts.file,
      line: opts.file ? 12 : undefined,
    },
    tunable: { width: true, quality: true },
    current: {
      src,
      srcsetCandidates: [
        { url: `${base}?w=640`, width: 640 },
        { url: `${base}?w=1080`, width: 1080 },
      ],
      format: "avif",
    },
    perViewport,
    fix: { bytes: { saved: 0, addedForSharpness: 0 } },
    evidence: { rung: "measured-page", notes: [] },
  };
}

function scan(url: string, images: ImageRecord[], imageBytes: Record<string, number> = {}): MeasuredPage {
  const views = [...new Set(images.flatMap((r) => r.perViewport.map((p) => p.viewport)))];
  const perViewport = Object.fromEntries(views.map((v) => [v, { imageBytes: imageBytes[v] ?? 0, exactSaved: 0, estSaved: 0, sharpnessGrowth: 0, images: [] }]));
  return {
    url,
    host: "shop.example",
    scannedAt: new Date(0).toISOString(),
    imgtuneVersion: "test",
    metric: "ssimulacra2",
    delta: 2,
    viewports: views,
    status: "ok",
    nextjs: true,
    perViewport,
    groups: [],
    counts: { images: images.length, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
    images,
  } as unknown as MeasuredPage;
}

const KB = 1024;

describe("parseCompareArgs", () => {
  it("reads two files, the format and the limit", () => {
    expect(parseCompareArgs(["a.json", "b.json", "--format", "json", "--limit", "5"])).toEqual({
      before: "a.json",
      after: "b.json",
      format: "json",
      limit: 5,
    });
  });

  it("refuses anything but two files and known options", () => {
    expect(() => parseCompareArgs(["a.json"])).toThrow(/usage/);
    expect(() => parseCompareArgs(["a.json", "b.json", "c.json"])).toThrow(/usage/);
    expect(() => parseCompareArgs(["a.json", "b.json", "--gpu"])).toThrow(/Unknown option/);
    expect(() => parseCompareArgs(["a.json", "b.json", "--format", "xml"])).toThrow(/text or json/);
    expect(() => parseCompareArgs(["a.json", "b.json", "--limit", "0"])).toThrow(/at least 1/);
  });
});

describe("pairImages", () => {
  it("pairs by the join key in document order, and leaves the extra images unpaired", () => {
    const before = [image("b1", { bytes: 100 * KB, src: "https://shop.example/x/a.jpg?w=1" }), image("b2", { bytes: 90 * KB, src: "https://shop.example/x/a.jpg?w=2" }), image("b3", { bytes: 5 * KB, src: "https://shop.example/y.jpg" })];
    const after = [image("a1", { bytes: 60 * KB, src: "https://shop.example/x/a.jpg?w=1" }), image("a2", { bytes: 40 * KB, src: "https://shop.example/x/a.jpg?w=2" }), image("a3", { bytes: 7 * KB, src: "https://shop.example/z.jpg" })];
    const joined = pairImages(before, after);
    expect(joined.pairs.map(([b, a]) => [b.id, a.id])).toEqual([
      ["b1", "a1"],
      ["b2", "a2"],
    ]);
    expect(joined.before.map((r) => r.id)).toEqual(["b3"]);
    expect(joined.after.map((r) => r.id)).toEqual(["a3"]);
  });
});

describe("compareScans", () => {
  it("reports saved and sharpness bytes as two numbers, never netted", () => {
    // One image saves 40 KB per view; another is undersized before and grows 12 KB per view for sharpness.
    const before = scan("https://shop.example/bags", [
      image("s1", { bytes: 100 * KB, src: "https://shop.example/a.jpg?w=1" }),
      image("u1", { bytes: 20 * KB, undersized: true, src: "https://shop.example/b.jpg?w=1" }),
    ]);
    const after = scan("https://shop.example/bags", [
      image("s2", { bytes: 60 * KB, src: "https://shop.example/a.jpg?w=1" }),
      image("u2", { bytes: 32 * KB, src: "https://shop.example/b.jpg?w=1" }),
    ]);
    const report = compareScans(before, after, { before: 0, after: 0 });
    expect(report.paired.images).toBe(2);
    expect(report.paired.saved).toBeCloseTo(40 * KB, 6);
    expect(report.paired.addedForSharpness).toBeCloseTo(12 * KB, 6);
    expect(report.paired.grewWithoutSharpness.images).toBe(0);
  });

  it("warns about growth that is not a sharpness fix, and keeps it out of the saving", () => {
    const before = scan("https://shop.example/bags", [image("g1", { bytes: 20 * KB, src: "https://shop.example/c.jpg?w=1" })]);
    const after = scan("https://shop.example/bags", [image("g2", { bytes: 26 * KB, src: "https://shop.example/c.jpg?w=1" })]);
    const report = compareScans(before, after, { before: 0, after: 0 });
    expect(report.paired.saved).toBe(0);
    expect(report.paired.addedForSharpness).toBe(0);
    expect(report.paired.grewWithoutSharpness).toEqual({ images: 1, bytes: 6 * KB });
    expect(renderCompare(report, 10)).toMatch(/warning: grew without a sharpness reason: 6\.0 KB\/view on 1 image/);
  });

  it("lists images in one scan only as data drift and does not count them", () => {
    const before = scan("https://shop.example/bags", [
      image("k1", { bytes: 50 * KB, src: "https://shop.example/k.jpg?w=1" }),
      image("gone", { bytes: 300 * KB, src: "https://shop.example/gone.jpg?w=1" }),
    ], { iphone: 0 });
    const after = scan("https://shop.example/bags", [
      image("k2", { bytes: 40 * KB, src: "https://shop.example/k.jpg?w=1" }),
      image("new", { bytes: 200 * KB, src: "https://shop.example/new.jpg?w=1" }),
    ]);
    const report = compareScans(before, after, { before: 0, after: 0 });
    expect(report.paired.saved).toBeCloseTo(10 * KB, 6);
    expect(report.paired.addedForSharpness).toBe(0);
    expect(report.disappeared.map((r) => r.id)).toEqual(["gone"]);
    expect(report.appeared.map((r) => r.id)).toEqual(["new"]);
    expect(renderCompare(report, 10)).toMatch(/unpaired, not counted \(data drift\): appeared 1, disappeared 1/);
  });

  it("shows the page total from each scan, labelled as including data drift", () => {
    const before = scan("https://shop.example/bags", [image("p1", { bytes: 10 * KB, src: "https://shop.example/p.jpg?w=1" })], { "iphone-15": 500 * KB, desktop: 700 * KB });
    const after = scan("https://shop.example/bags", [image("p2", { bytes: 9 * KB, src: "https://shop.example/p.jpg?w=1" })], { "iphone-15": 450 * KB, desktop: 650 * KB });
    const report = compareScans(before, after, { before: 0, after: 0 });
    expect(report.pageTotal.before).toBeCloseTo(600 * KB, 6);
    expect(report.pageTotal.after).toBeCloseTo(550 * KB, 6);
    expect(renderCompare(report, 10)).toMatch(/page total \(includes data drift, not the claim\): before 600\.0 KB\/view, after 550\.0 KB\/view/);
  });

  it("pairs a built scan against a built scan with no source fields, and matches by alt too", () => {
    const before = scan("https://shop.example/bags", [image("x1", { bytes: 30 * KB, alt: "red bag", src: "https://shop.example/r.jpg?w=1" }), image("x2", { bytes: 30 * KB, alt: "blue bag", src: "https://shop.example/r.jpg?w=1" })]);
    const after = scan("https://shop.example/bags", [image("y2", { bytes: 10 * KB, alt: "blue bag", src: "https://shop.example/r.jpg?w=1" }), image("y1", { bytes: 30 * KB, alt: "red bag", src: "https://shop.example/r.jpg?w=1" })]);
    const report = compareScans(before, after, { before: 0, after: 0 });
    // Same pattern, different alt: each bag is paired with itself, not by position.
    expect(report.changes.map((c) => [c.beforeId, c.afterId])).toEqual([["x2", "y2"]]);
    expect(report.paired.saved).toBeCloseTo(20 * KB, 6);
  });
});
