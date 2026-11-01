// `--gpu`: SSIMULACRA2 on an NVIDIA GPU, through an external program (native/ssimulacra2-gpu, built against Vship). Only
// the scoring moves to the GPU. Encoding and decoding stay on the CPU. The program is optional and found at run time:
// IMGTUNE_GPU_SCORER names it, else `imgtune-ssimu2-gpu` is looked up on PATH. A missing or failing program warns and the
// scores go to the CPU. It is never a hard requirement.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { flattenOnWhite, type GpuScoring } from "./metric.js";
import type { RawImage } from "./ssim.js";

export const GPU_SCORER_BINARY = "imgtune-ssimu2-gpu";

/**
 * The CPU fallbacks counted by the page being scanned, found by async context: pages scanned at the same time each count
 * their own (see countGpuFallbacks). Outside a page, nothing is counted here; the scorer's own totals still are.
 */
const pageFallbacks = new AsyncLocalStorage<{ fallbacks: number }>();

/** Runs `fn` and returns its value with the CPU fallbacks it caused, including those of the promises it started. */
export async function countGpuFallbacks<T>(fn: () => Promise<T>): Promise<{ value: T; fallbacks: number }> {
  const tally = { fallbacks: 0 };
  const value = await pageFallbacks.run(tally, fn);
  return { value, fallbacks: tally.fallbacks };
}
export const GPU_SCORER_ENV = "IMGTUNE_GPU_SCORER";

/** Limits of the program's protocol (native/ssimulacra2-gpu): a pair outside them is scored on the CPU. */
const MIN_SIDE = 8;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_REQUEST_PAIRS = 256;
/** A status message from the program longer than this is a broken stream, not a message. */
const MAX_MESSAGE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 60_000;
/** The self-test: an identical pair must score near 100 and a changed pair well below it. */
const SELF_TEST_IDENTICAL_MIN = 95;
const SELF_TEST_GAP = 10;

/** The GPU index an option names: nvidia-smi's index (PCI bus order). */
export function parseGpuDevice(text: string): number {
  if (!/^\d{1,3}$/.test(text)) throw new Error(`--gpu-device needs a GPU index (a whole number, as nvidia-smi lists it), not ${JSON.stringify(text.slice(0, 40))}`);
  return Number(text);
}

/** Text that came from a program or a file: printable, one line, short. */
function plain(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
}

/**
 * The environment of the program. A CUDA_VISIBLE_DEVICES the user set is kept as it is: the device is then an index within
 * the devices it lists, and the user's restriction (a GPU they excluded) is respected. Without one, imgtune restricts the
 * program to `device`. CUDA_DEVICE_ORDER is never overwritten: CUDA numbers the devices fastest first unless it is set to
 * PCI_BUS_ID (the order nvidia-smi lists them in).
 */
export function gpuScorerEnv(device: number, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (base.CUDA_VISIBLE_DEVICES !== undefined) return { ...base };
  return { ...base, CUDA_VISIBLE_DEVICES: String(device) };
}

/** The `--device` argument the program gets: `device` within the user's visible list, else 0 (imgtune's own restriction). */
export function gpuProgramIndex(device: number, base: NodeJS.ProcessEnv = process.env): number {
  return base.CUDA_VISIBLE_DEVICES !== undefined ? device : 0;
}

/**
 * The line that says which device the scorer opened and how it was numbered, printed before the first score. Index order
 * is CUDA's (fastest first) unless CUDA_DEVICE_ORDER says otherwise, so the name is the thing to check.
 */
export function openedDeviceLine(device: number, name: string, base: NodeJS.ProcessEnv = process.env): string {
  const order = plain(base.CUDA_DEVICE_ORDER ?? "FASTEST_FIRST (CUDA's default)");
  const visible = base.CUDA_VISIBLE_DEVICES !== undefined ? `CUDA_VISIBLE_DEVICES=${plain(base.CUDA_VISIBLE_DEVICES)}` : `CUDA_VISIBLE_DEVICES=${device} (set by imgtune)`;
  return `--gpu: opened ${name}, device index ${device} (CUDA_DEVICE_ORDER: ${order}; ${visible})`;
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** The program's path: IMGTUNE_GPU_SCORER when set (it must be executable), else the first match on PATH. */
export async function findGpuScorer(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const configured = env[GPU_SCORER_ENV];
  if (configured !== undefined && configured !== "") return (await isExecutable(configured)) ? configured : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, GPU_SCORER_BINARY);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export interface GpuCheck {
  /** The device's name as the driver reports it. */
  name: string;
  identical: number;
  perturbed: number;
}

/** Runs the program's self-test on a device. Rejects with the reason when the program fails or does not score right. */
export function checkGpuScorer(binary: string, device: number, env: NodeJS.ProcessEnv = process.env): Promise<GpuCheck> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["--check", "--device", String(gpuProgramIndex(device, env))], { env: gpuScorerEnv(device, env), timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const reason = plain(stderr.split("\n").find((line) => line.trim() !== "") ?? err.message);
        reject(new Error(`the GPU scorer failed its check (${reason})`));
        return;
      }
      let parsed: { device?: unknown; identical?: unknown; perturbed?: unknown };
      try {
        parsed = JSON.parse(stdout) as typeof parsed;
      } catch {
        reject(new Error("the GPU scorer printed no check result"));
        return;
      }
      const { device: name, identical, perturbed } = parsed;
      if (typeof name !== "string" || typeof identical !== "number" || typeof perturbed !== "number") {
        reject(new Error("the GPU scorer printed an unreadable check result"));
        return;
      }
      if (!(identical >= SELF_TEST_IDENTICAL_MIN && perturbed <= identical - SELF_TEST_GAP)) {
        reject(new Error(`the GPU scorer's self-test failed (identical ${identical}, changed ${perturbed})`));
        return;
      }
      resolve({ name: plain(name), identical, perturbed });
    });
  });
}

/** Whether a pair can go to the program: the sides and the pixel count it accepts. */
export function gpuEligible(width: number, height: number): boolean {
  return width >= MIN_SIDE && height >= MIN_SIDE && width * height <= MAX_PIXELS;
}

/** Writes the RGB bytes of an RGBA image (flattened on white first, as the CPU scorer does) at `at`. */
function putRgb(out: Buffer, at: number, img: RawImage): number {
  const rgba = flattenOnWhite(img);
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    out[at++] = rgba[i * 4];
    out[at++] = rgba[i * 4 + 1];
    out[at++] = rgba[i * 4 + 2];
  }
  return at;
}

/** One request: a count, then per pair the size and the reference and test RGB. See native/ssimulacra2-gpu. */
export function encodeRequest(pairs: [RawImage, RawImage][]): Buffer {
  if (pairs.length === 0 || pairs.length > MAX_REQUEST_PAIRS) throw new Error(`a GPU request holds 1 to ${MAX_REQUEST_PAIRS} pairs, not ${pairs.length}`);
  let size = 4;
  for (const [ref, test] of pairs) {
    if (ref.width !== test.width || ref.height !== test.height) throw new Error("GPU scoring needs equal dimensions");
    size += 8 + ref.width * ref.height * 6;
  }
  const out = Buffer.alloc(size);
  out.writeUInt32LE(pairs.length, 0);
  let at = 4;
  for (const [ref, test] of pairs) {
    out.writeUInt32LE(ref.width, at);
    out.writeUInt32LE(ref.height, at + 4);
    at += 8;
    at = putRgb(out, at, ref);
    at = putRgb(out, at, test);
  }
  return out;
}

export interface GpuScorerOptions {
  binary: string;
  device: number;
  deviceName: string;
  env?: NodeJS.ProcessEnv;
  /** Called once, with the reason, when the program fails. The scores from then on are the CPU's. */
  warn: (message: string) => void;
}

/**
 * A long-lived GPU scorer: one program process per run (CUDA starts once), requests one at a time over its stdin and
 * stdout. `tryScore` returns undefined when the CPU must score the pair (too small, or the GPU has failed).
 */
export class GpuScorer implements GpuScoring {
  readonly device: number;
  readonly deviceName: string;
  /** Scores the GPU could not take after it failed, so the CPU scored them. */
  fallbackScores = 0;
  /**
   * Every pair the CPU scored through this scorer: the fallbacks, and the pairs too small for the program (which never
   * count as fallbacks). A caller that stores a score under this scorer's key checks that this did not move (see remote.ts).
   */
  cpuScores = 0;

  private readonly binary: string;
  private readonly env: NodeJS.ProcessEnv;
  /** The CUDA device numbering and visible list the scorer ran with (written into the scan JSON, so a run can be checked). */
  get cuda(): { deviceOrder: string; visibleDevices: string } {
    return {
      deviceOrder: this.env.CUDA_DEVICE_ORDER ?? "FASTEST_FIRST",
      visibleDevices: this.env.CUDA_VISIBLE_DEVICES ?? String(this.device),
    };
  }
  private readonly warn: (message: string) => void;
  private child?: ChildProcess;
  private stderrTail = "";
  private buffered: Buffer = Buffer.alloc(0);
  private waiting?: { need: number; resolve: (buf: Buffer) => void; reject: (err: Error) => void };
  private queue: Promise<unknown> = Promise.resolve();
  private failure?: Error;
  private closing = false;

  constructor(opts: GpuScorerOptions) {
    this.binary = opts.binary;
    this.device = opts.device;
    this.deviceName = opts.deviceName;
    this.env = opts.env ?? process.env;
    this.warn = opts.warn;
  }

  /** The GPU's score for the pair, or undefined when the CPU must score it. */
  async tryScore(ref: RawImage, test: RawImage): Promise<number | undefined> {
    if (this.failure !== undefined) {
      this.fallback();
      return undefined;
    }
    if (!gpuEligible(ref.width, ref.height)) {
      this.cpuScores++;
      return undefined;
    }
    try {
      const [value] = await this.scoreBatch([[ref, test]]);
      return value;
    } catch (err) {
      this.fallback();
      this.kill(err instanceof Error ? err : new Error(String(err)));
      return undefined;
    }
  }

  /** The CPU scores a pair the GPU could not take: counted for the scorer, and for the page that asked. */
  private fallback(): void {
    this.fallbackScores++;
    this.cpuScores++;
    const tally = pageFallbacks.getStore();
    if (tally !== undefined) tally.fallbacks++;
  }

  /** Scores several pairs in one request (one round trip). Requests run one at a time, in the order they were made. */
  scoreBatch(pairs: [RawImage, RawImage][]): Promise<number[]> {
    const body = encodeRequest(pairs);
    const run = () => this.exchange(pairs.length, body);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Ends the program's input, so it exits on its own. Kills it after a short wait if it does not. */
  close(): void {
    this.closing = true;
    const child = this.child;
    if (child === undefined) return;
    child.stdin?.end();
    const timer = setTimeout(() => child.kill(), 2000);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }

  private async exchange(count: number, body: Buffer): Promise<number[]> {
    if (this.failure !== undefined) throw this.failure;
    const child = this.start();
    child.stdin?.write(body);
    const status = (await this.read(4)).readUInt32LE(0);
    if (status !== 0) {
      const length = (await this.read(4)).readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) throw new Error("the GPU scorer sent a broken message");
      throw new Error(`the GPU scorer failed (${plain((await this.read(length)).toString("utf8"))})`);
    }
    const scores = await this.read(count * 8);
    return Array.from({ length: count }, (_, i) => scores.readDoubleLE(i * 8));
  }

  private start(): ChildProcess {
    if (this.child !== undefined) return this.child;
    const child = spawn(this.binary, ["--device", String(gpuProgramIndex(this.device, this.env))], { env: gpuScorerEnv(this.device, this.env), stdio: ["pipe", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.drain();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.stdin?.on("error", () => this.kill(new Error("the GPU scorer closed its input")));
    child.on("error", (err) => this.kill(new Error(`the GPU scorer could not run (${plain(err.message)})`)));
    child.on("exit", (code, signal) => {
      if (this.closing) return;
      const last = plain(this.stderrTail.split("\n").filter((line) => line.trim() !== "").pop() ?? "");
      this.kill(new Error(`the GPU scorer stopped (${signal ?? `exit ${code}`})${last ? `: ${last}` : ""}`));
    });
    this.child = child;
    return child;
  }

  private read(need: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.kill(new Error(`the GPU scorer gave no answer within ${REQUEST_TIMEOUT_MS / 1000} s`)),
        REQUEST_TIMEOUT_MS,
      );
      this.waiting = {
        need,
        resolve: (buf) => {
          clearTimeout(timer);
          resolve(buf);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiting !== undefined && this.buffered.length >= this.waiting.need) {
      const waiting = this.waiting;
      this.waiting = undefined;
      const out = this.buffered.subarray(0, waiting.need);
      this.buffered = this.buffered.subarray(waiting.need);
      waiting.resolve(out);
    }
  }

  /** Marks the scorer failed (once: the warning is printed then), stops the program and fails the waiting request. */
  private kill(err: Error): void {
    if (this.failure === undefined) {
      this.failure = err;
      if (!this.closing) this.warn(`--gpu: ${err.message}; the scores from here on run on the CPU`);
    }
    this.child?.kill();
    if (this.waiting !== undefined) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.reject(this.failure);
    }
  }
}

/**
 * Starts the GPU scorer for `--gpu`. Returns undefined, after a warning, when the program is missing or fails its
 * self-test: the run then scores on the CPU, as it does without --gpu.
 */
export async function startGpuScorer(device: number, log: (message: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<GpuScorer | undefined> {
  const binary = await findGpuScorer(env);
  if (binary === undefined) {
    const reason = env[GPU_SCORER_ENV] ? `${GPU_SCORER_ENV} does not name an executable file` : `${GPU_SCORER_BINARY} is not on PATH`;
    log(`--gpu: ${reason}; scoring on the CPU`);
    return undefined;
  }
  let check: GpuCheck;
  try {
    check = await checkGpuScorer(binary, device, env);
  } catch (err) {
    log(`--gpu ${device}: ${(err as Error).message}; scoring on the CPU`);
    return undefined;
  }
  log(openedDeviceLine(device, check.name, env));
  return new GpuScorer({ binary, device, deviceName: check.name, env, warn: log });
}

/** The line that tells a reader which scorer made the numbers (scan, image and recheck print it when the GPU scored). */
export function gpuNote(device: number, deviceName: string, cpuFallbacks = 0): string {
  const fell = cpuFallbacks > 0 ? `; ${cpuFallbacks} score(s) fell back to the CPU after the GPU failed` : "";
  return `scored on GPU; may differ slightly from CPU (device ${device}: ${deviceName})${fell}`;
}
