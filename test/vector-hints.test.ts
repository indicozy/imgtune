// The vector check in the hints and the summary: a passing SVG leads the hint when it is the larger saving; a flat image
// with no passing SVG gets one note (no byte claim) only when it is big enough.
import { describe, expect, it } from "vitest";
import { hintsOf, renderHint, vectorHinted } from "../src/hints.js";
import { vectorLine } from "../src/summary.js";
import type { ImageRecord } from "../src/images.js";
import type { PageResult } from "../src/remote.js";
import { VECTOR_LOOKS_MIN_BYTES } from "../src/vector-art.js";

function image(id: string, bytes: number, vector: ImageRecord["fix"]["vector"], saved = 0): ImageRecord {
  return {
    id,
    page: "https://site.test/",
    locator: { component: ["Logo"], file: "src/Logo.tsx", line: 4, kind: "image", verified: true, selector: "img", classes: "", loader: "plain-img" },
    tunable: { width: true, quality: true },
    current: { src: `https://site.test/${id}.png`, sizes: "100vw", srcsetCandidates: [], format: "png" },
    perViewport: [
      { viewport: "desktop", domIndex: 0, dpr: 1, renderedCssPx: 600, neededPx: 600, servedBytes: bytes, undersized: false, loaded: true, lcp: false },
    ],
    fix: { sizes: undefined, bytes: { saved, addedForSharpness: 0, sizes: 0, quality: saved }, vector },
    evidence: { rung: "measured", notes: [] },
  } as unknown as ImageRecord;
}

const flat = { uniqueColors: 4, top16Share: 1, alphaBinaryShare: 1, smoothShare: 0, megapixels: 0.1, flat: true };

function pageOf(images: ImageRecord[]): PageResult {
  return { url: "https://site.test/", host: "site.test", viewports: ["desktop"], images, status: "ok" } as unknown as PageResult;
}

describe("vector hints", () => {
  it("leads with the SVG when it wins, and keeps the raster fix as a fallback line", () => {
    const won = image("w", 9216, { flatness: flat, passed: true, wins: true, svgBytes: 2253, score: 77.2, badPixelShare: 0.013, savedPerView: 6963, tracedFile: "svg/w.svg" }, 6963);
    const [hint] = hintsOf(pageOf([won]));
    const lines = renderHint(hint, 1);
    const vectorAt = lines.findIndex((l) => l.includes("vector art: serve SVG"));
    expect(vectorAt).toBeGreaterThan(0);
    expect(lines[vectorAt]).toContain("~2.2 KB (br) vs 9.0 KB now");
    expect(lines[vectorAt]).toContain("fidelity 77 at half size (bar 70)");
    expect(lines[vectorAt]).toContain("traced one: svg/w.svg");
    expect(vectorAt).toBeLessThan(lines.findIndex((l) => l.includes("sizes ")));
    expect(hint.bytes.saved).toBe(6963);
  });

  it("puts a passing SVG that does not win after the raster lines, and claims no more than the raster saving", () => {
    const lost = image("l", 9216, { flatness: flat, passed: true, svgBytes: 2253, score: 80, badPixelShare: 0, savedPerView: 6963 }, 8000);
    const [hint] = hintsOf(pageOf([lost]));
    const lines = renderHint(hint, 1);
    expect(lines.findIndex((l) => l.includes("vector art: serve SVG"))).toBeGreaterThan(lines.findIndex((l) => l.includes("saves ")));
    expect(hint.bytes.saved).toBe(8000);
  });

  it("gives a flat image of 10 KB or more with no passing SVG one note and no byte claim", () => {
    const note = image("n", VECTOR_LOOKS_MIN_BYTES + 1, { flatness: flat, notChecked: "over --svg-budget" });
    expect(vectorHinted(note)).toBe(true);
    const [hint] = hintsOf(pageOf([note]));
    expect(renderHint(hint, 1).join("\n")).toContain("looks like vector art (flat colors); if a source SVG exists, serve it");
    expect(hint.bytes.saved).toBe(0);
  });

  it("leaves out a small flat image with no passing SVG", () => {
    const small = image("s", VECTOR_LOOKS_MIN_BYTES - 1, { flatness: flat, notChecked: "over --svg-budget" });
    expect(vectorHinted(small)).toBe(false);
    expect(hintsOf(pageOf([small]))).toHaveLength(0);
  });

  it("counts the flat images and the traced ones in the summary line", () => {
    const pages = [
      pageOf([
        image("a", 9216, { flatness: flat, passed: true, wins: true, svgBytes: 2000, score: 77, badPixelShare: 0, savedPerView: 4096 }, 4096),
        image("b", 9216, { flatness: flat, notChecked: "trace failed" }),
      ]),
    ];
    expect(vectorLine(pages)).toBe("vector art: 2 image(s) look like vector art, 1 traced to a smaller SVG, 4.0 KB/view");
    expect(vectorLine([pageOf([])])).toBeUndefined();
  });
});
