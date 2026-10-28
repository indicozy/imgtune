import sharp from "sharp";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeScorer, resolveSsimulacra2, score } from "../src/metric.js";
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

describe("score ssim", () => {
  it("scores identical images as 1 without a binary", async () => {
    const img = gradientNoise(64, 48, 0, 7);
    expect(await score("ssim", img, img)).toBe(1);
  });
});

describe.skipIf(!hasBinary)("score ssimulacra2", () => {
  it("scores identical images as 100", async () => {
    const img = gradientNoise(96, 64, 0, 8);
    const value = await score("ssimulacra2", img, img, { projectDir: await projectDir() });
    expect(value).toBeGreaterThan(99.99);
    expect(value).toBeLessThanOrEqual(100.0001);
  });

  it("scores a degraded JPEG roundtrip between 50 and 90", async () => {
    const dir = await projectDir();
    const ref = gradientNoise(256, 192, 6, 9);
    const jpeg = await sharp(ref.data, { raw: { width: 256, height: 192, channels: 4 } }).jpeg({ quality: 50 }).toBuffer();
    const degraded = await decodeRgba(jpeg);
    const value = await score("ssimulacra2", ref, degraded, { projectDir: dir });
    expect(value).toBeLessThan(90);
    expect(value).toBeGreaterThan(50);
  });

  it("leaves no PNG behind in the project's temp directory", async () => {
    const dir = await projectDir();
    const img = gradientNoise(32, 32, 0, 10);
    await score("ssimulacra2", img, img, { projectDir: dir });
    expect(await readdir(join(dir, ".imgtune", "tmp"))).toEqual([]);
  });

  it("runs more scores than the four-run limit at once and gets every result", async () => {
    const scorer = makeScorer("ssimulacra2", { projectDir: await projectDir() });
    const img = gradientNoise(48, 48, 0, 11);
    const values = await Promise.all(Array.from({ length: 9 }, () => scorer(img, img)));
    for (const value of values) expect(value).toBeGreaterThan(99.99);
  });
});

describe("ssimulacra2 binary lookup", () => {
  it("reports a missing configured binary with the install hint", async () => {
    const img = gradientNoise(16, 16, 0, 12);
    await expect(
      score("ssimulacra2", img, img, { projectDir: await projectDir(), binary: "/nonexistent/ssimulacra2_rs" }),
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
