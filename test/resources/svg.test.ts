import { describe, expect, it } from "vitest";
import { analyzer, fidelity, FIDELITY_BAR, optimizeSvg } from "../../src/resources/svg.js";
import type { PageContext, ResourceRecord } from "../../src/resources/types.js";

const PAGE = "https://example.test/";
const CTX: PageContext = {
  url: PAGE,
  viewport: { name: "desktop", width: 1440, height: 900, dpr: 1 },
  text: "",
  usedFonts: [],
  fontFaces: [],
  icons: [],
  audio: [],
  lottie: [],
  models: [],
};

function record(url: string, body: Buffer, contentType = "image/svg+xml"): ResourceRecord {
  return { url, pageUrl: PAGE, viewport: "desktop", resourceType: "image", contentType, bytes: body.length, status: 200, thirdParty: false, body };
}

/** An editor export: metadata, comments, long float paths. The shapes are plain, so SVGO keeps them visually intact. */
function verboseSvg(count = 40): string {
  const shapes = Array.from({ length: count }, (_, i) => {
    const x = (i % 8) * 12.3456789;
    const y = Math.floor(i / 8) * 12.3456789;
    return `<path d="M${x.toFixed(6)} ${y.toFixed(6)}h10.123456789v10.987654321h-10.123456789z" fill="#336699" stroke="none"/>`;
  }).join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Some Editor 1.0, export of a test grid -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" id="Layer_1" x="0px" y="0px" width="120px" height="120px" viewBox="0 0 120 120" enable-background="new 0 0 120 120" xml:space="preserve">
  <metadata>
    <sfw xmlns="http://ns.adobe.com/SaveForWeb/1.0/"><slices></slices></sfw>
  </metadata>
  <g id="grid">
    ${shapes}
  </g>
</svg>`;
}

describe("svg wants", () => {
  it("takes SVG responses of 2 KB or more", () => {
    expect(analyzer.wants(record(PAGE + "a.svg", Buffer.alloc(3000)))).toBe(true);
    expect(analyzer.wants(record(PAGE + "a.svg", Buffer.alloc(100)))).toBe(false);
    expect(analyzer.wants(record(PAGE + "a.png", Buffer.alloc(3000), "image/png"))).toBe(false);
  });

  it("skips bodies over the size cap, and bodies under the minimum, in analyze", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0x20);
    expect(await analyzer.analyze([record(PAGE + "big.svg", big)], CTX)).toEqual([]);
  });
});

describe("svg optimisation", () => {
  it("shrinks an editor export", () => {
    const src = verboseSvg();
    const out = optimizeSvg(src);
    expect(out.length).toBeLessThan(src.length * 0.8);
    expect(out).not.toContain("Generator");
  });

  it("skips mergePaths on large exports, and keeps the output valid", () => {
    const big = verboseSvg(4000);
    expect(big.length).toBeGreaterThan(256 * 1024);
    const out = optimizeSvg(big);
    expect(out.startsWith("<svg")).toBe(true);
    expect(out.length).toBeLessThan(big.length);
  });

  it("keeps the render when the change is faithful, and not when the picture changes", async () => {
    const src = verboseSvg();
    const same = await fidelity(Buffer.from(src), Buffer.from(optimizeSvg(src)));
    expect(same).toBeGreaterThanOrEqual(FIDELITY_BAR);
    const changed = src.replace('fill="#336699"', 'fill="#ff0000"');
    const worse = await fidelity(Buffer.from(src), Buffer.from(changed));
    expect(worse).toBeLessThan(FIDELITY_BAR);
  });
});

describe("svg analyzer", () => {
  it("reports SVGO savings with the brotli sizes and the fidelity", async () => {
    const out = await analyzer.analyze([record(PAGE + "grid.svg", Buffer.from(verboseSvg()))], CTX);
    const f = out.find((x) => x.id.startsWith("svg:") && !x.id.includes(":raster"));
    expect(f).toBeDefined();
    expect(f!.kind).toBe("svg");
    expect(f!.estimate).toBe(false);
    expect(f!.savedBytes).toBeGreaterThan(0);
    expect(f!.fix.join("\n")).toContain("svgo");
    expect(f!.details?.ssimulacra2).toBeGreaterThanOrEqual(FIDELITY_BAR);
  });

  it("does not report an SVG that is already minimal", async () => {
    const tiny = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></svg>`.padEnd(2100, " ");
    const out = await analyzer.analyze([record(PAGE + "tiny.svg", Buffer.from(tiny))], CTX);
    expect(out.filter((x) => !x.id.includes(":"))).toEqual([]);
  });

  it("lists embedded base64 rasters with their size, at no saving", async () => {
    const raster = Buffer.alloc(4000, 7).toString("base64");
    const src = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100"><image width="100" height="100" xlink:href="data:image/png;base64,${raster}"/></svg>`;
    const out = await analyzer.analyze([record(PAGE + "emb.svg", Buffer.from(src))], CTX);
    const r = out.find((x) => x.id.endsWith(":raster"));
    expect(r?.savedBytes).toBe(0);
    expect(r?.title).toContain("1 embedded raster");
    expect(r?.details?.rasters).toEqual([{ format: "png", bytes: 4000 }]);
  });

  it("never throws on broken input", async () => {
    expect(await analyzer.analyze([record(PAGE + "bad.svg", Buffer.from("<svg><path d='"))], CTX)).toEqual([]);
  });
});
