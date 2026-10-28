import { calibrationOffset, type CalibrationSample } from "./calibrate.js";
import { encode, loadReference, type EncoderProfile } from "./encode.js";
import type { ImageConfig } from "./nextconfig.js";
import type { ImageObservation } from "./measure.js";
import { deriveSizeBranches, joinSizeBranches, sizesSlotAt, sizesValueAt, type SizeBranches } from "./sizes.js";
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
/** Projected bytes above this multiple of the current median count as growth. */
const GROWTH_RATIO = 1.05;
const NOTE_NOT_CONFIRMED = "estimated: not confirmed against /_next/image";
/** The media branches of a `sizes` value, in the order the notes list them. */
const BRANCHES = ["mobile", "desktop"] as const;
/** Rendered widths at one viewport count as several slots when the widest is over this multiple of the narrowest. */
const MULTI_SLOT_SPREAD = 1.5;
/** Widths closer than this factor to each other are one slot. */
const MULTI_SLOT_GROUP_RATIO = 1.25;
/** At most this many slot groups are named in the note. */
const MULTI_SLOT_LISTED = 3;
/** What a `sizes` value means when the usage has none: Next serves the full viewport width. */
const ABSENT_SIZES = "100vw";

export interface MeasuredWidth {
  page: string;
  viewport: string;
  renderedWidth: number;
}

/** Growth of one media branch under the full correction. */
export interface BranchGrowth {
  /** Mean projected bytes minus mean current bytes over the branch's projected viewports. */
  deltaBytes: number;
  /** The corrected branch projects more than GROWTH_RATIO times its current bytes. */
  grows: boolean;
  /** A growing branch keeps its current value in `proposed.sizes`. */
  kept: boolean;
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
  /**
   * `width` is the predicted srcset width at the reference viewport under the proposed sizes; 0 when the usage was not
   * measured. The per-viewport maps are projected bytes (default pass) under the proposed sizes and quality.
   */
  proposed: {
    sizes?: string;
    /** The full correction: every media branch at its measured width. `apply --allow-growth` writes this. */
    sizesFull?: string;
    quality?: number;
    width: number;
    projectedBytes?: number;
    ssim?: number;
    bytesByViewport?: Record<string, number>;
    /** `bytesByViewport` under the full correction, to compare with the proposed sizes. */
    bytesByViewportFull?: Record<string, number>;
    /** Per media branch, when the branch has a projected viewport. */
    branches?: { mobile?: BranchGrowth; desktop?: BranchGrowth };
  };
  /** Average saving per page view across the projected viewports; negative when the proposal grows bytes. */
  savedBytesTotal: number;
  estimated: boolean;
  servedFormats: string[];
  notes: string[];
  /** Set when `sizes` is an expression or comes from a spread: rendered widths per page and viewport. */
  measuredWidths?: MeasuredWidth[];
  /** Names of the rendered mobile viewports, so the report can label the phone column. */
  mobileViewports?: string[];
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

/** Rendered widths that are clearly apart: a new group starts where a width exceeds the previous one by more than 1.25x. */
function widthGroups(widths: number[]): { width: number; n: number }[] {
  const groups: number[][] = [];
  for (const w of [...widths].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && w <= last[last.length - 1] * MULTI_SLOT_GROUP_RATIO) last.push(w);
    else groups.push([w]);
  }
  return groups.map((group) => ({ width: Math.round(median(group) as number), n: group.length }));
}

/** Per-viewport facts from the rendered observations of one usage. */
interface ViewportStat {
  name: string;
  mobile: boolean;
  viewportWidth: number;
  /** Rendered observations at this viewport (default pass). */
  instances: number;
  /** Median rendered width (css px) and device pixel ratio. */
  slot: number;
  dpr: number;
  /** Median observed bytes at this viewport; undefined when no observation has bytes. */
  bytes?: number;
  /** Median natural (file) width of the rendered observations that have bytes. */
  servedWidth?: number;
  /** Median observed bytes per original. */
  bytesBySrc: Map<string, number>;
}

function viewportStats(rendered: ImageObservation[], bytes: Record<string, number>): ViewportStat[] {
  return unique(rendered.map((o) => o.viewport)).map((name) => {
    const at = rendered.filter((o) => o.viewport === name);
    const measured = at.filter((o) => o.bytes !== undefined);
    const bytesBySrc = new Map<string, number>();
    for (const src of unique(measured.map((o) => o.originalSrc ?? ""))) {
      const m = median(measured.flatMap((o) => (o.originalSrc === src ? [o.bytes as number] : [])));
      if (src && m !== undefined) bytesBySrc.set(src, m);
    }
    return {
      name,
      mobile: at[0].mobile,
      viewportWidth: at[0].viewportWidth,
      instances: at.length,
      slot: median(at.map((o) => o.renderedWidth)) ?? 0,
      dpr: at[0].dpr,
      bytes: bytes[name],
      servedWidth: median(measured.flatMap((o) => (o.naturalWidth > 0 ? [o.naturalWidth] : []))),
      bytesBySrc,
    };
  });
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
  const stats = viewportStats(rendered, result.current.bytesByViewport);
  const ref = stats.find((s) => s.name === refName) as ViewportStat;
  result.mobileViewports = stats.filter((s) => s.mobile).map((s) => s.name);

  if (usage.tag === "img") {
    return plainImg(result, refRendered, refSlot, refDpr);
  }

  const sizesManual =
    usage.props.sizes.kind === "expression" || (usage.hasSpread && usage.props.sizes.kind === "absent");
  const qualityManual =
    usage.props.quality.kind === "expression" || (usage.hasSpread && usage.props.quality.kind === "absent");

  if (sizesManual) {
    notes.push("manual change needed: sizes is an expression");
    result.measuredWidths = defaultObs.map((o) => ({ page: o.page, viewport: o.viewport, renderedWidth: o.renderedWidth }));
  }
  if (qualityManual) notes.push("manual change needed: quality is an expression");
  for (const s of stats) {
    const widths = rendered.filter((o) => o.viewport === s.name).map((o) => o.renderedWidth);
    if (Math.max(...widths) / Math.min(...widths) <= MULTI_SLOT_SPREAD) continue;
    const groups = widthGroups(widths);
    if (groups.length < 2) continue;
    const listed = groups.sort((a, b) => b.n - a.n).slice(0, MULTI_SLOT_LISTED).sort((a, b) => a.width - b.width);
    const parts = listed.map((g) => `${g.width}px ×${g.n}`).join(", ");
    notes.push(`renders at several widths at ${s.name}: ${parts}; one sizes cannot fit all — pass sizes from the parent (e.g. carousel)`);
  }

  // The full correction: every media branch at its measured width. Nothing when sizes is manual.
  const fullBranches: SizeBranches = sizesManual
    ? {}
    : deriveSizeBranches(rendered.map((o) => ({ viewportWidth: o.viewportWidth, renderedWidth: o.renderedWidth, mobile: o.mobile })));
  const sizesFull = sizesManual ? undefined : joinSizeBranches(fullBranches);

  // The width the browser picks at a viewport under `sizes`: the candidate for the slot the sizes give there.
  const widthAt = (sizes: string | undefined, s: ViewportStat): number => {
    const candidates = nextCandidates(ctx.imageConfig, sizes, widthLiteral);
    const slot = (sizes === undefined ? undefined : sizesSlotAt(sizes, s.viewportWidth)) ?? s.slot;
    return candidates.kind === "w" ? pickCandidate(candidates.widths, slot, s.dpr) : pickForX(candidates.widths, s.dpr);
  };
  // Manual sizes keep serving the file's own width, so the projection and the quality search use that width.
  const widthFor = (sizes: string | undefined, s: ViewportStat): number =>
    sizesManual ? (s.servedWidth ?? widthAt(sizes, s)) : widthAt(sizes, s);

  const probe = await prepareQuality(ctx, usageObs, quality);
  if (probe.samples.length === 0) notes.push("quality not proposed: no sample originals could be fetched");
  const sampleEval = evaluator(ctx, probe.offsets);
  const served: Format = result.servedFormats.includes("avif") ? "avif" : "webp";
  const projectionFormat: Format = ctx.profile === "cdn" ? "avif" : served;

  /** Quality searched at the reference viewport's width under `sizes`. Samples are not searched without originals. */
  const searchAtSizes = (sizes: string | undefined): Promise<QualityOutcome> =>
    probe.samples.length === 0 ? Promise.resolve({}) : searchAt(ctx, probe, quality, widthFor(sizes, ref));

  /** Projected median bytes per viewport name under `sizes` at quality `qNew`. A viewport that cannot be projected is omitted. */
  const project = async (sizes: string | undefined, qNew: number): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const s of stats) {
      if (s.bytes === undefined || s.servedWidth === undefined) continue;
      const projectedWidth = widthFor(sizes, s);
      const values: number[] = [];
      for (const sample of probe.samples) {
        const observed = s.bytesBySrc.get(sample.src);
        if (observed === undefined) continue;
        try {
          const projected = await sampleEval(sample, projectionFormat, qNew, projectedWidth);
          const baseline = await sampleEval(sample, projectionFormat, quality, s.servedWidth);
          if (projected && baseline && baseline.bytes > 0) values.push(observed * (projected.bytes / baseline.bytes));
        } catch (err) {
          logOnce(ctx, `projection ${sample.src}`, `skipping projection for ${sample.src}: ${message(err)}`);
        }
      }
      const m = median(values);
      if (m !== undefined) out[s.name] = m;
    }
    return out;
  };

  // Growth is judged per media branch, with the full correction at the quality searched for it.
  const fullSearch = await searchAtSizes(sizesFull);
  const qFull = fullSearch.proposedQuality ?? quality;
  const projFull = await project(sizesFull, qFull);
  const branches: { mobile?: BranchGrowth; desktop?: BranchGrowth } = {};
  for (const key of BRANCHES) {
    const members = stats.filter((s) => s.mobile === (key === "mobile") && s.bytes !== undefined && projFull[s.name] !== undefined);
    if (fullBranches[key] === undefined || members.length === 0) continue;
    const currentMean = mean(members.map((s) => s.bytes as number));
    const correctedMean = mean(members.map((s) => projFull[s.name]));
    branches[key] = { deltaBytes: correctedMean - currentMean, grows: correctedMean > currentMean * GROWTH_RATIO, kept: false };
  }

  // A growing branch keeps the current value at its own viewport width; the others take the full correction.
  const current = sizesLiteral ?? ABSENT_SIZES;
  const finalBranches: SizeBranches = {};
  let unresolved = false;
  for (const key of BRANCHES) {
    const full = fullBranches[key];
    if (full === undefined) continue;
    const decision = branches[key];
    if (!decision?.grows) {
      finalBranches[key] = full;
      continue;
    }
    const viewportWidth = (stats.find((s) => s.mobile === (key === "mobile")) as ViewportStat).viewportWidth;
    const keep = sizesValueAt(current, viewportWidth);
    if (keep === undefined) {
      unresolved = true;
    } else {
      decision.kept = true;
      finalBranches[key] = keep;
    }
  }
  // Every present branch keeping its value is no sizes proposal at all.
  const allKept = BRANCHES.filter((key) => fullBranches[key] !== undefined).every((key) => branches[key]?.kept === true);
  const proposedSizes = sizesManual || unresolved || allKept ? undefined : joinSizeBranches(finalBranches);
  for (const key of BRANCHES) {
    const decision = branches[key];
    if (!decision?.grows) continue;
    const delta = (decision.deltaBytes / 1024).toFixed(1);
    const outcome = decision.kept
      ? "kept current — use --allow-growth"
      : "current sizes could not be kept, so no sizes proposed — use --allow-growth";
    notes.push(`${key}: corrected sizes is sharper but larger (+${delta} KB/img); ${outcome}`);
  }

  // The page's sizes after the proposal: quality and bytes follow them.
  const finalSizes = proposedSizes ?? sizesLiteral;
  const sameAsFull = finalSizes === sizesFull;
  const finalSearch = sameAsFull ? fullSearch : await searchAtSizes(finalSizes);
  if (finalSearch.reason) notes.push(finalSearch.reason);
  const proposedQuality = finalSearch.proposedQuality;
  const qNew = proposedQuality ?? quality;
  // The projection under the full correction is kept as is; the final projection is copied so a confirmation can change it.
  const projFinal = { ...(sameAsFull ? projFull : await project(finalSizes, qNew)) };

  // Candidate widths that the ladder offers well above what a slot needs are reported as gaps.
  const candidates = nextCandidates(ctx.imageConfig, finalSizes, widthLiteral);
  if (candidates.kind === "w") {
    const gaps = new Set<number>();
    for (const s of stats) {
      const target = Math.ceil(s.slot * s.dpr);
      if (pickCandidate(candidates.widths, s.slot, s.dpr) > target * LADDER_GAP_RATIO) gaps.add(target);
    }
    for (const target of gaps) notes.push(`width ladder gap: add ${target} to deviceSizes`);
  }

  // Scores are taken at the reference viewport's width under the proposed sizes.
  const scoreWidth = widthFor(finalSizes, ref);
  const ssims: number[] = [];
  for (const sample of probe.samples) {
    try {
      const scored = await sampleEval(sample, served, qNew, scoreWidth);
      if (scored) ssims.push(scored.ssim);
    } catch (err) {
      logOnce(ctx, `projection ${sample.src}`, `skipping projection for ${sample.src}: ${message(err)}`);
    }
  }

  let estimated = true;
  if (ctx.profile === "next-default") {
    if (!ctx.opts.confirm) {
      notes.push(NOTE_NOT_CONFIRMED);
    } else if (proposedQuality !== undefined && probe.samples.length > 0) {
      // A confirmed result uses the served bytes of the primary format (AVIF when searched, else WebP).
      const primary: Format = ctx.searchFormats.includes("avif") ? "avif" : "webp";
      const outcome = await confirmQuality(ctx, probe.samples, proposedQuality, scoreWidth);
      const confirmedBytes = outcome?.confirmed ? outcome.bytes[primary] : undefined;
      if (confirmedBytes !== undefined) {
        projFinal[ref.name] = confirmedBytes;
        estimated = false;
      }
    }
  }
  result.estimated = estimated;

  // Savings: each projected viewport's saving times its instances, averaged over the projected viewports.
  const pairs = stats.filter((s) => s.bytes !== undefined && projFinal[s.name] !== undefined);
  result.savedBytesTotal =
    pairs.length === 0
      ? 0
      : pairs.reduce((sum, s) => sum + ((s.bytes as number) - projFinal[s.name]) * s.instances, 0) / pairs.length;

  result.proposed = {
    width: widthAt(finalSizes, ref),
    sizes: proposedSizes,
    sizesFull,
    quality: proposedQuality,
    projectedBytes: projFinal[ref.name],
    ssim: median(ssims),
    bytesByViewport: projFinal,
    bytesByViewportFull: projFull,
    branches,
  };
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

interface QualityProbe {
  /** Sample originals that decode. */
  samples: Sample[];
  /** Calibration offset per format (cdn profile only). */
  offsets: Partial<Record<Format, number>>;
}

interface QualityOutcome {
  proposedQuality?: number;
  reason?: string;
}

/** Fetches the sample originals and, for a cdn profile, calibrates each format. Neither depends on the width. */
async function prepareQuality(ctx: Context, usageObs: ImageObservation[], quality: number): Promise<QualityProbe> {
  const sources = unique(usageObs.flatMap((o) => (o.originalSrc ? [o.originalSrc] : []))).slice(0, ctx.cfg.samplesPerComponent);
  const samples: Sample[] = [];
  for (const src of sources) {
    const url = originalUrlFor(src, ctx.baseUrl);
    try {
      const buffer = await ctx.fetchCached(url);
      await loadReference(buffer, 1);
      samples.push({ src, buffer });
    } catch (err) {
      logOnce(ctx, url, `skipping sample ${url}: ${message(err)}`);
    }
  }

  const offsets: Partial<Record<Format, number>> = {};
  if (samples.length > 0 && ctx.profile === "cdn") {
    for (const format of ctx.searchFormats) {
      const fit = await calibrationOffset(await calibrationSamples(ctx, usageObs, format, quality), ctx.deps);
      if (fit) offsets[format] = fit.offset;
    }
  }
  return { samples, offsets };
}

/** Per-sample bisection per format at `width`, then the component's 95th percentile mapped onto the project's quality scale. */
async function searchAt(ctx: Context, probe: QualityProbe, quality: number, width: number): Promise<QualityOutcome> {
  const { cfg, deps } = ctx;
  const perSample: Record<Format, number[]> = { avif: [], webp: [] };
  for (const sample of probe.samples) {
    const ref = await loadReference(sample.buffer, width);
    for (const format of ctx.searchFormats) {
      perSample[format].push(await minPassingQuality(ref, format, quality, ctx.profile, cfg.threshold, cfg.tolerance, deps));
    }
  }

  const targets: number[] = [];
  for (const format of ctx.searchFormats) {
    const target = toTargetQuality(componentQuality(perSample[format]), probe.offsets[format], ctx.profile, quality);
    if (target === undefined) return { reason: `quality not proposed: no CDN ${format} variants observed for calibration` };
    targets.push(target);
  }
  return { proposedQuality: Math.max(...targets) };
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

type Scored = { bytes: number; ssim: number } | undefined;

/** `evaluate` memoised per usage: a (sample, format, quality, width) is encoded once however many viewports share it. */
function evaluator(ctx: Context, offsets: Partial<Record<Format, number>>) {
  const memo = new Map<string, Promise<Scored>>();
  return (sample: Sample, format: Format, cdnQ: number, width: number): Promise<Scored> => {
    const key = `${sample.src}|${format}|${cdnQ}|${width}`;
    let pending = memo.get(key);
    if (!pending) {
      pending = evaluate(ctx, sample.buffer, format, cdnQ, width, offsets);
      memo.set(key, pending);
    }
    return pending;
  };
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

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
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
