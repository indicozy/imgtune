// The media phase of a scan: after every page is measured, the animated images and `<video>` files of all pages are
// ranked by their bytes, and the heaviest ones within the budget get their sample encodes (media-encode.ts). Each asset
// is encoded once per run (its key), an outcome is kept in the result cache, and every ffmpeg step is bounded by the
// asset's deadline. Nothing here throws: a failure becomes the asset's `notEncoded` reason, so a scan always finishes.
// Without ffmpeg the phase still runs its cheap part: every asset is marked "ffmpeg not found" with one note.

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mapLimit } from "./concurrency.js";
import { animationOf } from "./animated.js";
import { FFMPEG_JOBS, probeFfmpeg, probeMedia, type FfmpegCaps, type MediaProbe } from "./ffmpeg.js";
import { prepareMedia } from "./media-prepare.js";
import {
  cutSamples,
  hasRange,
  type ClipSource,
  isAbortError,
  MAX_INPUT_PIXELS_FFMPEG,
  searchQuality,
  type CandidateResult,
  type MediaCodec,
  type SearchOutcome,
} from "./media-encode.js";
import { attributeLevers, rankForBudget, snapWidth, withFileLength, type LeverSteps, type VideoBytes } from "./media-model.js";
import { makeScorer, type Scorer } from "./metric.js";
import { isThirdPartyBlocked, type ThirdPartyPolicy } from "./third-party.js";
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
/** Time allowed for the length probe (a Range request) of one video URL, in ms. */
export const LENGTH_TIMEOUT_MS = 10_000;
/** Video URLs probed at once for their length. */
export const LENGTH_CONCURRENCY = 8;
/** The notEncoded reason of an asset the third-party policy blocks on its page. */
export const THIRD_PARTY_BLOCKED = "third-party blocked";
/** Longest error text kept in a notEncoded reason. */
const MAX_ERROR_CHARS = 200;

/** One asset to encode: an animated image, or a `<video>` file of the page. */
export interface MediaAsset {
  /** Identity for dedupe and results: see mediaKeyOf. */
  key: string;
  url: string;
  /** The page the asset was found on: the third-party policy is applied to each asset from its page. */
  page: string;
  kind: "video" | "animated";
  /** Where the file is used: "video" for a `<video>`, else the animated image's own context. */
  context: "img" | "css-background" | "video";
  /** The snapped target widths that need an encode. */
  widths: number[];
  /** Bytes per page view and per play, as the cheap levers give them (used to rank the assets). */
  perView: number;
  perPlay: number;
  /** How perView was counted (a video's; see VideoBytes). Needed to refine it once the file length is known. */
  perViewBasis?: VideoBytes["perViewBasis"];
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
  /** Names the scorer in the cache identity: "cpu", or the GPU that scores the run. Defaults to "cpu". */
  scorerId?: string;
  /** The SSIMULACRA2 scorer. The CPU one when absent. */
  score?: Scorer;
  /** Aborts the phase (SIGINT, SIGTERM): a running ffmpeg is killed, and every unfinished asset says "aborted". */
  signal?: AbortSignal;
  /**
   * The most pixels one frame of an animated WebP may have (default MAX_INPUT_PIXELS_FFMPEG). Only a test lowers it, to show
   * that the limit applies per frame and not to the whole animation.
   */
  framePixelLimit?: number;
  /**
   * The third-party policy, checked on every redirect hop of a video's Range probe (see hasRange): a hop the policy refuses
   * is never requested, and the video is "third-party blocked".
   */
  thirdParty?: ThirdPartyPolicy;
}

/** The phase's outcome for one asset key. */
export interface MediaEntry {
  /** The probe of the file, when it was read. */
  probe?: MediaProbe;
  candidates: CandidateResult[];
  /** Why no candidate was encoded (a reason from media-encode.ts, or one of the phase's own). */
  notEncoded?: string;
  /** The jobs that did not pass, with their reasons: a video's target width reports its own reason, not a generic one. */
  failed?: { codec: MediaCodec; width: number; reason: string }[];
}

export interface MediaResults {
  byKey: Map<string, MediaEntry>;
  /**
   * The full file length of each video URL, from its Range probe (see probeLengths). Set whenever the probe ran, whatever
   * the ffmpeg, budget, quality or survey settings: a click-to-play video's per-play bytes come from here.
   */
  lengths?: Map<string, number>;
  /** A note for the whole run, such as the missing-ffmpeg note. */
  note?: string;
  /**
   * The assets the third-party policy blocked, by blockedKeyOf (their page and key). They were never fetched or read, and
   * their records say "third-party blocked".
   */
  blocked?: Set<string>;
}

/** The identity of an asset blocked on one page: the same file may be allowed on another page. */
export function blockedKeyOf(page: string, key: string): string {
  return `${page}\n${key}`;
}

/**
 * Splits the assets by the third-party policy, each checked from the page it was found on, as the browser route guard checks
 * a request. A blocked asset is never fetched, read or proxied: its blockedKeyOf goes into `blocked`. A video is a media
 * request and an animated image an image request, so the policy's kept types decide.
 */
export function partitionByPolicy(assets: MediaAsset[], policy: ThirdPartyPolicy): { allowed: MediaAsset[]; blocked: Set<string> } {
  const blocked = new Set<string>();
  const allowed: MediaAsset[] = [];
  for (const asset of assets) {
    const facts = { pageUrl: asset.page, requestUrl: asset.url, resourceType: asset.kind === "video" ? "media" : "image", subFrame: false };
    if (isThirdPartyBlocked(policy, facts)) blocked.add(blockedKeyOf(asset.page, asset.key));
    else allowed.push(asset);
  }
  return { allowed, blocked };
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
    page: record.page,
    kind: "video",
    context: "video",
    widths,
    perView: record.bytes.perView,
    perPlay: record.bytes.perPlay,
    perViewBasis: record.bytes.perViewBasis,
  };
}

/** The redirect-hop check of a video's page: the third-party policy as the browser's route guard applies it. */
export function hopCheckOf(page: string, policy: ThirdPartyPolicy | undefined): ((hop: string) => boolean) | undefined {
  if (policy === undefined) return undefined;
  return (hop) => !isThirdPartyBlocked(policy, { pageUrl: page, requestUrl: hop, resourceType: "media", subFrame: false });
}

/**
 * The full file length of each URL, from its Range probe (hasRange: a HEAD and a `bytes=0-0` GET through the proxy). Runs
 * for every unique URL, LENGTH_CONCURRENCY at a time, each with LENGTH_TIMEOUT_MS. A URL is probed from the page it was
 * first found on, so its redirect hops are checked against that page's policy. A URL with no length is left out. Never
 * throws: a failed probe is just no length.
 */
export async function probeLengths(
  targets: readonly { url: string; page: string }[],
  proxy: string,
  options: { probe?: typeof hasRange; thirdParty?: ThirdPartyPolicy } = {},
): Promise<Map<string, number>> {
  const lengths = new Map<string, number>();
  const firstPage = new Map<string, string>();
  for (const target of targets) if (!firstPage.has(target.url)) firstPage.set(target.url, target.page);
  const probe = options.probe ?? hasRange;
  await mapLimit([...firstPage], LENGTH_CONCURRENCY, async ([url, page]) => {
    try {
      const info = await probe(url, LENGTH_TIMEOUT_MS, proxy, hopCheckOf(page, options.thirdParty));
      if (info.length !== undefined && info.length > 0) lengths.set(url, info.length);
    } catch {
      // No length: the record keeps its observed bytes.
    }
  });
  return lengths;
}

/**
 * The asset with its per-view and per-play bytes refined by the file length (see withFileLength), so the budget ranks a
 * click-to-play video by its full file. An asset without a length is returned as it is.
 */
export function refineAssetLength(asset: MediaAsset, length: number | undefined): MediaAsset {
  if (length === undefined || asset.kind !== "video") return asset;
  const bytes = withFileLength(
    { perView: asset.perView, perPlay: asset.perPlay, perViewBasis: asset.perViewBasis ?? "observed", browserDependent: false },
    length,
  );
  return { ...asset, perView: bytes.perView, perPlay: bytes.perPlay };
}

/** The device width an animated image needs: the largest any viewport needs (0 when none is known). */
export function animatedNeedOf(record: ImageRecord): number {
  const needs = record.perViewport.map((p) => p.neededPx).filter((n) => n > 0);
  return needs.length === 0 ? 0 : Math.max(...needs);
}

/**
 * The asset of an animated image record, or undefined when the record has no URL or no needed width. The one width is the
 * largest device width any viewport needs, snapped to a bucket, never above the file's own width.
 */
export function animatedAssetOf(record: ImageRecord, fix: AnimatedFix): MediaAsset | undefined {
  const url = record.current.src;
  if (url === undefined) return undefined;
  const need = animatedNeedOf(record);
  if (need === 0) return undefined;
  const widths = [snapWidth(need, record.current.naturalWidth ?? need)];
  return {
    key: mediaKeyOf("animated", fix.context, url, widths),
    url,
    page: record.page,
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
 * that width. The widest (the target, whose AV1 is the main hint) goes first, so it is not the job the asset's time limit
 * cuts off.
 */
function videoJobs(widths: readonly number[], probe: MediaProbe): Job[] {
  const jobs: Job[] = [];
  for (const width of [...widths].sort((a, b) => b - a)) {
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
  for (const width of [...widths].sort((a, b) => b - a)) {
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
  const failed: { codec: MediaCodec; width: number; reason: string }[] = [];
  let samples: Promise<string[]> | undefined;
  for (const job of jobs) {
    const cacheKey = `media|${identity}|${job.codec}|w${job.width}|v${opts.vmafBar}|s${opts.stillBar}|scorer ${opts.scorerId ?? "cpu"}|imgtune ${IMGTUNE_VERSION}|cache ${CACHE_VERSION}`;
    const cached = await opts.cache?.getJson<unknown>(cacheKey);
    let outcome: SearchOutcome;
    if (isCachedOutcome(cached)) {
      outcome = cached.ok ? { ok: true, best: cached.best, tried: 0 } : { ok: false, reason: "no-passing-quality" };
    } else {
      if (opts.signal?.aborted) return { probe, candidates, notEncoded: "aborted" };
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
        signal: opts.signal,
      });
      if (outcome.ok) await opts.cache?.putJson(cacheKey, { ok: true, best: outcome.best } satisfies CachedOutcome);
      else if (outcome.reason === "no-passing-quality") await opts.cache?.putJson(cacheKey, { ok: false, reason: "no-passing-quality" } satisfies CachedOutcome);
    }
    if (outcome.ok) candidates.push(outcome.best);
    else {
      reasons.push(outcome.reason);
      failed.push({ codec: job.codec, width: job.width, reason: outcome.reason });
    }
  }
  if (candidates.length > 0) return { probe, candidates, failed };
  if (jobs.length === 0) return { probe, candidates, notEncoded: "no width to encode" };
  return { probe, candidates, notEncoded: reasons[0], failed };
}

/**
 * The sample encodes of one file: its probe, then the jobs `jobsOf` gives for it. `input` is an absolute path or a URL
 * (read through `proxy`). A file that cannot be probed is a read error.
 */
async function encodeFile(
  input: ClipSource,
  identity: string,
  jobsOf: (probe: MediaProbe) => Job[],
  env: Env,
  deadline: number,
  dir: string,
  proxy: string | undefined,
  readError: string,
  known?: MediaProbe,
): Promise<MediaEntry> {
  // A file is probed here; a WebP source always comes with its probe (see prepareMedia).
  const probe = known ?? (await env.probe(input as string, PROBE_TIMEOUT_MS, { proxy }));
  if (probe === undefined) return { candidates: [], notEncoded: readError };
  // A frame over the pixel limit is refused before any sample is cut or encoded (see MAX_INPUT_PIXELS_FFMPEG).
  if (probe.width * probe.height > MAX_INPUT_PIXELS_FFMPEG) return { probe, candidates: [], notEncoded: "too-large" };
  return runJobs(jobsOf(probe), identity, probe, () => env.cut(input, probe, dir, deadline, proxy, env.opts.signal), dir, deadline, env, readError);
}

/** The notEncoded reason of a failure while preparing a file: too large to score, aborted, or the read error. */
function prepareReasonOf(err: unknown, readError: string): string {
  if (isAbortError(err)) return "aborted";
  if (err instanceof Error && err.message.startsWith("too large to score")) return "too-large";
  return readError;
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
  const range = await env.hasRange(asset.url, RANGE_TIMEOUT_MS, proxy, hopCheckOf(asset.page, env.opts.thirdParty));
  if (range.blocked) return { candidates: [], notEncoded: THIRD_PARTY_BLOCKED };
  const length = range.length;
  // ffmpeg reads the URL after its redirects, so it does not follow a chain the policy has already checked. The residual
  // risk (a later, different redirect that ffmpeg follows by itself) is accepted: the egress proxy still blocks private
  // addresses at connect time, and a third-party hop is never reached by the probe above.
  const input = range.url ?? asset.url;
  if (!range.range && (length ?? 0) > NO_RANGE_MAX_BYTES) {
    return { candidates: [], notEncoded: "server has no Range support" };
  }
  const dir = join(resolve(env.opts.workDir), digest(asset.key));
  const jobsOf = (probe: MediaProbe): Job[] => videoJobs(asset.widths, probe);
  if (!range.range) {
    const buffer = env.fetch ? await env.fetch(asset.url, NO_RANGE_MAX_BYTES) : undefined;
    if (buffer === undefined) return { candidates: [], notEncoded: "could not read the video" };
    const file = await writeSource(dir, buffer);
    return encodeFile(file, `${asset.url}|${contentHash(buffer)}`, jobsOf, env, deadline, dir, undefined, "could not read the video");
  }
  const identity = videoIdentityOf(asset.url, { etag: range.etag, lastModified: range.lastModified, length });
  return encodeFile(input, identity, jobsOf, env, deadline, dir, proxy, "could not read the video");
}

/**
 * The identity of a video's cached results: its URL, its validator (the ETag, else the Last-Modified date) and its length from
 * the Range probe. A changed file at the same URL changes the validator or the length, so it misses the cache. The asset key
 * (mediaKeyOf) cannot carry them: they are known only after the probe, which runs after the key is made.
 */
export function videoIdentityOf(url: string, range: { etag?: string; lastModified?: string; length?: number }): string {
  return `${url}|${range.etag ?? range.lastModified ?? ""}|${range.length ?? ""}`;
}

/** An animated image: its bytes, written to the work folder so ffmpeg reads a local file, then its sample encodes. */
async function encodeAnimated(asset: MediaAsset, env: Env, deadline: number): Promise<MediaEntry> {
  const readError = "could not read the image";
  const buffer = asset.buffer ?? (env.fetch ? await env.fetch(asset.url) : undefined);
  if (buffer === undefined) return { candidates: [], notEncoded: readError };
  const dir = join(resolve(env.opts.workDir), digest(asset.key));
  const jobsOf = (): Job[] => animatedJobs(asset.widths, asset.context);
  const identity = `${asset.url}|${contentHash(buffer)}`;
  if (animationOf(buffer)?.format === "webp") {
    // ffmpeg cannot read an animated WebP: it is decoded once into an FFV1 file (the samples are cut from that), and the
    // probe of that file is known. Refused before any decode when it is too large to score.
    let prepared: Awaited<ReturnType<typeof prepareMedia>>;
    try {
      prepared = await prepareMedia(join(dir, "source.webp"), buffer, join(dir, "prepared"), env.opts.framePixelLimit, env.opts.signal);
    } catch (err) {
      return { candidates: [], notEncoded: prepareReasonOf(err, readError) };
    }
    return encodeFile(prepared.source, identity, jobsOf, env, deadline, dir, undefined, readError, prepared.probe);
  }
  const file = await writeSource(dir, buffer);
  return encodeFile(file, identity, jobsOf, env, deadline, dir, undefined, readError);
}

/** One asset's entry. A passed deadline is a time limit, checked before any work. */
async function encodeOne(asset: MediaAsset, env: Env, deadline: number): Promise<MediaEntry> {
  if (env.opts.signal?.aborted) return { candidates: [], notEncoded: "aborted" };
  if (Date.now() >= deadline) return { candidates: [], notEncoded: "time-limit" };
  try {
    return asset.kind === "video" ? await encodeVideo(asset, env, deadline) : await encodeAnimated(asset, env, deadline);
  } catch (err) {
    if (isAbortError(err)) return { candidates: [], notEncoded: "aborted" };
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
      return finish(byKey, started, opts, undefined, unique);
    }
    if (!caps.ffmpeg) {
      for (const asset of unique) byKey.set(asset.key, { candidates: [], notEncoded: "ffmpeg not found" });
      opts.log(`media: ffmpeg not found; ${MEDIA_NOTE}`);
      return finish(byKey, started, opts, MEDIA_NOTE, unique);
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
    return finish(byKey, started, opts, undefined, unique);
  } catch (err) {
    // Unexpected: every asset gets the reason, and the scan goes on.
    const reason = `media error: ${errorText(err)}`;
    for (const asset of assets) if (!byKey.has(asset.key)) byKey.set(asset.key, { candidates: [], notEncoded: reason });
    return { byKey };
  }
}

/**
 * True when the entry has a candidate at the asset's target width, the largest of its widths: the width a video's estimate
 * is taken at (attachVideo) and an animated image's single width. An encode at a smaller width alone is not an estimate.
 */
export function hasTargetEstimate(entry: MediaEntry, asset: MediaAsset): boolean {
  const target = Math.max(0, ...asset.widths);
  return entry.candidates.some((c) => c.width === target);
}

/** The phase's closing log line, and its results. An asset counts as encoded only with an estimate at its target width. */
function finish(byKey: Map<string, MediaEntry>, started: number, opts: MediaOptions, note: string | undefined, assets: MediaAsset[]): MediaResults {
  const byAsset = new Map(assets.map((a) => [a.key, a]));
  let encoded = 0;
  let notEncoded = 0;
  for (const [key, entry] of byKey) {
    const asset = byAsset.get(key);
    if (asset !== undefined && hasTargetEstimate(entry, asset)) encoded++;
    else notEncoded++;
  }
  opts.log(`media: done in ${((Date.now() - started) / 1000).toFixed(1)} s, ${encoded} encoded, ${notEncoded} not encoded`);
  return note === undefined ? { byKey } : { byKey, note };
}

/**
 * The steps of the lever chain for a video, from its full bytes: audio, then resolution, then the re-encode (see
 * attributeLevers). The search returns only the best passing quality, so the quality stage is zero by design and the codec
 * stage carries the whole re-encode (codec and quality together). Task 8 labels that step "re-encode". The resolution stage
 * is the no-audio bytes scaled by the pixel ratio (an estimate), clamped into [final, no-audio]; the steps then sum to
 * start − final exactly. An encode larger than the no-audio bytes has no lever (a negative saving), so no steps are given.
 */
function stepsOf(record: VideoRecord, estimate: CandidateResult, target: number, probe: MediaProbe | undefined): LeverSteps | undefined {
  const start = record.bytes.perPlay;
  const audio = record.levers.audio?.bytes ?? 0;
  const noAudio = start - audio;
  const final = estimate.bytes;
  const source = probe?.width ?? target;
  if (!(source > 0) || final > noAudio) return undefined;
  const scaled = Math.round(noAudio * (target / source) ** 2);
  const resized = Math.min(noAudio, Math.max(final, scaled));
  return attributeLevers({ start, noAudio, resized, recoded: final, final });
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

/** The bytes of a video refined by the server's length, when the record did not know the full size. */
export function refineBytes(bytes: VideoRecord["bytes"], length: number | undefined): VideoRecord["bytes"] {
  if (bytes.fullBytesKnown || length === undefined) return bytes;
  return { ...withFileLength(bytes, length), fullBytesKnown: true };
}

/** One video record with its entry: the probe, the audio lever, the estimate and its steps, or the reason it has none. */
function attachVideo(record: VideoRecord, entry: MediaEntry | undefined, fallback: string | undefined): VideoRecord {
  if (entry === undefined) return fallback === undefined ? record : { ...record, notEncoded: fallback };
  const levers = { ...record.levers };
  const audio = audioBytesOf(record, entry.probe);
  if (audio !== undefined) levers.audio = { bytes: audio };
  // Frame rate is informational, never in the claim (CLAUDE.md): a faster source costs more bytes, so a lower rate is a lever.
  if (entry.probe !== undefined && entry.probe.fps > 30) {
    levers.info = [...levers.info, `${entry.probe.fps} fps: a lower frame rate would save bytes too (not measured)`];
  }
  const out: VideoRecord = {
    ...record,
    levers,
    ...(entry.probe !== undefined ? { probe: entry.probe } : {}),
  };
  const target = Math.max(0, ...(record.widths?.widths ?? []));
  const atTarget = entry.candidates.filter((c) => c.width === target);
  // AV1 is the main hint; the H.264 fallback is the estimate only when no AV1 encode passed at the target width.
  const estimate = smallest(atTarget.filter((c) => c.codec === "av1-mp4")) ?? smallest(atTarget);
  if (estimate === undefined) {
    // The target's own failure says why (a time limit, or no quality that passed); the generic reason is the last resort.
    const atTargetFailure = entry.failed?.find((f) => f.width === target)?.reason;
    out.notEncoded = entry.notEncoded ?? atTargetFailure ?? "no passing quality";
    return out;
  }
  out.estimate = estimate;
  const steps = stepsOf(out, estimate, target, entry.probe);
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
  const isBlocked = (page: string, key: string): boolean => results.blocked?.has(blockedKeyOf(page, key)) === true;
  const videos = result.videos?.map((record) => {
    const key = videoAssetOf(record).key;
    if (isBlocked(record.page, key)) return { ...record, notEncoded: THIRD_PARTY_BLOCKED };
    const sized = { ...record, bytes: refineBytes(record.bytes, results.lengths?.get(record.src)) };
    return attachVideo(sized, results.byKey.get(key), fallback);
  });
  const images = result.images?.map((image) => {
    const animated = image.fix.animated;
    if (animated === undefined) return image;
    const asset = animatedAssetOf(image, animated);
    if (asset !== undefined && isBlocked(image.page, asset.key)) {
      return { ...image, fix: { ...image.fix, animated: { ...animated, notEncoded: THIRD_PARTY_BLOCKED } } };
    }
    const entry = asset === undefined ? undefined : results.byKey.get(asset.key);
    if (entry === undefined) {
      return fallback === undefined ? image : { ...image, fix: { ...image.fix, animated: { ...animated, notEncoded: fallback } } };
    }
    // The need and the file's width travel with the estimate, so a hint can say when the width was capped at the file's own.
    const sizing = { need: animatedNeedOf(image), ...(image.current.naturalWidth !== undefined ? { sourceWidth: image.current.naturalWidth } : {}) };
    const next: AnimatedFix =
      entry.candidates.length > 0
        ? { ...animated, estimate: entry.candidates, ...sizing }
        : { ...animated, notEncoded: entry.notEncoded ?? "no passing quality", ...sizing };
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
