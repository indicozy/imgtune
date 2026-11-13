// The system ffmpeg and ffprobe, used through their command lines. imgtune never bundles ffmpeg: a probe reports what
// the installed build can do, and every call here is bounded by a timeout and can be aborted, so one heavy file cannot
// hold a scan.

import { spawn } from "node:child_process";

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
  /** Stdout cap in bytes; a run past it is killed and rejects with FfmpegOutputTooLarge. */
  maxStdoutBytes?: number;
}

/**
 * Runs a binary to completion. Resolves with the exit code for any exit (a non-zero code is the caller's to judge);
 * rejects on a timeout (FfmpegTimeout), on an abort, on stdout past its cap (FfmpegOutputTooLarge), or when the binary
 * cannot be started. The process is killed with SIGKILL on a timeout, an abort or an oversized stdout, so a stuck or
 * runaway encode releases its CPU at once.
 */
function runBinary(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      settle();
    };
    const onAbort = (): void => {
      child.kill("SIGKILL");
      finish(() => reject(abortError()));
    };

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new FfmpegTimeout(opts.timeoutMs)));
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill("SIGKILL");
        finish(() => reject(new FfmpegOutputTooLarge(maxStdoutBytes)));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
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
  const none: FfmpegCaps = {
    ffmpeg: false,
    ffprobe: false,
    vmaf: false,
    x264: false,
    webpAnim: false,
    avifMuxer: false,
  };
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
    const ffmpegOk = encoders !== undefined;
    const encoderNames = encoders ?? new Set<string>();
    const av1 = encoderNames.has("libsvtav1")
      ? "libsvtav1"
      : encoderNames.has("libaom-av1")
        ? "libaom-av1"
        : undefined;
    return {
      ffmpeg: ffmpegOk,
      ffprobe: ffprobeOk,
      vmaf: filters?.has("libvmaf") ?? false,
      av1,
      x264: encoderNames.has("libx264"),
      webpAnim: encoderNames.has("libwebp_anim"),
      avifMuxer: muxers?.has("avif") ?? false,
    };
  } catch {
    return none;
  }
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
 * Reads the size, length, frame rate and codecs of a video or animated file with ffprobe. `input` is a file path or an
 * http(s) URL. Resolves undefined when ffprobe fails, times out, or finds no video stream.
 */
export async function probeMedia(input: string, timeoutMs: number): Promise<MediaProbe | undefined> {
  try {
    const result = await runBinary(
      ffprobeBin(),
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-i", input],
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
