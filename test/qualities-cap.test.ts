import { describe, expect, it } from "vitest";
import { capQualities, planQualityCap, qualitiesLine, savedAt, unitOf, type QualityCapUnit } from "../src/qualities-cap.js";
import type { ImageRecord } from "../src/images.js";
import type { PageResult } from "../src/remote.js";

const unit = (id: string, current: number, target: number, saved: number): QualityCapUnit => ({ id, current, target, saved });

describe("savedAt", () => {
  it("scales the saving at the target linearly up to the current quality, and nothing at it", () => {
    const u = unit("a", 90, 60, 3000);
    expect(savedAt(u, 60)).toBe(3000);
    expect(savedAt(u, 75)).toBe(1500);
    expect(savedAt(u, 90)).toBe(0);
  });

  it("is negative above the current quality: a raise adds the bytes the same line gives", () => {
    expect(savedAt(unit("a", 90, 60, 3000), 95)).toBe(-500);
  });

  it("keeps the measured saving at the target, even when the target is the current quality", () => {
    expect(savedAt(unit("a", 75, 75, 500), 75)).toBe(500);
    expect(savedAt(unit("a", 75, 75, 500), 80)).toBe(0);
  });

  it("is zero without a saving, and below the target", () => {
    expect(savedAt(unit("a", 75, 60, 0), 60)).toBe(0);
    expect(savedAt(unit("a", 90, 60, 300), 55)).toBe(0);
  });
});

describe("capQualities", () => {
  const units = [unit("a", 90, 60, 4000), unit("b", 90, 70, 2000), unit("c", 90, 85, 1000)];

  it("maps every image up to a listed value, never below its target", () => {
    for (const max of [1, 2, 3, 4]) {
      const cap = capQualities(units, max) as NonNullable<ReturnType<typeof capQualities>>;
      for (const u of units) expect(cap.finalFor(u)).toBeGreaterThanOrEqual(u.target);
    }
  });

  it("always lists the largest target, so every image has a value to map up to", () => {
    for (const max of [1, 2, 4]) {
      const cap = capQualities(units, max) as NonNullable<ReturnType<typeof capQualities>>;
      expect(cap.values[cap.values.length - 1]).toBe(85);
    }
  });

  it("lists at most the cap, and a larger cap never keeps less saving", () => {
    let previous = -Infinity;
    for (const max of [1, 2, 3, 4]) {
      const cap = capQualities(units, max) as NonNullable<ReturnType<typeof capQualities>>;
      expect(cap.values.length).toBeLessThanOrEqual(max);
      expect(cap.kept).toBeGreaterThanOrEqual(previous);
      previous = cap.kept;
    }
  });

  it("with one value, every image maps to the largest target", () => {
    const cap = capQualities(units, 1) as NonNullable<ReturnType<typeof capQualities>>;
    expect(cap.values).toEqual([85]);
    expect(units.map((u) => cap.finalFor(u))).toEqual([85, 85, 85]);
  });

  it("picks the pair that keeps the most saving", () => {
    // [60, 85]: the 9000 at 60 stays in full and the 70 moves up to 85; [70, 85] moves the 9000 only to 70.
    const heavyAt60 = [unit("a", 90, 60, 9000), unit("b", 90, 70, 100), unit("c", 90, 85, 100)];
    const cap = capQualities(heavyAt60, 2) as NonNullable<ReturnType<typeof capQualities>>;
    expect(cap.values).toEqual([60, 85]);
    expect(cap.finalFor(heavyAt60[0])).toBe(60);
    expect(cap.finalFor(heavyAt60[1])).toBe(85);
  });

  it("lists the default too when it keeps it, rather than raising the image that is already there", () => {
    // The 75 image needs 75 (no saving to take); the 90 image needs 80. [75, 80] keeps both savings; [80] raises the 75.
    const mixed = [unit("default", 75, 75, 2000), unit("explicit", 90, 80, 1000)];
    const cap = capQualities(mixed, 2) as NonNullable<ReturnType<typeof capQualities>>;
    expect(cap.values).toEqual([75, 80]);
    expect(cap.finalFor(mixed[0])).toBe(75);
    expect(cap.kept).toBe(3000);
  });

  it("raises an image when the list leaves it no lower value, and nets the bytes it adds", () => {
    const forced = [unit("default", 75, 60, 5000), unit("explicit", 90, 85, 100)];
    const cap = capQualities(forced, 1) as NonNullable<ReturnType<typeof capQualities>>;
    expect(cap.values).toEqual([85]);
    expect(cap.finalFor(forced[0])).toBe(85);
    expect(savedAt(forced[0], 85)).toBeCloseTo(-3333.3, 0);
    expect(cap.kept).toBeLessThan(cap.total);
  });

  it("keeps the whole saving when every target is the current quality (nothing moves)", () => {
    const atCurrent = [unit("a", 75, 75, 2000), unit("b", 75, 75, 800)];
    const cap = capQualities(atCurrent, 2) as NonNullable<ReturnType<typeof capQualities>>;
    expect(cap.values).toEqual([75]);
    expect(cap.kept).toBe(2800);
    expect(cap.total).toBe(2800);
  });

  it("breaks ties toward the smaller list, then the lower values", () => {
    const none = [unit("a", 75, 60, 0), unit("b", 75, 70, 0)];
    expect(capQualities(none, 4)?.values).toEqual([70]);
    const equal = [unit("a", 90, 60, 1000), unit("b", 90, 80, 1000)];
    const cap = capQualities(equal, 2) as NonNullable<ReturnType<typeof capQualities>>;
    // [80] alone keeps 333 + 1000; the pair keeps both in full, so the pair wins.
    expect(cap.values).toEqual([60, 80]);
  });

  it("is undefined without units", () => {
    expect(capQualities([], 2)).toBeUndefined();
  });
});

function record(id: string, overrides: Partial<ImageRecord> & { loader?: string; quality?: number; target?: number; saved?: number } = {}): ImageRecord {
  const { loader = "next-default", quality = 90, target = 80, saved = 1000 } = overrides;
  return {
    id,
    page: "https://shop.example/a",
    locator: { component: ["Card"], selector: "img", classes: "", loader },
    tunable: { width: true, quality: true },
    current: { srcsetCandidates: [], quality, format: "webp" },
    perViewport: [],
    fix: {
      quality: { perFormat: { webp: target }, groupRule: "max-of-targets", group: "Card", samples: 1, current: quality, qualityAssumed: false },
      bytes: { saved, addedForSharpness: 0, sizes: 0, quality: saved },
    },
    evidence: { rung: "measured-page", notes: [] },
  };
}

function page(url: string, images: ImageRecord[], status: PageResult["status"] = "ok"): PageResult {
  return {
    url,
    host: "shop.example",
    scannedAt: new Date(0).toISOString(),
    imgtuneVersion: "test",
    metric: "ssimulacra2",
    delta: 2,
    viewports: ["desktop"],
    status,
    nextjs: true,
    perViewport: {},
    groups: [],
    counts: { images: images.length, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
    images,
  } as PageResult;
}

describe("unitOf", () => {
  it("covers next/image images with a current quality and a target, and nothing else", () => {
    expect(unitOf(record("a"))).toEqual({ id: "a", current: 90, target: 80, saved: 1000 });
    expect(unitOf(record("b", { loader: "cloudinary" }))).toBeUndefined();
    expect(unitOf({ ...record("c"), kind: "css-background" })).toBeUndefined();
    const noTarget = record("d");
    noTarget.fix.quality = undefined;
    expect(unitOf(noTarget)).toBeUndefined();
  });

  it("reads the quality part of an older record from its saving beyond the sizes", () => {
    const older = record("e");
    older.fix.bytes = { saved: 1500, addedForSharpness: 0, sizes: 500 };
    expect(unitOf(older)?.saved).toBe(1000);
  });
});

describe("planQualityCap", () => {
  it("clusters the next/image targets across pages, and skips pages that did not measure", () => {
    const pages = [
      page("https://shop.example/a", [record("a1", { target: 60, saved: 4000 }), record("a2", { target: 80, saved: 500 })]),
      page("https://shop.example/b", [record("b1", { target: 70, saved: 2000 })]),
      page("https://shop.example/broken", [record("x", { target: 50, saved: 9000 })], "broken"),
    ];
    const plan = planQualityCap(pages, 2);
    expect(plan).toBeDefined();
    expect(plan?.values.length).toBeLessThanOrEqual(2);
    expect(plan?.byRecord.has("x")).toBe(false);
    for (const [, mapped] of plan?.byRecord ?? []) {
      expect(mapped.to).toBeGreaterThanOrEqual(mapped.from);
      expect(plan?.values).toContain(mapped.to);
    }
    expect(plan?.images).toBe(3);
  });

  it("is undefined when no page has a next/image image", () => {
    expect(planQualityCap([page("https://shop.example/a", [record("c", { loader: "cloudinary" })])])).toBeUndefined();
  });

  it("prints the site-level line with the list in brackets, and the share kept when there is a saving", () => {
    const plan = planQualityCap([page("https://shop.example/a", [record("a1", { target: 60, saved: 4000 })])], 2);
    expect(qualitiesLine(plan as NonNullable<typeof plan>)).toMatch(/^next\.config: images\.qualities: \[60\]  \(at most 2 value\(s\) for 1 next\/image image\(s\); approx\. est\. kept 100%/);
    const none = planQualityCap([page("https://shop.example/a", [record("a2", { target: 60, saved: 0 })])], 2);
    expect(qualitiesLine(none as NonNullable<typeof none>)).not.toMatch(/kept/);
  });
});
