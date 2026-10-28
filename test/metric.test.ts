import sharp from "sharp";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { assertMetricAvailable, clearSsimulacra2Cache, makeScorer, resolveSsimulacra2, score } from "../src/metric.js";
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

describe.skipIf(!hasBinary)("ssimulacra2 concurrency", () => {
  it("never runs more than four binaries at once, and does run several", async () => {
    const dir = await projectDir();
    const { bin, log } = await countingBinary(dir);
    const scorer = makeScorer("ssimulacra2", { projectDir: dir, binary: bin });
    const img = gradientNoise(48, 48, 0, 11);
    const values = await Promise.all(Array.from({ length: 9 }, () => scorer(img, img)));
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

  it("fails the startup check for a missing binary when the metric is ssimulacra2, and not for ssim", async () => {
    await expect(assertMetricAvailable("ssimulacra2", "/nonexistent/ssimulacra2_rs")).rejects.toThrow(
      /ssimulacra2_rs not found at \/nonexistent\/ssimulacra2_rs; install with/,
    );
    await expect(assertMetricAvailable("ssim", "/nonexistent/ssimulacra2_rs")).resolves.toBeUndefined();
  });

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
