import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encode } from "../src/encode.js";
import { calibrationOffset, confirmNextDefault, withQuality, type ConfirmSample } from "../src/calibrate.js";
import type { RawImage } from "../src/ssim.js";
import { gradientNoise } from "./image-fixtures.js";

const tiny: RawImage = { data: new Uint8ClampedArray(4), width: 1, height: 1 };

/** Stub encoder whose byte size is quality * 1000. */
const bytesEqualQuality = (async (_ref: RawImage, _format: "avif" | "webp", quality: number) => ({
  bytes: quality * 1000,
  decoded: tiny,
  buffer: Buffer.alloc(0),
})) as typeof encode;

describe("calibrationOffset", () => {
  it("matches the cdn byte size to a local quality and returns cdnQuality minus that quality", async () => {
    const result = await calibrationOffset(
      [{ ref: tiny, format: "avif", cdnQuality: 85, cdnBytes: 75000 }],
      { encode: bytesEqualQuality },
    );
    expect(result).toEqual({ offset: 10, n: 1 });
  });

  it("takes the median of per-sample offsets, averaging the middle pair for even n", async () => {
    const result = await calibrationOffset(
      [
        { ref: tiny, format: "avif", cdnQuality: 85, cdnBytes: 75000 },
        { ref: tiny, format: "avif", cdnQuality: 95, cdnBytes: 75000 },
      ],
      { encode: bytesEqualQuality },
    );
    expect(result).toEqual({ offset: 15, n: 2 });
  });

  it("returns undefined without samples", async () => {
    expect(await calibrationOffset([])).toBeUndefined();
  });

  it("works with the real encoder on a synthetic image", async () => {
    const ref = gradientNoise(96, 96, 4, 31);
    const target = (await encode(ref, "webp", 70, "cdn")).bytes;
    const result = await calibrationOffset([{ ref, format: "webp", cdnQuality: 70, cdnBytes: target }]);
    expect(result?.n).toBe(1);
    expect(Math.abs(result!.offset)).toBeLessThanOrEqual(10);
  });
});

describe("withQuality", () => {
  it("inserts q into a single-line array in sorted position", () => {
    const text = "const c = { images: { qualities: [75, 85] } };";
    expect(withQuality(text, 80)).toBe("const c = { images: { qualities: [75, 80, 85] } };");
    expect(withQuality(text, 90)).toBe("const c = { images: { qualities: [75, 85, 90] } };");
    expect(withQuality(text, 50)).toBe("const c = { images: { qualities: [50, 75, 85] } };");
  });

  it("leaves the text unchanged when q is already present", () => {
    const text = "images: { qualities: [75, 85] }";
    expect(withQuality(text, 85)).toBe(text);
  });

  it("keeps a multi-line array layout and trailing comma", () => {
    const text = "images: {\n  qualities: [\n    75,\n    85,\n  ],\n}";
    expect(withQuality(text, 80)).toBe("images: {\n  qualities: [\n    75,\n    80,\n    85,\n  ],\n}");
    expect(withQuality(text, 95)).toBe("images: {\n  qualities: [\n    75,\n    85,\n    95,\n  ],\n}");
  });

  it("only edits a qualities property that is a direct member of images", () => {
    expect(withQuality("const c = { qualities: [75] };", 80)).toBeUndefined();
    expect(withQuality("experimental: { qualities: [75] }", 80)).toBeUndefined();
    expect(withQuality("images: { loader: { qualities: [75] } }", 80)).toBeUndefined();
    expect(withQuality("images: { loader: { qualities: [75] }, qualities: [85] }", 90)).toBe(
      "images: { loader: { qualities: [75] }, qualities: [85, 90] }",
    );
    expect(withQuality("experimental: { qualities: [75] }, images: { qualities: [85] }", 90)).toBe(
      "experimental: { qualities: [75] }, images: { qualities: [85, 90] }",
    );
  });

  it("rejects a qualities array with non-numeric entries, even when they are strings", () => {
    expect(withQuality("images: { qualities: [75, 'x'] }", 80)).toBeUndefined();
  });

  it("returns undefined when there is no literal qualities array", () => {
    expect(withQuality("images: { formats: ['image/avif'] }", 80)).toBeUndefined();
    expect(withQuality("images: { qualities: QUALITIES }", 80)).toBeUndefined();
    expect(withQuality("images: { qualities: [75, LOW] }", 80)).toBeUndefined();
  });
});

/** Original image at the sample width, and the server-style variant of it encoded at `quality`. */
async function variantOf(ref: RawImage, format: "avif" | "webp", quality: number): Promise<Buffer> {
  const source = sharp(ref.data, { raw: { width: ref.width, height: ref.height, channels: 4 } });
  return format === "avif" ? source.avif({ quality }).toBuffer() : source.webp({ quality }).toBuffer();
}

function makeFetch(variantQuality: number, contentTypeOverride?: string) {
  const calls: { url: string; accept: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const accept = String((init?.headers as Record<string, string>).Accept);
    calls.push({ url, accept });
    const format = accept.startsWith("image/avif") ? "avif" : "webp";
    const body = await variantOf(refs.get(new URL(url).searchParams.get("url")!)!, format, variantQuality);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { "content-type": contentTypeOverride ?? `image/${format}` },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const refs = new Map<string, RawImage>();
const samples: ConfirmSample[] = [0, 1].map((i) => {
  const src = `/photos/p${i}.jpg`;
  const ref = gradientNoise(96, 96, 2, 40 + i);
  refs.set(src, ref);
  return { src, ref, width: 96 };
});

describe("confirmNextDefault", () => {
  it("confirms a faithful optimizer output and sends both Accept headers when both formats are probed", async () => {
    const { fetchImpl, calls } = makeFetch(95);
    const result = await confirmNextDefault("http://localhost:3000", samples, 85, 0.9, {
      fetchImpl,
      formats: ["avif", "webp"],
    });
    expect(result.confirmed).toBe(true);
    expect(result.ssim.avif).toBeGreaterThan(0.9);
    expect(result.ssim.webp).toBeGreaterThan(0.9);
    expect(result.bytes.avif).toBeGreaterThan(0);
    expect(calls.some((c) => c.accept === "image/avif,image/webp,*/*")).toBe(true);
    expect(calls.some((c) => c.accept === "image/webp,*/*")).toBe(true);
    expect(calls[0].url).toBe(
      `http://localhost:3000/_next/image?url=${encodeURIComponent("/photos/p0.jpg")}&w=96&q=85`,
    );
  });

  it("probes only webp by default and leaves avif fields undefined", async () => {
    const { fetchImpl, calls } = makeFetch(95);
    const result = await confirmNextDefault("http://localhost:3000", samples, 85, 0.9, { fetchImpl });
    expect(result.confirmed).toBe(true);
    expect(calls.every((c) => c.accept === "image/webp,*/*")).toBe(true);
    expect(result.ssim.avif).toBeUndefined();
    expect(result.bytes.avif).toBeUndefined();
    expect(result.failures.avif).toBeUndefined();
    expect(result.ssim.webp).toBeGreaterThan(0.9);
  });

  it("confirms nothing when no formats are probed", async () => {
    const { fetchImpl, calls } = makeFetch(95);
    const result = await confirmNextDefault("http://localhost:3000", samples, 85, 0.9, { fetchImpl, formats: [] });
    expect(result.confirmed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not confirm a heavily degraded optimizer output and counts ssim failures", async () => {
    const { fetchImpl } = makeFetch(3);
    const result = await confirmNextDefault("http://localhost:3000", samples, 85, 0.975, {
      fetchImpl,
      formats: ["avif", "webp"],
    });
    expect(result.confirmed).toBe(false);
    expect(result.failures.webp?.["ssim-fail"]).toBe(samples.length);
    expect(result.failures.avif?.["ssim-fail"]).toBe(samples.length);
  });

  it("records a non-OK HTTP response as an http failure and cancels its body", async () => {
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      )) as typeof fetch;
    const result = await confirmNextDefault("http://localhost:3000", samples, 85, 0.9, { fetchImpl });
    expect(result.confirmed).toBe(false);
    expect(result.failures.webp?.http).toBe(samples.length);
    expect(result.errors.webp).toBe("HTTP 500");
    expect(result.ssim.webp).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("records a rejected fetch as a fetch failure", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("socket hang up");
    }) as typeof fetch;
    const result = await confirmNextDefault("http://localhost:3000", samples, 85, 0.9, { fetchImpl });
    expect(result.confirmed).toBe(false);
    expect(result.failures.webp?.fetch).toBe(samples.length);
    expect(result.errors.webp).toBe("socket hang up");
  });

  it("resizes a wider variant to the reference size before scoring", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const accept = String((init?.headers as Record<string, string>).Accept);
      const ref = refs.get(new URL(String(input)).searchParams.get("url")!)!;
      const format = accept.startsWith("image/avif") ? "avif" : "webp";
      const wide = sharp(ref.data, { raw: { width: ref.width, height: ref.height, channels: 4 } }).resize(ref.width * 2, ref.height * 2);
      const body = await (format === "avif" ? wide.avif({ quality: 95 }) : wide.webp({ quality: 95 })).toBuffer();
      return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": `image/${format}` } });
    }) as typeof fetch;
    const result = await confirmNextDefault("http://localhost:3000", samples, 85, 0.5, { fetchImpl, percentile: 0.5 });
    expect(result.ssim.webp).toBeGreaterThan(0.5);
  });

  it("counts a wrong content type as a failed sample", async () => {
    const { fetchImpl } = makeFetch(95, "image/png");
    const result = await confirmNextDefault("http://localhost:3000", samples, 85, 0.9, { fetchImpl });
    expect(result.confirmed).toBe(false);
    expect(result.failures.webp?.["content-type"]).toBe(samples.length);
  });
});
