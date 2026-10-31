import { describe, expect, it } from "vitest";
import { compareImage, parseRecheckArgs } from "../src/recheck.js";
import type { ImageRecord } from "../src/images.js";

/** A record with one viewport, for the comparison rules. */
function record(overrides: { renderedCssPx?: number; servedBytes?: number; undersized?: boolean; sizes?: string; saved?: number; src?: string } = {}): ImageRecord {
  return {
    id: "abc123",
    page: "https://shop.example/",
    locator: { component: ["Card"], selector: "img", classes: "", loader: "next-default" },
    tunable: { width: true, quality: true },
    current: { src: overrides.src ?? "/_next/image?url=a&w=640", srcsetCandidates: [], format: "avif" },
    perViewport: [
      {
        viewport: "iphone-15",
        dpr: 3,
        renderedCssPx: overrides.renderedCssPx ?? 342,
        neededPx: 1026,
        servedBytes: overrides.servedBytes ?? 100_000,
        undersized: overrides.undersized ?? false,
        loaded: true,
      },
    ],
    fix: {
      sizes: overrides.sizes !== undefined ? { value: overrides.sizes, basis: "layout-formula", rung: "measured-page", branches: [] } : undefined,
      bytes: { saved: overrides.saved ?? 20_000, addedForSharpness: 0 },
    },
    evidence: { rung: "measured-page", notes: [] },
  } as unknown as ImageRecord;
}

describe("parseRecheckArgs", () => {
  it("reads the scan file and the image ids", () => {
    expect(parseRecheckArgs(["--recheck", "scan.json", "--ids", "a1, b2,,"])).toEqual({ file: "scan.json", ids: ["a1", "b2"] });
  });

  it("needs the scan file, and refuses other options", () => {
    expect(() => parseRecheckArgs(["--ids", "a1"])).toThrow(/usage: imgtune scan --recheck/);
    expect(() => parseRecheckArgs(["--recheck", "scan.json", "--out", "x"])).toThrow(/is not an option of --recheck/);
    expect(() => parseRecheckArgs(["--recheck", "scan.json", "--ids", ",,"])).toThrow(/at least one image id/);
  });
});

describe("compareImage", () => {
  it("passes an image whose served bytes fell and that stayed sharp", () => {
    const check = compareImage(record({ servedBytes: 200_000 }), record({ servedBytes: 120_000, sizes: "calc(100vw - 32px)" }), false);
    expect(check.failures).toEqual([]);
    expect(check.lines.join("\n")).toContain("served 195 KB -> 117 KB");
  });

  it("fails an image that became undersized", () => {
    const check = compareImage(record({ undersized: false }), record({ undersized: true }), false);
    expect(check.failures).toEqual(["iphone-15: became undersized"]);
  });

  it("fails bytes that rose without a sharpness fix, and passes them when the image was undersized and is now sharp", () => {
    expect(compareImage(record({ servedBytes: 100_000 }), record({ servedBytes: 150_000 }), false).failures).toHaveLength(1);
    expect(compareImage(record({ servedBytes: 100_000, undersized: true }), record({ servedBytes: 150_000, undersized: false }), false).failures).toEqual([]);
  });

  it("reuses the saving of an image whose src did not change, and says so", () => {
    const check = compareImage(record({ saved: 30_000 }), record({ saved: 0 }), true);
    expect(check.lines.join("\n")).toContain("saves 29 KB -> 29 KB (src unchanged: estimate reused)");
  });

  it("fails an image that is no longer on the page", () => {
    expect(compareImage(record(), undefined, false).failures).toEqual(["gone"]);
  });
});
