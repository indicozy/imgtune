// The system ffmpeg and ffprobe, used through their command lines. imgtune never bundles ffmpeg: a probe reports what
// the installed build can do, and every call here is bounded by a timeout and can be aborted, so one heavy file cannot
// hold a scan.

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Writable } from "node:stream";

/**
 * What the installed ffmpeg can do. `av1` is the AV1 encoder to use (SVT-AV1 preferred, libaom as the fallback), or
 * undefined when neither is built in. `vmaf` is the libvmaf filter used for the quality check; `avifMuxer` is the AVIF
 * container; `webpAnim` is the animated WebP encoder; `x264` is the H.264 fallback encoder.
 */
export interface FfmpegCaps {
  ffmpeg: boolean;
  ffprobe: boolean;
  vmaf: boolean;
  av1?: "libsvtav1" | "libaom-av1";
  x264: boolean;
  webpAnim: boolean;
  avifMuxer: boolean;
  /**
   * NVENC encoders, listed by the build and proven by a test encode on the chosen GPU (see withGpu). Both are false
   * until withGpu runs for a device: the listing alone does not say the driver can open the card.
   */
  av1Nvenc: boolean;
  h264Nvenc: boolean;
  /**
   * The libvmaf_cuda filter: VMAF on the GPU. Listed by the build, and proven on a device by withGpu. Both are false until
   * withGpu runs for a device.
   */
  vmafCuda: boolean;
}

/** What one probed video or animated file is: its size, length, frame rate and codecs, read by ffprobe. */
export interface MediaProbe {
  /** Length in seconds. 0 when the file does not say (for example a live stream). */
  durationS: number;
  width: number;
  height: number;
  /** Frames per second, from avg_frame_rate, falling back to r_frame_rate. 0 when unknown. */
  fps: number;
  videoCodec: string;
  /** Present only when the file has an audio track. */
  audio?: { codec: string; bitrate?: number };
  /** Whole-file bitrate in bits per second, when ffprobe reports it. */
  bitrate?: number;
}

/** Parallel ffmpeg jobs an encode run starts at once: a small number, because each job already uses several threads. */
export const FFMPEG_JOBS = 4;
/** Threads each ffmpeg job uses. FFMPEG_JOBS × FFMPEG_THREADS stays within the CPUs the encodes are given. */
export const FFMPEG_THREADS = 2;

/** Stderr kept from a run, in bytes. The tail is kept, because ffmpeg prints the error last. */
const STDERR_CAP = 64 * 1024;

/** Stdout a run may produce before it is stopped, in bytes: enough for a short raw-video sample, not for a runaway. */
export const DEFAULT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/** Thrown when an ffmpeg run passes its timeout; the process is killed before this rejects. */
export class FfmpegTimeout extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`ffmpeg did not finish within ${timeoutMs} ms`);
    this.name = "FfmpegTimeout";
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when a run writes more stdout than its cap; the process is killed before this rejects. */
export class FfmpegOutputTooLarge extends Error {
  readonly maxStdoutBytes: number;

  constructor(maxStdoutBytes: number) {
    super(`ffmpeg wrote more than ${maxStdoutBytes} bytes to stdout`);
    this.name = "FfmpegOutputTooLarge";
    this.maxStdoutBytes = maxStdoutBytes;
  }
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Bytes written to the process's stdin, chunk by chunk, then closed (read as `-i pipe:0`). A raw timeline is streamed this
   * way, a page at a time, so it is never built in memory. A write that fails because the process is gone is not an error.
   */
  stdin?: () => AsyncIterable<Uint8Array>;
  /** Stdout cap in bytes; a run past it is killed and rejects with FfmpegOutputTooLarge. */
  maxStdoutBytes?: number;
  /** The environment of the process. Default: this process's, or the GPU's inside onGpuDevice. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The most ffmpeg and ffprobe processes the CPU pool runs at once. 4 jobs × FFMPEG_THREADS (2) = 8 threads, which is the CPU
 * budget the encodes are given. Every CPU run waits for a slot, FIFO, across the whole process.
 */
export const FFMPEG_MAX_PROCS = 4;
/**
 * The most ffmpeg processes one GPU runs at once (its own pool, apart from the CPU pool). Two, so the card's NVENC sessions
 * and its CUDA context are not oversubscribed by one worker pair.
 */
export const GPU_MAX_PROCS = 2;

/** The GPU a run is bound to, inherited by every async step started inside onGpuDevice. */
const gpuContext = new AsyncLocalStorage<{ device: number }>();

/**
 * Runs `run` with every ffmpeg and ffprobe process it starts bound to one GPU: they take that GPU's pool (GPU_MAX_PROCS) and
 * run with CUDA_DEVICE_ORDER=PCI_BUS_ID and CUDA_VISIBLE_DEVICES=device, unless a call names its own environment. Runs outside
 * it use the CPU pool (FFMPEG_MAX_PROCS).
 */
export function onGpuDevice<T>(device: number, run: () => Promise<T>): Promise<T> {
  return gpuContext.run({ device }, run);
}

/** A slot pool: at most `limit` processes hold a slot at once, the rest wait in arrival order. */
class SlotPool {
  inUse = 0;
  readonly queue: (() => void)[] = [];
  constructor(readonly limit: number) {}
}

const cpuPool = new SlotPool(FFMPEG_MAX_PROCS);
const gpuPools = new Map<number, SlotPool>();

function gpuPool(device: number): SlotPool {
  let pool = gpuPools.get(device);
  if (pool === undefined) {
    pool = new SlotPool(GPU_MAX_PROCS);
    gpuPools.set(device, pool);
  }
  return pool;
}

/**
 * Starts `run` now when a slot of the pool is free, else queues it. Returns a function that removes the run from the queue if
 * it is still waiting (used when its timeout or abort fires first). A run that starts holds its slot until releaseSlot.
 */
function requestSlot(pool: SlotPool, run: () => void): () => void {
  if (pool.inUse < pool.limit) {
    pool.inUse++;
    run();
    return () => {};
  }
  pool.queue.push(run);
  return () => {
    const index = pool.queue.indexOf(run);
    if (index >= 0) pool.queue.splice(index, 1);
  };
}

/** Gives a slot back. The next queued run of the pool takes it at once, so the count never exceeds the pool's limit. */
function releaseSlot(pool: SlotPool): void {
  pool.inUse--;
  const next = pool.queue.shift();
  if (next) {
    pool.inUse++;
    next();
  }
}

/**
 * Runs a binary to completion, once it holds a slot (see FFMPEG_MAX_PROCS). Resolves with the exit code for any exit (a
 * non-zero code is the caller's to judge); rejects on a timeout (FfmpegTimeout), on an abort, on stdout past its cap
 * (FfmpegOutputTooLarge), or when the binary cannot be started.
 *
 * The timeout starts when the call is made, so it covers the wait for a slot: a run still queued when its timeout fires
 * is removed from the queue and never starts. The per-asset deadline in media-encode is computed at call time too, so it
 * covers the queueing as well. The process is killed with SIGKILL on a timeout, an abort or an oversized stdout, and its
 * slot is released then, so a stuck or runaway encode gives its CPU back at once.
 */
function runBinary(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  // A run started inside onGpuDevice belongs to that GPU: its pool, and its CUDA environment unless the call names one.
  const device = gpuContext.getStore()?.device;
  const pool = device === undefined ? cpuPool : gpuPool(device);
  const env = opts.env ?? (device === undefined ? undefined : nvencEnv(device));
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    let child: ChildProcess | undefined;
    let holdsSlot = false;
    let cancelQueued: () => void = () => {};
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    // Stderr is kept as bytes and decoded once at close, so a multi-byte character is never split by a chunk edge.
    let stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (holdsSlot) {
        holdsSlot = false;
        releaseSlot(pool);
      } else {
        cancelQueued();
      }
      settle();
    };
    const kill = (): void => {
      child?.kill("SIGKILL");
    };
    const onAbort = (): void => {
      kill();
      finish(() => reject(abortError()));
    };

    timer = setTimeout(() => {
      kill();
      finish(() => reject(new FfmpegTimeout(opts.timeoutMs)));
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const start = (): void => {
      holdsSlot = true;
      try {
        child = spawn(bin, args, { stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"], env });
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        return;
      }
      if (opts.stdin && child.stdin) feedStdin(child.stdin, opts.stdin(), () => settled);
      child.stdout!.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          kill();
          finish(() => reject(new FfmpegOutputTooLarge(maxStdoutBytes)));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        stderrBytes += chunk.length;
        if (stderrBytes > STDERR_CAP) {
          // Compact to the tail, so memory stays bounded even for a chatty run.
          const tail = Buffer.concat(stderr).subarray(-STDERR_CAP);
          stderr = [tail];
          stderrBytes = tail.length;
        }
      });
      child.on("error", (err) => finish(() => reject(err)));
      child.on("close", (code) => {
        finish(() =>
          resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: decodeStderr(Buffer.concat(stderr)) }),
        );
      });
    };
    cancelQueued = requestSlot(pool, start);
  });
}

/**
 * Decodes the kept tail of stderr. The tail may start inside a multi-byte character, so leading continuation bytes
 * (10xxxxxx) are dropped first. Valid UTF-8 never starts with one, so this is a no-op when nothing was cut.
 */
function decodeStderr(bytes: Buffer): string {
  let start = 0;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/**
 * Writes the chunks to a process's stdin, honouring backpressure, then ends it. Stops when the run has settled (a killed
 * process closes its stdin, and a write to it then fails: the error is the run's outcome, not this one).
 */
async function feedStdin(stdin: Writable, chunks: AsyncIterable<Uint8Array>, settled: () => boolean): Promise<void> {
  stdin.on("error", () => undefined);
  try {
    for await (const chunk of chunks) {
      if (settled() || stdin.destroyed) break;
      if (!stdin.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            stdin.off("drain", done);
            stdin.off("close", done);
            resolve();
          };
          stdin.once("drain", done);
          stdin.once("close", done);
        });
      }
    }
  } catch {
    // The producer failed: the process sees its input end early and the run reports that.
  } finally {
    if (!stdin.destroyed) stdin.end();
  }
}

function abortError(): Error {
  const err = new Error("ffmpeg run aborted");
  err.name = "AbortError";
  return err;
}

/** The ffmpeg binary: IMGTUNE_FFMPEG when set, else `ffmpeg` on PATH. */
function ffmpegBin(): string {
  return process.env.IMGTUNE_FFMPEG || "ffmpeg";
}

/** The ffprobe binary: IMGTUNE_FFPROBE when set, else `ffprobe` on PATH. */
function ffprobeBin(): string {
  return process.env.IMGTUNE_FFPROBE || "ffprobe";
}

/**
 * Runs ffmpeg with `-hide_banner -nostdin` in front of the given arguments. Resolves with the exit code and captured
 * output; rejects with FfmpegTimeout past the timeout, on abort, or when the binary cannot be started.
 */
export function runFfmpeg(args: string[], opts: RunOptions): Promise<RunResult> {
  return runBinary(ffmpegBin(), ["-hide_banner", "-nostdin", ...args], opts);
}

let probing: Promise<FfmpegCaps> | undefined;

/**
 * Which capabilities the installed ffmpeg has. Memoised per process, so a scan probes once. Never throws: a missing or
 * broken binary reports false for everything it would have provided.
 */
export function probeFfmpeg(): Promise<FfmpegCaps> {
  probing ??= computeCaps();
  return probing;
}

/** Forgets the memoised probe, so the next probeFfmpeg reads the environment again. For tests only. */
export function resetFfmpegProbe(): void {
  probing = undefined;
}

const PROBE_TIMEOUT_MS = 15_000;

async function computeCaps(): Promise<FfmpegCaps> {
  try {
    const [encoders, filters, muxers, ffprobeOk] = await Promise.all([
      listOutput(() => runFfmpeg(["-encoders"], { timeoutMs: PROBE_TIMEOUT_MS })),
      listOutput(() => runFfmpeg(["-filters"], { timeoutMs: PROBE_TIMEOUT_MS })),
      listOutput(() => runFfmpeg(["-muxers"], { timeoutMs: PROBE_TIMEOUT_MS })),
      runBinary(ffprobeBin(), ["-version"], { timeoutMs: PROBE_TIMEOUT_MS }).then(
        (r) => r.code === 0,
        () => false,
      ),
    ]);
    return capsOf({ encoders, filters, muxers, ffprobe: ffprobeOk });
  } catch {
    return capsOf({});
  }
}

/**
 * The capabilities a set of ffmpeg listings gives. A listing that is undefined (the command failed) reports its
 * capabilities as missing; `ffmpeg` is true only when the encoder listing could be read. The NVENC flags are only the
 * listing's: the device test (withGpu) is what makes them usable.
 */
export function capsOf(lists: { encoders?: Set<string>; filters?: Set<string>; muxers?: Set<string>; ffprobe?: boolean }): FfmpegCaps {
  const encoderNames = lists.encoders ?? new Set<string>();
  const av1 = encoderNames.has("libsvtav1")
    ? "libsvtav1"
    : encoderNames.has("libaom-av1")
      ? "libaom-av1"
      : undefined;
  return {
    ffmpeg: lists.encoders !== undefined,
    ffprobe: lists.ffprobe ?? false,
    vmaf: lists.filters?.has("libvmaf") ?? false,
    av1,
    x264: encoderNames.has("libx264"),
    webpAnim: encoderNames.has("libwebp_anim"),
    avifMuxer: lists.muxers?.has("avif") ?? false,
    av1Nvenc: encoderNames.has("av1_nvenc"),
    h264Nvenc: encoderNames.has("h264_nvenc"),
    vmafCuda: lists.filters?.has("libvmaf_cuda") ?? false,
  };
}

/** The NVENC options of one encode: preset p4, the high-quality tune, constant quality `cq` in VBR, on GPU index 0. */
export function nvencOptions(cq: number): string[] {
  return ["-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", String(cq), "-b:v", "0", "-gpu", "0"];
}

/**
 * The environment of an NVENC run on one GPU: CUDA numbers the devices by PCI bus, and only the chosen device is visible,
 * so `-gpu 0` is that device. This overrides any CUDA_VISIBLE_DEVICES of this process (the encode has no other use for it).
 */
export function nvencEnv(device: number, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, CUDA_DEVICE_ORDER: "PCI_BUS_ID", CUDA_VISIBLE_DEVICES: String(device) };
}

/** The 256x144 test clip of the NVENC probe: 0.2 s, the smallest size NVENC takes. */
const NVENC_TEST_INPUT = ["-f", "lavfi", "-i", "testsrc2=s=256x144:d=0.2"];
const NVENC_TEST_TIMEOUT_MS = 30_000;

const gpuTests = new Map<number, Promise<{ av1: boolean; h264: boolean; vmafCuda: boolean }>>();

/**
 * Proves the GPU encoders and VMAF on one device: a tiny encode per NVENC encoder the build lists, and a tiny libvmaf_cuda run
 * when the build lists it. Memoised per device, so a run tests each card once. A failed test means that encoder or filter
 * cannot run on that device.
 */
export function testGpu(device: number, caps: FfmpegCaps): Promise<{ av1: boolean; h264: boolean; vmafCuda: boolean }> {
  let pending = gpuTests.get(device);
  if (pending === undefined) {
    pending = Promise.all([
      caps.av1Nvenc ? encodesOn("av1_nvenc", device) : Promise.resolve(false),
      caps.h264Nvenc ? encodesOn("h264_nvenc", device) : Promise.resolve(false),
      caps.vmafCuda ? vmafCudaOn(device) : Promise.resolve(false),
    ]).then(([av1, h264, vmafCuda]) => ({ av1, h264, vmafCuda }));
    gpuTests.set(device, pending);
  }
  return pending;
}

/** Whether libvmaf_cuda scores two frames on `device` (exit code 0). Never throws. */
async function vmafCudaOn(device: number): Promise<boolean> {
  try {
    const result = await runFfmpeg(
      [
        "-f", "lavfi", "-i", "testsrc2=s=256x144:d=0.2",
        "-f", "lavfi", "-i", "testsrc2=s=256x144:d=0.2",
        "-filter_complex", "[0:v]format=yuv420p,hwupload_cuda[a];[1:v]format=yuv420p,hwupload_cuda[b];[a][b]libvmaf_cuda",
        "-f", "null", "-",
      ],
      { timeoutMs: NVENC_TEST_TIMEOUT_MS, env: nvencEnv(device) },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

/** Whether `encoder` makes a frame on `device` (exit code 0 of a short encode to the null muxer). Never throws. */
async function encodesOn(encoder: string, device: number): Promise<boolean> {
  try {
    const result = await runFfmpeg(
      [...NVENC_TEST_INPUT, "-c:v", encoder, ...nvencOptions(30), "-f", "null", "-"],
      { timeoutMs: NVENC_TEST_TIMEOUT_MS, env: nvencEnv(device) },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * The capabilities with the GPU encoders and VMAF that passed their tests on `device`. Without a device the caps come back
 * with the NVENC and CUDA flags false.
 */
export async function withGpu(caps: FfmpegCaps, device: number | undefined): Promise<FfmpegCaps> {
  if (device === undefined || (!caps.av1Nvenc && !caps.h264Nvenc && !caps.vmafCuda)) {
    return { ...caps, av1Nvenc: false, h264Nvenc: false, vmafCuda: false };
  }
  const tested = await testGpu(device, caps);
  return { ...caps, av1Nvenc: tested.av1, h264Nvenc: tested.h264, vmafCuda: tested.vmafCuda };
}

/**
 * Runs a listing command (`-encoders`, `-filters`, `-muxers`) and returns the set of names it lists, or undefined when
 * the command fails. Each listing row is `flags name description`, so the name is the second token; legend and header
 * lines contribute only tokens that no capability is looked up by.
 */
async function listOutput(run: () => Promise<RunResult>): Promise<Set<string> | undefined> {
  const result = await run().catch(() => undefined);
  if (!result || result.code !== 0) return undefined;
  return parseListing(result.stdout.toString("utf8"));
}

/** Names from an ffmpeg listing (`-encoders`, `-filters`, `-muxers`): the second token of each row. */
export function parseListing(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length >= 2) names.add(tokens[1]);
  }
  return names;
}

/**
 * The input options for one ffmpeg or ffprobe input, to go before its `-i`. An http(s) URL comes from a scanned page,
 * so it may read only the network protocols, and goes through `proxy` when one is set. A local file may read only
 * files and pipes. Any other input is refused: a relative path, or a scheme such as file: or concat:, could read
 * something the scan did not mean to open. A URL with no proxy is refused with its own message.
 */
export function inputOptions(input: string, proxy?: string): string[] {
  if (/^https?:\/\//i.test(input)) {
    // A URL comes from a scanned page, so it only ever goes through the egress proxy, which checks each destination.
    if (proxy === undefined) throw new Error("URL inputs require the egress proxy");
    // httpproxy is ffmpeg's CONNECT tunnel to `proxy`: without it every https URL fails ("not on whitelist").
    return ["-protocol_whitelist", "http,https,tcp,tls,crypto,httpproxy", "-http_proxy", proxy];
  }
  if (isAbsolute(input)) return ["-protocol_whitelist", "file,pipe"];
  throw new Error(`media input must be an absolute path or an http(s) URL: ${input}`);
}

/**
 * Reads the size, length, frame rate and codecs of a video or animated file with ffprobe. `input` is an absolute file
 * path or an http(s) URL (see inputOptions); `opts.proxy` is the HTTP proxy a URL goes through. Resolves undefined when
 * ffprobe fails, times out, finds no video stream, or the input is refused. A URL with no proxy rejects.
 */
export async function probeMedia(
  input: string,
  timeoutMs: number,
  opts: { proxy?: string } = {},
): Promise<MediaProbe | undefined> {
  if (/^https?:\/\//i.test(input) && opts.proxy === undefined) throw new Error("URL inputs require the egress proxy");
  try {
    const result = await runBinary(
      ffprobeBin(),
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...inputOptions(input, opts.proxy), "-i", input],
      { timeoutMs },
    );
    if (result.code !== 0) return undefined;
    return parseProbeJson(JSON.parse(result.stdout.toString("utf8")));
  } catch {
    return undefined;
  }
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  bit_rate?: string;
  disposition?: { attached_pic?: number };
}

interface ProbeJson {
  streams?: ProbeStream[];
  format?: { duration?: string; bit_rate?: string };
}

/** Turns ffprobe's JSON into a MediaProbe, or undefined when there is no usable video stream. */
export function parseProbeJson(json: ProbeJson): MediaProbe | undefined {
  const streams = json.streams ?? [];
  // A cover image attached to an audio file is a video stream too, so skip it.
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!video || !video.width || !video.height || !video.codec_name) return undefined;
  const audio = streams.find((s) => s.codec_type === "audio");

  const formatDuration = toNumber(json.format?.duration);
  const durationS = formatDuration ?? toNumber(video.duration) ?? 0;
  const bitrate = toNumber(json.format?.bit_rate);

  const media: MediaProbe = {
    durationS,
    width: video.width,
    height: video.height,
    fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) ?? 0,
    videoCodec: video.codec_name,
  };
  if (audio?.codec_name) {
    const audioBitrate = toNumber(audio.bit_rate);
    media.audio = audioBitrate === undefined
      ? { codec: audio.codec_name }
      : { codec: audio.codec_name, bitrate: audioBitrate };
  }
  if (bitrate !== undefined) media.bitrate = bitrate;
  return media;
}

/** A finite, non-negative number from an ffprobe string field, or undefined. */
function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Frames per second from an ffprobe rate such as "30/1" or "30000/1001". Undefined for "0/0" or anything not a rate,
 * so the caller can fall back to the next rate field.
 */
export function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0 || n < 0) return undefined;
  const fps = n / d;
  return fps > 0 ? fps : undefined;
}
