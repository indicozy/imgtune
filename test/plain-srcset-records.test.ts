import { describe, expect, it } from "vitest";
import { buildImageRecords } from "../src/images.js";
import type { Instance, ObservedImage } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const PHONE_A: Viewport = { name: "phone-a", width: 375, height: 667, dpr: 2, mobile: true };
const PHONE_B: Viewport = { name: "phone-b", width: 390, height: 844, dpr: 3, mobile: true };
const DESK: Viewport = { name: "desk", width: 1440, height: 900, dpr: 2, mobile: false };
const DESK_1X: Viewport = { name: "desk-1x", width: 1280, height: 800, dpr: 1, mobile: false };
const PAGE = "https://example.test/";

/** A plain <img> with no srcset, 1200 px wide, rendered at `renderedWidth` CSS px at one viewport. */
function plain(viewport: Viewport, renderedWidth: number, src: string, est: number): Instance {
  const img = {
    index: 0,
    currentSrc: src,
    renderedWidth,
    renderedHeight: 60,
    srcset: "",
    classes: "",
    nextImage: false,
    inFirstViewport: false,
    locator: { selector: "img#hero", owners: [] },
  } as unknown as ObservedImage;
  return {
    viewport,
    element: 0,
    img,
    url: src,
    bytes: 90_000,
    pixelWidth: 1200,
    renderedWidth,
    needed: Math.ceil(renderedWidth * viewport.dpr),
    kind: "plain",
    exact: 0,
    est,
    estAggressive: est,
    growth: 0,
    group: "hero",
    loader: "generic",
    qualityParam: "none",
    format: "jpeg",
  } as unknown as Instance;
}

/** The phones at 88 CSS px and the desktop at 190 CSS px, as the scan of the real page measured them. */
function viewportsOf(src: string) {
  const instances = [plain(PHONE_A, 88, src, 300), plain(PHONE_B, 88, src, 300), plain(DESK_1X, 190, src, 300), plain(DESK, 190, src, 300)];
  const observations = [PHONE_A, PHONE_B, DESK_1X, DESK].map((viewport) => ({ viewport, responses: new Map(), images: [], load: "fresh", blocked: false, blockedRequests: 0, nextjs: false }));
  return { instances, observations };
}

const build = (src: string, nextjs = false) => {
  const { instances, observations } = viewportsOf(src);
  return buildImageRecords({
    pageUrl: PAGE,
    observations: observations.map((o) => ({ ...o, nextjs })) as never[],
    instances,
    refName: "phone-a",
    resolved: new Map(),
    currentQuality: () => ({ quality: 75, assumed: true }),
    nextjs,
  })[0];
};

describe("buildImageRecords: a plain image with no srcset", () => {
  it("gets the variant widths the viewports need, and books the whole saving as resize", () => {
    const record = build("https://cdn.example.net/hero.jpg");
    // Needs 176, 264, 190, 380 device px: rounded up to 10, then merged to three widths (190, 270, 380).
    expect(record.fix.srcset?.widths).toEqual([190, 270, 380]);
    expect(record.fix.srcset?.largest).toBe(380);
    expect(record.fix.bytes.saved).toBeGreaterThan(0);
    expect(record.fix.bytes.resize).toBe(record.fix.bytes.saved);
    expect(record.fix.bytes.sizes).toBe(0);
    expect(record.fix.bytes.quality).toBe(0);
    // Without a srcset, a sizes proposal does nothing, so the record carries none.
    expect(record.fix.sizes).toBeUndefined();
  });

  it("keeps the existing advice on a page with Next.js detected", () => {
    const record = build("https://cdn.example.net/hero.jpg", true);
    expect(record.fix.srcset).toBeUndefined();
    expect(record.fix.bytes.resize).toBeUndefined();
  });

  it("keeps a named adapter's advice: the loader there can resize by URL", () => {
    const record = build("https://res.cloudinary.com/demo/image/upload/v1/hero.jpg");
    expect(record.locator.loader).toBe("cloudinary");
    expect(record.fix.srcset).toBeUndefined();
    expect(record.fix.bytes.resize).toBeUndefined();
  });
});
