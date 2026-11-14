// The resource analyzers (src/resources/): compression and favicons on synthetic records, the phase's dedupe across
// viewports, and the text rendering. No browser: the capture is tested in resources-scan.test.ts.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { analyzer as compression, MIN_BYTES, SAMPLE_BYTES } from "../src/resources/compression.js";
import { analyzer as favicon, largestPngFrame } from "../src/resources/favicon.js";
import { analyzeResources, runPhaseWith } from "../src/resources/phase.js";
import { completeFontFaces, fontFaceRulesOf } from "../src/resources/capture.js";
import { resourceLinesOf, resourceTotalsLine } from "../src/resources/report.js";
import { ANALYZERS } from "../src/resources/index.js";
import type { PageContext, ResourceAnalyzer, ResourceFinding, ResourceRecord } from "../src/resources/types.js";
import type { Viewport } from "../src/types.js";

const page = "https://site.example/";

/** A repetitive text body of about `bytes` bytes: compresses well, so brotli saves most of it. */
function textBody(bytes: number): Buffer {
  const line = ".card-item{display:flex;margin:0 auto;color:#334455;transition:all .2s ease}\n";
  return Buffer.from(line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes));
}

function recordOf(over: Partial<ResourceRecord> & { url: string; body?: Buffer }): ResourceRecord {
  const body = over.body;
  return {
    pageUrl: page,
    viewport: "desktop",
    resourceType: "script",
    contentType: "text/javascript",
    bytes: body?.length ?? 0,
    status: 200,
    thirdParty: false,
    ...over,
  };
}

function contextOf(over: Partial<PageContext> = {}): PageContext {
  return {
    url: page,
    viewport: { name: "desktop", width: 1440, height: 900, dpr: 1 },
    text: "",
    usedFonts: [],
    fontFaces: [],
    icons: [],
    audio: [],
    lottie: [],
    models: [],
    ...over,
  };
}

const noFetch = { get: async () => undefined } as unknown as Parameters<typeof analyzeResources>[2]["fetcher"];

describe("compression analyzer", () => {
  it("wants an uncompressed text-like response of at least 1 KB, and nothing else", () => {
    const big = recordOf({ url: `${page}a.js`, bytes: 5000 });
    expect(compression.wants(big)).toBe(true);
    expect(compression.wants({ ...big, contentEncoding: "br" })).toBe(false);
    expect(compression.wants({ ...big, bytes: MIN_BYTES - 1 })).toBe(false);
    expect(compression.wants({ ...big, contentType: "image/png" })).toBe(false);
    expect(compression.wants({ ...big, contentType: "image/svg+xml" })).toBe(true);
    expect(compression.wants({ ...big, contentType: "font/woff2" })).toBe(false);
    expect(compression.wants({ ...big, status: 404 })).toBe(false);
  });

  it("reports the brotli saving of a text body, measured", async () => {
    const body = textBody(60_000);
    const [finding] = await compression.analyze([recordOf({ url: `${page}app.js`, body, bytes: body.length })], contextOf());
    expect(finding).toBeDefined();
    expect(finding.kind).toBe("compression");
    expect(finding.estimate).toBe(false);
    expect(finding.bytes).toBe(60_000);
    expect(finding.savedBytes).toBeGreaterThan(40_000);
    expect(finding.savedBytes).toBeLessThanOrEqual(60_000);
    expect(finding.details).toMatchObject({ host: "site.example", contentType: "text/javascript", files: 1 });
    expect(finding.fix.join(" ")).toMatch(/brotli/);
  });

  it("groups the files of one host and content type into one finding", async () => {
    const a = textBody(30_000);
    const b = textBody(40_000);
    const findings = await compression.analyze(
      [recordOf({ url: `${page}a.js`, body: a, bytes: a.length }), recordOf({ url: `${page}b.js`, body: b, bytes: b.length })],
      contextOf(),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({ files: 2, bytes: 70_000 });
  });

  it("drops a group that saves less than 1 KB, and a record with no body", async () => {
    const noise = randomBytes(4096);
    expect(await compression.analyze([recordOf({ url: `${page}n.js`, body: noise, bytes: noise.length })], contextOf())).toEqual([]);
    expect(await compression.analyze([recordOf({ url: `${page}x.js`, bytes: 90_000 })], contextOf())).toEqual([]);
  });

  it("encodes only a sample of a body over the sample size, and labels it an estimate", async () => {
    const body = textBody(SAMPLE_BYTES + 500_000);
    const [finding] = await compression.analyze([recordOf({ url: `${page}big.js`, body, bytes: body.length })], contextOf());
    expect(finding?.estimate).toBe(true);
    expect(finding?.savedBytes).toBeGreaterThan(0);
  });
});

/** A PNG of `px` square with noise, so its size is real (not a flat colour that compresses to nothing). */
async function noisyPng(px: number, sigma = 60): Promise<Buffer> {
  return sharp({ create: { width: px, height: px, channels: 3, background: "#4a7", noise: { type: "gaussian", mean: 128, sigma } } })
    .png()
    .toBuffer();
}

/** An ICO file with one PNG frame of the given image. */
function icoOf(png: Buffer, px: number): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = px === 256 ? 0 : px;
  entry[1] = px === 256 ? 0 : px;
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

describe("favicon analyzer", () => {
  it("reads the largest PNG frame of an ICO", async () => {
    const png = await noisyPng(64, 10);
    expect(largestPngFrame(icoOf(png, 64))?.equals(png)).toBe(true);
    expect(largestPngFrame(Buffer.from("not an icon at all"))).toBeUndefined();
  });

  it("flags a favicon over 10 KB with a measured 32 px re-encode", async () => {
    const body = await noisyPng(512);
    const url = `${page}favicon.png`;
    const ctx = contextOf({ icons: [{ rel: "icon", href: url, type: "image/png" }] });
    const [finding] = await favicon.analyze([recordOf({ url, contentType: "image/png", body, bytes: body.length, resourceType: "image" })], ctx);
    expect(finding).toBeDefined();
    expect(finding.estimate).toBe(false);
    expect(finding.details).toMatchObject({ role: "favicon", px: 32 });
    expect(finding.savedBytes).toBeGreaterThan(body.length * 0.9);
    expect(finding.title).toMatch(/per first visit/);
  });

  it("reads an ICO through its PNG frame", async () => {
    const png = await noisyPng(256);
    const body = icoOf(png, 256);
    const url = `${page}favicon.ico`;
    const [finding] = await favicon.analyze([recordOf({ url, contentType: "image/x-icon", body, bytes: body.length, resourceType: "other" })], contextOf());
    expect(finding?.savedBytes).toBeGreaterThan(0);
    expect(finding?.details).toMatchObject({ source: "256x256" });
  });

  it("flags an apple-touch-icon over 30 KB against 180 px, and leaves a small icon alone", async () => {
    const big = await noisyPng(1024);
    const small = await noisyPng(16, 5);
    const apple = `${page}apple.png`;
    const tiny = `${page}small.png`;
    const ctx = contextOf({
      icons: [
        { rel: "apple-touch-icon", href: apple },
        { rel: "icon", href: tiny },
      ],
    });
    const findings = await favicon.analyze(
      [
        recordOf({ url: apple, contentType: "image/png", body: big, bytes: big.length, resourceType: "image" }),
        recordOf({ url: tiny, contentType: "image/png", body: small, bytes: small.length, resourceType: "image" }),
      ],
      ctx,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({ role: "apple-touch", px: 180 });
  });
});

describe("resource phase", () => {
  const desktop: Viewport = { name: "desktop", width: 1440, height: 900, dpr: 1, mobile: false };
  const phone: Viewport = { name: "phone", width: 390, height: 844, dpr: 3, mobile: true };

  it("dedupes the findings of the viewports by id, keeping the largest bytes", async () => {
    const body = textBody(50_000);
    const url = `${page}shared.js`;
    const views = [
      { viewport: desktop, resources: [recordOf({ url, body, bytes: body.length, viewport: "desktop" })] },
      { viewport: phone, resources: [recordOf({ url, body: body.subarray(0, 40_000), bytes: 40_000, viewport: "phone" })] },
    ];
    const findings = await analyzeResources(views, page, { fetcher: noFetch, allowPrivate: false });
    expect(findings).toHaveLength(1);
    expect(findings[0].bytes).toBe(50_000);
  });

  it("fetches a declared icon the page did not load, and sniffs its type", async () => {
    const png = await noisyPng(512);
    const iconUrl = `${page}icon-512.png`;
    const fetcher = { get: async (url: string) => (url === iconUrl ? png : undefined) } as unknown as Parameters<typeof analyzeResources>[2]["fetcher"];
    const views = [{ viewport: desktop, resources: [], pageContext: { ...contextOf(), icons: [{ rel: "icon", href: iconUrl }] } }];
    const findings: ResourceFinding[] = await analyzeResources(views, page, { fetcher, allowPrivate: false });
    expect(findings.map((f) => f.kind)).toEqual(["favicon"]);
    expect(findings[0].url).toBe(iconUrl);
  });

  it("does not judge a fetched icon's encoding: only the favicon analyzer takes it", async () => {
    // A mask icon (SVG) the page never loaded: the phase fetches it, decoded, so compression must not see it.
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${"<path d='M0 0L10 10'/>".repeat(200)}</svg>`);
    const url = `${page}mask.svg`;
    const fetcher = { get: async () => svg } as unknown as Parameters<typeof analyzeResources>[2]["fetcher"];
    const views = [{ viewport: desktop, resources: [], pageContext: { ...contextOf(), icons: [{ rel: "mask-icon", href: url }] } }];
    const findings = await analyzeResources(views, page, { fetcher, allowPrivate: false });
    expect(findings.filter((f) => f.kind === "compression")).toEqual([]);
  });

  it("fetches again a wanted response the capture kept no body for, once per URL", async () => {
    const body = textBody(50_000);
    const url = `${page}range.js`;
    const calls: string[] = [];
    const fetcher = { get: async (u: string) => (calls.push(u), body) } as unknown as Parameters<typeof analyzeResources>[2]["fetcher"];
    const bodiless = recordOf({ url, bytes: 50_000, status: 206, viewport: "desktop" });
    const views = [
      { viewport: desktop, resources: [bodiless] },
      { viewport: phone, resources: [{ ...bodiless, viewport: "phone" }] },
    ];
    const findings = await analyzeResources(views, page, { fetcher, allowPrivate: false });
    expect(calls.filter((u) => u === url)).toEqual([url]);
    expect(findings.map((f) => f.kind)).toEqual(["compression"]);
  });

  it("does not fetch again a response that no analyzer wants", async () => {
    const url = `${page}photo.png`;
    const calls: string[] = [];
    const fetcher = { get: async (u: string) => (calls.push(u), Buffer.alloc(10)) } as unknown as Parameters<typeof analyzeResources>[2]["fetcher"];
    await analyzeResources([{ viewport: desktop, resources: [recordOf({ url, contentType: "video/mp4", bytes: 9_000_000, body: undefined })] }], page, { fetcher, allowPrivate: false });
    expect(calls.filter((u) => u === url)).toEqual([]);
  });

  it("keeps a cross-site icon under the third-party policy (images are a kept type)", async () => {
    const png = await noisyPng(512);
    const icon = "https://cdn.other.example/i.png";
    const calls: string[] = [];
    const fetcher = { get: async (url: string) => (calls.push(url), png) } as unknown as Parameters<typeof analyzeResources>[2]["fetcher"];
    const views = [{ viewport: desktop, resources: [], pageContext: { ...contextOf(), icons: [{ rel: "icon", href: icon }] } }];
    const findings = await analyzeResources(views, page, { fetcher, allowPrivate: false, thirdParty: { block: true, allowHosts: [] } });
    expect(calls).toEqual([icon]);
    expect(findings[0]?.url).toBe(icon);
  });
});

describe("font face URLs from stylesheet text", () => {
  it("reads the src URL and unicode-range of each rule, made absolute against the sheet", () => {
    const css = `@font-face{font-family:"Inter";font-weight:400;font-style:normal;src:url(/f/inter.woff2) format("woff2");unicode-range:U+0000-00FF}
@font-face{font-family:Inter;font-weight:700;src:local(Inter), url("../f/inter-bold.woff2")}`;
    const rules = fontFaceRulesOf(css, "https://cdn.example/css/site.css");
    expect(rules).toEqual([
      { family: "inter", weight: "400", style: "normal", unicodeRange: "U+0000-00FF", url: "https://cdn.example/f/inter.woff2" },
      { family: "inter", weight: "700", style: "normal", unicodeRange: undefined, url: "https://cdn.example/f/inter-bold.woff2" },
    ]);
  });

  it("completes a face the CSSOM left without a URL, and keeps the faces no rule matches", () => {
    const rules = fontFaceRulesOf(`@font-face{font-family:Inter;font-weight:400;src:url(https://cdn.example/a.woff2)}`, "https://x.example/s.css");
    const faces = [
      { family: "Inter", weight: "400", style: "normal", status: "loaded" },
      { family: "Other", weight: "400", style: "normal", status: "loaded" },
    ];
    const [inter, other] = completeFontFaces(faces, rules);
    expect(inter.url).toBe("https://cdn.example/a.woff2");
    expect(other.url).toBeUndefined();
  });
});

describe("cross-viewport merge", () => {
  const desktop: Viewport = { name: "desktop", width: 1440, height: 900, dpr: 1, mobile: false };
  const phone: Viewport = { name: "phone", width: 390, height: 844, dpr: 3, mobile: true };
  const unusedFace = (url: string): ResourceFinding => ({
    id: "font:face",
    kind: "font",
    url,
    bytes: 1000,
    savedBytes: 0,
    estimate: false,
    title: "unused face",
    fix: [],
    details: { unused: true, perViewport: "all" },
  });

  it("keeps a perViewport-all finding only when every viewport reports it", async () => {
    const finder = (views: string[]) => ({
      kind: "font" as const,
      wants: () => true,
      analyze: async (_r: ResourceRecord[], ctx: PageContext) => (views.includes(ctx.viewport.name) ? [unusedFace(`${page}f.woff2`)] : []),
    });
    expect(await mergeWith(finder(["desktop"]), [desktop, phone])).toEqual([]);
    expect(await mergeWith(finder(["desktop", "phone"]), [desktop, phone])).toHaveLength(1);
  });

  it("sorts informational findings after the savings, and keeps them out of the totals", () => {
    const saving: ResourceFinding = { ...unusedFace("x"), id: "s", savedBytes: 500, details: undefined, title: "saves" };
    const info: ResourceFinding = { ...unusedFace("y"), id: "i", savedBytes: 0, details: undefined, title: "info" };
    const line = resourceTotalsLine([info, saving]);
    expect(line).toMatch(/^resources: 1 finding\(s\), saves ~0 KB\/view, 1 informational, not in the image totals$/);
    expect(resourceTotalsLine([info])).toMatch(/^resources: no saving, 1 informational/);
  });
});

/** Runs the phase with one analyzer registered in place of the defaults' behaviour: the kind is the analyzer's. */
async function mergeWith(analyzer: { kind: "font"; wants: () => boolean; analyze: (r: ResourceRecord[], c: PageContext) => Promise<ResourceFinding[]> }, viewports: Viewport[]): Promise<ResourceFinding[]> {
  // The phase reads the registry; the test drives the same merge through analyzeResources with a font record present.
  const views = viewports.map((viewport) => ({ viewport, resources: [recordOf({ url: `${page}f.woff2`, contentType: "font/woff2", body: Buffer.alloc(4) })] }));
  return runPhaseWith([analyzer as unknown as ResourceAnalyzer], views, page, { fetcher: noFetch, allowPrivate: false });
}

describe("resource report lines", () => {
  const finding: ResourceFinding = {
    id: "compression:abc",
    kind: "compression",
    url: `${page}app.js`,
    bytes: 60_000,
    savedBytes: 50_000,
    estimate: false,
    title: "1 text/javascript file(s) from site.example sent uncompressed",
    fix: ["enable brotli for text/javascript"],
  };

  it("totals the findings and marks an estimate", () => {
    expect(resourceTotalsLine([])).toBeUndefined();
    expect(resourceTotalsLine([finding])).toMatch(/^resources: 1 finding\(s\), saves ~49 KB\/view, not in the image totals$/);
    expect(resourceTotalsLine([{ ...finding, estimate: true }])).toMatch(/est\. in part/);
  });

  it("renders one row and its first fix line per finding", () => {
    const lines = resourceLinesOf([finding], (text) => text);
    expect(lines[0]).toMatch(/^ {2}resources:/);
    expect(lines[1]).toMatch(/^ {4}compression: 1 text\/javascript/);
    expect(lines[2]).toMatch(/^ {6}fix: enable brotli/);
    expect(resourceLinesOf([], (text) => text)).toEqual([]);
  });
});

describe("the analyzer registry", () => {
  it("registers one analyzer per kind, and each wants at least its own kind of response", () => {
    expect(ANALYZERS.map((a) => a.kind).sort()).toEqual(["audio", "compression", "favicon", "font", "lottie", "model", "svg"]);
    const fontFile: ResourceRecord = {
      url: "https://shop.example/inter.woff2",
      pageUrl: "https://shop.example/",
      viewport: "desktop",
      resourceType: "font",
      contentType: "font/woff2",
      bytes: 40_000,
      status: 200,
      thirdParty: false,
    };
    expect(ANALYZERS.find((a) => a.kind === "font")?.wants(fontFile)).toBe(true);
    expect(ANALYZERS.find((a) => a.kind === "model")?.wants(fontFile)).toBe(false);
  });

  it("adds no bytes for an informational finding (no saving) to the totals", () => {
    const info: ResourceFinding = { id: "favicon:x", kind: "favicon", url: "https://shop.example/favicon.ico", bytes: 50_000, savedBytes: 0, estimate: false, title: "favicon", fix: [] };
    const line = resourceTotalsLine([info]) ?? "";
    expect(line).toContain("no saving");
    expect(line).toContain("not in the image totals");
    expect(line).not.toMatch(/saves ~/);
  });
});
