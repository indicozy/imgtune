import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import sharp from "sharp";
import { writeFileAtomic } from "./atomic.js";
import { ssim, type RawImage } from "./ssim.js";

/** `ssimulacra2`: perceptual score, 100 for identical images. `ssim`: the plain SSIM in ssim.ts, 1 for identical. */
export type Metric = "ssimulacra2" | "ssim";
export const METRICS: readonly Metric[] = ["ssimulacra2", "ssim"];

/** Scores a decoded image against its reference on the metric's own scale. Synchronous scorers are fine too. */
export type Scorer = (ref: RawImage, test: RawImage) => number | Promise<number>;

export interface ScoreOptions {
  /** Project root. ssimulacra2 writes its PNG pair under `<projectDir>/.imgtune/tmp`. Defaults to the working directory. */
  projectDir?: string;
  /** The `ssimulacra2_rs` binary (config `ssimulacra2Path`). Without it the binary is looked up on PATH, then in ~/.cargo/bin. */
  binary?: string;
}

const BINARY = "ssimulacra2_rs";
const INSTALL_HINT = 'install with "cargo install ssimulacra2_rs --no-default-features" or run with --metric ssim';
const MAX_CONCURRENT_RUNS = 4;
const RUN_TIMEOUT_MS = 120_000;

/** Binary runs in flight, and the callers waiting for a slot. A finishing run hands its slot to the next waiter. */
let running = 0;
const waiting: (() => void)[] = [];

async function withRunSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running < MAX_CONCURRENT_RUNS) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** Scores `test` against `ref` with the given metric. Dimensions must match. */
export async function score(metric: Metric, ref: RawImage, test: RawImage, opts: ScoreOptions = {}): Promise<number> {
  if (metric === "ssim") return ssim(ref, test);
  return ssimulacra2(ref, test, opts);
}

/** A scorer bound to one metric and its options, for the search, analysis and verify code. */
export function makeScorer(metric: Metric, opts: ScoreOptions = {}): Scorer {
  return (ref, test) => score(metric, ref, test, opts);
}

/** Short name of a metric as shown in table headers. */
export function metricLabel(metric: Metric): string {
  return metric === "ssim" ? "SSIM" : "SSIMU2";
}

/** A score with the decimals its metric is read at. */
export function formatScore(metric: Metric, value: number): string {
  return value.toFixed(metric === "ssim" ? 3 : 1);
}

async function ssimulacra2(ref: RawImage, test: RawImage, opts: ScoreOptions): Promise<number> {
  if (ref.width !== test.width || ref.height !== test.height) {
    throw new Error(`ssimulacra2 requires equal dimensions (${ref.width}x${ref.height} vs ${test.width}x${test.height})`);
  }
  const binary = await resolveSsimulacra2(opts.binary);
  const projectDir = opts.projectDir ?? process.cwd();
  const dir = join(projectDir, ".imgtune", "tmp");
  await mkdir(dir, { recursive: true });
  const stem = join(dir, randomUUID());
  const refPath = `${stem}-ref.png`;
  const testPath = `${stem}-test.png`;
  try {
    await writeFileAtomic(refPath, await toPng(ref), { root: projectDir });
    await writeFileAtomic(testPath, await toPng(test), { root: projectDir });
    const stdout = await withRunSlot(() => runBinary(binary, ["image", refPath, testPath]));
    const match = /Score:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(stdout);
    const value = match ? Number(match[1]) : Number.NaN;
    if (!Number.isFinite(value)) throw new Error(`${BINARY} printed no score: ${stdout.trim()}`);
    return value;
  } finally {
    await rm(refPath, { force: true });
    await rm(testPath, { force: true });
  }
}

/**
 * PNG of the image composited on white. The binary reads colour only and ignores alpha, so flattening keeps the
 * colour under transparent pixels from counting. Opaque images are unchanged.
 */
async function toPng(img: RawImage): Promise<Buffer> {
  const data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return sharp(data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

function runBinary(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // execFile, not exec: the paths never go through a shell.
    execFile(binary, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${BINARY} failed: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

const missing = (where: string): Error => new Error(`${BINARY} not found${where}; ${INSTALL_HINT}`);

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** Resolved binary per configured path (`""` for the lookup without one). Only successes are kept. */
const resolvedBinaries = new Map<string, string>();

/**
 * The ssimulacra2_rs binary: the configured path when one is given (and must exist), else the first match on PATH,
 * else ~/.cargo/bin/ssimulacra2_rs. Throws with the install hint when none is found. The lookup runs once per
 * configured path; later calls return the cached path.
 */
export async function resolveSsimulacra2(configured?: string): Promise<string> {
  const key = configured ?? "";
  const cached = resolvedBinaries.get(key);
  if (cached !== undefined) return cached;
  const found = await lookUpSsimulacra2(configured);
  resolvedBinaries.set(key, found);
  return found;
}

/** Forgets the cached binaries, so the next resolution looks them up again. For tests. */
export function clearSsimulacra2Cache(): void {
  resolvedBinaries.clear();
}

/**
 * Fails before any work starts when the metric needs the ssimulacra2 binary and it cannot be found, with the install
 * hint. Resolving also caches the path for the scores that follow.
 */
export async function assertMetricAvailable(metric: Metric, binary?: string): Promise<void> {
  if (metric === "ssimulacra2") await resolveSsimulacra2(binary);
}

async function lookUpSsimulacra2(configured?: string): Promise<string> {
  if (configured !== undefined) {
    if (await isExecutable(configured)) return configured;
    throw missing(` at ${configured}`);
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, BINARY);
    if (await isExecutable(candidate)) return candidate;
  }
  const cargo = join(homedir(), ".cargo", "bin", BINARY);
  if (await isExecutable(cargo)) return cargo;
  throw missing("");
}
