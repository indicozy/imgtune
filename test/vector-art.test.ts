import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { gradientNoise, rawToPng } from "./image-fixtures.js";
import {
  FLAT_MAX_COLORS,
  FLAT_TOP16_MIN,
  VECTOR_BAR,
  VECTOR_MIN_SAVING,
  VECTORIZER_VERSION,
  cleanSvg,
  flatnessOf,
  svgBytes,
  svgFidelity,
  traceSvg,
} from "../src/vector-art.js";

// A flat logo made of shapes only (no text, so the render does not depend on installed fonts).
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">
<rect width="600" height="200" fill="#ffffff"/><circle cx="100" cy="100" r="70" fill="#e4572e"/>
<path d="M60 130 L100 50 L140 130 Z" fill="#ffffff"/><rect x="200" y="60" width="330" height="80" rx="14" fill="#29335c"/></svg>`;

const logoPng = (): Promise<Buffer> => sharp(Buffer.from(LOGO_SVG)).png().toBuffer();

afterEach(() => {
  vi.doUnmock("@neplex/vectorizer");
  vi.resetModules();
});

describe("thresholds", () => {
  it("are the census values: bar 70, a 30% saving, flat at 90% in 16 colours and 256 colours at most", () => {
    expect(VECTOR_BAR).toBe(70);
    expect(VECTOR_MIN_SAVING).toBe(0.3);
    expect(FLAT_TOP16_MIN).toBe(0.9);
    expect(FLAT_MAX_COLORS).toBe(256);
  });

  it("names the vectorizer version the package pins", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      optionalDependencies: Record<string, string>;
    };
    expect(VECTORIZER_VERSION).toBe(pkg.optionalDependencies["@neplex/vectorizer"]);
  });
});

describe("flatnessOf", () => {
  it("calls a flat logo flat", async () => {
    const flat = await flatnessOf(await logoPng());
    expect(flat).toBeDefined();
    expect(flat?.flat).toBe(true);
    expect(flat?.uniqueColors).toBeLessThanOrEqual(FLAT_MAX_COLORS);
    expect(flat?.top16Share).toBeGreaterThanOrEqual(FLAT_TOP16_MIN);
    expect(flat?.alphaBinaryShare).toBe(1);
  });

  it("does not call a photo-like noisy gradient flat", async () => {
    const photo = await rawToPng(gradientNoise(400, 300, 12, 7));
    const flat = await flatnessOf(photo);
    expect(flat?.flat).toBe(false);
    expect(flat?.uniqueColors).toBeGreaterThan(FLAT_MAX_COLORS);
  });

  it("reads the alpha of a transparent logo as binary", async () => {
    const transparent = await sharp(Buffer.from(LOGO_SVG)).ensureAlpha().png().toBuffer();
    const flat = await flatnessOf(transparent);
    expect(flat?.alphaBinaryShare).toBe(1);
  });

  it("returns undefined for bytes that are not an image", async () => {
    expect(await flatnessOf(Buffer.from("not an image at all"))).toBeUndefined();
  });
});

describe("tracing and fidelity", () => {
  it("traces a flat logo to an SVG that passes the bar and is at least 30% smaller than the PNG", async () => {
    const png = await logoPng();
    const svg = await traceSvg(png);
    expect(svg).toMatch(/<svg[\s>]/);
    const fidelity = await svgFidelity(png, svg as string);
    expect(fidelity.score).toBeGreaterThanOrEqual(VECTOR_BAR);
    expect(fidelity.badPixelShare).toBeLessThan(0.05);
    expect(svgBytes(svg as string)).toBeLessThan(png.length * (1 - VECTOR_MIN_SAVING));
  });

  it("keeps the fidelity after the cleanup (the scored SVG is the cleaned one)", async () => {
    const png = await logoPng();
    const raw = (await traceSvg(png)) as string;
    const cleaned = cleanSvg(raw);
    expect(cleaned.length).toBeLessThanOrEqual(raw.length);
    expect((await svgFidelity(png, cleaned)).score).toBeGreaterThanOrEqual(VECTOR_BAR);
  });

  it("does not trace a photo-like image into a passing SVG", async () => {
    const photo = await rawToPng(gradientNoise(200, 150, 12, 3));
    const svg = await traceSvg(photo);
    if (svg === undefined) return;
    expect((await svgFidelity(photo, svg)).score).toBeLessThan(VECTOR_BAR);
  });

  it("downscales a large input before tracing (the SVG is at most 2 MP in size)", async () => {
    const big = await sharp(Buffer.from(LOGO_SVG)).resize(2400, 1000, { fit: "fill" }).png().toBuffer();
    const svg = (await traceSvg(big)) as string;
    const width = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)?.[1]);
    const height = Number(/<svg[^>]*\sheight="(\d+)"/.exec(svg)?.[1]);
    expect(width * height).toBeLessThanOrEqual(2_000_000);
  });

  it("cleans the SVG: whitespace between tags goes, and path numbers are rounded to one decimal", () => {
    const messy = '<svg>\n  <path d="M1.2345 2.3456 L10.0001 20.9999"  fill="#000"/>\n</svg>';
    const clean = cleanSvg(messy);
    expect(clean).not.toMatch(/>\s+</);
    expect(clean).toContain('d="M1.2 2.3 L10.0 21.0"');
  });
});

describe("a missing vectorizer", () => {
  it("gives undefined from loadVectorizer and traceSvg, and never throws", async () => {
    vi.doMock("@neplex/vectorizer", () => {
      throw new Error("Cannot find package '@neplex/vectorizer'");
    });
    vi.resetModules();
    const mod = await import("../src/vector-art.js");
    expect(await mod.loadVectorizer()).toBeUndefined();
    expect(await mod.traceSvg(await logoPng())).toBeUndefined();
  });
});

describe("the fidelity scale", () => {
  it("scores a very large image at no more than SCORE_MAX_PIXELS, and still passes a clean trace", async () => {
    const big = await sharp(Buffer.from(LOGO_SVG)).resize(4000, 1334, { fit: "fill" }).png().toBuffer();
    const svg = (await traceSvg(big)) as string;
    const started = Date.now();
    const fidelity = await svgFidelity(big, svg);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fidelity.score).toBeGreaterThanOrEqual(VECTOR_BAR);
  });
});
