// Single-file media for `imgtune image`: an animated GIF, animated WebP or APNG, or a video (MP4, MOV, WebM), read from a
// local file. Two modes. Without a reference, an animated file gets the candidates of the three animated codecs (animated
// AVIF, animated WebP and AV1 MP4) at a width, each the lowest-bytes quality that meets the bars. With a reference, a
// candidate (a re-encode an agent made) is compared with the original at a width, and passes or fails the same bars.
// Both measure from 2-second samples, so every byte figure is an estimate. The files are read, never written, except the
// lossless copy of an animated WebP (ffmpeg cannot read one) in a scratch folder the caller removes.

import { join } from "node:path";
import { animationOf, type AnimationInfo } from "./animated.js";
import type { FfmpegCaps, MediaProbe } from "./ffmpeg.js";
import { prepareMedia, type PreparedMedia } from "./media-prepare.js";
import {
  compareToReference,
  cutSamples,
  effectiveStillBar,
  searchQuality,
  type CandidateResult,
  type MediaCodec,
  type SearchOutcome,
} from "./media-encode.js";
import type { Scorer } from "./metric.js";
import { reasonText } from "./media-model.js";
import { pixelSize, safeText } from "./remote.js";
import { IMGTUNE_VERSION } from "./version.js";

/** The animated codecs a single animated file is searched for, in report order. */
export const ANIMATED_CODECS: MediaCodec[] = ["animated-avif", "animated-webp", "av1-mp4"];
/** Time one codec's search may take, in ms. */
export const CODEC_BUDGET_MS = 180_000;
/** Time a reference check may take, in ms. */
export const REFERENCE_BUDGET_MS = 300_000;
/** A candidate may end this much before the reference and still be compared (encoders trim a fraction of a second). */
const LENGTH_TOLERANCE_S = 0.5;
/** The note printed when ffmpeg is missing: the bytes are still measured, the encodes are not made. */
export const NO_FFMPEG_NOTE = "ffmpeg is not on PATH: the candidates and the reference check need it (ffmpeg enables the full hints)";

/** Brands of an ISO box file that are still images (AVIF, HEIC), not video. */
const STILL_BRANDS = new Set(["avif", "avis", "heic", "heix", "heim", "heis", "mif1", "msf1"]);

export type MediaKind = "video" | "animated";

export { prepareMedia, type PreparedMedia };

/** Whether an MP4, MOV or WebM (or Matroska) file: an ISO box file with a video brand, or an EBML header. */
export function isVideoContainer(buffer: Buffer): boolean {
  if (buffer.length >= 12 && buffer.toString("latin1", 4, 8) === "ftyp") return !STILL_BRANDS.has(buffer.toString("latin1", 8, 12));
  return buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
}

/** The kind of media a file is, from its bytes: animated (GIF, WebP, APNG with more than one frame), video, or undefined. */
export function mediaKindOf(buffer: Buffer): MediaKind | undefined {
  if (animationOf(buffer)) return "animated";
  if (isVideoContainer(buffer)) return "video";
  return undefined;
}

/** What the run needs for every media file: the capabilities, the scorer, the bars, and the scratch folder of the run. */
export interface MediaContext {
  caps: FfmpegCaps;
  score: Scorer;
  /** Scratch folder of the run: each file gets a subfolder, and the caller removes the whole folder. */
  dir: string;
  /** --video-bar: the minimum VMAF (see DEFAULT_VIDEO_BAR in remote.ts). */
  videoBar: number;
  /** --video-still-bar: the still-guard bar before it is made relative to the reference's ceiling. */
  videoStillBar: number;
  /** Aborts the run (SIGINT, SIGTERM): a running ffmpeg is killed and the file reports the interruption. */
  signal?: AbortSignal;
}

/** The file as it is now: its format, size and, where it is known, its width, length and frames. */
export interface MediaCurrent {
  format: string;
  width: number;
  height: number;
  bytes: number;
  seconds?: number;
  frames?: number;
}

/** Where the width comes from: the user's --width, or the file's own size. */
export interface MediaWidth {
  source: "user" | "file";
  px: number;
}

/** One animated file: its candidates per codec, or why there are none. */
export interface AnimatedFileResult {
  label: string;
  evidence: "media-file";
  imgtuneVersion: string;
  kind: "animated";
  current: MediaCurrent;
  width: MediaWidth;
  bars: { vmaf: number; stillRequested: number };
  candidates: { codec: MediaCodec; outcome: SearchOutcome }[];
  note?: string;
  error?: string;
}

/** One video file without a reference: its size and length, and the hint to compare it. */
export interface VideoFileResult {
  label: string;
  evidence: "media-file";
  imgtuneVersion: string;
  kind: "video";
  current: MediaCurrent;
  note?: string;
  error?: string;
}

export type MediaFileResult = AnimatedFileResult | VideoFileResult;

/** One candidate compared with its reference: the scores, the bars that applied, and the verdict. */
export interface ReferenceFileResult {
  label: string;
  evidence: "media-reference";
  imgtuneVersion: string;
  current: MediaCurrent;
  reference: { label: string; width: number; height: number; seconds: number };
  width: number;
  vmaf: number;
  vmafBar: number;
  still: number;
  /** The still bar that applied: the requested one, or lower when the reference's own ceiling is lower. */
  stillBar: number;
  stillBarRequested: number;
  /** The reference's own best still-guard score, in the candidate's codec at its best quality. Absent without an encoder. */
  ceiling?: number;
  /** The codec of that ceiling: the candidate's own, or AV1 when the candidate's has no encoder. */
  ceilingCodec?: MediaCodec;
  samples: number;
  pass: boolean;
  error?: string;
}

const base = <K extends "animated" | "video">(label: string, kind: K) => ({ label, evidence: "media-file" as const, imgtuneVersion: IMGTUNE_VERSION, kind });

/** The current size of a file: its bytes, its pixel size from the header, and the animation's length and frames. */
async function currentOf(buffer: Buffer, format: string, animation?: AnimationInfo, probe?: MediaProbe): Promise<MediaCurrent> {
  const size = probe ? { width: probe.width, height: probe.height } : await pixelSize(buffer);
  const current: MediaCurrent = { format, width: size?.width ?? 0, height: size?.height ?? 0, bytes: buffer.length };
  if (animation) {
    current.seconds = animation.durationMs / 1000;
    current.frames = animation.frames;
  } else if (probe && probe.durationS > 0) current.seconds = probe.durationS;
  return current;
}

/** The formats a file's probe or animation names, for the report. */
function formatOf(animation: AnimationInfo | undefined, probe: MediaProbe | undefined): string {
  return probe?.videoCodec ?? animation?.format ?? "?";
}

/**
 * One animated file without a reference: the candidates of each animated codec at `width` (the file's own width when not
 * given), each the lowest-bytes quality that meets the bars. Never throws: a failure is the result's error.
 */
export async function measureAnimated(
  input: { label: string; path: string; buffer: Buffer },
  width: number | undefined,
  ctx: MediaContext,
  dir: string,
): Promise<AnimatedFileResult> {
  const animation = animationOf(input.buffer);
  const bars = { vmaf: ctx.videoBar, stillRequested: ctx.videoStillBar };
  const current = await currentOf(input.buffer, formatOf(animation, undefined), animation);
  const widthOf = (px: number): MediaWidth => ({ source: width === undefined ? "file" : "user", px });
  const result = (extra: Partial<AnimatedFileResult>): AnimatedFileResult => ({
    ...base(input.label, "animated"),
    current,
    width: widthOf(width ?? current.width),
    bars,
    candidates: [],
    ...extra,
  } as AnimatedFileResult);
  if (!ctx.caps.ffmpeg) return result({ note: NO_FFMPEG_NOTE });
  try {
    const prepared = await prepareMedia(input.path, input.buffer, join(dir, "prepared"), undefined, ctx.signal);
    current.format = formatOf(animation, prepared.probe);
    current.width = prepared.probe.width;
    current.height = prepared.probe.height;
    const px = width ?? prepared.probe.width;
    const samples = await cutSamples(prepared.source, prepared.probe, join(dir, "samples"), Date.now() + CODEC_BUDGET_MS, undefined, ctx.signal);
    const candidates: AnimatedFileResult["candidates"] = [];
    for (const codec of ANIMATED_CODECS) {
      const outcome = await searchQuality(samples, prepared.probe, codec, px, {
        vmafBar: ctx.videoBar,
        stillBar: ctx.videoStillBar,
        deadline: Date.now() + CODEC_BUDGET_MS,
        caps: ctx.caps,
        score: ctx.score,
        workDir: join(dir, codec),
        signal: ctx.signal,
      });
      candidates.push({ codec, outcome });
    }
    return result({ width: widthOf(px), candidates });
  } catch (err) {
    return result({ error: (err as Error).message });
  }
}

/** One video file without a reference: its size and length, and what to do with it. */
export async function describeVideo(input: { label: string; path: string; buffer: Buffer }, ctx: MediaContext, dir: string): Promise<VideoFileResult> {
  const note = "a video: give --reference <original> to check a re-encode of it against the bars";
  if (!ctx.caps.ffmpeg) return { ...base(input.label, "video"), current: await currentOf(input.buffer, "video"), note: NO_FFMPEG_NOTE };
  try {
    const prepared = await prepareMedia(input.path, input.buffer, join(dir, "prepared"), undefined, ctx.signal);
    return { ...base(input.label, "video"), current: await currentOf(input.buffer, formatOf(undefined, prepared.probe), undefined, prepared.probe), note };
  } catch (err) {
    return { ...base(input.label, "video"), current: await currentOf(input.buffer, "video"), error: (err as Error).message };
  }
}

/**
 * The codec a candidate is judged in: its own (animated WebP, H.264 or AV1), so its still ceiling is the best its codec can
 * reach. Any other format is judged against AV1, as the search does.
 */
export function candidateCodecOf(cand: { animation?: AnimationInfo; probe: MediaProbe }): MediaCodec {
  if (cand.animation?.format === "webp") return "animated-webp";
  if (cand.probe.videoCodec === "h264") return "h264-mp4";
  return "av1-mp4";
}

/**
 * A candidate compared with its reference at `width` (the candidate's own width when not given). The still bar is made
 * relative to the reference's ceiling (its own AV1 CRF 20 encode's still guard) as the search does; without an AV1 encoder
 * the bar stays absolute. Never throws: a failure is the result's error, and the verdict is a fail.
 */
export async function compareReferenceFile(
  candidate: { label: string; path: string; buffer: Buffer },
  reference: { label: string; path: string; buffer: Buffer },
  width: number | undefined,
  ctx: MediaContext,
  dir: string,
): Promise<ReferenceFileResult> {
  const requested = ctx.videoStillBar;
  const fail = (error: string, extra: Partial<ReferenceFileResult> = {}): ReferenceFileResult => ({
    label: candidate.label,
    evidence: "media-reference",
    imgtuneVersion: IMGTUNE_VERSION,
    current: { format: "?", width: 0, height: 0, bytes: candidate.buffer.length },
    reference: { label: reference.label, width: 0, height: 0, seconds: 0 },
    width: width ?? 0,
    vmaf: 0,
    vmafBar: ctx.videoBar,
    still: 0,
    stillBar: requested,
    stillBarRequested: requested,
    samples: 0,
    pass: false,
    error,
    ...extra,
  });
  try {
    const cand = await prepareMedia(candidate.path, candidate.buffer, join(dir, "candidate"), undefined, ctx.signal);
    const ref = await prepareMedia(reference.path, reference.buffer, join(dir, "reference"), undefined, ctx.signal);
    // The samples are cut at the reference's moments, so a candidate that ends before the reference cannot be compared.
    if (cand.probe.durationS + LENGTH_TOLERANCE_S < ref.probe.durationS) {
      return fail(`the candidate is ${cand.probe.durationS.toFixed(1)} s but the reference is ${ref.probe.durationS.toFixed(1)} s: give a candidate of the same length (the samples are cut at the same moments)`);
    }
    const px = width ?? cand.probe.width;
    const score = await compareToReference(
      cand.source,
      ref.source,
      ref.probe,
      px,
      {
        vmafBar: ctx.videoBar,
        stillBar: requested,
        deadline: Date.now() + REFERENCE_BUDGET_MS,
        caps: ctx.caps,
        score: ctx.score,
        workDir: join(dir, "compare"),
        signal: ctx.signal,
      },
      candidateCodecOf(cand),
    );
    const stillBar = score.ceiling === undefined ? requested : effectiveStillBar(requested, score.ceiling);
    const current = await currentOf(candidate.buffer, formatOf(cand.animation, cand.probe), cand.animation, cand.probe);
    return {
      label: candidate.label,
      evidence: "media-reference",
      imgtuneVersion: IMGTUNE_VERSION,
      current,
      reference: { label: reference.label, width: ref.probe.width, height: ref.probe.height, seconds: ref.probe.durationS },
      width: px,
      vmaf: score.vmaf,
      vmafBar: ctx.videoBar,
      still: score.still,
      stillBar,
      stillBarRequested: requested,
      ...(score.ceiling !== undefined ? { ceiling: score.ceiling } : {}),
      ...(score.ceilingCodec !== undefined ? { ceilingCodec: score.ceilingCodec } : {}),
      samples: score.samples,
      pass: score.vmaf >= ctx.videoBar && score.still >= stillBar,
    };
  } catch (err) {
    return fail((err as Error).message);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------------

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/** How a candidate's quality reads: a CRF for AV1 and AVIF, a q for WebP. */
function qualityText(codec: MediaCodec, quality: number): string {
  return codec === "animated-webp" ? `q ${quality}` : `CRF ${quality}`;
}

/** The text of one candidate line: its quality, width, estimated bytes and scores against the bars. */
function candidateLine(codec: MediaCodec, best: CandidateResult): string {
  return `  ${codec.padEnd(14)} ${qualityText(codec, best.quality)} at ${best.width} px: ${kb(best.bytes)} est. (VMAF ${best.vmaf.toFixed(1)} bar ${best.vmafBar}, still p10 ${best.still.toFixed(1)} bar ${best.stillBar.toFixed(1)})`;
}

/** The text of one animated file: its size, the bars, one line per codec, and the best saving. */
export function renderAnimated(result: AnimatedFileResult): string {
  const label = safeText(result.label);
  const c = result.current;
  const span = c.seconds !== undefined ? `, ${c.seconds.toFixed(1)} s${c.frames !== undefined ? `, ${c.frames} frames` : ""}` : "";
  const head = `${label}  ${safeText(c.format)} ${c.width}x${c.height}  ${kb(c.bytes)} now  animated${span}`;
  if (result.error) return `${head}\n  ${safeText(result.error)}\n`;
  const lines = [head];
  const widthNote = result.width.source === "user" ? "from --width" : "the file's own width; --width sets another";
  lines.push(`  width ${result.width.px} px (${widthNote})`);
  // The note only when a candidate's still bar was lowered below the requested one (its own ceiling is low).
  const lowered = result.candidates.some(({ outcome }) => outcome.ok && outcome.best.stillBar < result.bars.stillRequested);
  lines.push(`  bars VMAF ${result.bars.vmaf}, still p10 ${result.bars.stillRequested}${lowered ? " (lowered for a source whose own best encode scores low)" : ""}`);
  if (result.note) lines.push(`  ${safeText(result.note)}`);
  let best: { codec: MediaCodec; bytes: number } | undefined;
  for (const { codec, outcome } of result.candidates) {
    if (outcome.ok) {
      lines.push(candidateLine(codec, outcome.best));
      if (best === undefined || outcome.best.bytes < best.bytes) best = { codec, bytes: outcome.best.bytes };
    } else {
      const why = reasonText(outcome.reason);
      lines.push(`  ${codec.padEnd(14)} no quality meets the bars (${why})`);
    }
  }
  if (best) {
    const saves = c.bytes - best.bytes;
    lines.push(`  best ${best.codec} ${kb(best.bytes)} est.${saves >= 0 ? ` (saves ${kb(saves)} est.)` : ""}`);
  }
  if (result.candidates.length > 0) lines.push("  estimates from 2 s samples; the full length is not encoded");
  return `${lines.join("\n")}\n`;
}

/** How each codec's best-quality ceiling is named in a report. */
const CEILING_NAME: Record<MediaCodec, string> = {
  "av1-mp4": "AV1 CRF 20",
  "animated-avif": "AVIF CRF 20",
  "h264-mp4": "H.264 CRF 18",
  "animated-webp": "WebP q 90",
};

/** The text of one video file without a reference. */
export function renderVideo(result: VideoFileResult): string {
  const c = result.current;
  const span = c.seconds !== undefined ? `, ${c.seconds.toFixed(1)} s` : "";
  const lines = [`${safeText(result.label)}  ${safeText(c.format)} ${c.width}x${c.height}  ${kb(c.bytes)} now  video${span}`];
  if (result.error) lines.push(`  ${safeText(result.error)}`);
  if (result.note) lines.push(`  ${safeText(result.note)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The text of a reference check: the candidate's size, the reference, and the verdict line
 * `VMAF <v> (bar <b>) still p10 <s> (bar <sb>): pass|fail`. The still bar line says when the bar was lowered.
 */
export function renderReference(result: ReferenceFileResult): string {
  const c = result.current;
  const head = `${safeText(result.label)}  ${safeText(c.format)} ${c.width}x${c.height}  ${kb(c.bytes)} now`;
  if (result.error) return `${head}\n  ${safeText(result.error)}\n`;
  const lines = [head];
  const ref = result.reference;
  lines.push(`  reference ${safeText(ref.label)} (${ref.width}x${ref.height}, ${ref.seconds.toFixed(1)} s); compared at ${result.width} px`);
  if (result.ceiling === undefined) lines.push("  still bar is absolute: no AV1 encoder, so the reference's own ceiling is not measured");
  else {
    if (result.stillBar < result.stillBarRequested) {
      lines.push(`  still bar lowered from ${result.stillBarRequested} to ${result.stillBar.toFixed(1)}: the reference's own best encode scores ${result.ceiling.toFixed(1)}`);
    }
    // The ceiling is the reference's best encode in the candidate's codec (AV1 when that codec has no encoder), named here.
    lines.push(`  still bar ceiling: the reference's best ${CEILING_NAME[result.ceilingCodec ?? "av1-mp4"]} encode (candidate ${safeText(c.format)})`);
  }
  const verdict = `VMAF ${result.vmaf.toFixed(1)} (bar ${result.vmafBar}) still p10 ${result.still.toFixed(1)} (bar ${result.stillBar.toFixed(1)}): ${result.pass ? "pass" : "fail"}`;
  lines.push(verdict);
  return `${lines.join("\n")}\n`;
}
