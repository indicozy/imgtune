// The media phase of a scan: after every page is measured, the animated images and `<video>` files of all pages are
// ranked by their bytes, and the heaviest ones within the budget get their sample encodes (media-encode.ts). Each asset
// is encoded once per run (its key), an outcome is kept in the result cache, and every ffmpeg step is bounded by the
// asset's deadline. Nothing here throws: a failure becomes the asset's `notEncoded` reason, so a scan always finishes.
// Without ffmpeg the phase still runs its cheap part: every asset is marked "ffmpeg not found" with one note.

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mapLimit } from "./concurrency.js";
import { FFMPEG_JOBS, probeFfmpeg, probeMedia, type FfmpegCaps, type MediaProbe } from "./ffmpeg.js";
import {
  cutSamples,
  hasRange,
  searchQuality,
  type CandidateResult,
  type MediaCodec,
  type SearchOutcome,
} from "./media-encode.js";
import { attributeLevers, rankForBudget, snapWidth, type LeverSteps } from "./media-model.js";
import { makeScorer, type Scorer } from "./metric.js";
import { CACHE_VERSION, contentHash, type ResultCache } from "./result-cache.js";
import type { ImageRecord } from "./images.js";
import type { PageResult } from "./remote.js";
import type { AnimatedFix, VideoRecord } from "./video-analysis.js";
import { IMGTUNE_VERSION } from "./version.js";

/** The note printed once when ffmpeg is missing: what installing it adds. */
export const MEDIA_NOTE = "install ffmpeg for verified video and GIF hints";
/** Longest a single asset may take, in ms; the phase's own time limit caps it further. */
const ASSET_CAP_MS = 60_000;
/** Time allowed for the Range probe of a video URL, in ms. */
const RANGE_TIMEOUT_MS = 15_000;
/** Time allowed for ffprobe of one file, in ms. */
const PROBE_TIMEOUT_MS = 30_000;
/** A video the server cannot seek in is not downloaded above this size: the encode would read all of it. */
const NO_RANGE_MAX_BYTES = 50_000_000;
/** Longest error text kept in a notEncoded reason. */
const MAX_ERROR_CHARS = 200;

/** One asset to encode: an animated image, or a `<video>` file of the page. */
export interface MediaAsset {
  /** Identity for dedupe and results: see mediaKeyOf. */
  key: string;
  url: string;
  kind: "video" | "animated";
  /** Where the file is used: "video" for a `<video>`, else the animated image's own context. */
  context: "img" | "css-background" | "video";
  /** The snapped target widths that need an encode. */
  widths: number[];
  /** Bytes per page view and per play, as the cheap levers give them (used to rank the assets). */
  perView: number;
  perPlay: number;
  /** The bytes already read, when the caller has them. Otherwise the phase fetches them (see MediaDeps.fetch). */
  buffer?: Buffer;
}

export interface MediaOptions {
  /** At most this many assets (by per-view bytes) are encoded. */
  budget: number;
  /** The phase's time limit, in seconds; each asset's deadline is the earlier of this and its own cap. */
  timeS: number;
  /** Minimum VMAF of a passing quality. */
  vmafBar: number;
  /** Minimum 10th-percentile SSIMULACRA2 of the still-frame guard. */
  stillBar: number;
  /** A --survey scan: nothing is encoded. */
  survey: boolean;
  /** Scratch folder for samples and candidates. The phase creates it and removes it when it ends. */
  workDir: string;
  cache?: ResultCache;
  log: (line: string) => void;
  /** The egress proxy a video URL goes through. Required when a video is encoded. */
  proxy?: string;
  /** The SSIMULACRA2 scorer. The CPU one when absent. */
  score?: Scorer;
}

/** The phase's outcome for one asset key. */
export interface MediaEntry {
  /** The probe of the file, when it was read. */
  probe?: MediaProbe;
  candidates: CandidateResult[];
  /** Why no candidate was encoded (a reason from media-encode.ts, or one of the phase's own). */
  notEncoded?: string;
  /** The full file length the server reported, for a video (refines its per-play bytes). */
  length?: number;
}

export interface MediaResults {
  byKey: Map<string, MediaEntry>;
  /** A note for the whole run, such as the missing-ffmpeg note. */
  note?: string;
}

/**
 * The steps the phase calls. Production leaves them unset; tests inject them to run without an encoder, to count the
 * encodes, or to supply the fetch of an animated file.
 */
export interface MediaDeps {
  caps?: FfmpegCaps;
  search?: typeof searchQuality;
  cut?: typeof cutSamples;
  probe?: typeof probeMedia;
  hasRange?: typeof hasRange;
  /**
   * The bytes of a file, fetched with the run's guarded fetcher, up to `maxBytes`. Undefined when it cannot be read. Used
   * for an animated image, and for a video whose server has no Range support.
   */
  fetch?: (url: string, maxBytes?: number) => Promise<Buffer | undefined>;
}

/** The flags attachMediaResults reads when a page has no entry for one of its assets. */
export interface MediaAttachArgs {
  quality: boolean;
  survey: boolean;
}

/**
 * The key of one asset: its kind, its context, its widths and its URL. Two assets with one key are one encode. The
 * validators of a video (its ETag and length) refine the result-cache key later, not this one.
 */
export function mediaKeyOf(kind: MediaAsset["kind"], context: MediaAsset["context"], url: string, widths: readonly number[]): string {
  return `${kind}|${context}|${widths.join(",")}|${url}`;
}

/** The asset of a `<video>` record: its widths are the kept widths of the scan. */
export function videoAssetOf(record: VideoRecord): MediaAsset {
  const widths = record.widths?.widths ?? [];
  return {
    key: mediaKeyOf("video", "video", record.src, widths),
    url: record.src,
    kind: "video",
    context: "video",
    widths,
    perView: record.bytes.perView,
    perPlay: record.bytes.perPlay,
  };
}

/**
 * The asset of an animated image record, or undefined when the record has no URL or no needed width. The one width is the
 * largest device width any viewport needs, snapped to a bucket, never above the file's own width.
 */
export function animatedAssetOf(record: ImageRecord, fix: AnimatedFix): MediaAsset | undefined {
  const url = record.current.src;
  if (url === undefined) return undefined;
  const needs = record.perViewport.map((p) => p.neededPx).filter((n) => n > 0);
  if (needs.length === 0) return undefined;
  const need = Math.max(...needs);
  const widths = [snapWidth(need, record.current.naturalWidth ?? need)];
  return {
    key: mediaKeyOf("animated", fix.context, url, widths),
    url,
    kind: "animated",
    context: fix.context,
    widths,
    perView: fix.perViewBytes,
    perPlay: fix.perViewBytes,
  };
}

/** The assets of one measured page: its videos and its animated images. */
export function mediaAssetsOf(result: PageResult): MediaAsset[] {
  const assets: MediaAsset[] = (result.videos ?? []).map(videoAssetOf);
  for (const image of result.images ?? []) {
    if (image.fix.animated === undefined) continue;
    const asset = animatedAssetOf(image, image.fix.animated);
    if (asset !== undefined) assets.push(asset);
  }
  return assets;
}

/** Results that mark every asset as not encoded for one reason (a survey, or a scan with quality off). */
export function skippedMedia(assets: MediaAsset[], reason: string): MediaResults {
  const byKey = new Map<string, MediaEntry>();
  for (const asset of assets) {
    if (!byKey.has(asset.key)) byKey.set(asset.key, { candidates: [], notEncoded: reason });
  }
  return { byKey };
}

/** One sample-encode job: a codec at a width. */
interface Job {
  codec: MediaCodec;
  width: number;
}

/**
 * The jobs of a video: AV1 at each width, and the H.264 fallback at each width unless the served file already is H.264 at
 * that width.
 */
function videoJobs(widths: readonly number[], probe: MediaProbe): Job[] {
  const jobs: Job[] = [];
  for (const width of widths) {
    jobs.push({ codec: "av1-mp4", width });
    if (!(probe.videoCodec === "h264" && width >= probe.width)) jobs.push({ codec: "h264-mp4", width });
  }
  return jobs;
}

/**
 * The jobs of an animated image: animated AVIF and WebP at each width, and AV1 too for an `<img>`, so the over-threshold
 * rule (a video instead of the image) can be judged.
 */
function animatedJobs(widths: readonly number[], context: MediaAsset["context"]): Job[] {
  const jobs: Job[] = [];
  for (const width of widths) {
    jobs.push({ codec: "animated-avif", width }, { codec: "animated-webp", width });
    if (context === "img") jobs.push({ codec: "av1-mp4", width });
  }
  return jobs;
}

/** The dependencies and settings every asset's encode shares. */
interface Env {
  opts: MediaOptions;
  caps: FfmpegCaps;
  score: Scorer;
  search: typeof searchQuality;
  cut: typeof cutSamples;
  probe: typeof probeMedia;
  hasRange: typeof hasRange;
  fetch?: (url: string, maxBytes?: number) => Promise<Buffer | undefined>;
}

/** What the result cache keeps for one job: a passing candidate, or the "no passing quality" outcome. */
type CachedOutcome = { ok: true; best: CandidateResult } | { ok: false; reason: "no-passing-quality" };

/** A short, file-name-safe digest of a key, for the per-asset folder. */
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The error text of an unexpected failure, one line and at most MAX_ERROR_CHARS long. */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").slice(0, MAX_ERROR_CHARS);
}

/** True when a cached value has the shape the phase wrote. The cache is untrusted, so every field is checked. */
function isCachedOutcome(value: unknown): value is CachedOutcome {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { ok?: unknown; best?: unknown; reason?: unknown };
  if (v.ok === false) return v.reason === "no-passing-quality";
  if (v.ok !== true || typeof v.best !== "object" || v.best === null) return false;
  const b = v.best as Record<string, unknown>;
  const numbers = ["width", "quality", "sampleBytes", "sampleSeconds", "bytes", "vmaf", "still"];
  return (
    numbers.every((k) => typeof b[k] === "number" && Number.isFinite(b[k] as number)) &&
    (b.codec === "av1-mp4" || b.codec === "h264-mp4" || b.codec === "animated-avif" || b.codec === "animated-webp")
  );
}

/**
 * Runs the jobs of one asset in order, each through the cache first. The samples are cut once, on the first job that
 * misses the cache. Returns the candidates that passed; when none did, the first reason.
 */
async function runJobs(
  jobs: Job[],
  identity: string,
  probe: MediaProbe,
  samplesOf: () => Promise<string[]>,
  dir: string,
  deadline: number,
  env: Env,
  readError: string,
): Promise<MediaEntry> {
  const { opts } = env;
  const candidates: CandidateResult[] = [];
  const reasons: string[] = [];
  let samples: Promise<string[]> | undefined;
  for (const job of jobs) {
    const cacheKey = `media|${identity}|${job.codec}|w${job.width}|v${opts.vmafBar}|s${opts.stillBar}|imgtune ${IMGTUNE_VERSION}|cache ${CACHE_VERSION}`;
    const cached = await opts.cache?.getJson<unknown>(cacheKey);
    let outcome: SearchOutcome;
    if (isCachedOutcome(cached)) {
      outcome = cached.ok ? { ok: true, best: cached.best, tried: 0 } : { ok: false, reason: "no-passing-quality" };
    } else {
      if (Date.now() >= deadline) return { probe, candidates, notEncoded: "time-limit" };
      samples ??= samplesOf();
      let cut: string[];
      try {
        cut = await samples;
      } catch {
        return { probe, candidates, notEncoded: Date.now() >= deadline ? "time-limit" : readError };
      }
      outcome = await env.search(cut, probe, job.codec, job.width, {
        vmafBar: opts.vmafBar,
        stillBar: opts.stillBar,
        deadline,
        caps: env.caps,
        score: env.score,
        workDir: join(dir, `${job.codec}-${job.width}`),
      });
      if (outcome.ok) await opts.cache?.putJson(cacheKey, { ok: true, best: outcome.best } satisfies CachedOutcome);
      else if (outcome.reason === "no-passing-quality") await opts.cache?.putJson(cacheKey, { ok: false, reason: "no-passing-quality" } satisfies CachedOutcome);
    }
    if (outcome.ok) candidates.push(outcome.best);
    else reasons.push(outcome.reason);
  }
  if (candidates.length > 0) return { probe, candidates };
  if (jobs.length === 0) return { probe, candidates, notEncoded: "no width to encode" };
  return { probe, candidates, notEncoded: reasons[0] };
}

/**
 * The sample encodes of one file: its probe, then the jobs `jobsOf` gives for it. `input` is an absolute path or a URL
 * (read through `proxy`). A file that cannot be probed is a read error.
 */
async function encodeFile(
  input: string,
  identity: string,
  jobsOf: (probe: MediaProbe) => Job[],
  env: Env,
  deadline: number,
  dir: string,
  proxy: string | undefined,
  readError: string,
): Promise<MediaEntry> {
  const probe = await env.probe(input, PROBE_TIMEOUT_MS, { proxy });
  if (probe === undefined) return { candidates: [], notEncoded: readError };
  return runJobs(jobsOf(probe), identity, probe, () => env.cut(input, probe, dir, deadline, proxy), dir, deadline, env, readError);
}

/** Writes a file's bytes into the asset's folder and returns the local path. */
async function writeSource(dir: string, buffer: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, "source");
  await writeFile(file, buffer);
  return file;
}

/**
 * A `<video>`: its Range support and length, then its sample encodes. A server with Range support is sampled through the
 * proxy by seeking. A server without it cannot be sought (ffmpeg then cuts a truncated sample and still exits 0), so a
 * file of up to NO_RANGE_MAX_BYTES is read whole, once, and cut from the local copy; a larger one is not read at all.
 */
async function encodeVideo(asset: MediaAsset, env: Env, deadline: number): Promise<MediaEntry> {
  const proxy = env.opts.proxy;
  const range = await env.hasRange(asset.url, RANGE_TIMEOUT_MS, proxy);
  const length = range.length;
  if (!range.range && (length ?? 0) > NO_RANGE_MAX_BYTES) {
    return { candidates: [], notEncoded: "server has no Range support", ...(length !== undefined ? { length } : {}) };
  }
  const withLength = length !== undefined ? { length } : {};
  const dir = join(resolve(env.opts.workDir), digest(asset.key));
  const jobsOf = (probe: MediaProbe): Job[] => videoJobs(asset.widths, probe);
  if (!range.range) {
    const buffer = env.fetch ? await env.fetch(asset.url, NO_RANGE_MAX_BYTES) : undefined;
    if (buffer === undefined) return { candidates: [], notEncoded: "could not read the video", ...withLength };
    const file = await writeSource(dir, buffer);
    const entry = await encodeFile(file, `${asset.url}|${contentHash(buffer)}`, jobsOf, env, deadline, dir, undefined, "could not read the video");
    return { ...entry, ...withLength };
  }
  const identity = `${asset.url}|${range.etag ?? range.lastModified ?? ""}|${length ?? ""}`;
  const entry = await encodeFile(asset.url, identity, jobsOf, env, deadline, dir, proxy, "could not read the video");
  return { ...entry, ...withLength };
}

/** An animated image: its bytes, written to the work folder so ffmpeg reads a local file, then its sample encodes. */
async function encodeAnimated(asset: MediaAsset, env: Env, deadline: number): Promise<MediaEntry> {
  const buffer = asset.buffer ?? (env.fetch ? await env.fetch(asset.url) : undefined);
  if (buffer === undefined) return { candidates: [], notEncoded: "could not read the image" };
  const dir = join(resolve(env.opts.workDir), digest(asset.key));
  const file = await writeSource(dir, buffer);
  return encodeFile(
    file,
    `${asset.url}|${contentHash(buffer)}`,
    () => animatedJobs(asset.widths, asset.context),
    env,
    deadline,
    dir,
    undefined,
    "could not read the image",
  );
}

/** One asset's entry. A passed deadline is a time limit, checked before any work. */
async function encodeOne(asset: MediaAsset, env: Env, deadline: number): Promise<MediaEntry> {
  if (Date.now() >= deadline) return { candidates: [], notEncoded: "time-limit" };
  try {
    return asset.kind === "video" ? await encodeVideo(asset, env, deadline) : await encodeAnimated(asset, env, deadline);
  } catch (err) {
    return { candidates: [], notEncoded: `media error: ${errorText(err)}` };
  }
}

/**
 * Runs the media phase for the assets of a scan. Within the budget, each unique asset is probed, cut into samples and
 * searched per codec and width; the rest are marked "over --media-budget". `--survey` encodes nothing. Without ffmpeg
 * every asset is marked "ffmpeg not found" and the note is set. Never throws. The work folder is removed at the end.
 */
export async function runMediaPhase(assets: MediaAsset[], opts: MediaOptions, deps: MediaDeps = {}): Promise<MediaResults> {
  const byKey = new Map<string, MediaEntry>();
  if (assets.length === 0) return { byKey };
  const started = Date.now();
  const phaseEnd = started + Math.max(0, opts.timeS) * 1000;
  try {
    const caps = deps.caps ?? (await probeFfmpeg());
    const unique = [...new Map(assets.map((a) => [a.key, a])).values()];
    const ranked = rankForBudget(unique, opts.budget);
    const running = !opts.survey && caps.ffmpeg;
    opts.log(`media: ${assets.length} assets, ${running ? ranked.encode.length : 0} to encode (budget ${opts.budget})`);
    if (opts.survey) {
      for (const asset of unique) byKey.set(asset.key, { candidates: [], notEncoded: "survey" });
      return finish(byKey, started, opts, undefined);
    }
    if (!caps.ffmpeg) {
      for (const asset of unique) byKey.set(asset.key, { candidates: [], notEncoded: "ffmpeg not found" });
      opts.log(`media: ffmpeg not found; ${MEDIA_NOTE}`);
      return finish(byKey, started, opts, MEDIA_NOTE);
    }
    for (const asset of ranked.skipped) byKey.set(asset.key, { candidates: [], notEncoded: "over --media-budget" });
    const env: Env = {
      opts,
      caps,
      score: opts.score ?? makeScorer("ssimulacra2"),
      search: deps.search ?? searchQuality,
      cut: deps.cut ?? cutSamples,
      probe: deps.probe ?? probeMedia,
      hasRange: deps.hasRange ?? hasRange,
      fetch: deps.fetch,
    };
    await mkdir(opts.workDir, { recursive: true });
    try {
      await mapLimit(ranked.encode, FFMPEG_JOBS, async (asset) => {
        const deadline = Math.min(Date.now() + ASSET_CAP_MS, phaseEnd);
        byKey.set(asset.key, await encodeOne(asset, env, deadline));
      });
    } finally {
      await rm(opts.workDir, { recursive: true, force: true });
    }
    return finish(byKey, started, opts, undefined);
  } catch (err) {
    // Unexpected: every asset gets the reason, and the scan goes on.
    const reason = `media error: ${errorText(err)}`;
    for (const asset of assets) if (!byKey.has(asset.key)) byKey.set(asset.key, { candidates: [], notEncoded: reason });
    return { byKey };
  }
}

/** The phase's closing log line, and its results. */
function finish(byKey: Map<string, MediaEntry>, started: number, opts: MediaOptions, note: string | undefined): MediaResults {
  let encoded = 0;
  let notEncoded = 0;
  for (const entry of byKey.values()) {
    if (entry.candidates.length > 0) encoded++;
    else notEncoded++;
  }
  opts.log(`media: done in ${((Date.now() - started) / 1000).toFixed(1)} s, ${encoded} encoded, ${notEncoded} not encoded`);
  return note === undefined ? { byKey } : { byKey, note };
}

/**
 * The steps of the lever chain for a video, from its full bytes: audio, then resolution, codec and quality (see
 * attributeLevers). The resolution stage scales the bytes without audio by the pixel ratio (an estimate); the codec
 * stage is the AV1 candidate at the target width (or the estimate when there is none), and the final stage is the
 * estimate.
 */
function stepsOf(
  record: VideoRecord,
  estimate: CandidateResult,
  av1AtTarget: CandidateResult | undefined,
  target: number,
  probe: MediaProbe | undefined,
): LeverSteps | undefined {
  const start = record.bytes.perPlay;
  const audio = record.levers.audio?.bytes ?? 0;
  const noAudio = start - audio;
  const source = probe?.width ?? target;
  if (!(source > 0)) return undefined;
  const resized = Math.round(noAudio * (target / source) ** 2);
  const recoded = av1AtTarget?.bytes ?? estimate.bytes;
  return attributeLevers({ start, noAudio, resized, recoded, final: estimate.bytes });
}

/** The lowest-bytes candidate, or undefined when there is none. The first of equal bytes wins. */
function smallest(candidates: CandidateResult[]): CandidateResult | undefined {
  let best: CandidateResult | undefined;
  for (const c of candidates) if (best === undefined || c.bytes < best.bytes) best = c;
  return best;
}

/** The audio bytes of a muted video that has an audio track: its audio bitrate over its length. */
function audioBytesOf(record: VideoRecord, probe: MediaProbe | undefined): number | undefined {
  const bitrate = probe?.audio?.bitrate;
  if (bitrate === undefined || !record.attributes?.muted || !(probe!.durationS > 0)) return undefined;
  return Math.round((bitrate / 8) * probe!.durationS);
}

/** The full-file bytes refined by the server's length, when the record did not know the full size. */
function refineBytes(bytes: VideoRecord["bytes"], length: number | undefined): VideoRecord["bytes"] {
  if (bytes.fullBytesKnown || length === undefined) return bytes;
  return {
    ...bytes,
    perPlay: length,
    fullBytesKnown: true,
    perView: bytes.perViewBasis === "full-file" ? length : bytes.perView,
  };
}

/** One video record with its entry: the probe, the audio lever, the estimate and its steps, or the reason it has none. */
function attachVideo(record: VideoRecord, entry: MediaEntry | undefined, fallback: string | undefined): VideoRecord {
  if (entry === undefined) return fallback === undefined ? record : { ...record, notEncoded: fallback };
  const levers = { ...record.levers };
  const audio = audioBytesOf(record, entry.probe);
  if (audio !== undefined) levers.audio = { bytes: audio };
  const out: VideoRecord = {
    ...record,
    bytes: refineBytes(record.bytes, entry.length),
    levers,
    ...(entry.probe !== undefined ? { probe: entry.probe } : {}),
  };
  const target = Math.max(0, ...(record.widths?.widths ?? []));
  const atTarget = entry.candidates.filter((c) => c.width === target);
  // AV1 is the main hint; the H.264 fallback is the estimate only when no AV1 encode passed at the target width.
  const av1 = smallest(atTarget.filter((c) => c.codec === "av1-mp4"));
  const estimate = av1 ?? smallest(atTarget);
  if (estimate === undefined) {
    out.notEncoded = entry.notEncoded ?? "no passing quality";
    return out;
  }
  out.estimate = estimate;
  const steps = stepsOf(out, estimate, av1, target, entry.probe);
  if (steps !== undefined) out.steps = steps;
  return out;
}

/**
 * Puts the media results on one analysed page, before it is written: each video gets its probe, its audio lever, its
 * estimate and steps (or its reason), and each animated image gets its candidates (or its reason). A page whose asset has
 * no entry gets the fallback reason of the scan (survey or quality off), and otherwise keeps the cheap levers it has.
 * Pages resumed from disk never pass through here.
 */
export function attachMediaResults(result: PageResult, results: MediaResults, args: MediaAttachArgs): PageResult {
  const fallback = args.survey ? "survey" : args.quality ? undefined : "quality off";
  const videos = result.videos?.map((record) => attachVideo(record, results.byKey.get(videoAssetOf(record).key), fallback));
  const images = result.images?.map((image) => {
    const animated = image.fix.animated;
    if (animated === undefined) return image;
    const asset = animatedAssetOf(image, animated);
    const entry = asset === undefined ? undefined : results.byKey.get(asset.key);
    if (entry === undefined) {
      return fallback === undefined ? image : { ...image, fix: { ...image.fix, animated: { ...animated, notEncoded: fallback } } };
    }
    const next: AnimatedFix =
      entry.candidates.length > 0
        ? { ...animated, estimate: entry.candidates }
        : { ...animated, notEncoded: entry.notEncoded ?? "no passing quality" };
    return { ...image, fix: { ...image.fix, animated: next } };
  });
  const hasAssets = mediaAssetsOf(result).length > 0;
  return {
    ...result,
    ...(videos !== undefined ? { videos } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(results.note !== undefined && hasAssets ? { mediaNote: results.note } : {}),
  };
}
