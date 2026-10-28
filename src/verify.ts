import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { makeFetchOriginal, measureUsages, profileOf, progress, restoreAndReport, unique, type Log } from "./audit.js";
import { sha1 } from "./atomic.js";
import { encode, loadReference } from "./encode.js";
import { readImageConfig } from "./nextconfig.js";
import type { ImageObservation } from "./measure.js";
import { originalFor } from "./loaders.js";
import { installRestoreHandlers } from "./instrument.js";
import { assertMetricAvailable, formatScore, makeScorer, metricLabel, type Metric, type Scorer } from "./metric.js";
import { readReport } from "./report.js";
import { listSourceFiles, scanFile } from "./scan.js";
import { loadState, saveState, type Format, type StateEntry } from "./state.js";
import { ssim, type RawImage } from "./ssim.js";
import type { ImageUsage, ImgtuneConfig } from "./types.js";

const FORMATS: Format[] = ["avif", "webp"];

/** Share of usable samples per format that must reach the threshold, as integer percent. */
const PASS_PERCENT = 95;
const VARIANT_TIMEOUT_MS = 30_000;
const ACCEPT: Record<Format, string> = {
  avif: "image/avif,*/*",
  webp: "image/webp,*/*",
};
/** Viewport listed first in the table, the audit's reference viewport. */
const REFERENCE_VIEWPORT = "iphone-15";

/** One scored served variant. `ssim` undefined means the sample could not be used (not a failure). */
export interface VerifySample {
  format: Format;
  ssim?: number;
  /** The bar this sample had to reach (R38). Absent: the absolute threshold applies. */
  minScore?: number;
  /** cdn rule: local quality drop in points from the before-quality to the applied one (0 for a sizes-only change). */
  drop?: number;
  /** cdn rule, sizes-only: the served file is narrower than 90% of what the render needs. */
  undersized?: { file: number; needed: number };
}

export interface FormatCounts {
  /** Samples that could be scored. */
  usable: number;
  /** Usable samples at or above the threshold. */
  passing: number;
}

export interface Judgement {
  status: "verified" | "regressed" | "unmeasured";
  /** Set when `status` is unmeasured, and for a regression by an undersized served file. */
  reason?: string;
  /** Median SSIM of the usable samples per judged format. */
  ssim: { avif?: number; webp?: number };
  /** Median bar of the usable samples per judged format (R38): what the score is shown against as "min". */
  minScore?: { avif?: number; webp?: number };
  /** Median local quality drop per judged format (cdn rule), shown as "drop" in place of "min". */
  drop?: { avif?: number; webp?: number };
  /** Usable and passing counts per judged format. */
  counts: { avif?: FormatCounts; webp?: FormatCounts };
  /** Set for a regression when a quality raise can help: applied quality + tolerance, capped at the pre-apply quality. */
  raiseTo?: number;
}

export interface VerifyRow {
  usageId: string;
  component: string;
  relFile: string;
  line: number;
  /** Median observed bytes per viewport name (default pass). */
  bytes: Record<string, number>;
  /** Audit-time median bytes per viewport, when the usage is in the audit report. */
  beforeBytes?: Record<string, number>;
  judgement: Judgement;
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The quality to ask for after a regression, or undefined when no raise can help. */
function raiseTarget(
  applied: { quality?: number },
  before: { quality?: number } | undefined,
  tolerance: number,
): number | undefined {
  if (applied.quality === undefined) return undefined;
  const cap = before?.quality ?? 100;
  const target = Math.min(cap, applied.quality + tolerance);
  return target > applied.quality ? target : undefined;
}

/** Fewest usable samples a served format needs before it can be judged. */
export const MIN_USABLE_SAMPLES = 5;

export interface JudgeInput {
  samples: VerifySample[];
  /** Formats the page actually served for this usage (from the observed content-types). */
  served: Format[];
  /** Samples taken per format (`samplesPerComponent`); the minimum is the lesser of this and MIN_USABLE_SAMPLES. */
  samplesPerComponent: number;
  threshold: number;
  tolerance: number;
  /** The cdn rule's allowed quality drop (`delta`); set only when the drop check applies. */
  maxDrop?: number;
  applied: { sizes?: string; quality?: number };
  before: { sizes?: string; quality?: number } | undefined;
}

/**
 * Decides an applied usage from its scored samples. Every format the page served for the usage is judged, and each
 * needs at least min(MIN_USABLE_SAMPLES, samplesPerComponent) usable samples, else the usage is unmeasured. It is
 * verified when every judged format has at least 95% of its usable samples at or above `threshold`, otherwise
 * regressed. Unusable samples never count against a format.
 */
export function judgeVerification(input: JudgeInput): Judgement {
  const { samples, served, threshold } = input;
  const minimum = Math.max(1, Math.min(MIN_USABLE_SAMPLES, input.samplesPerComponent));
  const formats = FORMATS.filter((format) => served.includes(format));
  const judgement: Judgement = { status: "verified", ssim: {}, counts: {} };
  if (formats.length === 0) return { ...judgement, status: "unmeasured", reason: "no avif or webp image served" };

  let failed = false;
  let undersized: string | undefined;
  const dropOk = (s: VerifySample): boolean => s.drop === undefined || input.maxDrop === undefined || s.drop <= input.maxDrop;
  for (const format of formats) {
    const usable = samples.filter((s): s is VerifySample & { ssim: number } => s.format === format && s.ssim !== undefined);
    if (usable.length < minimum) {
      return {
        ...judgement,
        status: "unmeasured",
        reason: `insufficient ${format} samples: ${usable.length}`,
      };
    }
    const bars = usable.map((s) => s.minScore ?? threshold);
    const passing = usable.filter((s, i) => s.ssim >= bars[i] && dropOk(s)).length;
    judgement.counts[format] = { usable: usable.length, passing };
    judgement.ssim[format] = median(usable.map((s) => s.ssim));
    // The cdn rule judges by drop against the floor, so no bar is shown or stored for it.
    if (input.maxDrop === undefined) (judgement.minScore ??= {})[format] = median(bars);
    const drops = usable.flatMap((s) => (s.drop === undefined ? [] : [s.drop]));
    if (drops.length > 0) {
      judgement.drop ??= {};
      judgement.drop[format] = median(drops);
    }
    const small = usable.find((s) => s.undersized !== undefined)?.undersized;
    if (small && undersized === undefined) undersized = `undersized: ${small.file}px for ${small.needed}px`;
    if (passing * 100 < PASS_PERCENT * usable.length) failed = true;
  }
  // A served file too small for its render is a regression whatever the score says.
  if (undersized !== undefined) return { ...judgement, status: "regressed", reason: undersized };
  if (!failed) return judgement;
  return {
    ...judgement,
    status: "regressed",
    raiseTo: raiseTarget(input.applied, input.before, input.tolerance),
  };
}

/** The format a served image is in, from its response content-type. */
export function formatOfContentType(contentType: string | undefined): Format | undefined {
  const type = (contentType ?? "").toLowerCase();
  if (type.startsWith("image/avif")) return "avif";
  if (type.startsWith("image/webp")) return "webp";
  return undefined;
}

/** Up to `limit` observations of `format` with distinct served URLs, in observation order. */
export function sampleVariants(observations: ImageObservation[], format: Format, limit: number): ImageObservation[] {
  const seen = new Set<string>();
  const picked: ImageObservation[] = [];
  for (const obs of observations) {
    if (picked.length >= limit) break;
    if (obs.renderedWidth < 1 || !obs.currentSrc) continue;
    if (formatOfContentType(obs.contentType) !== format) continue;
    if (seen.has(obs.currentSrc)) continue;
    seen.add(obs.currentSrc);
    picked.push(obs);
  }
  return picked;
}

/** A scored variant: its SSIM and the decoded pixel width it was scored at. */
export type VariantScore = { ssim: number; width: number } | { unusable: string };

export interface VariantDeps {
  fetchImpl?: typeof fetch;
  fetchOriginal: (url: string) => Promise<Buffer>;
  /** Scores the served variant against its reference; production passes the configured metric. */
  score?: Scorer;
}

/**
 * Downloads the served variant the browser loaded (same URL, Accept for the format), checks its content-type, decodes it,
 * and scores it against the original downscaled to the served width. Anything that stops the check from being a
 * measurement is reported as unusable, never thrown.
 */
export async function scoreVariant(obs: ImageObservation, format: Format, baseUrl: string, deps: VariantDeps): Promise<VariantScore> {
  if (!obs.originalSrc) return { unusable: "no data-imgtune-src on the image" };
  const fetchImpl = deps.fetchImpl ?? fetch;

  let body: Buffer;
  try {
    const res = await fetchImpl(obs.currentSrc, {
      headers: { Accept: ACCEPT[format] },
      signal: AbortSignal.timeout(VARIANT_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { unusable: `HTTP ${res.status}` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (formatOfContentType(contentType) !== format) {
      await res.body?.cancel().catch(() => undefined);
      return { unusable: `content-type ${contentType || "(none)"}` };
    }
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { unusable: `fetch failed: ${(err as Error).message}` };
  }

  let served: RawImage;
  try {
    const raw = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    served = { data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), width: raw.info.width, height: raw.info.height };
  } catch (err) {
    return { unusable: `decode failed: ${(err as Error).message}` };
  }

  let original: Buffer;
  try {
    original = await deps.fetchOriginal(originalFor(obs.currentSrc, obs.originalSrc, baseUrl));
  } catch (err) {
    return { unusable: `original: ${(err as Error).message}` };
  }
  let reference: RawImage;
  try {
    reference = await loadReference(original, served.width);
  } catch (err) {
    return { unusable: `original decode failed: ${(err as Error).message}` };
  }
  // The decoded width is what the server served; a resize below only aligns the pixels for scoring.
  const decodedWidth = served.width;
  if (reference.width !== served.width || reference.height !== served.height) {
    // Rounding can differ by a pixel between the server's resize and ours; compare at the reference size.
    const resized = await sharp(Buffer.from(served.data.buffer, served.data.byteOffset, served.data.byteLength), {
      raw: { width: served.width, height: served.height, channels: 4 },
    })
      .resize(reference.width, reference.height, { kernel: "lanczos3", fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    served = { data: new Uint8ClampedArray(resized.data.buffer, resized.data.byteOffset, resized.data.byteLength), width: reference.width, height: reference.height };
  }
  const score = deps.score ?? ssim;
  return { ssim: await score(reference, served), width: decodedWidth };
}

/** Median bytes per viewport over the default-pass observations that have a byte count. */
export function bytesByViewport(observations: ImageObservation[]): Record<string, number> {
  const byName = new Map<string, number[]>();
  for (const obs of observations) {
    if (obs.accept !== "default" || obs.bytes === undefined) continue;
    const list = byName.get(obs.viewport) ?? [];
    list.push(obs.bytes);
    byName.set(obs.viewport, list);
  }
  const out: Record<string, number> = {};
  for (const [name, values] of byName) out[name] = median(values) ?? 0;
  return out;
}

/** Applied entries whose file still has the hash recorded at apply time, paired with their scanned usage. */
export function selectApplied(
  entries: StateEntry[],
  currentHash: (relFile: string) => string | undefined,
  usageOf: (entry: StateEntry) => ImageUsage | undefined,
): { entry: StateEntry; usage: ImageUsage }[] {
  const out: { entry: StateEntry; usage: ImageUsage }[] = [];
  for (const entry of entries) {
    if (entry.applied.sizes === undefined && entry.applied.quality === undefined) continue;
    if (currentHash(entry.relFile) !== entry.fileHash) continue;
    const usage = usageOf(entry);
    if (usage) out.push({ entry, usage });
  }
  return out;
}

const fmtBytes = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
/** A score, with its bar after "min" when the usage has one. */
const fmtScore = (metric: Metric, value: number | undefined, min?: number, drop?: number): string => {
  if (value === undefined) return "-";
  if (drop !== undefined) return `${formatScore(metric, value)} drop ${formatScore(metric, drop)}`;
  return min === undefined ? formatScore(metric, value) : `${formatScore(metric, value)} min ${formatScore(metric, min)}`;
};

function statusOf(judgement: Judgement): string {
  let status: string;
  if (judgement.status === "unmeasured") status = `not measured (${judgement.reason})`;
  else if (judgement.status === "verified") status = "verified";
  else if (judgement.reason !== undefined) status = `regressed (${judgement.reason})`;
  else status = judgement.raiseTo === undefined ? "regressed" : `regressed (raise quality to ${judgement.raiseTo})`;
  // The 95% rule decides the verdict, so the table shows the passing counts behind it.
  const counts = FORMATS.flatMap((format) => {
    const count = judgement.counts[format];
    return count ? [`${format} ${count.passing}/${count.usable}`] : [];
  });
  return counts.length === 0 ? status : `${status} (passing ${counts.join(", ")})`;
}

/** Bytes per viewport as "name KB, name KB", the reference viewport first; "-" when there are none. */
function byViewport(bytes: Record<string, number> | undefined): string {
  const names = Object.keys(bytes ?? {}).sort((a, b) => (a === REFERENCE_VIEWPORT ? -1 : b === REFERENCE_VIEWPORT ? 1 : 0));
  return names.map((name) => `${name} ${fmtBytes((bytes as Record<string, number>)[name])}`).join(", ") || "-";
}

/**
 * Aligned text table: component, location, bytes per viewport before and now, the metric's score per format, status.
 */
export function renderVerifyTable(rows: VerifyRow[], metric: Metric): string {
  const label = metricLabel(metric);
  const header = ["component", "location", "bytes before", "bytes now", `${label} avif`, `${label} webp`, "status"];
  const body = rows.map((row) => {
    return [
      row.component,
      `${row.relFile}:${row.line}`,
      byViewport(row.beforeBytes),
      byViewport(row.bytes),
      fmtScore(metric, row.judgement.ssim.avif, row.judgement.minScore?.avif, row.judgement.drop?.avif),
      fmtScore(metric, row.judgement.ssim.webp, row.judgement.minScore?.webp, row.judgement.drop?.webp),
      statusOf(row.judgement),
    ];
  });
  const table = [header, ...body];
  const widths = header.map((_, col) => Math.max(...table.map((cells) => cells[col].length)));
  return table.map((cells) => cells.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd()).join("\n");
}

export interface VerifyOptions {
  log?: Log;
  fetchImpl?: typeof fetch;
  /** Replaces the browser measurement (tests). Production starts a server and measures the pages. */
  measure?: typeof measureUsages;
  /** Replaces the download of an original (tests). Production fetches it from the project's server. */
  fetchOriginal?: (url: string) => Promise<Buffer>;
  /** Replaces the scorer (tests). Production scores with the configured metric. */
  score?: Scorer;
}

/**
 * The bar of one served variant, recomputed as the audit did (R38): max(floor, current - delta), where current is the
 * before-quality encoded locally at `width`, the variant's decoded served width. Throws when it cannot be computed:
 * the caller then makes the sample unusable (R41). Used by the next-default profile only.
 */
export async function recomputeBar(
  obs: ImageObservation,
  format: Format,
  beforeQuality: number,
  rule: { threshold: number; delta: number },
  baseUrl: string,
  deps: { fetchOriginal: (url: string) => Promise<Buffer>; score: Scorer },
  width: number,
): Promise<number> {
  if (!obs.originalSrc) throw new Error("no data-imgtune-src on the image");
  if (width < 1) throw new Error(`no served width (${width})`);
  const reference = await loadReference(await deps.fetchOriginal(originalFor(obs.currentSrc, obs.originalSrc, baseUrl)), width);
  const enc = await encode(reference, format, beforeQuality, "next-default");
  return Math.max(rule.threshold, (await deps.score(reference, enc.decoded)) - rule.delta);
}

/** The cdn rule's local stand-in quality for a CDN quality, on the scale the audit calibrated. */
const localQuality = (cdnQuality: number, offset: number): number => Math.min(100, Math.max(1, cdnQuality - offset));

/**
 * The cdn rule's quality drop of one served sample (R38, relative): the local score at the before-quality minus the
 * local score at the applied one, both encoded at the served width on the audit's calibrated scale. The CDN's own
 * encoder bias cancels out of the difference. A sizes-only change (same quality) has no drop by definition; without a
 * calibration offset the drop is undefined and not judged.
 */
export async function cdnDrop(
  original: Buffer,
  format: Format,
  width: number,
  quality: { before: number; now: number; offset?: number },
  score: Scorer,
): Promise<number | undefined> {
  if (quality.now === quality.before) return 0;
  const { offset } = quality;
  if (offset === undefined) return undefined;
  const reference = await loadReference(original, width);
  const scoreAt = async (cdnQuality: number): Promise<number> => {
    const enc = await encode(reference, format, localQuality(cdnQuality, offset), "cdn");
    return score(reference, enc.decoded);
  };
  return (await scoreAt(quality.before)) - (await scoreAt(quality.now));
}

/**
 * The sizes-only resolution check (cdn rule): the served file must be at least 90% of the smaller of what the render
 * needs (rendered width x dpr) and the original's own width. Returns the sizes when it fails.
 */
export async function undersizedFile(
  original: Buffer,
  obs: ImageObservation,
  servedWidth: number,
): Promise<{ file: number; needed: number } | undefined> {
  const originalWidth = (await sharp(original).metadata()).width ?? 0;
  const needed = Math.min(Math.ceil(obs.renderedWidth * obs.dpr), originalWidth);
  return servedWidth < 0.9 * needed ? { file: servedWidth, needed } : undefined;
}

/** What `judgeSample` needs about one scored served variant and its usage. */
export interface SampleInput {
  obs: ImageObservation;
  format: Format;
  /** SSIM and decoded width from `scoreVariant`. */
  scored: { ssim: number; width: number };
  /** Quality before the apply, and as applied (absent for a sizes-only change). */
  before?: number;
  applied?: number;
  /** The audit's CDN-to-local offset for this format (cdn profile). */
  offset?: number;
  profile: "next-default" | "cdn";
  /** The R38 relative rule's delta; absent for an absolute bar. */
  delta?: number;
  threshold: number;
  baseUrl: string;
}

export type SampleVerdict = { sample: VerifySample } | { unusable: string };

/**
 * The verdict input for one scored served variant (R38, R41). Without `delta` the sample is judged against the absolute
 * threshold. With it, next-default needs its recomputed bar and cdn needs its local drop; a sample whose bar or drop
 * cannot be computed is unusable, with the reason, and never passes on the floor alone.
 */
export async function judgeSample(
  input: SampleInput,
  deps: { fetchOriginal: (url: string) => Promise<Buffer>; score: Scorer },
): Promise<SampleVerdict> {
  const { obs, format, scored } = input;
  if (input.delta === undefined) return { sample: { format, ssim: scored.ssim } };
  if (input.profile === "next-default") {
    if (input.before === undefined) return { unusable: "bar not computable: no before quality recorded" };
    try {
      const minScore = await recomputeBar(obs, format, input.before, { threshold: input.threshold, delta: input.delta }, input.baseUrl, deps, scored.width);
      return { sample: { format, ssim: scored.ssim, minScore } };
    } catch (err) {
      return { unusable: `bar not computable: ${(err as Error).message}` };
    }
  }
  // cdn rule (R38): judged by the local quality drop, not by a bar. A sizes-only change has no quality to drop by, so it
  // needs no before quality either; only a quality change does.
  const { before, applied } = input;
  if (applied !== undefined && applied !== before && before === undefined) {
    return { unusable: "drop not computable: no before quality recorded" };
  }
  const qualityChanged = before !== undefined && applied !== undefined && applied !== before;
  try {
    const original = await deps.fetchOriginal(originalFor(obs.currentSrc, obs.originalSrc as string, input.baseUrl));
    // A quality change needs the calibration to map it to the local scale; a sizes-only change has no drop to map.
    const drop = qualityChanged
      ? await cdnDrop(original, format, scored.width, { before, now: applied, offset: input.offset }, deps.score)
      : 0;
    if (drop === undefined) return { unusable: `drop not computable: no calibration offset for ${format}` };
    const undersized = qualityChanged ? undefined : await undersizedFile(original, obs, scored.width);
    return { sample: { format, ssim: scored.ssim, drop, undersized } };
  } catch (err) {
    return { unusable: `local rescore failed: ${(err as Error).message}` };
  }
}

/**
 * The CDN-to-local quality offset of a format for one usage: the one the apply recorded in its state entry, else the one
 * the audit report holds (for state written before the offset was recorded).
 */
export function offsetFor(
  entry: StateEntry,
  reportOffsets: Partial<Record<Format, number>> | undefined,
  format: Format,
): number | undefined {
  return entry.calibration?.[format] ?? reportOffsets?.[format];
}

/** Audit-time CDN-to-local quality offset per format, keyed by usage id; empty when there is no readable report. */
async function auditCalibration(projectDir: string): Promise<Map<string, Partial<Record<Format, number>>>> {
  const out = new Map<string, Partial<Record<Format, number>>>();
  const report = await readReport(projectDir).catch(() => undefined);
  for (const result of report?.results ?? []) {
    if (result.calibration) out.set(result.usageId, result.calibration);
  }
  return out;
}

/** Audit-time median bytes per viewport, keyed by usage id; empty when there is no readable report. */
async function auditBytes(projectDir: string): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  const report = await readReport(projectDir).catch(() => undefined);
  for (const result of report?.results ?? []) {
    if (Object.keys(result.current.bytesByViewport).length > 0) out.set(result.usageId, result.current.bytesByViewport);
  }
  return out;
}

/** Formats the page served for a usage, from the content-types of all its observations. */
function servedFormats(observations: ImageObservation[]): Format[] {
  const seen = new Set(observations.map((obs) => formatOfContentType(obs.contentType)));
  return FORMATS.filter((format) => seen.has(format));
}

/**
 * `imgtune verify`: re-measures the applied usages with normal page loads and scores the served variants against the
 * originals. Verdicts are written into the state entries; source files are never edited.
 */
export async function verify(config: ImgtuneConfig, opts: VerifyOptions = {}): Promise<VerifyRow[]> {
  const log = opts.log ?? progress;
  const projectDir = config.projectDir;

  await assertMetricAvailable(config.metric, config.ssimulacra2Path);
  await restoreAndReport(projectDir, log);
  installRestoreHandlers(projectDir);

  log("scanning");
  // The audit's own listing of the paths, so a path that does not exist fails here as it does there. Only the entries
  // under the paths are judged; the others keep whatever verdict they have.
  const inScope = new Set(await listSourceFiles(projectDir, config.paths));
  const state = (await loadState(projectDir)).filter((entry) => inScope.has(resolve(projectDir, entry.relFile)));
  const hashes = new Map<string, string | undefined>();
  for (const relFile of unique(state.map((entry) => entry.relFile))) {
    try {
      hashes.set(relFile, sha1(await readFile(join(projectDir, relFile))));
    } catch {
      hashes.set(relFile, undefined);
    }
  }
  const scanned = new Map<string, ImageUsage[]>();
  const usageOf = (entry: StateEntry): ImageUsage | undefined => {
    let usages = scanned.get(entry.relFile);
    if (!usages) {
      usages = scanFile(join(projectDir, entry.relFile), projectDir);
      scanned.set(entry.relFile, usages);
    }
    return usages.find((usage) => usage.id === entry.usageId);
  };
  const applied = selectApplied(state, (relFile) => hashes.get(relFile), usageOf);
  for (const entry of state) {
    const hasApplied = entry.applied.sizes !== undefined || entry.applied.quality !== undefined;
    if (hasApplied && !applied.some((a) => a.entry === entry)) {
      log(`skipped ${entry.usageId}: file changed since apply or usage not found`);
    }
  }
  if (applied.length === 0) {
    log("nothing to verify: no applied usage is unchanged since apply");
    return [];
  }

  const beforeBytes = await auditBytes(projectDir);
  const calibration = await auditCalibration(projectDir);
  const score = opts.score ?? makeScorer(config.metric, { projectDir, binary: config.ssimulacra2Path });
  const imageConfig = readImageConfig(projectDir);
  const recomputable = profileOf(imageConfig) === "next-default";
  const measured = await (opts.measure ?? measureUsages)(config, applied.map((a) => a.usage), imageConfig, log);
  const rows: VerifyRow[] = [];
  const judged = new Map<string, { entry: StateEntry; judgement: Judgement; bytes: Record<string, number> }>();
  try {
    log(`checking ${applied.length} components`);
    const fetchOriginal = opts.fetchOriginal ?? makeFetchOriginal(projectDir);
    for (const { entry, usage } of applied) {
      const observations = measured.observations.filter((obs) => obs.usageId === usage.id);
      const samples: VerifySample[] = [];
      for (const format of FORMATS) {
        for (const obs of sampleVariants(observations, format, config.samplesPerComponent)) {
          const scored = await scoreVariant(obs, format, measured.baseUrl, { fetchImpl: opts.fetchImpl, fetchOriginal, score });
          if ("unusable" in scored) {
            log(`unusable ${format} sample for ${usage.id}: ${scored.unusable}`);
            samples.push({ format });
            continue;
          }
          const verdict = await judgeSample(
            {
              obs,
              format,
              scored,
              before: entry.before?.quality,
              applied: entry.applied.quality,
              offset: offsetFor(entry, calibration.get(usage.id), format),
              profile: recomputable ? "next-default" : "cdn",
              delta: config.delta,
              threshold: config.threshold,
              baseUrl: measured.baseUrl,
            },
            { fetchOriginal, score },
          );
          if ("unusable" in verdict) {
            log(`unusable ${format} sample for ${usage.id}: ${verdict.unusable}`);
            samples.push({ format });
          } else {
            samples.push(verdict.sample);
          }
        }
      }
      const judgement = judgeVerification({
        samples,
        served: servedFormats(observations),
        samplesPerComponent: config.samplesPerComponent,
        threshold: config.threshold,
        tolerance: config.tolerance,
        maxDrop: recomputable ? undefined : config.delta,
        applied: entry.applied,
        before: entry.before,
      });
      const bytes = bytesByViewport(observations);
      judged.set(usage.id, { entry, judgement, bytes });
      rows.push({
        usageId: usage.id,
        component: usage.component,
        relFile: usage.relFile,
        line: usage.line,
        bytes,
        beforeBytes: beforeBytes.get(usage.id),
        judgement,
      });
    }
  } finally {
    await measured.stop();
  }

  // Judged entries get the new verdict; unmeasured ones lose any old verdict so the file never shows a stale one.
  const now = new Date().toISOString();
  const updated: StateEntry[] = [];
  for (const { entry, judgement, bytes } of judged.values()) {
    if (judgement.status === "unmeasured") {
      if (entry.verification !== undefined) {
        const { verification: _stale, ...withoutVerdict } = entry;
        updated.push(withoutVerdict);
      }
      continue;
    }
    updated.push({
      ...entry,
      verification: {
        status: judgement.status,
        at: now,
        bytes,
        ssim: judgement.ssim,
        minScore: judgement.minScore,
        ...(judgement.drop !== undefined ? { drop: judgement.drop } : {}),
        counts: judgement.counts,
        ...(judgement.raiseTo !== undefined ? { raiseTo: judgement.raiseTo } : {}),
      },
    });
  }
  if (updated.length > 0) await saveState(projectDir, updated);

  process.stdout.write(`${renderVerifyTable(rows, config.metric)}\n`);
  log("done");
  return rows;
}
