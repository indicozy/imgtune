import sharp from "sharp";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyse, originalUrlFor, type AnalyseOptions } from "../src/analyse.js";
import { encode, loadReference, type EncoderProfile } from "../src/encode.js";
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

  it("flags growth when the projected bytes exceed the current median by more than 5%", async () => {
    // The proposal lowers the quality, but at this width it still projects ~740 bytes, above a 500-byte median.
    const observed = (await nextDefaultObservations()).map((o) => (o.viewport === "iphone-15" ? { ...o, bytes: 500 } : o));
    const [r] = await analyse([usage()], observed, nextConfig, cfg, BASE, fetchStub, silent());

    expect(r.grows).toBe(true);
    expect(r.notes).toContainEqual(expect.stringMatching(/^undersized now: corrected sizes is sharper but larger \(\+\d+(\.\d)? KB at iphone-15\)$/));
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
    // Stub encoder: bytes = quality * 1000 + reference width; SSIM always passes, so the search goes to its floor.
    const deps = {
      encode: (async (ref: RawImage, _format: string, q: number) => ({
        bytes: q * 1000 + ref.width,
        decoded: ref,
        buffer: Buffer.alloc(0),
      })) as unknown as NonNullable<AnalyseOptions["deps"]>["encode"],
      ssim: () => 1,
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

    // Bisection with an always-passing SSIM: AVIF settles at 28, WebP at 45 (offsets 0). The larger, 45, is proposed.
    expect(r.proposed.quality).toBe(45);
    // Projection: observed 85320 x (stub bytes at 45 / stub bytes at 85) = 45320, per sample.
    expect(r.proposed.projectedBytes).toBe(45320);
    expect(r.current.medianBytes).toBe(served);
    expect(r.savedBytesTotal).toBe((served - 45320) * 3);
  }, CDN_TIMEOUT_MS);

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
    expect(r.proposed.sizes).toBeDefined();
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
