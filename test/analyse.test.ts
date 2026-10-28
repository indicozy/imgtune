import sharp from "sharp";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyse, decideBranches, evaluator, originalUrlFor, type AnalyseOptions } from "../src/analyse.js";
import { clearEncodeCache, encode, encodeCacheStats, loadReference, type EncoderProfile } from "../src/encode.js";
import type { ImageObservation } from "../src/measure.js";
import { readImageConfig, type ImageConfig } from "../src/nextconfig.js";
import type { ImageUsage, ImgtuneConfig, PropInfo } from "../src/types.js";
import type { RawImage } from "../src/ssim.js";
import { gradientNoise } from "./image-fixtures.js";

const BASE = "http://localhost:3999";
const SRC = [0, 1, 2].map((i) => `${BASE}/media/p${i}.jpg`);
const originals = new Map<string, Buffer>();

beforeAll(async () => {
  for (const [i, url] of SRC.entries()) {
    const img = gradientNoise(320, 240, 2, i + 1);
    originals.set(url, await sharp(img.data, { raw: { width: 320, height: 240, channels: 4 } }).jpeg({ quality: 92 }).toBuffer());
  }
});

const fetchStub = async (url: string): Promise<Buffer> => {
  const buffer = originals.get(url);
  if (!buffer) throw new Error(`404 ${url}`);
  return buffer;
};

const cfg: ImgtuneConfig = {
  projectDir: "/project",
  paths: [],
  quality: "relaxed",
  metric: "ssim",
  threshold: 0.975,
  tolerance: 5,
  market: "ae-en",
  port: 3999,
  urls: {},
  viewports: [],
  samplesPerComponent: 3,
  maxPagesPerPattern: 1,
  includeDone: false,
};

const nextConfig: ImageConfig = readImageConfig(resolve(import.meta.dirname, "fixtures/next-config-none"));
const cdnConfig: ImageConfig = { ...nextConfig, loaderFile: "./src/lib/imageLoader.ts", qualities: [75, 85, 100] };

const ABSENT: PropInfo = { kind: "absent" };
const literal = (value: string | number): PropInfo => ({ kind: "literal", value, start: 0, end: 0 });
const expression: PropInfo = { kind: "expression", start: 0, end: 0 };

function usage(props: Partial<ImageUsage["props"]> = {}, extra: Partial<ImageUsage> = {}): ImageUsage {
  return {
    id: "card.tsx:4:10",
    file: "/project/src/card.tsx",
    relFile: "src/card.tsx",
    line: 4,
    col: 10,
    tag: "Image",
    component: "ProductCard",
    props: { src: expression, sizes: ABSENT, quality: ABSENT, width: ABSENT, height: ABSENT, fill: ABSENT, ...props },
    hasSpread: false,
    tagNameEnd: 0,
    ...extra,
  };
}

interface Spec {
  viewport: "iphone-15" | "desktop";
  src: string;
  page?: string;
  natural: number;
  rendered: number;
  accept?: "default" | "webp";
  bytes?: number;
  contentType?: string;
  currentSrc: string;
}

function observation(spec: Spec): ImageObservation {
  const mobile = spec.viewport === "iphone-15";
  return {
    usageId: "card.tsx:4:10",
    page: spec.page ?? "/",
    viewport: spec.viewport,
    viewportWidth: mobile ? 393 : 1440,
    dpr: mobile ? 3 : 1,
    mobile,
    renderedWidth: spec.rendered,
    renderedHeight: 300,
    naturalWidth: spec.natural,
    currentSrc: spec.currentSrc,
    originalSrc: spec.src,
    srcsetWidths: [],
    bytes: spec.bytes,
    contentType: spec.contentType,
    accept: spec.accept ?? "default",
  };
}

/** Bytes a local encode produces for the original at `width`: stands in for what the server or CDN served. */
async function bytesOf(src: string, width: number, format: "avif" | "webp", q: number, profile: EncoderProfile) {
  const ref = await loadReference(originals.get(src)!, width);
  return (await encode(ref, format, q, profile)).bytes;
}

const nextSrc = (src: string, width: number, q: number) =>
  `${BASE}/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=${q}`;

/** Default-optimizer observations: AVIF-less WebP served at q=85, phone 1200 wide and desktop 640 wide. */
async function nextDefaultObservations(): Promise<ImageObservation[]> {
  const out: ImageObservation[] = [];
  for (const src of SRC) {
    out.push(
      observation({
        viewport: "iphone-15",
        src,
        natural: 1200,
        rendered: 393,
        bytes: await bytesOf(src, 1200, "webp", 85, "next-default"),
        contentType: "image/webp",
        currentSrc: nextSrc(src, 1200, 85),
      }),
    );
    out.push(
      observation({
        viewport: "desktop",
        src,
        natural: 640,
        rendered: 600,
        bytes: await bytesOf(src, 640, "webp", 85, "next-default"),
        contentType: "image/webp",
        currentSrc: nextSrc(src, 640, 85),
      }),
    );
  }
  return out;
}

/** Custom-loader observations: AVIF (default pass) and WebP (webp pass) at quality 85 on the phone viewport. */
async function cdnObservations({ withWebp }: { withWebp: boolean }): Promise<ImageObservation[]> {
  const out: ImageObservation[] = [];
  for (const src of SRC) {
    const currentSrc = `https://shop-cdn.example.com/cdn-cgi/image/width=1200,quality=85,format=auto/${src}`;
    out.push(
      observation({
        viewport: "iphone-15",
        src,
        natural: 1200,
        rendered: 393,
        bytes: await bytesOf(src, 1200, "avif", 85, "cdn"),
        contentType: "image/avif",
        currentSrc,
      }),
    );
    if (withWebp) {
      out.push(
        observation({
          viewport: "iphone-15",
          src,
          natural: 1200,
          rendered: 393,
          accept: "webp",
          bytes: await bytesOf(src, 1200, "webp", 85, "cdn"),
          contentType: "image/webp",
          currentSrc,
        }),
      );
    }
  }
  return out;
}

/** AVIF (default pass) and WebP (webp pass) observations of one CDN variant whose stub size is `served` bytes. */
function cdnStubObservations(served: number): ImageObservation[] {
  const currentSrc = (src: string) => `https://shop-cdn.example.com/cdn-cgi/image/width=1200,quality=85,format=auto/${src}`;
  return [
    ...SRC.map((src) =>
      observation({ viewport: "iphone-15", src, natural: 1200, rendered: 393, bytes: served, contentType: "image/avif", currentSrc: currentSrc(src) }),
    ),
    ...SRC.map((src) =>
      observation({
        viewport: "iphone-15",
        src,
        natural: 1200,
        rendered: 393,
        accept: "webp",
        bytes: served,
        contentType: "image/webp",
        currentSrc: currentSrc(src),
      }),
    ),
  ];
}

/** AVIF effort-4 encodes make the CDN cases slow on the E-cores. */
const CDN_TIMEOUT_MS = 60_000;

const silent = (extra: AnalyseOptions = {}): AnalyseOptions => ({ log: () => {}, ...extra });

describe("originalUrlFor", () => {
  it("unwraps an absolute original from a cdn-cgi variant URL", () => {
    expect(
      originalUrlFor(
        "https://staging-shop-cdn.example.com/cdn-cgi/image/width=640,quality=85,format=auto/https://shop-cdn.example.com/media/x.jpg",
        BASE,
      ),
    ).toBe("https://shop-cdn.example.com/media/x.jpg");
  });

  it("resolves a cdn-cgi variant with a relative original against baseUrl", () => {
    expect(originalUrlFor("/cdn-cgi/image/w=1/media/y.jpg", BASE)).toBe("http://localhost:3999/media/y.jpg");
  });

  it("resolves a plain relative src against baseUrl", () => {
    expect(originalUrlFor("/a.png", BASE)).toBe("http://localhost:3999/a.png");
  });
});

/** Originals wide enough that the candidate widths differ (the 320px fixtures above cap every width at 320). */
const wideOriginals = new Map<string, Buffer>();
const wideFetch = async (url: string): Promise<Buffer> => {
  const buffer = wideOriginals.get(url);
  if (!buffer) throw new Error(`404 ${url}`);
  return buffer;
};

/** Encoder stand-in whose bytes follow the reference width, with SSIM 0 so quality is never lowered. */
const widthDeps = {
  encode: (async (ref: RawImage) => ({ bytes: ref.width * 100, decoded: ref, buffer: Buffer.alloc(0) })) as unknown as NonNullable<
    AnalyseOptions["deps"]
  >["encode"],
  score: () => 0,
};

function viewportObs(spec: { viewport: "iphone-15" | "desktop"; src: string; natural: number; rendered: number; bytes: number; dpr: number }): ImageObservation {
  return {
    ...observation({ ...spec, currentSrc: nextSrc(spec.src, spec.natural, 85), contentType: "image/webp" }),
    dpr: spec.dpr,
  };
}

describe("per-viewport projection and media branches", () => {
  beforeAll(async () => {
    for (const url of SRC) {
      wideOriginals.set(url, await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 90, g: 120, b: 150 } } }).jpeg().toBuffer());
    }
  });

  const run = (u: ImageUsage, observations: ImageObservation[], deps: AnalyseOptions["deps"] = widthDeps) =>
    analyse([u], observations, nextConfig, cfg, BASE, wideFetch, silent({ deps })).then(([r]) => r);

  it("keeps the current mobile sizes when corrected mobile grows, and applies the desktop correction", async () => {
    // 33vw is undersized on the phone (280 css px slot) and oversized on desktop (1440 at 2x wants ~950px).
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: 280, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 1080, rendered: 280, bytes: 20000, dpr: 2 }),
    ]);
    const r = await run(usage({ sizes: literal("33vw") }), observations);

    expect(r.proposed.sizesFull).toBe("280px");
    expect(r.proposed.sizes).toBe("(max-width: 768px) 33vw, 280px");
    expect(r.proposed.bytesByViewport!.desktop).toBeLessThan(r.current.bytesByViewport.desktop);
    expect(r.proposed.branches!.mobile).toMatchObject({ grows: true, kept: true });
    expect(r.proposed.branches!.desktop).toMatchObject({ grows: false, kept: false });
    expect(r.savedBytesTotal).toBeGreaterThan(0);
    expect(r.notes).toContainEqual(
      expect.stringMatching(/^mobile: corrected sizes is sharper but larger \(\+\d+\.\d KB\/img\); kept current — use --allow-growth$/),
    );
  });

  it("proposes no sizes when the proposal resolves to the current slot at every measured viewport", async () => {
    // calc(100vw - 0px) on the phone is the 393px slot the proposal would give, and 600px is already the desktop value.
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 1200, rendered: 393, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 1200, rendered: 600, bytes: 20000, dpr: 1 }),
    ]);
    const r = await run(usage({ sizes: literal("(max-width: 768px) calc(100vw - 0px), 600px") }), observations);

    expect(r.proposed.sizes).toBeUndefined();
    expect(r.proposed.sizesFull).toBeUndefined();
    expect(r.notes).toContain("sizes already fits");
  });

  it("proposes no sizes when the projected saving is negligible, even on a different slot", async () => {
    // 400px and 393px both resolve to the 1200w candidate, and 600px to 640w, so the projection saves nothing.
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 1200, rendered: 393, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 640, rendered: 600, bytes: 20000, dpr: 1 }),
    ]);
    const r = await run(usage({ sizes: literal("(max-width: 768px) 400px, 600px") }), observations);

    expect(r.proposed.sizes).toBeUndefined();
    expect(r.notes).toContain("sizes already fits");
  });

  it("proposes no sizes for an absent sizes when the proposal changes no slot or bytes", async () => {
    // Absent sizes is the 100vw default: the phone at 393px and desktop at 1440px already sit on 100vw.
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 1200, rendered: 393, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 1440, rendered: 1440, bytes: 20000, dpr: 1 }),
    ]);
    const r = await run(usage(), observations);

    expect(r.proposed.sizes).toBeUndefined();
    expect(r.notes).toContain("no sizes change worth making (no sizes attribute: 100vw default)");
  });

  it("proposes nothing for a vector image", async () => {
    const observations = SRC.flatMap((src) => [
      { ...viewportObs({ viewport: "iphone-15", src, natural: 1200, rendered: 393, bytes: 20000, dpr: 3 }), contentType: "image/svg+xml" },
      { ...viewportObs({ viewport: "desktop", src, natural: 1200, rendered: 600, bytes: 20000, dpr: 1 }), contentType: "image/svg+xml" },
    ]);
    const r = await run(usage(), observations);

    expect(r.proposed.sizes).toBeUndefined();
    expect(r.proposed.quality).toBeUndefined();
    expect(r.notes).toContain("vector image: sizes/quality do not apply");
  });

  it("proposes the full correction when both branches shrink", async () => {
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 1920, rendered: 200, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 1920, rendered: 280, bytes: 20000, dpr: 1 }),
    ]);
    const r = await run(usage(), observations);

    expect(r.proposed.sizesFull).toBe("(max-width: 768px) 200px, 280px");
    expect(r.proposed.sizes).toBe(r.proposed.sizesFull);
    expect(r.notes.some((n) => n.includes("corrected sizes is sharper"))).toBe(false);
  });

  it("proposes no sizes when both branches grow and keep the current value, but still proposes quality", async () => {
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 256, rendered: 280, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 384, rendered: 600, bytes: 20000, dpr: 1 }),
    ]);
    const r = await run(usage({ sizes: literal("20vw") }), observations);

    expect(r.proposed.sizesFull).toBe("(max-width: 768px) 280px, 600px");
    expect(r.proposed.sizes).toBeUndefined();
    expect(r.proposed.quality).toBeDefined();
    expect(r.notes).toContainEqual(expect.stringMatching(/^desktop: corrected sizes is sharper but larger/));
  });

  it("shrinks the desktop branch for a 1440@2 carousel card at 160px served a 1080px file (sunglasses numbers)", async () => {
    // Desktop 1440 at 2x, 33vw: the card renders 160 css px and the browser asks for ~950px, so the 1080px file is oversized.
    // The phone grid card renders 175px at 3x; its 33vw sizes serve a 640px file there, so the phone branch is unchanged.
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: 175, bytes: 8000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 1080, rendered: 160, bytes: 20480, dpr: 2 }),
    ]);
    const r = await run(usage({ sizes: literal("33vw") }), observations);

    expect(r.proposed.sizesFull).toBe("(max-width: 768px) 175px, 160px");
    expect(r.proposed.sizes).toBe("(max-width: 768px) 175px, 160px");
    expect(r.proposed.branches!.desktop).toMatchObject({ grows: false, kept: false });
    expect(r.proposed.bytesByViewport!.desktop).toBeLessThan(r.current.bytesByViewport.desktop);
    expect(r.savedBytesTotal).toBeGreaterThan(0);
  });

  it("notes several rendered widths at one viewport when they are clearly apart", async () => {
    const observations = SRC.flatMap((src, i) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: i === 0 ? 400 : 160, bytes: 8000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 640, rendered: 600, bytes: 8000, dpr: 1 }),
    ]);
    const r = await run(usage({ sizes: literal("33vw") }), observations);

    expect(r.notes).toContain(
      "renders at several widths at iphone-15: 160px ×2, 400px ×1; one sizes cannot fit all — pass sizes from the parent (e.g. carousel)",
    );
  });

  it("does not note several widths when the rendered widths are close", async () => {
    const observations = SRC.flatMap((src, i) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: i === 0 ? 175 : 160, bytes: 8000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 640, rendered: 600, bytes: 8000, dpr: 1 }),
    ]);
    const r = await run(usage({ sizes: literal("33vw") }), observations);

    expect(r.notes.some((n) => n.startsWith("renders at several widths"))).toBe(false);
  });

  it("skips a sample whose original is corrupt and analyses the others", async () => {
    const corrupt = async (url: string): Promise<Buffer> => (url === SRC[0] ? Buffer.from("not an image") : wideFetch(url));
    const logs: string[] = [];
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: 280, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 1080, rendered: 280, bytes: 20000, dpr: 2 }),
    ]);
    const [r] = await analyse([usage({ sizes: literal("33vw") })], observations, nextConfig, cfg, BASE, corrupt, {
      log: (msg) => logs.push(msg),
      deps: widthDeps,
    });
    expect(r.proposed.sizes).toBe("(max-width: 768px) 33vw, 280px");
    expect(r.proposed.quality).toBeDefined();
    expect(logs.some((l) => l.startsWith(`skipping sample ${SRC[0]}:`))).toBe(true);
  });

  it("skips a sample whose quality search throws and searches the rest", async () => {
    let calls = 0;
    const flaky = (async (ref: RawImage) => {
      if (calls++ === 0) throw new Error("encoder crashed");
      return { bytes: ref.width * 100, decoded: ref, buffer: Buffer.alloc(0) };
    }) as unknown as NonNullable<AnalyseOptions["deps"]>["encode"];
    const logs: string[] = [];
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: 280, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 1080, rendered: 280, bytes: 20000, dpr: 2 }),
    ]);
    const [r] = await analyse([usage({ sizes: literal("33vw") })], observations, nextConfig, cfg, BASE, wideFetch, {
      log: (msg) => logs.push(msg),
      deps: { encode: flaky, score: () => 0 },
    });
    expect(r.proposed.quality).toBeDefined();
    expect(logs).toContain(`skipping quality search for ${SRC[0]}: encoder crashed`);
  });

  it("proposes no quality when every quality search fails, and still completes", async () => {
    const broken = (async () => {
      throw new Error("encoder down");
    }) as unknown as NonNullable<AnalyseOptions["deps"]>["encode"];
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: 280, bytes: 20000, dpr: 3 }),
    ]);
    const [r] = await analyse([usage()], observations, nextConfig, cfg, BASE, wideFetch, silent({ deps: { encode: broken, score: () => 0 } }));
    expect(r.proposed.quality).toBeUndefined();
    expect(r.notes).toContain("quality not proposed: no sample could be searched");
  });

  it("searches the quality at the full correction's width as qualityFull, separately from the final quality", async () => {
    // Passes SSIM only at reference widths up to 700px: the full correction (1080px on the phone) fails, the 33vw one passes.
    const deps = { encode: widthDeps.encode, score: (ref: RawImage) => (ref.width <= 700 ? 1 : 0) };
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: 280, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 1080, rendered: 280, bytes: 20000, dpr: 2 }),
    ]);
    const r = await run(usage({ sizes: literal("33vw") }), observations, deps);
    expect(r.proposed.qualityFull).toBe(85);
    expect(r.proposed.quality!).toBeLessThan(85);
  });

  it("notes desktop widths of 668 and 160 as several slots", async () => {
    const observations = SRC.flatMap((src, i) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: 175, bytes: 8000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 640, rendered: i === 0 ? 668 : 160, bytes: 8000, dpr: 2 }),
    ]);
    const r = await run(usage({ sizes: literal("33vw") }), observations);
    expect(r.notes).toContain(
      "renders at several widths at desktop: 160px ×2, 668px ×1; one sizes cannot fit all — pass sizes from the parent (e.g. carousel)",
    );
  });

  it("keeps 100vw for a growing mobile branch when the current sizes is absent", async () => {
    const observations = SRC.flatMap((src) => [
      viewportObs({ viewport: "iphone-15", src, natural: 640, rendered: 400, bytes: 20000, dpr: 3 }),
      viewportObs({ viewport: "desktop", src, natural: 640, rendered: 600, bytes: 20000, dpr: 1 }),
    ]);
    const r = await run(usage(), observations);

    expect(r.proposed.sizesFull).toBe("(max-width: 768px) 400px, 600px");
    expect(r.proposed.sizes).toBe("(max-width: 768px) 100vw, 600px");
  });
});

describe("decideBranches", () => {
  const grows = { current: 20000, corrected: 33000 };
  const shrinks = { current: 20000, corrected: 11000 };
  const full = { mobile: "175px", desktop: "280px" };

  it("proposes the full correction when no branch grows", () => {
    const d = decideBranches(full, { mobile: shrinks, desktop: shrinks }, "33vw");
    expect(d.sizes).toBe("(max-width: 768px) 175px, 280px");
    expect(d.branches.mobile).toMatchObject({ grows: false, kept: false });
  });

  it("keeps an unconditioned current value for a growing mobile branch", () => {
    const d = decideBranches(full, { mobile: grows, desktop: shrinks }, "33vw");
    expect(d.sizes).toBe("(max-width: 768px) 33vw, 280px");
    expect(d.branches.mobile).toMatchObject({ grows: true, kept: true });
    expect(d.branches.desktop).toMatchObject({ grows: false, kept: false });
  });

  it("keeps an unconditioned current value for a growing desktop branch", () => {
    expect(decideBranches(full, { mobile: shrinks, desktop: grows }, "33vw").sizes).toBe("(max-width: 768px) 175px, 33vw");
  });

  it("proposes nothing when every present branch grows and keeps", () => {
    const d = decideBranches(full, { mobile: grows, desktop: grows }, "20vw");
    expect(d.sizes).toBeUndefined();
    expect(d.branches.desktop).toMatchObject({ grows: true, kept: true });
  });

  it("keeps the absent sizes (100vw) for a growing branch", () => {
    expect(decideBranches(full, { mobile: grows, desktop: shrinks }, "100vw").sizes).toBe("(max-width: 768px) 100vw, 280px");
  });

  it("overlays a conditioned current value so it applies unchanged in the kept branch", () => {
    const d = decideBranches({ mobile: "175px", desktop: "200px" }, { mobile: grows, desktop: shrinks }, "(max-width: 768px) 33vw, 280px");
    expect(d.sizes).toBe("(min-width: 769px) 200px, (max-width: 768px) 33vw, 280px");
  });

  it("overlays the corrected mobile branch over a conditioned current value that keeps desktop", () => {
    const d = decideBranches(full, { mobile: shrinks, desktop: grows }, "(max-width: 500px) 50vw, 280px");
    expect(d.sizes).toBe("(max-width: 768px) 175px, (max-width: 500px) 50vw, 280px");
  });

  it("proposes no sizes when a growing branch's current sizes is not understood", () => {
    const d = decideBranches(full, { mobile: grows, desktop: shrinks }, "(orientation: landscape) 50vw");
    expect(d.sizes).toBeUndefined();
    expect(d.branches.mobile).toMatchObject({ grows: true, kept: false });
  });

  it("treats a branch without projected viewports as not growing", () => {
    expect(decideBranches(full, {}, "33vw").sizes).toBe("(max-width: 768px) 175px, 280px");
  });

  it("is empty when no branch was measured", () => {
    expect(decideBranches({}, {}, "33vw")).toEqual({ branches: {}, sizes: undefined });
  });
});

describe("evaluator", () => {
  it("encodes each (sample, format, quality, width) once", async () => {
    const calls: string[] = [];
    const deps = {
      encode: (async (ref: RawImage, format: string, q: number) => {
        calls.push(`${ref.width}|${format}|${q}`);
        return { bytes: ref.width * 100, decoded: ref, buffer: Buffer.alloc(0) };
      }) as unknown as NonNullable<AnalyseOptions["deps"]>["encode"],
      score: () => 1,
    };
    const ctx = { profile: "next-default", deps } as unknown as Parameters<typeof evaluator>[0];
    const sample = { src: SRC[0], buffer: wideOriginals.get(SRC[0])! };
    const evaluate = evaluator(ctx, {});
    await evaluate(sample, "webp", 85, 640);
    await evaluate(sample, "webp", 85, 640);
    await evaluate(sample, "webp", 85, 1080);
    await evaluate(sample, "webp", 85, 640);
    expect(calls).toEqual(["640|webp|85", "1080|webp|85"]);
  });
});

describe("analyse", () => {
  it("proposes sizes and a lower quality for a next-default component, unconfirmed so estimated", async () => {
    const [r] = await analyse([usage()], await nextDefaultObservations(), nextConfig, cfg, BASE, fetchStub, silent());

    expect(r.proposed.sizes).toBe("(max-width: 768px) 393px, 600px");
    expect(r.proposed.width).toBe(1200);
    expect(r.proposed.quality).toBeDefined();
    expect(r.proposed.quality!).toBeLessThanOrEqual(85);
    expect(r.current.quality).toBe(85);
    expect(r.instances).toBe(3);
    expect(r.servedFormats).toEqual(["webp"]);
    expect(r.savedBytesTotal).toBeGreaterThan(0);
    expect(r.estimated).toBe(true);
    expect(r.notes).toContain("estimated: not confirmed against /_next/image");
    expect(r.notes).toContain("AVIF not served");
  });

  it("encodes a shared original once for a second usage: no new encodes for the same pixels", async () => {
    const observations = await nextDefaultObservations();
    const second = observations.map((o) => ({ ...o, usageId: "other.tsx:4:10" }));
    const otherUsage = usage({}, { id: "other.tsx:4:10", file: "/project/src/other.tsx", relFile: "src/other.tsx", line: 4 });

    clearEncodeCache();
    await analyse([usage()], observations, nextConfig, cfg, BASE, fetchStub, silent());
    const alone = encodeCacheStats();

    clearEncodeCache();
    await analyse([usage(), otherUsage], [...observations, ...second], nextConfig, cfg, BASE, fetchStub, silent());
    const shared = encodeCacheStats();

    expect(alone.misses).toBeGreaterThan(0);
    expect(shared.misses).toBe(alone.misses);
    expect(shared.hits).toBeGreaterThan(0);
  });

  it("marks a next-default result exact when the confirmation passes", async () => {
    const calls: { n: number; width: number; q: number; formats: string[] }[] = [];
    const confirm: NonNullable<AnalyseOptions["confirm"]> = async (samples, q, formats) => {
      calls.push({ n: samples.length, width: samples[0].width, q, formats });
      return { confirmed: true, ssim: { webp: 0.99 }, bytes: { webp: 1234 } };
    };
    const [r] = await analyse(
      [usage()],
      await nextDefaultObservations(),
      nextConfig,
      cfg,
      BASE,
      fetchStub,
      silent({ confirm }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ n: 3, width: 1200, q: r.proposed.quality, formats: ["webp"] });
    expect(r.estimated).toBe(false);
    expect(r.proposed.projectedBytes).toBe(1234);
    expect(r.notes).not.toContain("estimated: not confirmed against /_next/image");
  });

  it("keeps the local projection and estimated when the confirmation does not pass", async () => {
    const confirm: NonNullable<AnalyseOptions["confirm"]> = async () => ({
      confirmed: false,
      ssim: { webp: 0.8 },
      bytes: { webp: 1234 },
    });
    const [r] = await analyse(
      [usage()],
      await nextDefaultObservations(),
      nextConfig,
      cfg,
      BASE,
      fetchStub,
      silent({ confirm }),
    );

    expect(r.estimated).toBe(true);
    expect(r.proposed.projectedBytes).toBeDefined();
    expect(r.proposed.projectedBytes).not.toBe(1234);
  });

  it("counts only rendered observations for instances and bytes", async () => {
    const base = await nextDefaultObservations();
    const unrendered = observation({
      viewport: "iphone-15",
      src: SRC[0],
      page: "/hidden",
      natural: 0,
      rendered: 0,
      currentSrc: nextSrc(SRC[0], 1200, 85),
    });
    const [withHidden] = await analyse([usage()], [...base, unrendered], nextConfig, cfg, BASE, fetchStub, silent());
    const [plain] = await analyse([usage()], base, nextConfig, cfg, BASE, fetchStub, silent());

    expect(withHidden.instances).toBe(3);
    expect(withHidden.current.medianBytes).toBe(plain.current.medianBytes);
    expect(withHidden.current.medianWidth).toBe(plain.current.medianWidth);
    expect(withHidden.current.format).toBe("image/webp");
  });

  it("notes the assumed quality when neither a literal nor the URL gives one", async () => {
    const noQuality = (await nextDefaultObservations()).map((o) => ({ ...o, currentSrc: "/static/x.jpg" }));
    const failing = async (url: string): Promise<Buffer> => {
      throw new Error(`unreachable ${url}`);
    };
    const [r] = await analyse([usage()], noQuality, nextConfig, cfg, BASE, failing, silent());

    expect(r.current.quality).toBe(75);
    expect(r.notes).toContain("current quality assumed 75 (not found in props or URL)");
  });

  it("projects cdn bytes per sample from known byte counts", async () => {
    // Stub encoder: bytes = quality * 1000 + reference width; the score always passes, so the search goes to its floor.
    const deps = {
      encode: (async (ref: RawImage, _format: string, q: number) => ({
        bytes: q * 1000 + ref.width,
        decoded: ref,
        buffer: Buffer.alloc(0),
      })) as unknown as NonNullable<AnalyseOptions["deps"]>["encode"],
      score: () => 1,
    };
    // The CDN served quality 85 whose stub size is 85000 + 320 (the reference width after loading).
    const served = 85 * 1000 + 320;
    const observations = [
      ...SRC.map((src) =>
        observation({
          viewport: "iphone-15",
          src,
          natural: 1200,
          rendered: 393,
          bytes: served,
          contentType: "image/avif",
          currentSrc: `https://shop-cdn.example.com/cdn-cgi/image/width=1200,quality=85,format=auto/${src}`,
        }),
      ),
      ...SRC.map((src) =>
        observation({
          viewport: "iphone-15",
          src,
          natural: 1200,
          rendered: 393,
          accept: "webp",
          bytes: served,
          contentType: "image/webp",
          currentSrc: `https://shop-cdn.example.com/cdn-cgi/image/width=1200,quality=85,format=auto/${src}`,
        }),
      ),
    ];
    const [r] = await analyse([usage()], observations, cdnConfig, cfg, BASE, fetchStub, silent({ deps }));

    // The page was served AVIF, so AVIF decides (R36). Bisection with an always-passing score settles at 28 (offset 0).
    expect(r.proposed.quality).toBe(28);
    // Projection: observed 85320 x (stub bytes at 28 / stub bytes at 85) = 28320, per sample.
    expect(r.proposed.projectedBytes).toBe(28320);
    expect(r.current.medianBytes).toBe(served);
    expect(r.savedBytesTotal).toBe((served - 28320) * 3);
  }, CDN_TIMEOUT_MS);

  it("decides a cdn quality on the served format alone, scoring the WebP fallback at the chosen quality", async () => {
    // AVIF passes everywhere; WebP passes only from q70 and scores 70 below it. The served AVIF decides (28), not WebP (70).
    const deps = {
      encode: (async (ref: RawImage, format: string, q: number) => ({
        bytes: q * 1000 + ref.width,
        decoded: { data: Uint8ClampedArray.of(format === "webp" && q < 70 ? 70 : 95), width: ref.width, height: ref.height, },
        buffer: Buffer.alloc(0),
      })) as unknown as NonNullable<AnalyseOptions["deps"]>["encode"],
      score: (_ref: RawImage, test: RawImage) => test.data[0],
    };
    const served = 85 * 1000 + 320;
    const [r] = await analyse(
      [usage()],
      cdnStubObservations(served),
      cdnConfig,
      { ...cfg, metric: "ssimulacra2", threshold: 70, delta: 2 },
      BASE,
      fetchStub,
      silent({ deps }),
    );

    expect(r.proposed.quality).toBe(28);
    expect(r.notes).toContain("webp fallback drops 25.0 points at q28");
  }, CDN_TIMEOUT_MS);

  it("notes no WebP fallback when the other format also scores at the threshold", async () => {
    const deps = {
      encode: (async (ref: RawImage, _format: string, q: number) => ({
        bytes: q * 1000 + ref.width,
        decoded: { data: Uint8ClampedArray.of(95), width: ref.width, height: ref.height },
        buffer: Buffer.alloc(0),
      })) as unknown as NonNullable<AnalyseOptions["deps"]>["encode"],
      score: (_ref: RawImage, test: RawImage) => test.data[0],
    };
    const [r] = await analyse(
      [usage()],
      cdnStubObservations(85 * 1000 + 320),
      cdnConfig,
      { ...cfg, metric: "ssimulacra2", threshold: 70, delta: 2 },
      BASE,
      fetchStub,
      silent({ deps }),
    );

    expect(r.proposed.quality).toBe(28);
    expect(r.notes.some((n) => n.includes("fallback"))).toBe(false);
  }, CDN_TIMEOUT_MS);

  it("sets each sample's bar from the current quality's score (max of floor and current - delta), stored as minScore", async () => {
    // The score of a variant is its quality, so the current q85 scores 85: the bar is max(70, 85 - 2) = 83.
    const deps = {
      encode: (async (ref: RawImage, _format: string, q: number) => ({
        bytes: q * 1000 + ref.width,
        decoded: { data: Uint8ClampedArray.of(q), width: ref.width, height: ref.height },
        buffer: Buffer.alloc(0),
      })) as unknown as NonNullable<AnalyseOptions["deps"]>["encode"],
      score: (_ref: RawImage, test: RawImage) => test.data[0],
    };
    const [r] = await analyse(
      [usage()],
      await nextDefaultObservations(),
      nextConfig,
      { ...cfg, metric: "ssimulacra2", threshold: 70, delta: 2 },
      BASE,
      fetchStub,
      silent({ deps }),
    );

    expect(r.proposed.minScore?.webp).toBe(83);
    expect(r.proposed.quality).toBeGreaterThanOrEqual(83);
    expect(r.proposed.quality).toBeLessThanOrEqual(85);
  });

  it("proposes quality for a cdn component once AVIF and WebP are calibrated, and stays estimated", async () => {
    const [r] = await analyse(
      [usage()],
      await cdnObservations({ withWebp: true }),
      cdnConfig,
      cfg,
      BASE,
      fetchStub,
      silent(),
    );

    expect(r.proposed.quality).toBeDefined();
    expect(r.proposed.quality!).toBeLessThanOrEqual(85);
    expect(r.estimated).toBe(true);
    expect(r.savedBytesTotal).toBeGreaterThan(0);
    expect(r.notes.some((n) => n.startsWith("quality not proposed"))).toBe(false);
  }, CDN_TIMEOUT_MS);

  it("proposes no quality for a cdn component without WebP variants to calibrate against", async () => {
    const [r] = await analyse(
      [usage()],
      await cdnObservations({ withWebp: false }),
      cdnConfig,
      cfg,
      BASE,
      fetchStub,
      silent(),
    );

    expect(r.proposed.quality).toBeUndefined();
    // Absent sizes resolve to the same 1200w candidate as 393px, so the sizes change saves nothing and is no proposal.
    expect(r.proposed.sizes).toBeUndefined();
    expect(r.notes).toContain("no sizes change worth making (no sizes attribute: 100vw default)");
    expect(r.notes).toContain("quality not proposed: no CDN webp variants observed for calibration");
  }, CDN_TIMEOUT_MS);

  it("reports a usage with no observations as not measured, with no proposals", async () => {
    const [r] = await analyse([usage()], [], nextConfig, cfg, BASE, fetchStub, silent());

    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^not measured: /);
    expect(r.proposed.sizes).toBeUndefined();
    expect(r.proposed.quality).toBeUndefined();
    expect(r.savedBytesTotal).toBe(0);
    expect(r.instances).toBe(0);
  });

  it("reports a plain <img> without any proposal and without fetching originals", async () => {
    const noFetch = async (url: string): Promise<Buffer> => {
      throw new Error(`plain img must not fetch ${url}`);
    };
    const src = SRC[0];
    const observations = [
      observation({
        viewport: "iphone-15",
        src,
        natural: 1200,
        rendered: 393,
        bytes: 50000,
        contentType: "image/webp",
        currentSrc: nextSrc(src, 1200, 85),
      }),
    ];
    const [r] = await analyse([usage({}, { tag: "img" })], observations, nextConfig, cfg, BASE, noFetch, silent());

    expect(r.notes).toContain("plain <img>: report-only, consider next/image");
    expect(r.proposed.sizes).toBeUndefined();
    expect(r.proposed.quality).toBeUndefined();
    expect(r.estimated).toBe(true);
    expect(r.proposed.width).toBe(1179);
    expect(r.savedBytesTotal).toBeGreaterThan(0);
  });

  it("does not propose sizes for an expression, reports measured widths, and still searches quality", async () => {
    const observations = await nextDefaultObservations();
    const [r] = await analyse(
      [usage({ sizes: expression, quality: literal(85) })],
      observations,
      nextConfig,
      cfg,
      BASE,
      fetchStub,
      silent(),
    );

    expect(r.proposed.sizes).toBeUndefined();
    expect(r.notes).toContain("manual change needed: sizes is an expression");
    expect(r.measuredWidths).toHaveLength(6);
    expect(r.measuredWidths![0]).toEqual({ page: "/", viewport: "iphone-15", renderedWidth: 393 });
    expect(r.proposed.quality).toBeDefined();
    expect(r.proposed.quality!).toBeLessThanOrEqual(85);
  });

  it("searches and confirms quality at the served width when sizes is a manual expression", async () => {
    const calls: number[] = [];
    const confirm: NonNullable<AnalyseOptions["confirm"]> = async (samples) => {
      calls.push(samples[0].width);
      return { confirmed: true, ssim: { webp: 0.99 }, bytes: { webp: 1234 } };
    };
    // The page keeps serving the 384-wide file whatever the slot predicts, so that is the width to quote.
    const observations: ImageObservation[] = [];
    for (const src of SRC) {
      observations.push(
        observation({
          viewport: "iphone-15",
          src,
          natural: 384,
          rendered: 393,
          bytes: await bytesOf(src, 384, "webp", 85, "next-default"),
          contentType: "image/webp",
          currentSrc: nextSrc(src, 384, 85),
        }),
      );
    }
    const [r] = await analyse(
      [usage({ sizes: expression, quality: literal(85) })],
      observations,
      nextConfig,
      cfg,
      BASE,
      fetchStub,
      silent({ confirm }),
    );

    expect(calls).toEqual([384]);
    expect(r.estimated).toBe(false);
    expect(r.proposed.sizes).toBeUndefined();
  });

  it("reports that no quality is proposed when no sample original can be fetched", async () => {
    const logs: string[] = [];
    const failing = async (url: string): Promise<Buffer> => {
      throw new Error(`unreachable ${url}`);
    };
    const [r] = await analyse(
      [usage()],
      await nextDefaultObservations(),
      nextConfig,
      cfg,
      BASE,
      failing,
      { log: (msg) => logs.push(msg) },
    );

    expect(r.proposed.quality).toBeUndefined();
    expect(r.proposed.sizes).toBe("(max-width: 768px) 393px, 600px");
    expect(r.notes).toContain("quality not proposed: no sample originals could be fetched");
    expect(logs).toHaveLength(3);
  });
});

describe("audit through the loader adapters", () => {
  /** Stub encoder: bytes = quality * 1000 + reference width; every candidate passes, so the search runs to its floor. */
  const stubDeps = {
    encode: (async (ref: RawImage, _format: string, q: number) => ({
      bytes: q * 1000 + ref.width,
      decoded: ref,
      buffer: Buffer.alloc(0),
    })) as unknown as NonNullable<AnalyseOptions["deps"]>["encode"],
    score: () => 1,
  };

  it("proposes sizes only for a loader that cannot set quality, and says so", async () => {
    // A Shopify-served image: its original is on the CDN, its URL has no quality, and the loader takes none.
    const shop = "https://cdn.shopify.com/s/files/1/0001/x/";
    const shopFetch = async (url: string): Promise<Buffer> => fetchStub(url.replace(shop, `${BASE}/media/`));
    const observations: ImageObservation[] = [0, 1, 2].flatMap((i) => [
      observation({
        viewport: "iphone-15",
        src: `${shop}p${i}.jpg`,
        natural: 1200,
        rendered: 393,
        bytes: 40_000,
        contentType: "image/avif",
        currentSrc: `${shop}p${i}.jpg?width=1200`,
      }),
    ]);
    const [r] = await analyse([usage()], observations, cdnConfig, cfg, BASE, shopFetch, silent({ deps: stubDeps }));

    expect(r.proposed.quality).toBeUndefined();
    expect(r.notes).toContain("loader shopify cannot set quality (sizes only)");
  }, CDN_TIMEOUT_MS);

  it("uses the loader's documented default when the URL has no quality", async () => {
    const observations = SRC.map((src) =>
      observation({
        viewport: "iphone-15",
        src,
        natural: 1200,
        rendered: 393,
        bytes: 40_000,
        contentType: "image/avif",
        currentSrc: `https://shop-cdn.example.com/cdn-cgi/image/width=1200,format=auto/${src}`,
      }),
    );
    const [r] = await analyse([usage()], observations, cdnConfig, cfg, BASE, fetchStub, silent({ deps: stubDeps }));

    expect(r.current.quality).toBe(85);
    expect(r.notes.some((note) => note.startsWith("current quality assumed"))).toBe(false);
    expect(r.notes.some((note) => note.includes("sizes only"))).toBe(false);
  }, CDN_TIMEOUT_MS);
});
