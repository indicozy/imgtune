import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { makeFetchOriginal, measureUsages, progress, restoreAndReport, unique, type Log } from "./audit.js";
import { sha1 } from "./atomic.js";
import { loadReference } from "./encode.js";
import { readImageConfig } from "./nextconfig.js";
import type { ImageObservation } from "./measure.js";
import { originalUrlFor } from "./analyse.js";
import { installRestoreHandlers } from "./instrument.js";
import { readReport } from "./report.js";
import { scanFile } from "./scan.js";
import { loadState, saveState, type StateEntry } from "./state.js";
import { ssim, type RawImage } from "./ssim.js";
import type { ImageUsage, ImgtuneConfig } from "./types.js";

type Format = "avif" | "webp";
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
}

export interface FormatCounts {
  /** Samples that could be scored. */
  usable: number;
  /** Usable samples at or above the threshold. */
  passing: number;
}

export interface Judgement {
  status: "verified" | "regressed" | "unmeasured";
  /** Set when `status` is unmeasured. */
  reason?: string;
  /** Median SSIM of the usable samples per judged format. */
  ssim: { avif?: number; webp?: number };
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
  /** Audit-time median bytes at the reference viewport, when the usage is in the audit report. */
  beforeBytes?: number;
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
  const minimum = Math.min(MIN_USABLE_SAMPLES, input.samplesPerComponent);
  const formats = FORMATS.filter((format) => served.includes(format));
  const judgement: Judgement = { status: "verified", ssim: {}, counts: {} };
  if (formats.length === 0) return { ...judgement, status: "unmeasured", reason: "no avif or webp image served" };

  let failed = false;
  for (const format of formats) {
    const usable = samples.flatMap((s) => (s.format === format && s.ssim !== undefined ? [s.ssim] : []));
    if (usable.length < minimum) {
      return {
        ...judgement,
        status: "unmeasured",
        reason: `insufficient ${format} samples: ${usable.length}`,
      };
    }
    const passing = usable.filter((value) => value >= threshold).length;
    judgement.counts[format] = { usable: usable.length, passing };
    judgement.ssim[format] = median(usable);
    if (passing * 100 < PASS_PERCENT * usable.length) failed = true;
  }
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

export type VariantScore = { ssim: number } | { unusable: string };

export interface VariantDeps {
  fetchImpl?: typeof fetch;
  fetchOriginal: (url: string) => Promise<Buffer>;
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
    original = await deps.fetchOriginal(originalUrlFor(obs.originalSrc, baseUrl));
  } catch (err) {
    return { unusable: `original: ${(err as Error).message}` };
  }
  let reference: RawImage;
  try {
    reference = await loadReference(original, served.width);
  } catch (err) {
    return { unusable: `original decode failed: ${(err as Error).message}` };
  }
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
  return { ssim: ssim(reference, served) };
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
const fmtSsim = (value: number | undefined): string => (value === undefined ? "-" : value.toFixed(4));

function statusOf(judgement: Judgement): string {
  if (judgement.status === "unmeasured") return `not measured (${judgement.reason})`;
  if (judgement.status === "verified") return "verified";
  return judgement.raiseTo === undefined ? "regressed" : `regressed (raise quality to ${judgement.raiseTo})`;
}

/**
 * Aligned text table: component, location, bytes before and now (reference viewport before, every viewport now), SSIM
 * per format, status.
 */
export function renderVerifyTable(rows: VerifyRow[]): string {
  const header = ["component", "location", `bytes before (${REFERENCE_VIEWPORT})`, "bytes now", "SSIM avif", "SSIM webp", "status"];
  const body = rows.map((row) => {
    const viewports = Object.keys(row.bytes).sort((a, b) =>
      a === REFERENCE_VIEWPORT ? -1 : b === REFERENCE_VIEWPORT ? 1 : 0,
    );
    const now = viewports.map((name) => `${name} ${fmtBytes(row.bytes[name])}`).join(", ") || "-";
    const before = row.beforeBytes === undefined ? "-" : fmtBytes(row.beforeBytes);
    return [
      row.component,
      `${row.relFile}:${row.line}`,
      before,
      now,
      fmtSsim(row.judgement.ssim.avif),
      fmtSsim(row.judgement.ssim.webp),
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
}

/** Audit-time median bytes at the reference viewport, keyed by usage id; empty when there is no readable report. */
async function auditBytes(projectDir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const report = await readReport(projectDir).catch(() => undefined);
  for (const result of report?.results ?? []) {
    const bytes = result.current.bytesByViewport[REFERENCE_VIEWPORT];
    if (bytes !== undefined) out.set(result.usageId, bytes);
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

  await restoreAndReport(projectDir, log);
  installRestoreHandlers(projectDir);

  log("scanning");
  const state = await loadState(projectDir);
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
  const imageConfig = readImageConfig(projectDir);
  const measured = await measureUsages(config, applied.map((a) => a.usage), imageConfig, log);
  const rows: VerifyRow[] = [];
  const judged = new Map<string, { entry: StateEntry; judgement: Judgement; bytes: Record<string, number> }>();
  try {
    log(`checking ${applied.length} components`);
    const fetchOriginal = makeFetchOriginal(projectDir);
    for (const { entry, usage } of applied) {
      const observations = measured.observations.filter((obs) => obs.usageId === usage.id);
      const samples: VerifySample[] = [];
      for (const format of FORMATS) {
        for (const obs of sampleVariants(observations, format, config.samplesPerComponent)) {
          const score = await scoreVariant(obs, format, measured.baseUrl, { fetchImpl: opts.fetchImpl, fetchOriginal });
          if ("unusable" in score) {
            log(`unusable ${format} sample for ${usage.id}: ${score.unusable}`);
            samples.push({ format });
          } else {
            samples.push({ format, ssim: score.ssim });
          }
        }
      }
      const judgement = judgeVerification({
        samples,
        served: servedFormats(observations),
        samplesPerComponent: config.samplesPerComponent,
        threshold: config.threshold,
        tolerance: config.tolerance,
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
        counts: judgement.counts,
        ...(judgement.raiseTo !== undefined ? { raiseTo: judgement.raiseTo } : {}),
      },
    });
  }
  if (updated.length > 0) await saveState(projectDir, updated);

  process.stdout.write(`${renderVerifyTable(rows)}\n`);
  log("done");
  return rows;
}
