import { describe, expect, it } from "vitest";
import { applyCdnPolicies, CDN_AUTO_QUALITY_SHARE, loaderOf, qualityHintFor, type Instance } from "../src/remote.js";
import { formatAutoOf } from "../src/loaders.js";

const PAGE = "https://shop.example/bags";

function instance(overrides: Partial<Instance>): Instance {
  return {
    viewport: { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false },
    element: 0,
    img: { index: 0, currentSrc: "https://res.cloudinary.com/demo/image/upload/q_auto/a.jpg", renderedWidth: 300, renderedHeight: 200, srcset: "", classes: "", nextImage: false, inFirstViewport: true },
    url: "https://res.cloudinary.com/demo/image/upload/q_auto/a.jpg",
    bytes: 100_000,
    pixelWidth: 1000,
    renderedWidth: 300,
    needed: 300,
    kind: "srcset",
    exact: 0,
    est: 0,
    estAggressive: 0,
    growth: 0,
    group: "card",
    loader: "cloudinary",
    qualityParam: "auto",
    ...overrides,
  };
}

describe("applyCdnPolicies (q_auto)", () => {
  it("handles a group whose est. quality saving is below the share of its served bytes: the saving is not counted", () => {
    const small = instance({ est: CDN_AUTO_QUALITY_SHARE * 100_000 - 1 });
    applyCdnPolicies([small], 1);
    expect(small.est).toBe(0);
    expect(small.cdnQuality).toEqual({ handled: true, saved: CDN_AUTO_QUALITY_SHARE * 100_000 - 1 });
    expect(qualityHintFor("cloudinary", "auto", 80, small.cdnQuality)).toBe("quality handled by cloudinary (q_auto)");
  });

  it("keeps the saving of a group at or above the share, and names the explicit quality", () => {
    const big = instance({ est: 30_000 });
    applyCdnPolicies([big], 1);
    expect(big.est).toBe(30_000);
    expect(big.cdnQuality?.handled).toBe(false);
    expect(qualityHintFor("cloudinary", "auto", 80, big.cdnQuality)).toBe("cloudinary: q_auto leaves 29 KB per view; an explicit q_80 passes SSIMULACRA2");
  });

  it("measures the share on the group's bytes per view, over the viewports", () => {
    const desktop = instance({ viewport: { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false }, est: 4_000 });
    const phone = instance({ viewport: { name: "iphone-15", width: 390, height: 844, dpr: 3, mobile: true }, element: 1, est: 4_000 });
    applyCdnPolicies([desktop, phone], 2);
    // Two viewports, 100 KB served each: 4 KB per view of est. is below 10% of 100 KB.
    expect(desktop.cdnQuality?.handled).toBe(true);
    expect(desktop.est).toBe(0);
  });

  it("leaves an image without q_auto alone", () => {
    const explicit = instance({ qualityParam: "yes", loader: "cloudinary", est: 1 });
    applyCdnPolicies([explicit], 1);
    expect(explicit.est).toBe(1);
    expect(explicit.cdnQuality).toBeUndefined();
  });

  it("drops the format saving of a jpeg the CDN negotiates the format of", () => {
    const jpeg = instance({ formatAuto: true, qualityParam: "yes", format: "jpeg", est: 9_000, estAggressive: 9_000 });
    applyCdnPolicies([jpeg], 1);
    expect(jpeg.est).toBe(0);
    expect(jpeg.estAggressive).toBe(0);
    const webp = instance({ formatAuto: true, qualityParam: "yes", format: "webp", est: 9_000 });
    applyCdnPolicies([webp], 1);
    expect(webp.est).toBe(9_000);
  });

  it("gives an unnamed auto group the handled text when it has no measure", () => {
    expect(qualityHintFor("cloudinary", "auto", undefined)).toBe("quality handled by cloudinary (q_auto)");
  });
});

describe("loader detection of CDN format negotiation", () => {
  it("sees Cloudinary f_auto and imgix auto=format, and nothing else", () => {
    expect(formatAutoOf("https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/a.jpg", PAGE)).toBe(true);
    expect(formatAutoOf("https://img.example.com/c_fill,w_300,f_auto/a.jpg", PAGE)).toBe(true);
    expect(formatAutoOf("https://demo.imgix.net/a.jpg?auto=format,compress", PAGE)).toBe(true);
    expect(formatAutoOf("https://res.cloudinary.com/demo/image/upload/q_auto/a.jpg", PAGE)).toBe(false);
    expect(formatAutoOf("https://demo.imgix.net/a.jpg?auto=compress", PAGE)).toBe(false);
    expect(formatAutoOf("/_next/image?url=%2Fa.jpg&w=640&q=75", PAGE)).toBe(false);
  });

  it("marks formatAuto on the loader of such a URL only", () => {
    expect(loaderOf("https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/a.jpg", PAGE)).toEqual({ loader: "cloudinary", qualityParam: "auto", formatAuto: true });
    expect(loaderOf("https://res.cloudinary.com/demo/image/upload/q_auto/a.jpg", PAGE)).toEqual({ loader: "cloudinary", qualityParam: "auto" });
  });
});
