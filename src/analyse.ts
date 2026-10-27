import { calibrationOffset, type CalibrationSample } from "./calibrate.js";
import { encode, loadReference, type EncoderProfile } from "./encode.js";
import type { ImageConfig } from "./nextconfig.js";
import type { ImageObservation } from "./measure.js";
import { deriveSizes } from "./sizes.js";
import { componentQuality, minPassingQuality, toTargetQuality, type SearchDeps } from "./search.js";
import { nextCandidates, pickCandidate, pickForX } from "./srcset.js";
import { ssim, type RawImage } from "./ssim.js";
import type { ImageUsage, ImgtuneConfig, PropInfo } from "./types.js";

type Format = "avif" | "webp";

const DEFAULT_QUALITY = 75;
/** Rendered width may exceed slot x dpr by this factor before the width ladder is reported as a gap. */
const LADDER_GAP_RATIO = 1.25;
const CONFIRM_SAMPLES = 5;
const CALIBRATION_SAMPLES = 5;
const NOTE_NOT_CONFIRMED = "estimated: not confirmed against /_next/image";

export interface MeasuredWidth {
  page: string;
  viewport: string;
  renderedWidth: number;
}

export interface ComponentResult {
  usageId: string;
  component: string;
  relFile: string;
  line: number;
  /** Observations at the reference viewport in the default (non-webp) pass. */
  instances: number;
  current: {
    sizes?: string;
    quality: number;
    medianBytes?: number;
    medianWidth?: number;
    format?: string;
    /** Median observed bytes per viewport name (default pass). */
    bytesByViewport: Record<string, number>;
  };
  /** `width` is the predicted srcset width at the reference viewport; 0 when the usage was not measured. */
  proposed: { sizes?: string; quality?: number; width: number; projectedBytes?: number; ssim?: number };
  savedBytesTotal: number;
  estimated: boolean;
  servedFormats: string[];
  notes: string[];
  /** Set when `sizes` is an expression or comes from a spread: rendered widths per page and viewport. */
  measuredWidths?: MeasuredWidth[];
}

export interface AnalyseOptions {
  /** Confirms a `next-default` quality against the running app's `/_next/image`. */
  confirm?: (
    samples: { src: string; ref: RawImage; width: number }[],
    q: number,
    formats: Format[],
  ) => Promise<{ confirmed: boolean; ssim: { avif?: number; webp?: number }; bytes: { avif?: number; webp?: number } } | undefined>;
  deps?: SearchDeps;
  log?: (msg: string) => void;
}

/**
 * The URL to download for a rendered `src`. A Cloudflare `/cdn-cgi/image/<opts>/<rest>` path yields `<rest>` (the
 * original); anything else is resolved against `baseUrl`.
 */
export function originalUrlFor(src: string, baseUrl: string): string {
  const cdn = /\/cdn-cgi\/image\/[^/]+\/(.+)$/.exec(src);
  if (cdn) {
    const rest = cdn[1];
    if (/^https?:\/\//.test(rest)) return rest;
    const origin = /^https?:\/\//.test(src) ? new URL(src).origin : baseUrl;
    return new URL(`/${rest}`, origin).toString();
  }
  return new URL(src, baseUrl).toString();
}

/**
 * Turns the measurements of each component into a proposed `sizes` and `quality` with projected and saved bytes.
 * Usages are processed one at a time, and samples one at a time.
 */
export async function analyse(
  usages: ImageUsage[],
  obs: ImageObservation[],
  imageConfig: ImageConfig,
  cfg: ImgtuneConfig,
  baseUrl: string,
  fetchOriginal: (url: string) => Promise<Buffer>,
  opts: AnalyseOptions = {},
): Promise<ComponentResult[]> {
  const cache = new Map<string, Promise<Buffer>>();
  const ctx: Context = {
    cfg,
    imageConfig,
    profile: imageConfig.loaderFile ? "cdn" : "next-default",
    searchFormats: [],
    baseUrl,
    deps: opts.deps ?? {},
    opts,
    log: opts.log ?? ((msg) => console.error(`imgtune: ${msg}`)),
    loggedUrls: new Set(),
    fetchCached: (url) => {
      let pending = cache.get(url);
      if (!pending) {
        pending = fetchOriginal(url);
        cache.set(url, pending);
      }
      return pending;
    },
  };
  ctx.searchFormats = ctx.profile === "cdn" ? ["avif", "webp"] : nextDefaultFormats(imageConfig.formats);

  const byUsage = new Map<string, ImageObservation[]>();
  for (const o of obs) {
    const list = byUsage.get(o.usageId);
    if (list) list.push(o);
    else byUsage.set(o.usageId, [o]);
  }

  const results: ComponentResult[] = [];
  for (const usage of usages) {
    results.push(await analyseUsage(ctx, usage, byUsage.get(usage.id) ?? []));
  }

  // The default pass is the one a visitor with a stock browser gets. If it never serves AVIF the project is flagged.
  const defaultPass = obs.filter((o) => o.accept === "default");
  if (defaultPass.length > 0 && !defaultPass.some((o) => formatOf(o.contentType) === "avif")) {
    for (const r of results) r.notes.push("AVIF not served");
  }
  return results;
}

interface Context {
  cfg: ImgtuneConfig;
  imageConfig: ImageConfig;
  profile: EncoderProfile;
  searchFormats: Format[];
  baseUrl: string;
  deps: SearchDeps;
  opts: AnalyseOptions;
  log: (msg: string) => void;
  loggedUrls: Set<string>;
  fetchCached: (url: string) => Promise<Buffer>;
}

interface Sample {
  /** The `src` as rendered (what `/_next/image?url=` receives). */
  src: string;
  buffer: Buffer;
}

async function analyseUsage(ctx: Context, usage: ImageUsage, usageObs: ImageObservation[]): Promise<ComponentResult> {
  const notes: string[] = [];
  const defaultObs = usageObs.filter((o) => o.accept === "default");
  const rendered = defaultObs.filter((o) => o.renderedWidth >= 1);
  const sizesLiteral = literalString(usage.props.sizes);
  const widthLiteral = literalNumber(usage.props.width);
  const literalQuality = literalNumber(usage.props.quality);
  const urlQuality = currentQualityFromSrc(usageObs);
  const quality = literalQuality ?? urlQuality ?? DEFAULT_QUALITY;

  const result: ComponentResult = {
    usageId: usage.id,
    component: usage.component,
    relFile: usage.relFile,
    line: usage.line,
    instances: 0,
    current: { sizes: sizesLiteral, quality, bytesByViewport: bytesByViewport(defaultObs) },
    proposed: { width: 0 },
    savedBytesTotal: 0,
    estimated: true,
    servedFormats: unique(defaultObs.flatMap((o) => formatOf(o.contentType) ?? [])),
    notes,
  };

  if (defaultObs.length === 0) {
    notes.push("not measured: no default-pass observations");
    return result;
  }
  if (rendered.length === 0) {
    notes.push("not measured: image not rendered at any viewport");
    return result;
  }

  if (literalQuality === undefined && urlQuality === undefined) {
    notes.push(`current quality assumed ${DEFAULT_QUALITY} (not found in props or URL)`);
  }

  // Reference viewport: iphone-15 when measured, else the first mobile viewport, else the first viewport.
  const names = unique(rendered.map((o) => o.viewport));
  const refName = names.includes("iphone-15")
    ? "iphone-15"
    : (rendered.find((o) => o.mobile)?.viewport ?? names[0]);
  const refRendered = rendered.filter((o) => o.viewport === refName);
  // Bytes, width and format come from the rendered observations that also have a byte count.
  const refMeasured = refRendered.filter((o) => o.bytes !== undefined);
  const refSlot = median(refRendered.map((o) => o.renderedWidth)) ?? 0;
  const refDpr = refRendered[0].dpr;
  const medianBytes = median(refMeasured.flatMap((o) => (o.bytes === undefined ? [] : [o.bytes])));
  const medianWidth = median(refMeasured.flatMap((o) => (o.naturalWidth > 0 ? [o.naturalWidth] : [])));
  result.instances = refRendered.length;
  result.current = {
    ...result.current,
    medianBytes,
    medianWidth,
    format: mode(refMeasured.flatMap((o) => (o.contentType ? [o.contentType] : []))),
  };

  if (usage.tag === "img") {
    return plainImg(result, refRendered, refSlot, refDpr);
  }

  const sizesManual =
    usage.props.sizes.kind === "expression" || (usage.hasSpread && usage.props.sizes.kind === "absent");
  const qualityManual =
    usage.props.quality.kind === "expression" || (usage.hasSpread && usage.props.quality.kind === "absent");

  let proposedSizes: string | undefined;
  if (sizesManual) {
    notes.push("manual change needed: sizes is an expression");
    result.measuredWidths = defaultObs.map((o) => ({ page: o.page, viewport: o.viewport, renderedWidth: o.renderedWidth }));
  } else {
    proposedSizes = deriveSizes(
      rendered.map((o) => ({ viewportWidth: o.viewportWidth, renderedWidth: o.renderedWidth, mobile: o.mobile })),
    );
  }

  const candidates = nextCandidates(ctx.imageConfig, proposedSizes ?? sizesLiteral, widthLiteral);
  const predict = (slot: number, dpr: number): number =>
    candidates.kind === "w" ? pickCandidate(candidates.widths, slot, dpr) : pickForX(candidates.widths, dpr);
  const width = predict(refSlot, refDpr);
  result.proposed.width = width;
  result.proposed.sizes = proposedSizes;

  // Width ladder: the candidate offered at a viewport is much larger than the slot needs.
  if (candidates.kind === "w") {
    const gaps = new Set<number>();
    for (const name of names) {
      const at = rendered.filter((o) => o.viewport === name);
      const slot = median(at.map((o) => o.renderedWidth)) ?? 0;
      const dpr = at[0].dpr;
      const target = Math.ceil(slot * dpr);
      if (pickCandidate(candidates.widths, slot, dpr) > target * LADDER_GAP_RATIO) gaps.add(target);
    }
    for (const target of gaps) notes.push(`width ladder gap: add ${target} to deviceSizes`);
  }

  if (qualityManual) notes.push("manual change needed: quality is an expression");

  const search = await searchQuality(ctx, usageObs, quality, width, notes);
  const proposedQuality = search.proposedQuality;
  result.proposed.quality = proposedQuality;

  // Bytes are projected at the width the browser would pick. A manual `sizes` claims no width saving.
  const evalWidth = sizesManual ? (medianWidth ?? width) : width;
  const qNew = proposedQuality ?? quality;
  const served: Format = result.servedFormats.includes("avif") ? "avif" : "webp";
  const projectionFormat: Format = ctx.profile === "cdn" ? "avif" : served;

  // Observed reference-viewport bytes per original, for cdn projection (samples without one are skipped).
  const observedBySrc = new Map<string, number>();
  for (const src of unique(refMeasured.map((o) => o.originalSrc ?? ""))) {
    const m = median(refMeasured.flatMap((o) => (o.originalSrc === src ? [o.bytes as number] : [])));
    if (src && m !== undefined) observedBySrc.set(src, m);
  }

  const projectedPerSample: number[] = [];
  const ssims: number[] = [];
  for (const sample of search.samples) {
    try {
      const projected = await evaluate(ctx, sample.buffer, projectionFormat, qNew, evalWidth, search.offsets);
      if (ctx.profile === "cdn") {
        const observed = observedBySrc.get(sample.src);
        const baseline = await evaluate(ctx, sample.buffer, projectionFormat, quality, medianWidth ?? width, search.offsets);
        if (projected && baseline && baseline.bytes > 0 && observed !== undefined) {
          projectedPerSample.push(observed * (projected.bytes / baseline.bytes));
        }
      } else if (projected) {
        projectedPerSample.push(projected.bytes);
      }
      const scored = projectionFormat === served ? projected : await evaluate(ctx, sample.buffer, served, qNew, evalWidth, search.offsets);
      if (scored) ssims.push(scored.ssim);
    } catch (err) {
      logOnce(ctx, `projection ${sample.src}`, `skipping projection for ${sample.src}: ${message(err)}`);
    }
  }
  result.proposed.ssim = median(ssims);

  let projected = median(projectedPerSample);
  let estimated = true;
  if (ctx.profile === "next-default") {
    if (!ctx.opts.confirm) {
      notes.push(NOTE_NOT_CONFIRMED);
    } else if (proposedQuality !== undefined && search.samples.length > 0) {
      // A confirmed result uses the served bytes of the primary format (AVIF when searched, else WebP).
      const primary: Format = ctx.searchFormats.includes("avif") ? "avif" : "webp";
      const outcome = await confirmQuality(ctx, search.samples, proposedQuality, width);
      const confirmedBytes = outcome?.confirmed ? outcome.bytes[primary] : undefined;
      if (confirmedBytes !== undefined) {
        projected = confirmedBytes;
        estimated = false;
      }
    }
  }
  result.estimated = estimated;
  result.proposed.projectedBytes = projected;

  if (projected !== undefined && medianBytes !== undefined) {
    result.savedBytesTotal = Math.max(0, medianBytes - projected) * result.instances;
  }

  return result;
}

/** Plain `<img>`: report-only. Saves are the bytes a served-pixel-area scale-down to ceil(slot x dpr) would drop. */
function plainImg(result: ComponentResult, refAll: ImageObservation[], refSlot: number, refDpr: number): ComponentResult {
  result.notes.push("plain <img>: report-only, consider next/image");
  result.proposed.width = Math.ceil(refSlot * refDpr);
  let saved = 0;
  for (const o of refAll) {
    if (o.bytes === undefined || o.renderedWidth < 1 || o.naturalWidth < 1) continue;
    const scale = Math.ceil(o.renderedWidth * o.dpr) / o.naturalWidth;
    saved += Math.max(0, o.bytes * (1 - scale * scale));
  }
  result.savedBytesTotal = saved;
  result.estimated = true;
  return result;
}

interface QualitySearch {
  samples: Sample[];
  offsets: Partial<Record<Format, number>>;
  proposedQuality?: number;
}

/** Per-sample bisection per format, then the component's 95th percentile mapped onto the project's quality scale. */
async function searchQuality(
  ctx: Context,
  usageObs: ImageObservation[],
  quality: number,
  width: number,
  notes: string[],
): Promise<QualitySearch> {
  const { cfg, deps } = ctx;
  const sources = unique(usageObs.flatMap((o) => (o.originalSrc ? [o.originalSrc] : []))).slice(0, cfg.samplesPerComponent);

  const samples: Sample[] = [];
  const perSample: Record<Format, number[]> = { avif: [], webp: [] };
  for (const src of sources) {
    const url = originalUrlFor(src, ctx.baseUrl);
    try {
      const buffer = await ctx.fetchCached(url);
      const ref = await loadReference(buffer, width);
      const found: Partial<Record<Format, number>> = {};
      for (const format of ctx.searchFormats) {
        found[format] = await minPassingQuality(ref, format, quality, ctx.profile, cfg.threshold, cfg.tolerance, deps);
      }
      samples.push({ src, buffer });
      for (const format of ctx.searchFormats) perSample[format].push(found[format] as number);
    } catch (err) {
      logOnce(ctx, url, `skipping sample ${url}: ${message(err)}`);
    }
  }

  if (samples.length === 0) {
    notes.push("quality not proposed: no sample originals could be fetched");
    return { samples, offsets: {} };
  }

  const offsets: Partial<Record<Format, number>> = {};
  if (ctx.profile === "cdn") {
    for (const format of ctx.searchFormats) {
      const calibration = await calibrationSamples(ctx, usageObs, format, quality);
      const fit = await calibrationOffset(calibration, deps);
      if (fit) offsets[format] = fit.offset;
    }
  }

  const targets: number[] = [];
  for (const format of ctx.searchFormats) {
    const target = toTargetQuality(componentQuality(perSample[format]), offsets[format], ctx.profile, quality);
    if (target === undefined) {
      notes.push(`quality not proposed: no CDN ${format} variants observed for calibration`);
      return { samples, offsets };
    }
    targets.push(target);
  }
  return { samples, offsets, proposedQuality: Math.max(...targets) };
}

/** Up to five distinct originals of the usage's observed CDN variants in `format`, with their bytes and quality. */
async function calibrationSamples(
  ctx: Context,
  usageObs: ImageObservation[],
  format: Format,
  quality: number,
): Promise<CalibrationSample[]> {
  const accept = format === "avif" ? "default" : "webp";
  const picked = new Set<string>();
  const out: CalibrationSample[] = [];
  for (const o of usageObs) {
    if (out.length >= CALIBRATION_SAMPLES) break;
    if (o.accept !== accept || o.bytes === undefined || !o.originalSrc || o.naturalWidth < 1) continue;
    if (formatOf(o.contentType) !== format || picked.has(o.originalSrc)) continue;
    picked.add(o.originalSrc);
    const url = originalUrlFor(o.originalSrc, ctx.baseUrl);
    try {
      const ref = await loadReference(await ctx.fetchCached(url), o.naturalWidth);
      out.push({ ref, format, cdnQuality: quality, cdnBytes: o.bytes });
    } catch (err) {
      logOnce(ctx, url, `skipping calibration sample ${url}: ${message(err)}`);
    }
  }
  return out;
}

/** Local encode of one sample at `width` and the project's quality `cdnQ`: bytes and SSIM against the reference. */
async function evaluate(
  ctx: Context,
  buffer: Buffer,
  format: Format,
  cdnQ: number,
  width: number,
  offsets: Partial<Record<Format, number>>,
): Promise<{ bytes: number; ssim: number } | undefined> {
  let local = cdnQ;
  if (ctx.profile === "cdn") {
    const offset = offsets[format];
    if (offset === undefined) return undefined;
    local = cdnQ - offset;
  }
  local = Math.min(100, Math.max(1, local));
  const ref = await loadReference(buffer, width);
  const enc = await (ctx.deps.encode ?? encode)(ref, format, local, ctx.profile);
  return { bytes: enc.bytes, ssim: (ctx.deps.ssim ?? ssim)(ref, enc.decoded) };
}

/** `/_next/image` confirmation for a next-default quality. Failures are logged and yield no outcome. */
async function confirmQuality(
  ctx: Context,
  samples: Sample[],
  q: number,
  width: number,
): Promise<{ confirmed: boolean; bytes: { avif?: number; webp?: number } } | undefined> {
  const confirm = ctx.opts.confirm;
  if (!confirm) return undefined;
  try {
    const picked = [];
    for (const s of samples.slice(0, CONFIRM_SAMPLES)) {
      picked.push({ src: s.src, ref: await loadReference(s.buffer, width), width });
    }
    const outcome = await confirm(picked, q, ctx.searchFormats);
    return outcome && { confirmed: outcome.confirmed, bytes: outcome.bytes };
  } catch (err) {
    ctx.log(`confirmation failed: ${message(err)}`);
    return undefined;
  }
}

function logOnce(ctx: Context, url: string, text: string): void {
  if (ctx.loggedUrls.has(url)) return;
  ctx.loggedUrls.add(url);
  ctx.log(text);
}

/** Formats searched for `next-default`: images.formats restricted to AVIF/WebP, WebP when none. */
function nextDefaultFormats(formats: string[]): Format[] {
  const found: Format[] = [];
  for (const f of formats) {
    if (f === "image/avif" && !found.includes("avif")) found.push("avif");
    if (f === "image/webp" && !found.includes("webp")) found.push("webp");
  }
  return found.length > 0 ? found : ["webp"];
}

/** The subtype of a MIME type ("image/avif" -> "avif"); undefined when absent. */
function formatOf(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0].trim().toLowerCase().replace(/^image\//, "");
}

function currentQualityFromSrc(observations: ImageObservation[]): number | undefined {
  const values = observations.flatMap((o) => {
    const match = /quality=(\d+)/.exec(o.currentSrc) ?? /[?&]q=(\d+)/.exec(o.currentSrc);
    return match ? [Number(match[1])] : [];
  });
  const m = median(values);
  return m === undefined ? undefined : Math.round(m);
}

function bytesByViewport(defaultObs: ImageObservation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of unique(defaultObs.map((o) => o.viewport))) {
    const m = median(defaultObs.flatMap((o) => (o.viewport === name && o.bytes !== undefined ? [o.bytes] : [])));
    if (m !== undefined) out[name] = m;
  }
  return out;
}

function literalNumber(p: PropInfo): number | undefined {
  if (p.kind !== "literal") return undefined;
  if (typeof p.value === "number") return Number.isFinite(p.value) ? p.value : undefined;
  if (typeof p.value === "string" && p.value.trim() !== "" && Number.isFinite(Number(p.value))) return Number(p.value);
  return undefined;
}

function literalString(p: PropInfo): string | undefined {
  return p.kind === "literal" ? String(p.value) : undefined;
}

/** Median (middle pair averaged for even n); undefined for an empty list. */
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Most frequent value; ties go to the value seen first. */
function mode(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
