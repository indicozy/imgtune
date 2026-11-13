// Sample encodes for animated media and video. Each asset is cut into 2-second lossless clips, every clip is encoded at
// candidate qualities, and the search keeps the lowest-bytes quality that passes the bar: VMAF on the clip, plus an
// SSIMULACRA2 guard on its stillest frames (a blurred word in a screen recording shows in a still frame more than in
// VMAF). The bytes of a passing encode are extrapolated to the full duration, so every figure here is an estimate.
//
// Performance comes first: the encodes run on the CPU with FFMPEG_THREADS threads per job, and every ffmpeg call is
// bounded by the asset's deadline, so one heavy file cannot hold a scan.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import sharp from "sharp";
import {
  FFMPEG_THREADS,
  FfmpegTimeout,
  inputOptions,
  runFfmpeg,
  type FfmpegCaps,
  type MediaProbe,
} from "./ffmpeg.js";
import { extrapolate, sampleOffsets } from "./media-model.js";
import type { Scorer } from "./metric.js";
import type { RawImage } from "./ssim.js";

/** The encodes the search can produce. AVIF is measured as its AV1 bitstream in MP4 (see encoderArgs). */
export type MediaCodec = "av1-mp4" | "h264-mp4" | "animated-avif" | "animated-webp";

/** One quality that was encoded and scored. `quality` is the CRF for video and AVIF, the q for WebP. */
export interface CandidateResult {
  codec: MediaCodec;
  width: number;
  quality: number;
  /** Bytes of the encoded samples together. */
  sampleBytes: number;
  /** Seconds of the samples together. */
  sampleSeconds: number;
  /** Bytes extrapolated over the full duration. An estimate. */
  bytes: number;
  /** Pooled VMAF mean over the samples. */
  vmaf: number;
  /** 10th percentile of the SSIMULACRA2 scores of the still-frame guard. */
  still: number;
  /**
   * The effective still bar this result was judged against: min(the requested bar, this source's ceiling − STILL_GUARD_DELTA).
   * Reports show it next to `still`, since a source whose best encode scores low gets a lower bar, not a failing result.
   */
  stillBar: number;
  estimate: true;
  /** Always false: the encodes drop audio, and the audio saving is attributed separately. */
  audio: boolean;
}

export interface SearchOptions {
  /** Minimum VMAF of a passing quality. */
  vmafBar: number;
  /** Minimum 10th-percentile SSIMULACRA2 of the still-frame guard of a passing quality. */
  stillBar: number;
  /** Epoch ms by which the search must end for this asset. */
  deadline: number;
  caps: FfmpegCaps;
  /** The SSIMULACRA2 scorer (makeScorer("ssimulacra2")). */
  score: Scorer;
  /** Per-run scratch directory. Candidate files are removed as they are scored; the caller removes the directory. */
  workDir: string;
}

export type SearchOutcome =
  | { ok: true; best: CandidateResult; tried: number }
  | {
      ok: false;
      reason:
        | "no-ffmpeg"
        | "no-vmaf"
        | "no-encoder"
        | "time-limit"
        | "no-range"
        | "probe-failed"
        | "no-passing-quality"
        | "score-failed";
    };

/** What hasRange learned about a URL. `range` is true only when a byte range was actually served (a 206). */
export interface RangeInfo {
  range: boolean;
  length?: number;
  etag?: string;
  lastModified?: string;
}

/** Length of each sample clip, in seconds. */
const SAMPLE_SECONDS = 2;
/** Frame rate assumed when the probe does not say. */
const DEFAULT_FPS = 30;
/** Stillest frames per sample that the SSIMULACRA2 guard scores. */
const GUARD_FRAMES = 3;
/**
 * Gaussian sigma of the still-frame guard's prefilter for GIF sources. A dithered GIF has per-pixel dither patterns that
 * an encoder smooths, and SSIMULACRA2 scores that as loss even when VMAF passes (anim.gif: VMAF 93 at CRF 40, guard
 * about 19). Blurring the reference and the candidate guard frames alike compares the picture, not the dither. VMAF is
 * not blurred.
 */
export const GIF_GUARD_SIGMA = 1;
/**
 * How far below the source's own best-quality guard score the still bar may sit. The guard is relative: an encode
 * cannot score above what its codec achieves at its best quality, so a bar above (ceiling − this) can never pass a
 * source whose ceiling is low. Same rule as imgtune's image bar (max(70, served − delta)), taken the other way round.
 */
export const STILL_GUARD_DELTA = 10;
/** Longest single ffmpeg run, in ms; the asset deadline caps it further. */
const RUN_CAP_MS = 60_000;
/** Pixels a decoded image may have, the same limit as the image pipeline. */
const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "imgtune";

interface CodecSpec {
  /** Lowest and highest quality value the bisection may probe. */
  lo: number;
  hi: number;
  /** Encodes the bisection may make. */
  steps: number;
  /** Container the encode writes. */
  ext: "mp4" | "webp";
  /** Which end of the range is smaller: a higher CRF is smaller, a lower WebP q is smaller. */
  fewerBytesAt: "high" | "low";
}

/** Quality ranges and step counts from the design. AVIF shares the AV1 range. */
const SPECS: Record<MediaCodec, CodecSpec> = {
  "av1-mp4": { lo: 20, hi: 55, steps: 5, ext: "mp4", fewerBytesAt: "high" },
  "animated-avif": { lo: 20, hi: 55, steps: 5, ext: "mp4", fewerBytesAt: "high" },
  "h264-mp4": { lo: 18, hi: 35, steps: 4, ext: "mp4", fewerBytesAt: "high" },
  "animated-webp": { lo: 40, hi: 90, steps: 4, ext: "webp", fewerBytesAt: "low" },
};

/** The deadline passed before a step could start. */
class DeadlineHit extends Error {
  constructor() {
    super("deadline passed");
    this.name = "DeadlineHit";
  }
}

/** A step failed in a way that names the outcome: the encoder or the VMAF filter does not work. */
class StageError extends Error {
  readonly reason: "no-encoder" | "no-vmaf" | "score-failed";

  constructor(reason: "no-encoder" | "no-vmaf" | "score-failed") {
    super(reason);
    this.name = "StageError";
    this.reason = reason;
  }
}

/** True for a timeout or a passed deadline: the search then ends with what it has. */
function isDeadline(err: unknown): boolean {
  return err instanceof DeadlineHit || err instanceof FfmpegTimeout;
}

/** Milliseconds one ffmpeg run may take: what is left of the deadline, capped. Throws once the deadline has passed. */
function runBudget(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new DeadlineHit();
  return Math.min(left, RUN_CAP_MS);
}

/** One ffmpeg run, bounded by the deadline. The caller judges the exit code. */
function ffrun(args: string[], deadline: number): Promise<{ code: number; stderr: string }> {
  return runFfmpeg(["-loglevel", "error", ...args], { timeoutMs: runBudget(deadline) });
}

/** Last non-empty line of ffmpeg's stderr: the error, since ffmpeg prints it last. */
function lastLine(stderr: string): string {
  const lines = stderr.trim().split("\n");
  return lines[lines.length - 1] ?? "";
}

/**
 * Escapes a value that goes inside a filter option (libvmaf's log_path, the metadata file), so its separators are read
 * as text.
 */
function escapeFilterValue(value: string): string {
  return value.replace(/[\\:',;[\]]/g, "\\$&");
}

/** Runs `work`; a failure that is not a deadline becomes a StageError with the reason for this stage. */
async function stage<T>(reason: StageError["reason"], work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isDeadline(err) || err instanceof StageError) throw err;
    throw new StageError(reason);
  }
}

/**
 * Cuts the 2-second samples of a video or animated file, as lossless FFV1 in Matroska at the offsets sampleOffsets
 * gives. The input may be an absolute path or an http(s) URL, read with Range requests; a URL goes through `proxy`
 * when one is set. The frame rate is forced to the probed rate, so the reference and the candidates share one
 * timeline. Rejects when the input is refused, or when any cut fails (a 404 for example).
 */
export async function cutSamples(
  input: string,
  probe: MediaProbe,
  workDir: string,
  deadline: number,
  proxy?: string,
): Promise<string[]> {
  // Refuses a bad input before any file is written.
  const options = inputOptions(input, proxy);
  await mkdir(workDir, { recursive: true });
  const rate = probe.fps > 0 ? ["-r", String(probe.fps), "-fps_mode", "cfr"] : [];
  return Promise.all(
    sampleOffsets(probe.durationS).map(async (offset, i) => {
      const out = join(workDir, `sample-${i}.mkv`);
      const result = await ffrun(
        [
          ...options,
          "-ss",
          String(offset),
          "-i",
          input,
          "-t",
          String(SAMPLE_SECONDS),
          "-map",
          "0:v:0",
          "-an",
          ...rate,
          "-c:v",
          "ffv1",
          "-threads",
          String(FFMPEG_THREADS),
          "-y",
          out,
        ],
        deadline,
      );
      if (result.code !== 0) throw new Error(`ffmpeg could not cut sample ${i}: ${lastLine(result.stderr)}`);
      return out;
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Range probing
// ---------------------------------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
}

/**
 * Whether the server serves byte ranges, with the length and validators, from a HEAD and a `Range: bytes=0-0` GET.
 * The GET is the decisive check: a server may not advertise ranges on HEAD, and ffmpeg needs the real thing to seek.
 * Any request failure reads as no range. Only the headers of each answer are read, never a body. Every request goes
 * through `proxy` (the egress proxy, which checks each destination): an http target gets the absolute URL, and an https
 * target gets a CONNECT tunnel. Redirects are followed, at most 3. Rejects when no proxy is given.
 */
export async function hasRange(url: string, timeoutMs: number, proxy?: string): Promise<RangeInfo> {
  // A URL comes from a scanned page, so it only ever goes through the egress proxy.
  if (proxy === undefined) throw new Error("URL inputs require the egress proxy");
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { range: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const head = await exchange("HEAD", target, {}, proxy, controller.signal).catch(() => undefined);
    const get = await exchange("GET", target, { Range: "bytes=0-0" }, proxy, controller.signal).catch(() => undefined);
    const info: RangeInfo = { range: get?.status === 206 };
    const length = get?.status === 206
      ? totalOf(headerText(get.headers["content-range"]))
      : head && head.status >= 200 && head.status < 300
        ? numberOf(headerText(head.headers["content-length"]))
        : undefined;
    if (length !== undefined) info.length = length;
    const etag = headerText(head?.headers.etag) ?? headerText(get?.headers.etag);
    if (etag !== undefined) info.etag = etag;
    const lastModified = headerText(head?.headers["last-modified"]) ?? headerText(get?.headers["last-modified"]);
    if (lastModified !== undefined) info.lastModified = lastModified;
    return info;
  } finally {
    clearTimeout(timer);
  }
}

/** One request, following redirects (at most MAX_REDIRECTS). */
async function exchange(
  method: "HEAD" | "GET",
  url: URL,
  headers: Record<string, string>,
  proxy: string,
  signal: AbortSignal,
  hops = 0,
): Promise<Reply> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not an http(s) URL");
  const reply = await send(method, url, headers, proxy, signal);
  const location = headerText(reply.headers.location);
  if (REDIRECT_STATUSES.has(reply.status) && location !== undefined) {
    if (hops >= MAX_REDIRECTS) throw new Error("too many redirects");
    return exchange(method, new URL(location, url), headers, proxy, signal, hops + 1);
  }
  return reply;
}

/** One request to one URL, through the egress proxy. The response body is discarded after the headers. */
function send(
  method: "HEAD" | "GET",
  url: URL,
  headers: Record<string, string>,
  proxy: string,
  signal: AbortSignal,
): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const finish = (res: IncomingMessage): void => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
      res.destroy();
    };
    const fail = (err: Error): void => reject(err);
    const secure = url.protocol === "https:";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || (secure ? 443 : 80);
    const common = { method, headers: { ...headers, "User-Agent": USER_AGENT, Accept: "*/*" }, signal, agent: false };
    const via = new URL(proxy);

    if (!secure) {
      const req = httpRequest(
        { host: via.hostname, port: via.port, path: url.href, ...common, headers: { ...common.headers, Host: url.host } },
        finish,
      );
      req.on("error", fail);
      req.end();
      return;
    }

    // An https target: a CONNECT tunnel through the proxy, then TLS inside it.
    const authority = `${host}:${port}`;
    const connect = httpRequest({
      host: via.hostname,
      port: via.port,
      method: "CONNECT",
      path: authority,
      headers: { Host: authority },
      agent: false,
      signal,
    });
    connect.on("error", fail);
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`proxy refused the tunnel: ${res.statusCode}`));
        return;
      }
      const tunnel = tlsConnect({ socket, ...(isIP(host) === 0 ? { servername: host } : {}) });
      tunnel.on("error", fail);
      const req = httpsRequest(
        { host, port, path: url.pathname + url.search, ...common, createConnection: () => tunnel },
        finish,
      );
      req.on("error", fail);
      req.end();
    });
    connect.end();
  });
}

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function numberOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The total length from a Content-Range such as "bytes 0-0/12345". */
function totalOf(contentRange: string | undefined): number | undefined {
  const match = /\/(\d+)$/.exec(contentRange ?? "");
  return match ? Number(match[1]) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Frame selection and reading
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The indices of the `count` stillest frames, from the metadata that signalstats prints (`frame:N` then the YDIF
 * difference to the previous frame). Frame 0 has no previous frame, so its 0 is not a real difference and it is not
 * ranked, unless it is the only frame. Returns them in frame order. With no readable difference it returns [0].
 */
export function stillestFrames(metadata: string, count: number): number[] {
  const diffs = new Map<number, number>();
  let frame = -1;
  for (const line of metadata.split("\n")) {
    const index = /^frame:(\d+)/.exec(line);
    if (index) {
      frame = Number(index[1]);
      continue;
    }
    const ydif = /^lavfi\.signalstats\.YDIF=(\S+)/.exec(line);
    if (ydif && frame >= 0 && Number.isFinite(Number(ydif[1]))) diffs.set(frame, Number(ydif[1]));
  }
  const ranked = [...diffs]
    .filter(([n]) => n > 0 || diffs.size === 1)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  if (ranked.length === 0) return [0];
  return ranked
    .slice(0, Math.max(1, Math.floor(count)))
    .map(([n]) => n)
    .sort((a, b) => a - b);
}

/** The 10th percentile by the lower nearest rank: for up to 11 values, the minimum. 0 for no values. */
export function tenthPercentile(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(0.1 * (sorted.length - 1))];
}

/**
 * The frame on screen at each constant-rate tick. Frame i covers [start, start + delay) in ms, and tick k is at
 * k × 1000 / fps. A frame that lasts several ticks repeats; the last frame holds to the end.
 */
export function cfrIndices(delaysMs: number[], fps: number, ticks: number): number[] {
  const out: number[] = [];
  let frame = 0;
  let start = 0;
  for (let k = 0; k < ticks; k++) {
    const at = (k * 1000) / fps;
    while (frame < delaysMs.length - 1 && start + delaysMs[frame] <= at) {
      start += delaysMs[frame];
      frame++;
    }
    out.push(frame);
  }
  return out;
}

/** The stillest frames of a sample: their indices, and the reference pixels at the candidate width. */
export interface GuardRef {
  indices: number[];
  frames: RawImage[];
}

/**
 * The image at exactly `width` x `height`: the same pixels when it already is that size, else resized (lanczos). The
 * scorer needs equal dimensions, and a candidate can differ by a pixel from the reference after its own scaling.
 */
async function fitTo(img: RawImage, width: number, height: number): Promise<RawImage> {
  if (img.width === width && img.height === height) return img;
  const bytes = Buffer.from(img.data.buffer as ArrayBuffer, img.data.byteOffset, img.data.byteLength);
  const { data, info } = await sharp(bytes, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/** Decodes a PNG (or any sharp-readable image) to 8-bit RGBA. */
async function decodeRgba(bytes: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/** The indices of the stillest frames of one sample, from signalstats' YDIF (see stillestFrames). */
async function stillestOf(sample: string, metadataFile: string, deadline: number): Promise<number[]> {
  const result = await ffrun(
    [
      ...inputOptions(sample),
      "-i",
      sample,
      "-vf",
      `format=yuv420p,signalstats,metadata=mode=print:file=${escapeFilterValue(metadataFile)}`,
      "-f",
      "null",
      "-",
    ],
    deadline,
  );
  if (result.code !== 0) throw new Error(`ffmpeg could not measure frame differences: ${lastLine(result.stderr)}`);
  return stillestFrames(await readFile(metadataFile, "utf8"), GUARD_FRAMES);
}

/**
 * The frames at `indices` (ascending) of a file, after `filters`, decoded to RGBA in index order. Written as PNG
 * through a select filter, so the frames are exactly the ones asked for.
 */
async function framesAt(
  input: string,
  filters: string[],
  indices: number[],
  dir: string,
  deadline: number,
): Promise<RawImage[]> {
  if (indices.length === 0) return [];
  await mkdir(dir, { recursive: true });
  // format=yuv420p before the select: a scaled frame and a decoded copy carry different chroma-location tags, and the
  // RGB conversion of each then differs at chroma edges (measured: 16965 channel values off by more than 8). Forcing
  // one YUV format on both sides makes the reference and the candidate convert identically.
  const pick = `format=yuv420p,select='${indices.map((n) => `eq(n,${n})`).join("+")}'`;
  const result = await ffrun(
    [
      ...inputOptions(input),
      "-i",
      input,
      "-vf",
      [...filters, pick].join(","),
      "-fps_mode",
      "passthrough",
      "-y",
      join(dir, "f-%d.png"),
    ],
    deadline,
  );
  if (result.code !== 0) throw new Error(`ffmpeg could not read frames: ${lastLine(result.stderr)}`);
  const frames: RawImage[] = [];
  for (let k = 1; k <= indices.length; k++) {
    frames.push(await decodeRgba(await readFile(join(dir, `f-${k}.png`))));
  }
  return frames;
}

// ---------------------------------------------------------------------------------------------------------------------
// Encoding and scoring
// ---------------------------------------------------------------------------------------------------------------------

/** The AV1 encoder arguments: SVT-AV1 when built in, libaom otherwise. `crf` is the quality. */
function av1Args(caps: FfmpegCaps, crf: string): string[] {
  return caps.av1 === "libaom-av1"
    ? ["-c:v", "libaom-av1", "-crf", crf, "-b:v", "0", "-cpu-used", "8", "-row-mt", "1"]
    : ["-c:v", "libsvtav1", "-preset", "10", "-crf", crf, "-svtav1-params", "lp=2"];
}

/**
 * The encoder and container arguments for one codec at quality `q`. Every output drops audio.
 *
 * animated-avif is measured as the same AV1 bitstream in an MP4 container, not as an AVIF file. The bitstream is the
 * same (same encoder, preset, CRF and pixel format). The AVIF container differs by about 150 bytes per 2-second clip.
 * ffmpeg cannot read an animated AVIF back for scoring, so the MP4 twin is also what gets scored. The bytes are an
 * estimate within that container difference.
 */
function encoderArgs(codec: MediaCodec, q: number, caps: FfmpegCaps): string[] {
  const quality = String(q);
  switch (codec) {
    case "av1-mp4":
      return [...av1Args(caps, quality), "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", "-f", "mp4"];
    case "animated-avif":
      return [...av1Args(caps, quality), "-pix_fmt", "yuv420p", "-an", "-f", "mp4"];
    case "h264-mp4":
      return [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        quality,
        "-an",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
      ];
    case "animated-webp":
      return ["-c:v", "libwebp_anim", "-q:v", quality, "-loop", "0", "-an", "-f", "webp"];
  }
}

/** Encodes one sample at `width` (lanczos scale) and quality `q`. A failure is the encoder's: StageError no-encoder. */
async function encodeClip(
  sample: string,
  codec: MediaCodec,
  width: number,
  q: number,
  out: string,
  caps: FfmpegCaps,
  deadline: number,
): Promise<void> {
  await stage("no-encoder", async () => {
    const result = await ffrun(
      [
        ...inputOptions(sample),
        "-i",
        sample,
        "-vf",
        `scale=${width}:-2:flags=lanczos`,
        "-threads",
        String(FFMPEG_THREADS),
        ...encoderArgs(codec, q, caps),
        "-y",
        out,
      ],
      deadline,
    );
    if (result.code !== 0) throw new Error(lastLine(result.stderr));
  });
}

/**
 * The candidate of one sample, as ffmpeg reads it: the input for libvmaf, and its frames at given indices. An animated
 * WebP cannot be read by ffmpeg, so it is decoded in-process and written as raw RGBA for libvmaf.
 */
interface Candidate {
  input: string[];
  frames(indices: number[]): Promise<RawImage[]>;
}

/** A candidate that ffmpeg reads from its file. */
function fileCandidate(out: string, dir: string, i: number, deadline: number): Candidate {
  return {
    input: [...inputOptions(out), "-i", out],
    frames: (indices) => framesAt(out, [], indices, join(dir, `g-${i}`), deadline),
  };
}

/**
 * An animated WebP candidate: every frame decoded, then laid out on the constant-rate timeline of the reference
 * (repeated where a frame lasts longer), so frame k of the candidate is frame k of the reference.
 */
async function webpCandidate(out: string, dir: string, i: number, fps: number): Promise<Candidate> {
  const bytes = await readFile(out);
  const meta = await sharp(bytes, { animated: true, limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  const { data, info } = await sharp(bytes, { animated: true, limitInputPixels: MAX_IMAGE_PIXELS })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pages = info.pages ?? 1;
  const height = info.pageHeight ?? info.height;
  const pageBytes = info.width * height * 4;
  const pageFrames: RawImage[] = Array.from({ length: pages }, (_, p) => {
    const part = data.subarray(p * pageBytes, (p + 1) * pageBytes);
    return { data: new Uint8ClampedArray(part.buffer, part.byteOffset, part.byteLength), width: info.width, height };
  });
  const delays = meta.delay ?? pageFrames.map(() => 1000 / fps);
  const total = delays.reduce((acc, d) => acc + d, 0);
  const ticks = Math.max(1, Math.round((total * fps) / 1000));
  const frames = cfrIndices(delays, fps, ticks).map((p) => pageFrames[Math.min(p, pageFrames.length - 1)]);

  const raw = join(dir, `s${i}.rgba`);
  await writeFile(raw, Buffer.concat(frames.map((f) => Buffer.from(f.data.buffer as ArrayBuffer, f.data.byteOffset, f.data.byteLength))));
  return {
    input: [
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-video_size",
      `${info.width}x${height}`,
      "-framerate",
      String(fps),
      ...inputOptions(raw),
      "-i",
      raw,
    ],
    frames: async (indices) => indices.map((n) => frames[Math.min(n, frames.length - 1)]),
  };
}

/**
 * Pooled VMAF mean of `distorted` against `reference`, both scaled to `width` as the design sets. Both sides are
 * re-timed by frame index at `fps`: libvmaf pairs frames by timestamp, and the lossless sample and the encodes carry
 * different timebases, so their timestamps would otherwise pair the wrong frames. The longer side is trimmed to the
 * shorter (shortest=1), since an encode can drop or add a frame.
 */
async function vmafOf(
  distorted: string[],
  reference: string,
  width: number,
  fps: number,
  log: string,
  deadline: number,
): Promise<number> {
  return stage("no-vmaf", async () => {
    const retime = `settb=AVTB,setpts=N/${fps}/TB`;
    const graph =
      `[0:v]scale=${width}:-2:flags=bicubic,${retime}[d];` +
      `[1:v]scale=${width}:-2:flags=bicubic,${retime}[r];` +
      `[d][r]libvmaf=n_threads=${FFMPEG_THREADS}:shortest=1:log_fmt=json:log_path=${escapeFilterValue(log)}`;
    const result = await ffrun(
      [...distorted, ...inputOptions(reference), "-i", reference, "-lavfi", graph, "-f", "null", "-"],
      deadline,
    );
    if (result.code !== 0) throw new Error(lastLine(result.stderr));
    const json = JSON.parse(await readFile(log, "utf8")) as { pooled_metrics?: { vmaf?: { mean?: unknown } } };
    const mean = json.pooled_metrics?.vmaf?.mean;
    if (typeof mean !== "number") throw new Error("no pooled VMAF mean");
    return mean;
  });
}

/** Everything one search needs, so the steps do not take it as separate arguments. */
interface Ctx {
  samples: string[];
  probe: MediaProbe;
  codec: MediaCodec;
  width: number;
  fps: number;
  /** Seconds of each sample. */
  seconds: number[];
  opts: SearchOptions;
  guards: GuardRef[];
  /** The guard prefilter sigma: GIF_GUARD_SIGMA for a GIF source, undefined otherwise. */
  blur?: number;
  /** Results of this search by quality, so no quality is encoded twice. */
  cache: Map<number, Scored>;
}

/** A scored quality, before the search attaches the still bar it was judged against. */
type Scored = Omit<CandidateResult, "stillBar">;

/**
 * evaluate, memoised per search: a quality already encoded is returned from the cache. The deadline is checked before a
 * new encode, so the ceiling encode and the bisection both stop at the deadline.
 */
async function evaluateCached(ctx: Ctx, q: number): Promise<Scored> {
  const known = ctx.cache.get(q);
  if (known) return known;
  if (Date.now() >= ctx.opts.deadline) throw new DeadlineHit();
  const result = await evaluate(ctx, q);
  ctx.cache.set(q, result);
  return result;
}

/**
 * The SSIMULACRA2 scores of the still-frame guard for one sample. Two failures are told apart. A frame that cannot be
 * read (a candidate with fewer frames than the reference, for example) scores 0 for that frame, so the candidate fails
 * its bar: it fails closed. A scorer that throws is a broken scorer, not a failing candidate, so it surfaces as
 * score-failed. A deadline ends the search either way.
 */
async function guardScores(ctx: Ctx, i: number, cand: Candidate): Promise<number[]> {
  const ref = ctx.guards[i];
  let frames: RawImage[];
  try {
    frames = await cand.frames(ref.indices);
  } catch (err) {
    if (isDeadline(err)) throw err;
    return ref.indices.map(() => 0);
  }
  const out: number[] = [];
  for (let k = 0; k < frames.length; k++) {
    if (Date.now() >= ctx.opts.deadline) throw new DeadlineHit();
    const want = ref.frames[k];
    try {
      let got = await fitTo(frames[k], want.width, want.height);
      if (ctx.blur !== undefined) got = await blurFrame(got, ctx.blur);
      out.push(await ctx.opts.score(want, got));
    } catch (err) {
      if (isDeadline(err)) throw err;
      throw new StageError("score-failed");
    }
  }
  return out;
}

function mean(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

/** Encodes every sample at quality `q`, scores it, and returns the result (pass or fail). Removes its files after. */
async function evaluate(ctx: Ctx, q: number): Promise<Scored> {
  const { codec, width, opts } = ctx;
  const dir = join(opts.workDir, `cand-${codec}-${width}-${q}`);
  await mkdir(dir, { recursive: true });
  try {
    let sampleBytes = 0;
    const vmafs: number[] = [];
    const scores: number[] = [];
    for (let i = 0; i < ctx.samples.length; i++) {
      const out = join(dir, `s${i}.${SPECS[codec].ext}`);
      await encodeClip(ctx.samples[i], codec, width, q, out, opts.caps, opts.deadline);
      sampleBytes += (await stat(out)).size;
      const cand = codec === "animated-webp"
        ? await stage("no-encoder", () => webpCandidate(out, dir, i, ctx.fps))
        : fileCandidate(out, dir, i, opts.deadline);
      vmafs.push(await vmafOf(cand.input, ctx.samples[i], width, ctx.fps, join(dir, `vmaf-${i}.json`), opts.deadline));
      scores.push(...(await guardScores(ctx, i, cand)));
    }
    const sampleSeconds = ctx.seconds.reduce((acc, s) => acc + s, 0);
    return {
      codec,
      width,
      quality: q,
      sampleBytes,
      sampleSeconds,
      bytes: extrapolate(sampleBytes, sampleSeconds, ctx.probe.durationS),
      vmaf: mean(vmafs),
      still: tenthPercentile(scores),
      estimate: true,
      audio: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A gaussian blur of one frame (sharp's gaussian, sigma as given). Used as the guard prefilter; the same call is made on
 * the reference and on the candidate, so both sides are compared through the same filter.
 */
export async function blurFrame(img: RawImage, sigma: number): Promise<RawImage> {
  const bytes = Buffer.from(img.data.buffer as ArrayBuffer, img.data.byteOffset, img.data.byteLength);
  const { data, info } = await sharp(bytes, { raw: { width: img.width, height: img.height, channels: 4 } })
    .blur(sigma)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/**
 * The reference's stillest frames of one sample, at `width`: the frame indices, and the reference pixels there (blurred
 * by `blurSigma` when given). The candidate is later read at the same indices (see guardScores). `metadataFile` and
 * `dir` are scratch paths.
 */
export async function guardOf(
  sample: string,
  width: number,
  metadataFile: string,
  dir: string,
  deadline: number,
  blurSigma?: number,
): Promise<GuardRef> {
  const indices = await stillestOf(sample, metadataFile, deadline);
  const raw = await framesAt(sample, [`scale=${width}:-2:flags=lanczos`], indices, dir, deadline);
  const frames = blurSigma === undefined ? raw : await Promise.all(raw.map((f) => blurFrame(f, blurSigma)));
  return { indices, frames };
}

/** The reference's stillest frames per sample, at the candidate width. Run once per search. */
async function prepareGuards(ctx: Ctx): Promise<GuardRef[]> {
  const guards: GuardRef[] = [];
  for (let i = 0; i < ctx.samples.length; i++) {
    guards.push(
      await guardOf(
        ctx.samples[i],
        ctx.width,
        join(ctx.opts.workDir, `ydif-${i}.txt`),
        join(ctx.opts.workDir, `ref-${ctx.width}-${i}`),
        ctx.opts.deadline,
        ctx.blur,
      ),
    );
  }
  return guards;
}

/** Whether ffmpeg has the encoder a codec needs. */
function hasEncoder(caps: FfmpegCaps, codec: MediaCodec): boolean {
  switch (codec) {
    case "av1-mp4":
    case "animated-avif":
      return caps.av1 !== undefined;
    case "h264-mp4":
      return caps.x264;
    case "animated-webp":
      return caps.webpAnim;
  }
}

/** Seconds of each sample: 2 s, shorter where the file ends first. */
function clipSeconds(durationS: number, count: number): number[] {
  const offsets = sampleOffsets(durationS);
  return Array.from({ length: count }, (_, i) => Math.max(0, Math.min(SAMPLE_SECONDS, durationS - (offsets[i] ?? 0))));
}

/**
 * Finds the lowest-bytes quality that passes the bar: VMAF of at least `vmafBar` and a still-frame guard of at least
 * `stillBar`. The quality is bisected over the codec's range, in at most the codec's steps. Quality changes bytes
 * monotonically, so the bisection keeps the passing side and narrows toward the cheapest passing quality.
 *
 * The samples are local files (cutSamples). Each step encodes every sample at the width, scores VMAF and the guard,
 * then removes its files. The deadline is checked before every encode and run: when it passes, the best passing
 * quality so far is returned, or time-limit when none passed. Encoder and VMAF failures are reported as no-encoder and
 * no-vmaf, and a failure to prepare the reference is probe-failed.
 */
export async function searchQuality(
  samples: string[],
  probe: MediaProbe,
  codec: MediaCodec,
  width: number,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  const { caps } = opts;
  if (!caps.ffmpeg) return { ok: false, reason: "no-ffmpeg" };
  if (!caps.vmaf) return { ok: false, reason: "no-vmaf" };
  if (!hasEncoder(caps, codec)) return { ok: false, reason: "no-encoder" };
  // Without a length the bytes cannot be extrapolated, so there is nothing to report.
  if (samples.length === 0 || !(probe.durationS > 0)) return { ok: false, reason: "probe-failed" };
  if (Date.now() >= opts.deadline) return { ok: false, reason: "time-limit" };

  const spec = SPECS[codec];
  const ctx: Ctx = {
    samples,
    probe,
    codec,
    width,
    fps: probe.fps > 0 ? probe.fps : DEFAULT_FPS,
    seconds: clipSeconds(probe.durationS, samples.length),
    opts,
    guards: [],
    blur: probe.videoCodec === "gif" ? GIF_GUARD_SIGMA : undefined,
    cache: new Map(),
  };

  let best: CandidateResult | undefined;
  try {
    await mkdir(opts.workDir, { recursive: true });
    ctx.guards = await prepareGuards(ctx);
    // The ceiling: the codec's best-quality encode. Its guard score sets the still bar for this source. A ceiling that
    // misses the VMAF bar means no quality can pass, so the search ends there.
    const bound = codec === "animated-webp" ? spec.hi : spec.lo;
    const ceiling = await evaluateCached(ctx, bound);
    if (ceiling.vmaf < opts.vmafBar) return { ok: false, reason: "no-passing-quality" };
    const stillBar = Math.min(opts.stillBar, ceiling.still - STILL_GUARD_DELTA);
    let lo = spec.lo;
    let hi = spec.hi;
    for (let step = 0; step < spec.steps && lo <= hi; step++) {
      const q = Math.floor((lo + hi) / 2);
      const result = await evaluateCached(ctx, q);
      const pass = result.vmaf >= opts.vmafBar && result.still >= stillBar;
      if (pass && (best === undefined || result.bytes < best.bytes)) best = { ...result, stillBar };
      // The cheaper side is the one to search next: up for a CRF, down for a WebP q.
      if (spec.fewerBytesAt === "high") {
        if (pass) lo = q + 1;
        else hi = q - 1;
      } else if (pass) {
        hi = q - 1;
      } else {
        lo = q + 1;
      }
    }
  } catch (err) {
    // A broken scorer is reported even when an earlier quality passed: the passes before it were not checked by it.
    if (err instanceof StageError && err.reason === "score-failed") return { ok: false, reason: "score-failed" };
    if (best) return { ok: true, best, tried: ctx.cache.size };
    if (err instanceof StageError) return { ok: false, reason: err.reason };
    return { ok: false, reason: isDeadline(err) ? "time-limit" : "probe-failed" };
  }
  return best ? { ok: true, best, tried: ctx.cache.size } : { ok: false, reason: "no-passing-quality" };
}
