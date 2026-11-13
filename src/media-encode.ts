// Sample encodes for animated media and video. Each asset is cut into 2-second lossless clips, every clip is encoded at
// candidate qualities, and the search keeps the lowest-bytes quality that passes the bar: VMAF on the clip, plus an
// SSIMULACRA2 guard on its stillest frames (a blurred word in a screen recording shows in a still frame more than in
// VMAF). The bytes of a passing encode are extrapolated to the full duration, so every figure here is an estimate.
//
// Performance comes first: the encodes run on the CPU with FFMPEG_THREADS threads per job, and every ffmpeg call is
// bounded by the asset's deadline, so one heavy file cannot hold a scan.

import { mkdir, readFile, rm, stat } from "node:fs/promises";
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
import { isTooLarge, MAX_INPUT_PIXELS_FFMPEG, PixelsTooLarge, WindowTooLarge, MAX_WINDOW_FRAMES } from "./media-limits.js";
import type { Scorer } from "./metric.js";
import type { RawImage } from "./ssim.js";
import { WebpAnimation, cfrIndices } from "./webp-animation.js";

export { cfrIndices, MAX_INPUT_PIXELS_FFMPEG, PixelsTooLarge, WindowTooLarge };

/** A clip's source for the cut: a file (its path or URL), or an animated WebP read frame by frame. */
export type ClipSource = string | WebpAnimation;

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
  /** The VMAF bar this result was judged against (the requested bar; VMAF is not relativised). */
  vmafBar: number;
  estimate: true;
  /** Always false: the encodes drop audio, and the audio saving is attributed separately. */
  audio: boolean;
  /** The AV1 encoder the candidate was made with (AV1 and animated AVIF only): SVT-AV1, or libaom when SVT is not built in. */
  encoder?: "libsvtav1" | "libaom-av1";
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
  /**
   * Aborts the search: a running ffmpeg is killed, and the search returns "aborted" (see searchQuality). Set by the CLI on
   * SIGINT and SIGTERM, so a stopped run leaves no encode behind.
   */
  signal?: AbortSignal;
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
        | "too-large"
        | "score-failed"
        | "aborted";
    };

/** What hasRange learned about a URL. `range` is true only when a byte range was actually served (a 206). */
export interface RangeInfo {
  range: boolean;
  length?: number;
  etag?: string;
  lastModified?: string;
  /**
   * The URL the file is read from, after the redirects: ffmpeg is given this one, so it does not follow the chain itself.
   * Absent when no request got an answer.
   */
  url?: string;
  /** True when a redirect hop was refused by the third-party policy: the file is not read (see hasRange). */
  blocked?: boolean;
}

/** Length of each sample clip, in seconds. */
const SAMPLE_SECONDS = 2;
/** Frame rate assumed when the probe does not say. */
const DEFAULT_FPS = 30;
/**
 * Stillest frames per sample that the SSIMULACRA2 guard scores. Two, not three: each scored frame at 1280 px costs about
 * half a second, and the guard is the largest cost of a search (scoring was 52% of a 1280 px search's time; see the
 * performance round in the report). With 2 per sample the guard p10 is taken over 6 frames, still the minimum.
 */
const GUARD_FRAMES = 2;
/**
 * libvmaf scores every n-th frame. 2 halves VMAF's frame work; the pooled mean moves by about 0.15 on the test clip.
 */
const VMAF_SUBSAMPLE = 2;
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
/**
 * The lowest still bar a source can get. Below this a guard score says nothing: a bar at or under 0 would pass any encode.
 */
export const STILL_GUARD_FLOOR = 20;

/**
 * The still bar for one source: the requested bar, or the source's ceiling minus STILL_GUARD_DELTA when that is lower,
 * but never below STILL_GUARD_FLOOR. A ceiling of 5 gives STILL_GUARD_FLOOR, not −5.
 */
export function effectiveStillBar(requested: number, ceiling: number): number {
  return Math.max(STILL_GUARD_FLOOR, Math.min(requested, ceiling - STILL_GUARD_DELTA));
}
/** Longest single ffmpeg run, in ms; the asset deadline caps it further. */
const RUN_CAP_MS = 60_000;
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
  /**
   * The first quality the bisection probes, when it is not the middle. AV1 starts at CRF 40: the search then spends its
   * expensive passing probes near the answer, not on the far half of the range (see the performance round).
   */
  start?: number;
}

/** Quality ranges and step counts from the design. AVIF shares the AV1 range. */
const SPECS: Record<MediaCodec, CodecSpec> = {
  "av1-mp4": { lo: 20, hi: 55, steps: 5, ext: "mp4", fewerBytesAt: "high", start: 40 },
  "animated-avif": { lo: 20, hi: 55, steps: 5, ext: "mp4", fewerBytesAt: "high", start: 40 },
  "h264-mp4": { lo: 18, hi: 35, steps: 4, ext: "mp4", fewerBytesAt: "high" },
  "animated-webp": { lo: 40, hi: 90, steps: 4, ext: "webp", fewerBytesAt: "low" },
};

/** True for an abort (the run's signal fired): the search stops and reports "aborted". */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

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

/**
 * One ffmpeg run, bounded by the deadline and stopped by the signal. `stdin` feeds the input from a pipe (see RunOptions).
 * The caller judges the exit code.
 */
function ffrun(
  args: string[],
  deadline: number,
  signal?: AbortSignal,
  stdin?: () => AsyncIterable<Uint8Array>,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return runFfmpeg(["-loglevel", "error", ...args], { timeoutMs: runBudget(deadline), signal, stdin });
}

/**
 * The results of parallel work, or the first failure once every piece has settled. Promise.all would reject at the
 * first failure while the siblings still run, and a caller that then removes the shared directory would race them.
 * Waiting for all of them first means nothing is still writing when the failure reaches the caller.
 */
async function settleAll<T>(work: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(work);
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
  }
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
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
    if (isDeadline(err) || isAbortError(err) || err instanceof StageError || isTooLarge(err)) throw err;
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
  input: ClipSource,
  probe: MediaProbe,
  workDir: string,
  deadline: number,
  proxy?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (typeof input !== "string") return cutWebpSamples(input, probe.durationS, workDir, deadline, signal);
  // Refuses a bad input before any file is written.
  const options = inputOptions(input, proxy);
  await mkdir(workDir, { recursive: true });
  const rate = probe.fps > 0 ? ["-r", String(probe.fps), "-fps_mode", "cfr"] : [];
  return settleAll(
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
        signal,
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
  /** The URL that answered (the last hop of the redirects). */
  url?: string;
}

/** A redirect hop the third-party policy refuses: the request is not made. */
class HopBlocked extends Error {
  constructor(readonly hop: string) {
    super("third-party redirect blocked");
    this.name = "HopBlocked";
  }
}

/**
 * Whether the server serves byte ranges, with the length and validators, from a HEAD and a `Range: bytes=0-0` GET.
 * The GET is the decisive check: a server may not advertise ranges on HEAD, and ffmpeg needs the real thing to seek.
 * Any request failure reads as no range. Only the headers of each answer are read, never a body. Every request goes
 * through `proxy` (the egress proxy, which checks each destination): an http target gets the absolute URL, and an https
 * target gets a CONNECT tunnel. Redirects are followed, at most 3. Rejects when no proxy is given.
 */
export async function hasRange(url: string, timeoutMs: number, proxy?: string, allowHop?: (hop: string) => boolean): Promise<RangeInfo> {
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
  let blocked = false;
  const refused = (err: unknown): undefined => {
    if (err instanceof HopBlocked) blocked = true;
    return undefined;
  };
  try {
    const head = await exchange("HEAD", target, {}, proxy, controller.signal, 0, allowHop).catch(refused);
    const get = await exchange("GET", target, { Range: "bytes=0-0" }, proxy, controller.signal, 0, allowHop).catch(refused);
    // A file behind a refused hop is not read at all: its length and range are not taken from the allowed part of the chain.
    if (blocked) return { range: false, blocked: true };
    const info: RangeInfo = { range: get?.status === 206 };
    const answered = get?.url ?? head?.url;
    if (answered !== undefined) info.url = answered;
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
  allowHop?: (hop: string) => boolean,
): Promise<Reply> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not an http(s) URL");
  const reply = await send(method, url, headers, proxy, signal);
  const location = headerText(reply.headers.location);
  if (REDIRECT_STATUSES.has(reply.status) && location !== undefined) {
    if (hops >= MAX_REDIRECTS) throw new Error("too many redirects");
    const next = new URL(location, url);
    // The policy is checked on every hop, as the browser's route guard checks each request. A refused hop is not requested.
    if (allowHop !== undefined && !allowHop(next.href)) throw new HopBlocked(next.href);
    return exchange(method, next, headers, proxy, signal, hops + 1, allowHop);
  }
  return { ...reply, url: url.href };
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

/** The 10th percentile by the lower nearest rank: for up to 10 values, the minimum. 0 for no values. */
export function tenthPercentile(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(0.1 * (sorted.length - 1))];
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

/** One 4:2:0 frame as ffmpeg wrote it: its size and its three planes (chroma is ceil(width/2) × ceil(height/2)). */
export interface YuvFrame {
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

/**
 * The frames of a YUV4MPEG2 stream (ffmpeg's yuv4mpegpipe, 4:2:0). The size comes from the header, and each frame's planes
 * are read as they are: no colour metadata is applied, so the planes are the decoded values.
 */
export function yuv4mpegFrames(bytes: Buffer): YuvFrame[] {
  const headerEnd = bytes.indexOf(0x0a);
  if (headerEnd < 0 || bytes.toString("latin1", 0, 9) !== "YUV4MPEG2") throw new Error("ffmpeg did not write a YUV4MPEG2 stream");
  const tokens = bytes.toString("latin1", 0, headerEnd).split(" ");
  const width = Number(tokens.find((t) => t.startsWith("W"))?.slice(1));
  const height = Number(tokens.find((t) => t.startsWith("H"))?.slice(1));
  if (!(width > 0 && height > 0)) throw new Error("the YUV4MPEG2 header has no frame size");
  const chromaSize = ((width + 1) >> 1) * ((height + 1) >> 1);
  const lumaSize = width * height;
  const frames: YuvFrame[] = [];
  let pos = headerEnd + 1;
  while (pos < bytes.length) {
    const lineEnd = bytes.indexOf(0x0a, pos);
    if (lineEnd < 0 || bytes.toString("latin1", pos, pos + 5) !== "FRAME") throw new Error("a YUV4MPEG2 frame header is malformed");
    const start = lineEnd + 1;
    if (start + lumaSize + 2 * chromaSize > bytes.length) throw new Error("a YUV4MPEG2 frame is truncated");
    frames.push({
      width,
      height,
      y: bytes.subarray(start, start + lumaSize),
      u: bytes.subarray(start + lumaSize, start + lumaSize + chromaSize),
      v: bytes.subarray(start + lumaSize + chromaSize, start + lumaSize + 2 * chromaSize),
    });
    pos = start + lumaSize + 2 * chromaSize;
  }
  return frames;
}

/**
 * BT.601 limited-range 4:2:0 YUV to 8-bit RGBA, opaque. Each chroma sample covers its 2 × 2 luma block (nearest). The
 * constants are written out, so a reference and a candidate with the same planes always give the same pixels, whatever
 * colour metadata either file carries.
 */
export function yuvToRgba(frame: YuvFrame): RawImage {
  const { width, height, y, u, v } = frame;
  const cw = (width + 1) >> 1;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const chromaRow = (row >> 1) * cw;
    for (let col = 0; col < width; col++) {
      const luma = 1.164383 * (y[row * width + col] - 16);
      const c = chromaRow + (col >> 1);
      const cb = u[c] - 128;
      const cr = v[c] - 128;
      const o = (row * width + col) * 4;
      out[o] = luma + 1.596027 * cr;
      out[o + 1] = luma - 0.391762 * cb - 0.812968 * cr;
      out[o + 2] = luma + 2.017232 * cb;
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

/** The indices of the stillest frames of one sample, from signalstats' YDIF (see stillestFrames). */
async function stillestOf(sample: string, metadataFile: string, deadline: number, signal?: AbortSignal): Promise<number[]> {
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
    signal,
  );
  if (result.code !== 0) throw new Error(`ffmpeg could not measure frame differences: ${lastLine(result.stderr)}`);
  return stillestFrames(await readFile(metadataFile, "utf8"), GUARD_FRAMES);
}

/**
 * The frames at `indices` (ascending) of a file, after `filters`, as RGBA in index order. A select filter picks exactly
 * the frames asked for, and ffmpeg writes them as raw 4:2:0 planes (YUV4MPEG2) on stdout. The conversion to RGB is
 * yuvToRgba, not ffmpeg's. The suspected fault (measured symptom: an AV1 CRF 26 candidate of a 720x1280 WebP scored VMAF
 * 95.3 but guard 21.3) is that ffmpeg's RGB conversion reads colour metadata (matrix, range, chroma location) that the
 * sample and the encoded candidate carry differently. VMAF reads luma only, so it cannot see that. Converting the planes
 * here, with one fixed formula, makes the reference and every candidate take the same conversion. Not yet run.
 */
async function framesAt(input: string, filters: string[], indices: number[], deadline: number, signal?: AbortSignal): Promise<RawImage[]> {
  if (indices.length === 0) return [];
  const pick = `format=yuv420p,select='${indices.map((n) => `eq(n,${n})`).join("+")}'`;
  const result = await ffrun(
    [...inputOptions(input), "-i", input, "-vf", [...filters, pick].join(","), "-fps_mode", "passthrough", "-f", "yuv4mpegpipe", "-"],
    deadline,
    signal,
  );
  if (result.code !== 0) throw new Error(`ffmpeg could not read frames: ${lastLine(result.stderr)}`);
  const planes = yuv4mpegFrames(result.stdout);
  if (planes.length !== indices.length) throw new Error(`ffmpeg gave ${planes.length} of the ${indices.length} frames asked for`);
  return planes.map(yuvToRgba);
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
  signal?: AbortSignal,
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
      signal,
    );
    if (result.code !== 0) throw new Error(lastLine(result.stderr));
  });
}

/**
 * The candidate of one sample, as ffmpeg reads it: the input for libvmaf, the bytes it reads from stdin (when the input is
 * a pipe), and its frames at given indices. An animated WebP cannot be read by ffmpeg, so it is decoded in-process and
 * streamed as raw RGBA.
 */
export interface Candidate {
  input: string[];
  stdin?: () => AsyncIterable<Uint8Array>;
  frames(indices: number[]): Promise<RawImage[]>;
}

/** A candidate that ffmpeg reads from its file. */
function fileCandidate(out: string, deadline: number, signal?: AbortSignal): Candidate {
  return {
    input: [...inputOptions(out), "-i", out],
    frames: (indices) => framesAt(out, [], indices, deadline, signal),
  };
}

/** The tick phase of a candidate's WebP timeline: the middle of each tick's interval (see webpCandidate). */
const TICK_CENTRE = 0.5;

/**
 * An animated WebP candidate, read frame by frame: its frames are composed in order (WebpAnimation), so the candidate's
 * timeline is streamed to VMAF and its guard frames are decoded on demand. Two readers of the same file: one feeds ffmpeg, the
 * other gives the guard frames, so each is read in order.
 */
async function webpCandidate(out: string, fps: number, seconds: number): Promise<Candidate> {
  const bytes = await readFile(out);
  // A still candidate (an encoder writes one when its frames are all alike) holds for the sample's length.
  // The candidate has one frame per sample frame, so tick k is read at the middle of its interval: the frame starts of an
  // encoded WebP are rounded to whole milliseconds, and a tick at its exact start can fall in the frame before (off by one).
  const feed = new WebpAnimation(bytes, fps, undefined, seconds * 1000, TICK_CENTRE);
  const guard = new WebpAnimation(bytes, fps, undefined, seconds * 1000, TICK_CENTRE);
  return {
    input: ["-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", `${feed.width}x${feed.height}`, "-framerate", String(fps), "-i", "pipe:0"],
    stdin: () => feed.ticks(0, feed.tickPages.length),
    frames: async (indices) => {
      const frames: RawImage[] = [];
      for (const n of indices) frames.push(await guard.page(guard.tickPages[Math.min(n, guard.tickPages.length - 1)]));
      return frames;
    },
  };
}

/**
 * The 2-second sample windows of an animated WebP source, cut as lossless FFV1 like cutSamples' files: each window's frames
 * are read from the animation and streamed to ffmpeg, so only the pages inside a window are decoded, and the whole animation
 * is never materialised. Windows are cut in order, so the reader moves forward (see WebpAnimation.page).
 */
async function cutWebpSamples(animation: WebpAnimation, durationS: number, workDir: string, deadline: number, signal?: AbortSignal): Promise<string[]> {
  await mkdir(workDir, { recursive: true });
  const fps = animation.fps;
  const total = animation.tickPages.length;
  const samples: string[] = [];
  for (const [i, offset] of sampleOffsets(durationS).entries()) {
    const from = Math.min(total, Math.round(offset * fps));
    const to = Math.min(total, from + SAMPLE_SECONDS * fps);
    if (to - from > MAX_WINDOW_FRAMES) throw new WindowTooLarge(to - from);
    const out = join(workDir, `sample-${i}.mkv`);
    const result = await ffrun(
      ["-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", `${animation.width}x${animation.height}`, "-framerate", String(fps), "-i", "pipe:0", "-an", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-threads", String(FFMPEG_THREADS), "-y", out],
      deadline,
      signal,
      () => animation.ticks(from, to),
    );
    if (result.code !== 0) throw new Error(`ffmpeg could not write sample ${i} of this animated WebP: ${lastLine(result.stderr)}`);
    samples.push(out);
  }
  return samples;
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
  signal?: AbortSignal,
  stdin?: () => AsyncIterable<Uint8Array>,
): Promise<number> {
  return stage("no-vmaf", async () => {
    const retime = `settb=AVTB,setpts=N/${fps}/TB`;
    const graph =
      `[0:v]scale=${width}:-2:flags=bicubic,${retime}[d];` +
      `[1:v]scale=${width}:-2:flags=bicubic,${retime}[r];` +
      `[d][r]libvmaf=n_threads=${FFMPEG_THREADS}:shortest=1:n_subsample=${VMAF_SUBSAMPLE}:log_fmt=json:log_path=${escapeFilterValue(log)}`;
    const result = await ffrun(
      [...distorted, ...inputOptions(reference), "-i", reference, "-lavfi", graph, "-f", "null", "-"],
      deadline,
      signal,
      stdin,
    );
    if (result.code !== 0) throw new Error(lastLine(result.stderr));
    const json = JSON.parse(await readFile(log, "utf8")) as { pooled_metrics?: { vmaf?: { mean?: unknown } } };
    const mean = json.pooled_metrics?.vmaf?.mean;
    if (typeof mean !== "number") throw new Error("no pooled VMAF mean");
    return mean;
  });
}

/** Everything one search needs, so the steps do not take it as separate arguments. */
export interface Ctx {
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
  /**
   * The still bar once it is known (after the ceiling). A candidate with a guard score below it has failed: the p10 of up
   * to 10 frames is their minimum, so the search stops scoring it at that frame.
   */
  failBelow?: number;
}

/** A scored quality, before the search attaches the still bar it was judged against. */
type Scored = Omit<CandidateResult, "stillBar" | "vmafBar">;

/**
 * evaluate, memoised per search: a quality already encoded is returned from the cache. The deadline is checked before a
 * new encode, so the ceiling encode and the bisection both stop at the deadline. `strict` is for the ceiling (see evaluate).
 */
async function evaluateCached(ctx: Ctx, q: number, strict = false): Promise<Scored> {
  const known = ctx.cache.get(q);
  if (known) return known;
  if (Date.now() >= ctx.opts.deadline) throw new DeadlineHit();
  const result = await evaluate(ctx, q, strict);
  ctx.cache.set(q, result);
  return result;
}

/** One sample's candidate, read before any scoring: its bytes, its VMAF, and its guard frames (null when unreadable). */
interface SampleRead {
  bytes: number;
  vmaf: number;
  frames: RawImage[] | null;
}

/**
 * Encodes one sample at quality `q` and reads what the search needs from it: the bytes, the VMAF, and the frames at the
 * guard's indices. These are child processes (or a short decode), so the samples of a candidate run in parallel (an
 * animated WebP's samples run one at a time, see readAll). A frame that cannot be read (a candidate with fewer frames than
 * the reference, for example) gives null, which scores 0 for every guard frame of that sample: the candidate fails closed.
 */
async function readSample(ctx: Ctx, q: number, dir: string, i: number): Promise<SampleRead> {
  const { codec, width, opts } = ctx;
  const out = join(dir, `s${i}.${SPECS[codec].ext}`);
  await encodeClip(ctx.samples[i], codec, width, q, out, opts.caps, opts.deadline, opts.signal);
  const bytes = (await stat(out)).size;
  const cand = codec === "animated-webp"
    ? await stage("no-encoder", () => webpCandidate(out, ctx.fps, ctx.seconds[i]))
    : fileCandidate(out, opts.deadline, opts.signal);
  const vmaf = await vmafOf(cand.input, ctx.samples[i], width, ctx.fps, join(dir, `vmaf-${i}.json`), opts.deadline, opts.signal, cand.stdin);
  let frames: RawImage[] | null;
  try {
    frames = await cand.frames(ctx.guards[i].indices);
  } catch (err) {
    if (isDeadline(err) || isAbortError(err)) throw err;
    frames = null;
  }
  return { bytes, vmaf, frames };
}

/**
 * The samples of one quality, read. An animated WebP's samples are read one after another: each decodes its own timeline,
 * so running them together would hold several decoded timelines at once. Other codecs run their samples in parallel.
 */
async function readAll(ctx: Ctx, q: number, dir: string): Promise<SampleRead[]> {
  if (ctx.codec !== "animated-webp") return settleAll(ctx.samples.map((_, i) => readSample(ctx, q, dir, i)));
  const reads: SampleRead[] = [];
  for (let i = 0; i < ctx.samples.length; i++) reads.push(await readSample(ctx, q, dir, i));
  return reads;
}

/**
 * The guard scores of one sample, all of them (no early exit). A frame that cannot be read scores 0 (fails closed), or,
 * when `strict` (a ceiling, whose bar the source is judged by), is score-failed: a ceiling of 0 would lower the bar of
 * every candidate of the source.
 */
export async function guardScores(ctx: Ctx, i: number, cand: Candidate, strict = false): Promise<number[]> {
  const ref = ctx.guards[i];
  let frames: RawImage[];
  try {
    frames = await cand.frames(ref.indices);
  } catch (err) {
    if (isDeadline(err) || isAbortError(err)) throw err;
    if (strict) throw new StageError("score-failed");
    return ref.indices.map(() => 0);
  }
  const out: number[] = [];
  for (let k = 0; k < frames.length; k++) out.push(await scoreFrame(ctx, ref.frames[k], frames[k]));
  return out;
}

/**
 * The SSIMULACRA2 score of one guard frame: the candidate fitted to the reference's size, prefiltered when the source is
 * a GIF, then scored. A scorer that throws is a broken scorer, not a failing candidate, so it surfaces as score-failed.
 * A deadline ends the search either way.
 */
async function scoreFrame(ctx: Ctx, want: RawImage, got: RawImage): Promise<number> {
  if (Date.now() >= ctx.opts.deadline) throw new DeadlineHit();
  try {
    let frame = await fitTo(got, want.width, want.height);
    if (ctx.blur !== undefined) frame = await blurFrame(frame, ctx.blur);
    return await ctx.opts.score(want, frame);
  } catch (err) {
    if (isDeadline(err)) throw err;
    throw new StageError("score-failed");
  }
}

function mean(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

/**
 * Encodes every sample at quality `q`, scores it, and returns the result (pass or fail). Removes its files after.
 *
 * Two phases. First the samples are read (encode, VMAF, guard frames). Then the guard is scored in order, and a candidate
 * stops at its first score below ctx.failBelow: the p10 of up to 10 frames is their minimum, so one frame below the bar
 * already decides the result. The reported `still` is then the minimum so far, which is still below the bar.
 *
 * `strict` (the ceiling): an unreadable guard frame is score-failed, never a 0 score (see guardScores).
 */
async function evaluate(ctx: Ctx, q: number, strict = false): Promise<Scored> {
  const { codec, width, opts } = ctx;
  const dir = join(opts.workDir, `cand-${codec}-${width}-${q}`);
  await mkdir(dir, { recursive: true });
  try {
    const reads = await readAll(ctx, q, dir);
    const scores: number[] = [];
    let failed = false;
    for (let i = 0; i < reads.length && !failed; i++) {
      const ref = ctx.guards[i];
      const frames = reads[i].frames;
      if (frames === null && strict) throw new StageError("score-failed");
      for (let k = 0; k < ref.indices.length && !failed; k++) {
        const value = frames === null ? 0 : await scoreFrame(ctx, ref.frames[k], frames[k]);
        scores.push(value);
        if (ctx.failBelow !== undefined && value < ctx.failBelow) failed = true;
      }
    }
    const sampleBytes = reads.reduce((acc, r) => acc + r.bytes, 0);
    const sampleSeconds = ctx.seconds.reduce((acc, s) => acc + s, 0);
    return {
      codec,
      width,
      quality: q,
      sampleBytes,
      sampleSeconds,
      bytes: extrapolate(sampleBytes, sampleSeconds, ctx.probe.durationS),
      vmaf: mean(reads.map((r) => r.vmaf)),
      still: tenthPercentile(scores),
      estimate: true,
      audio: false,
      ...(codec === "av1-mp4" || codec === "animated-avif" ? { encoder: ctx.opts.caps.av1 } : {}),
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
  _dir: string,
  deadline: number,
  blurSigma?: number,
  signal?: AbortSignal,
): Promise<GuardRef> {
  // `_dir` is kept so the callers keep their signature: the frames now come over stdout, so no scratch files are written.
  const indices = await stillestOf(sample, metadataFile, deadline, signal);
  const raw = await framesAt(sample, [`scale=${width}:-2:flags=lanczos`], indices, deadline, signal);
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
        ctx.opts.signal,
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
 *
 * The bisection has 1-CRF resolution: it stops after the codec's steps, so the result can sit one CRF (or one WebP q
 * step) below the true cheapest passing quality. Accepted for performance (see the performance round in the report).
 */
export async function searchQuality(
  samples: string[],
  probe: MediaProbe,
  codec: MediaCodec,
  width: number,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  const { caps } = opts;
  if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
  if (!caps.ffmpeg) return { ok: false, reason: "no-ffmpeg" };
  if (!caps.vmaf) return { ok: false, reason: "no-vmaf" };
  if (!hasEncoder(caps, codec)) return { ok: false, reason: "no-encoder" };
  // An oversized frame is refused before any decode or encode (ffmpeg would allocate frames of several GB).
  if (probe.width * probe.height > MAX_INPUT_PIXELS_FFMPEG) return { ok: false, reason: "too-large" };
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
    const ceiling = await evaluateCached(ctx, bound, true);
    if (ceiling.vmaf < opts.vmafBar) return { ok: false, reason: "no-passing-quality" };
    const stillBar = effectiveStillBar(opts.stillBar, ceiling.still);
    ctx.failBelow = stillBar;
    let lo = spec.lo;
    let hi = spec.hi;
    for (let step = 0; step < spec.steps && lo <= hi; step++) {
      const q = step === 0 && spec.start !== undefined ? spec.start : Math.floor((lo + hi) / 2);
      const result = await evaluateCached(ctx, q);
      const pass = result.vmaf >= opts.vmafBar && result.still >= stillBar;
      if (pass && (best === undefined || result.bytes < best.bytes)) best = { ...result, stillBar, vmafBar: opts.vmafBar };
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
    // An aborted run stops at once, and its partial result is not kept: the caller reports it as interrupted.
    if (opts.signal?.aborted || isAbortError(err)) return { ok: false, reason: "aborted" };
    // A timeline over the cap, or a frame over the pixel limit, is refused as a whole: no quality of this codec can be scored.
    if (isTooLarge(err)) return { ok: false, reason: "too-large" };
    // A broken scorer is reported even when an earlier quality passed: the passes before it were not checked by it.
    if (err instanceof StageError && err.reason === "score-failed") return { ok: false, reason: "score-failed" };
    if (best) return { ok: true, best, tried: ctx.cache.size };
    if (err instanceof StageError) return { ok: false, reason: err.reason };
    return { ok: false, reason: isDeadline(err) ? "time-limit" : "probe-failed" };
  }
  return best ? { ok: true, best, tried: ctx.cache.size } : { ok: false, reason: "no-passing-quality" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Compare with a reference (imgtune image --reference)
// ---------------------------------------------------------------------------------------------------------------------

/** What a candidate scores against its reference (see compareToReference). */
export interface ReferenceScore {
  /** Pooled VMAF mean over the samples. */
  vmaf: number;
  /** 10th percentile of the SSIMULACRA2 scores of the still-frame guard. */
  still: number;
  /**
   * The still guard of the reference's own best encode, in the candidate's codec at its best quality (see compareToReference).
   * The still bar is made relative with it (effectiveStillBar), as the search does. Undefined when no encoder is built in.
   */
  ceiling?: number;
  /** The codec the ceiling was encoded with (the candidate's, or AV1 when that codec has no encoder). */
  ceilingCodec?: MediaCodec;
  /** Number of 2-second samples compared. */
  samples: number;
}

/**
 * Scores one encoded candidate against its reference, for `imgtune image --reference`. The reference is cut into the same
 * 2-second samples the search uses, at the offsets of its probe; the candidate is cut at those same offsets, so both sides
 * cover the same moments. Both are scaled to `width` and scored as searchQuality scores an encode (the VMAF mean, the
 * 10th percentile of the still guard, the same prefilter for a GIF reference). Nothing is re-encoded except the
 * reference's ceiling: one encode of each sample at the best quality of the candidate's own codec (`codec`: AV1 CRF 20, H.264
 * CRF 18, WebP q 90), so a candidate is judged against the bar its codec can reach. AV1 stands in when that codec has no
 * encoder. Throws when a file cannot be cut or scored, and when the ceiling's own frames cannot be read (score-failed).
 */
export async function compareToReference(
  candidate: ClipSource,
  reference: ClipSource,
  probe: MediaProbe,
  width: number,
  opts: SearchOptions,
  codec: MediaCodec = "av1-mp4",
): Promise<ReferenceScore> {
  const referenceSamples = await cutSamples(reference, probe, join(opts.workDir, "reference"), opts.deadline, undefined, opts.signal);
  const candidateSamples = await cutSamples(candidate, probe, join(opts.workDir, "candidate"), opts.deadline, undefined, opts.signal);
  const scored = await scoreSamples(candidateSamples, referenceSamples, probe, width, opts, { webp: false, strict: false });
  const ceilingCodec: MediaCodec | undefined = hasEncoder(opts.caps, codec) ? codec : opts.caps.av1 !== undefined ? "av1-mp4" : undefined;
  let ceiling: number | undefined;
  if (ceilingCodec !== undefined) {
    const dir = join(opts.workDir, "ceiling");
    await mkdir(dir, { recursive: true });
    const spec = SPECS[ceilingCodec];
    const bound = ceilingCodec === "animated-webp" ? spec.hi : spec.lo;
    const encoded: string[] = [];
    for (let i = 0; i < referenceSamples.length; i++) {
      const out = join(dir, `s${i}.${spec.ext}`);
      await encodeClip(referenceSamples[i], ceilingCodec, width, bound, out, opts.caps, opts.deadline, opts.signal);
      encoded.push(out);
    }
    ceiling = (await scoreSamples(encoded, referenceSamples, probe, width, opts, { webp: ceilingCodec === "animated-webp", strict: true })).still;
  }
  return { vmaf: scored.vmaf, still: scored.still, ceiling, ceilingCodec, samples: referenceSamples.length };
}

/**
 * The pooled VMAF mean and the still-guard 10th percentile of candidate samples against reference samples (the same
 * cut offsets, one file per sample). The loop of an encode's score, without the encode: the search and the comparison
 * both score this way. `kind.webp`: the candidates are animated WebP files (decoded, not read by ffmpeg); `kind.strict`:
 * an unreadable guard frame is score-failed (see guardScores).
 */
async function scoreSamples(
  candidates: string[],
  samples: string[],
  probe: MediaProbe,
  width: number,
  opts: SearchOptions,
  kind: { webp: boolean; strict: boolean },
): Promise<{ vmaf: number; still: number }> {
  // The codec field only names the candidate kind for the cache of a search; scoring never reads it.
  const ctx: Ctx = {
    samples,
    probe,
    codec: kind.webp ? "animated-webp" : "av1-mp4",
    width,
    fps: probe.fps > 0 ? probe.fps : DEFAULT_FPS,
    seconds: clipSeconds(probe.durationS, samples.length),
    opts,
    guards: [],
    blur: probe.videoCodec === "gif" ? GIF_GUARD_SIGMA : undefined,
    cache: new Map(),
  };
  await mkdir(opts.workDir, { recursive: true });
  ctx.guards = await prepareGuards(ctx);
  const vmafs: number[] = [];
  const scores: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const cand = kind.webp
      ? await webpCandidate(candidates[i], ctx.fps, ctx.seconds[i])
      : fileCandidate(candidates[i], opts.deadline, opts.signal);
    vmafs.push(await vmafOf(cand.input, samples[i], width, ctx.fps, join(opts.workDir, `vmaf-${i}.json`), opts.deadline, opts.signal, cand.stdin));
    scores.push(...(await guardScores(ctx, i, cand, kind.strict)));
  }
  return { vmaf: mean(vmafs), still: tenthPercentile(scores) };
}
