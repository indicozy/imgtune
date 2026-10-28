import sharp from "sharp";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertMetricAvailable,
  cachedScorer,
  clearScoreCache,
  clearSsimulacra2Cache,
  makeScorer,
  resolveSsimulacra2,
  score,
} from "../src/metric.js";
import { ssim, type RawImage } from "../src/ssim.js";
import { decodeRgba, gradientNoise } from "./image-fixtures.js";

const created: string[] = [];
async function projectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "imgtune-metric-"));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

const hasBinary = await resolveSsimulacra2().then(
  () => true,
  () => false,
);

/** The image with every pixel's alpha set to `alpha`. */
function withAlpha(img: RawImage, alpha: number): RawImage {
  const data = new Uint8ClampedArray(img.data);
  for (let i = 3; i < data.length; i += 4) data[i] = alpha;
  return { data, width: img.width, height: img.height };
}

async function jpegRoundtrip(img: RawImage, quality: number): Promise<RawImage> {
  const jpeg = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).jpeg({ quality }).toBuffer();
  return decodeRgba(jpeg);
}

describe("score ssim", () => {
  it("scores identical images as 1 without a binary", async () => {
    const img = gradientNoise(64, 48, 0, 7);
    expect(await score("ssim", img, img)).toBe(1);
  });
});

describe("score ssimulacra2 (WebAssembly)", () => {
  it("scores identical images as 100 without a binary", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const img = gradientNoise(96, 64, 0, 8);
      const value = await score("ssimulacra2", img, img);
      expect(value).toBeGreaterThan(99.99);
      expect(value).toBeLessThanOrEqual(100.0001);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("scores a degraded JPEG roundtrip between 50 and 90", async () => {
    const ref = gradientNoise(256, 192, 6, 9);
    const degraded = await jpegRoundtrip(ref, 50);
    const value = await score("ssimulacra2", ref, degraded);
    expect(value).toBeLessThan(90);
    expect(value).toBeGreaterThan(50);
  });

  it("ignores the colour under transparent pixels, as the native path does", async () => {
    const opaqueWhite = { ...gradientNoise(32, 32, 0, 13), data: new Uint8ClampedArray(32 * 32 * 4).fill(255) };
    const transparent = gradientNoise(32, 32, 9, 14);
    const clear = withAlpha(transparent, 0);
    expect(await score("ssimulacra2", opaqueWhite, clear)).toBeGreaterThan(99.99);
  });

  it("rejects a buffer that does not hold width x height RGBA pixels", async () => {
    const img = gradientNoise(16, 16, 0, 15);
    const short = { ...img, data: img.data.subarray(0, 100) };
    await expect(score("ssimulacra2", img, short)).rejects.toThrow(/RGBA bytes/);
  });

  it.skipIf(!hasBinary)("matches the native binary on five pairs within 0.01", async () => {
    const dir = await projectDir();
    const ref = gradientNoise(256, 192, 6, 31);
    const pairs: [RawImage, RawImage][] = [
      [ref, await jpegRoundtrip(ref, 20)],
      [ref, await jpegRoundtrip(ref, 40)],
      [ref, await jpegRoundtrip(ref, 60)],
      [ref, await jpegRoundtrip(ref, 85)],
      [withAlpha(ref, 128), withAlpha(await jpegRoundtrip(ref, 40), 128)],
    ];
    for (const [a, b] of pairs) {
      const wasm = await score("ssimulacra2", a, b);
      const native = await score("ssimulacra2-native", a, b, { projectDir: dir });
      expect(Math.abs(wasm - native)).toBeLessThanOrEqual(0.01);
    }
  });
});

describe.skipIf(!hasBinary)("score ssimulacra2-native", () => {
  it("scores identical images as 100", async () => {
    const img = gradientNoise(96, 64, 0, 8);
    const value = await score("ssimulacra2-native", img, img, { projectDir: await projectDir() });
    expect(value).toBeGreaterThan(99.99);
    expect(value).toBeLessThanOrEqual(100.0001);
  });

  it("scores a degraded JPEG roundtrip between 50 and 90", async () => {
    const dir = await projectDir();
    const ref = gradientNoise(256, 192, 6, 9);
    const degraded = await jpegRoundtrip(ref, 50);
    const value = await score("ssimulacra2-native", ref, degraded, { projectDir: dir });
    expect(value).toBeLessThan(90);
    expect(value).toBeGreaterThan(50);
  });

  it("leaves no PNG behind in the project's temp directory", async () => {
    const dir = await projectDir();
    const img = gradientNoise(32, 32, 0, 10);
    await score("ssimulacra2-native", img, img, { projectDir: dir });
    expect(await readdir(join(dir, ".imgtune", "tmp"))).toEqual([]);
  });
});

/** A stand-in ssimulacra2_rs that logs how many runs are in flight when it starts, then scores 90 after 200 ms. */
async function countingBinary(dir: string): Promise<{ bin: string; log: string }> {
  const active = join(dir, "active");
  const log = join(dir, "in-flight.log");
  await mkdir(active);
  const bin = join(dir, "ssimulacra2_rs");
  await writeFile(
    bin,
    `#!/bin/sh\nmkdir "${active}/$$" || exit 1\necho "$(ls -1 "${active}" | wc -l)" >> "${log}"\nsleep 0.2\nrmdir "${active}/$$"\necho "Score: 90"\n`,
  );
  await chmod(bin, 0o755);
  return { bin, log };
}

describe("ssimulacra2-native concurrency", () => {
  it("never runs more than four binaries at once, and does run several", async () => {
    const dir = await projectDir();
    const { bin, log } = await countingBinary(dir);
    const scorer = makeScorer("ssimulacra2-native", { projectDir: dir, binary: bin });
    const img = gradientNoise(48, 48, 0, 11);
    // Distinct pixels, so the score cache does not answer any of the nine.
    const values = await Promise.all(Array.from({ length: 9 }, (_, i) => scorer(gradientNoise(48, 48, 2, 100 + i), img)));
    expect(values).toEqual(Array(9).fill(90));
    const inFlight = (await readFile(log, "utf8")).trim().split("\n").map(Number);
    expect(inFlight).toHaveLength(9);
    expect(Math.max(...inFlight)).toBeLessThanOrEqual(4);
    expect(Math.max(...inFlight)).toBeGreaterThanOrEqual(2);
  });
});

describe("ssimulacra2 binary lookup", () => {
  beforeEach(() => clearSsimulacra2Cache());

  it("looks a configured binary up once and keeps its path after that", async () => {
    const { bin } = await countingBinary(await projectDir());
    expect(await resolveSsimulacra2(bin)).toBe(bin);
    await unlink(bin);
    expect(await resolveSsimulacra2(bin)).toBe(bin);
  });

  it("fails the startup check for a missing binary when the metric is ssimulacra2-native, and not for ssimulacra2 or ssim", async () => {
    await expect(assertMetricAvailable("ssimulacra2-native", "/nonexistent/ssimulacra2_rs")).rejects.toThrow(
      /ssimulacra2_rs not found at \/nonexistent\/ssimulacra2_rs; install with/,
    );
    await expect(assertMetricAvailable("ssimulacra2", "/nonexistent/ssimulacra2_rs")).resolves.toBeUndefined();
    await expect(assertMetricAvailable("ssim", "/nonexistent/ssimulacra2_rs")).resolves.toBeUndefined();
  });

  it("reports a missing configured binary with the install hint", async () => {
    const img = gradientNoise(16, 16, 0, 12);
    await expect(
      score("ssimulacra2-native", img, img, { projectDir: await projectDir(), binary: "/nonexistent/ssimulacra2_rs" }),
    ).rejects.toThrow(/ssimulacra2_rs not found at \/nonexistent\/ssimulacra2_rs; install with "cargo install ssimulacra2_rs --no-default-features" or run with --metric ssim/);
  });

  it("reports the install hint when no binary is found on PATH or in ~/.cargo/bin", async () => {
    const saved = process.env.PATH;
    const home = process.env.HOME;
    process.env.PATH = "/nonexistent";
    process.env.HOME = "/nonexistent";
    try {
      await expect(resolveSsimulacra2()).rejects.toThrow(
        'ssimulacra2_rs not found; install with "cargo install ssimulacra2_rs --no-default-features" or run with --metric ssim',
      );
    } finally {
      process.env.PATH = saved;
      process.env.HOME = home;
    }
  });
});

describe("cachedScorer", () => {
  beforeEach(() => clearScoreCache());
  const a = gradientNoise(32, 32, 0, 21);
  const b = gradientNoise(32, 32, 3, 22);

  it("scores each ordered pair of images once, however often it is asked", async () => {
    let calls = 0;
    const scorer = cachedScorer("ssim", (ref, test) => {
      calls++;
      return ssim(ref, test);
    });
    const first = await scorer(a, b);
    expect(await scorer(a, b)).toBe(first);
    expect(await scorer(a, b)).toBe(first);
    expect(calls).toBe(1);
    await scorer(b, a);
    expect(calls).toBe(2);
  });

  it("shares a score between scorers of the same metric, and not across metrics", async () => {
    let calls = 0;
    const inner = (ref: typeof a, test: typeof a) => {
      calls++;
      return ssim(ref, test);
    };
    await cachedScorer("ssim", inner)(a, b);
    await cachedScorer("ssim", inner)(a, b);
    expect(calls).toBe(1);
    await cachedScorer("ssimulacra2", inner)(a, b);
    expect(calls).toBe(2);
  });

  it("does not keep a failed score, so the next ask computes it again", async () => {
    let calls = 0;
    const scorer = cachedScorer("ssim", (ref, test) => {
      calls++;
      if (calls === 1) throw new Error("binary failed");
      return ssim(ref, test);
    });
    await expect(scorer(a, b)).rejects.toThrow("binary failed");
    expect(await scorer(a, b)).toBeCloseTo(ssim(a, b), 12);
    expect(calls).toBe(2);
  });
});
