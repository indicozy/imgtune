import { describe, expect, it } from "vitest";
import type { ImageRecord, ImagePerViewport } from "../src/images.js";
import { applySizesOutcome, sizesOutcomeOf } from "../src/sizes-outcome.js";

const KB = 1024;

/** A record with a srcset of the given widths, served at `servedWidth` on each viewport, and a proposed sizes value. */
function record(opts: {
  current: string;
  proposed: string;
  widths: number[];
  servedWidth: number;
  servedBytes: number;
  undersized?: boolean;
  viewports: { name: string; dpr: number; rendered: number }[];
}): ImageRecord {
  const perViewport: ImagePerViewport[] = opts.viewports.map((v) => ({
    viewport: v.name,
    dpr: v.dpr,
    renderedCssPx: v.rendered,
    neededPx: Math.ceil(v.rendered * v.dpr),
    servedPx: opts.servedWidth,
    servedBytes: opts.servedBytes,
    undersized: opts.undersized === true,
    loaded: true,
  }));
  return {
    id: "r1",
    page: "https://shop.example/bags",
    locator: { component: ["Card"], selector: "img", classes: "", loader: "next-default" },
    tunable: { width: true, quality: true },
    current: {
      sizes: opts.current,
      srcsetCandidates: opts.widths.map((w) => ({ url: `https://shop.example/img.jpg?w=${w}`, width: w })),
      format: "avif",
    },
    perViewport,
    fix: {
      sizes: { value: opts.proposed, basis: "layout-formula", rung: "measured-page", branches: [] },
      bytes: { saved: 0, addedForSharpness: 0 },
    },
    evidence: { rung: "measured-page", notes: [] },
  } as unknown as ImageRecord;
}

/** Bytes per candidate width: about 0.05 bytes per pixel of width squared, so a larger file is always bigger. */
const bytesOfWidth = (w: number) => Math.round(w * w * 0.05);
const bytesOf = async (url: string) => {
  const w = Number(/w=(\d+)/.exec(url)?.[1]);
  return bytesOfWidth(w);
};
const widthsAt = { "iphone-15": 390, desktop: 1440 };

describe("sizesOutcomeOf", () => {
  it("finds the candidate the proposed sizes pick at each viewport and the bytes it costs", async () => {
    // Current sizes 100vw on a 390 px phone at dpr 3: the served 1170 px file. Proposed calc(100vw + 8px): 1194 px needed,
    // so the 1200 px file is picked instead, and it is bigger.
    const r = record({
      current: "100vw",
      proposed: "calc(100vw + 8px)",
      widths: [390, 780, 1170, 1200, 2000],
      servedWidth: 1170,
      servedBytes: bytesOfWidth(1170),
      viewports: [{ name: "iphone-15", dpr: 3, rendered: 390 }],
    });
    const outcome = await sizesOutcomeOf(r, new Map([["iphone-15", 390]]), 1, bytesOf);
    expect(outcome?.saved).toBe(0);
    expect(outcome?.grew).toBeCloseTo(bytesOfWidth(1200) - bytesOfWidth(1170), 6);
    expect(outcome?.biggerAt).toEqual(["iphone-15"]);
  });
});

describe("applySizesOutcome", () => {
  it("drops a sizes proposal that makes bytes rise, and says why", async () => {
    const r = record({
      current: "100vw",
      proposed: "calc(100vw + 8px)",
      widths: [390, 780, 1170, 1200, 2000],
      servedWidth: 1170,
      servedBytes: bytesOfWidth(1170),
      viewports: [{ name: "iphone-15", dpr: 3, rendered: 390 }],
    });
    await applySizesOutcome([r], new Map([["iphone-15", 390]]), 1, bytesOf);
    expect(r.fix.sizes).toBeUndefined();
    expect(r.fix.noSaving).toBe("no saving: proposed sizes calc(100vw + 8px) picks larger candidates at iphone-15");
    expect(r.fix.bytes.saved).toBe(0);
    expect(r.fix.bytes.sizes).toBe(0);
  });

  it("drops a proposal whose candidates are all the same size as the file now (the source is smaller than they are)", async () => {
    // Every candidate is served at the same bytes (the source image is 714 px wide): the proposal changes no bytes.
    const same = async () => bytesOfWidth(1200);
    const r = record({
      current: "100vw",
      proposed: "714px",
      widths: [640, 750, 1200],
      servedWidth: 1200,
      servedBytes: bytesOfWidth(1200),
      undersized: true,
      viewports: [{ name: "desktop", dpr: 2, rendered: 714 }],
    });
    await applySizesOutcome([r], new Map([["desktop", 1440]]), 1, same);
    expect(r.fix.noSaving).toBe("no saving: proposed sizes 714px pick files of the same size as now");
    expect(r.fix.sizes).toBeUndefined();
  });

  it("keeps a proposal that saves, with the predicted saving as its sizes part", async () => {
    const r = record({
      current: "100vw",
      proposed: "33vw",
      widths: [390, 780, 1170, 1200, 2000],
      servedWidth: 1200,
      servedBytes: bytesOfWidth(1200),
      viewports: [{ name: "desktop", dpr: 1, rendered: 475 }],
    });
    await applySizesOutcome([r], new Map([["desktop", 1440]]), 1, bytesOf);
    // 33vw at 1440 is 475 px: the 780 px file (smaller than the served 1200 px one) is picked.
    expect(r.fix.sizes?.value).toBe("33vw");
    expect(r.fix.noSaving).toBeUndefined();
    expect(r.fix.bytes.sizes).toBe(bytesOfWidth(1200) - bytesOfWidth(780));
    expect(r.fix.bytes.saved).toBe(r.fix.bytes.sizes);
  });

  it("does not count growth on an undersized image as a bytes rise (it is a sharpness fix)", async () => {
    const r = record({
      current: "33vw",
      proposed: "calc(100vw + 8px)",
      widths: [390, 780, 1170, 1200, 2000],
      servedWidth: 780,
      servedBytes: bytesOfWidth(780),
      undersized: true,
      viewports: [{ name: "iphone-15", dpr: 3, rendered: 390 }],
    });
    await applySizesOutcome([r], new Map([["iphone-15", 390]]), 1, bytesOf);
    expect(r.fix.noSaving).toBeUndefined();
    expect(r.fix.sizes?.value).toBe("calc(100vw + 8px)");
  });

  it("leaves the record alone when a candidate cannot be read", async () => {
    const r = record({
      current: "100vw",
      proposed: "33vw",
      widths: [390, 780, 1170],
      servedWidth: 1170,
      servedBytes: bytesOfWidth(1170),
      viewports: [{ name: "desktop", dpr: 1, rendered: 475 }],
    });
    await applySizesOutcome([r], new Map([["desktop", 1440]]), 1, async () => undefined);
    expect(r.fix.sizes?.value).toBe("33vw");
    expect(r.fix.noSaving).toBeUndefined();
  });

  it("divides by the viewports of the scan, as the page's own numbers do", async () => {
    const r = record({
      current: "100vw",
      proposed: "33vw",
      widths: [390, 780, 1170, 1200, 2000],
      servedWidth: 1200,
      servedBytes: bytesOfWidth(1200),
      viewports: [{ name: "desktop", dpr: 1, rendered: 475 }],
    });
    const one = await sizesOutcomeOf(r, new Map([["desktop", 1440]]), 1, bytesOf);
    const two = await sizesOutcomeOf(r, new Map([["desktop", 1440]]), 2, bytesOf);
    expect(two?.saved).toBeCloseTo((one?.saved ?? 0) / 2, 6);
  });
});
