import { calibrationOffset, type CalibrationSample, type ConfirmSample } from "./calibrate.js";
import { encode, loadReference, type EncoderProfile } from "./encode.js";
import { adapterFor, cloudflareOriginal, originalFor, type QualityParam } from "./loaders.js";
import type { ImageConfig } from "./nextconfig.js";
import type { ImageObservation } from "./measure.js";
import {
  deriveSizeBranches,
  isSingleValue,
  isSizesValue,
  joinSizeBranches,
  overlaySizes,
  sizesSlotAt,
  sizesValueAt,
  type SizeBranches,
} from "./sizes.js";
import { formatScore, makeScorer } from "./metric.js";
import { componentQuality, minPassingQuality, toTargetQuality, type SearchDeps } from "./search.js";
import { nextCandidates, pickCandidate, pickForX } from "./srcset.js";
import { ssim, type RawImage } from "./ssim.js";
import type { ImageUsage, ImgtuneConfig, PropInfo } from "./types.js";

type Format = "avif" | "webp";

const DEFAULT_QUALITY = 75;
/** Rendered width may exceed slot x dpr by this factor before the width ladder is reported as a gap. */
const LADDER_GAP_RATIO = 1.25;
const CONFIRM_SAMPLES = 5;
/** A cdn format that does not decide the quality is noted when it loses more than delta plus this many points (R36, R38). */
const FALLBACK_EXTRA_POINTS = 3;
const CALIBRATION_SAMPLES = 5;
/** Projected bytes above this multiple of the current median count as growth. */
const GROWTH_RATIO = 1.05;
const NOTE_NOT_CONFIRMED = "estimated: not confirmed against /_next/image";
const NOTE_SIZES_FITS = "sizes already fits";
/** The same, for a usage with no sizes attribute: the page gets the 100vw default either way. */
const NOTE_SIZES_NO_CHANGE = "no sizes change worth making (no sizes attribute: 100vw default)";
const NOTE_VECTOR = "vector image: sizes/quality do not apply";
/** A sizes proposal saving fewer bytes per image than this, and under NEGLIGIBLE_RATIO of the current bytes, is dropped. */
const NEGLIGIBLE_BYTES = 200;
const NEGLIGIBLE_RATIO = 0.02;
/** The media branches of a `sizes` value, in the order the notes list them. */
const BRANCHES = ["mobile", "desktop"] as const;
export type Branch = (typeof BRANCHES)[number];
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

/** Mean current and corrected bytes of one branch's projected viewports. */
export interface BranchMeans {
  current: number;
  corrected: number;
}

export interface BranchDecision {
  branches: { mobile?: BranchGrowth; desktop?: BranchGrowth };
  /** The `sizes` value to propose; undefined for no proposal. */
  sizes?: string;
}

/**
 * The per-branch growth decision and the `sizes` it leads to. A branch grows when its corrected sizes projects more
 * than GROWTH_RATIO times its current bytes, and a growing branch keeps the current sizes in its own range. A branch
 * without means is not judged. `current` is the sizes as written (100vw when absent).
 *
 * A single unconditioned current value is kept as it is. A conditioned one is kept by laying the corrected branch in
 * front of it (see overlaySizes), so the current value still applies everywhere else. A current value this module does
 * not understand cannot be written safely: a growing branch then leaves no proposal. When every present branch grows,
 * nothing is proposed.
 */
export function decideBranches(full: SizeBranches, means: Partial<Record<Branch, BranchMeans>>, current: string): BranchDecision {
  const branches: BranchDecision["branches"] = {};
  for (const key of BRANCHES) {
    const m = means[key];
    if (full[key] === undefined || m === undefined) continue;
    branches[key] = { deltaBytes: m.corrected - m.current, grows: m.corrected > m.current * GROWTH_RATIO, kept: false };
  }
  const present = BRANCHES.filter((key) => full[key] !== undefined);
  const growing = (key: Branch): boolean => branches[key]?.grows === true;
  if (!present.some(growing)) return { branches, sizes: joinSizeBranches(full) };

  for (const key of present) {
    const decision = branches[key];
    if (decision?.grows) decision.kept = true;
  }
  if (present.every(growing)) return { branches, sizes: undefined };
  if (!isSizesValue(current)) {
    for (const key of present) {
      const decision = branches[key];
      if (decision) decision.kept = false;
    }
    return { branches, sizes: undefined };
  }
  if (isSingleValue(current)) {
    // An unconditioned value is the same at every width, so it stands in for the growing branch as it is.
    const value = sizesValueAt(current, 0) as string;
    const final: SizeBranches = {};
    for (const key of present) final[key] = growing(key) ? value : full[key];
    return { branches, sizes: joinSizeBranches(final) };
  }
  // Both branches are present here: one present branch that grows is already "every present branch grows".
  const sizes = growing("mobile")
    ? overlaySizes("desktop", full.desktop as string, current)
    : overlaySizes("mobile", full.mobile as string, current);
  return { branches, sizes };
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
    /** The bar per format (R38): the median over samples of max(floor, current score - delta) at the proposed width. */
    minScore?: { avif?: number; webp?: number };
    bytesByViewport?: Record<string, number>;
    /** `bytesByViewport` under the full correction, to compare with the proposed sizes. */
    bytesByViewportFull?: Record<string, number>;
    /** The quality searched at the full correction's width: what `apply --allow-growth` writes with `sizesFull`. */
    qualityFull?: number;
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
  /** Derived: true when any media branch grows bytes under the full correction. */
  grows?: boolean;
  /** cdn profile: the CDN-to-local quality offset per format the search used, so verify scores on the same scale. */
  calibration?: Partial<Record<Format, number>>;
}

export interface AnalyseOptions {
  /** Confirms a `next-default` quality against the running app's `/_next/image`. */
  confirm?: (
    samples: ConfirmSample[],
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
  const url = new URL(src, baseUrl);
  return cloudflareOriginal(url) ?? url.toString();
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
    // The configured metric scores every decision; a test can inject its own scorer.
    deps: { score: makeScorer(cfg.metric, { projectDir: cfg.projectDir, binary: cfg.ssimulacra2Path }), ...(opts.deps ?? {}) },
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
  const loader = loaderOfUsage(usageObs, ctx.baseUrl);
  const urlQuality = currentQualityFromSrc(usageObs, ctx.baseUrl);
  const quality = literalQuality ?? urlQuality ?? loader?.defaultQuality ?? DEFAULT_QUALITY;

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
  // A vector file has no width to scale to, so sizes and quality do not apply to it.
  const servedFormats = unique(usageObs.flatMap((o) => (o.contentType && formatOf(o.contentType) ? [formatOf(o.contentType) as string] : [])));
  if (servedFormats.length > 0 && servedFormats.every((format) => format === "svg+xml")) {
    notes.push(NOTE_VECTOR);
    return result;
  }

  if (literalQuality === undefined && urlQuality === undefined && loader?.defaultQuality === undefined) {
    notes.push(`current quality assumed ${DEFAULT_QUALITY} (not found in props or URL)`);
  }
  // A loader that takes no quality in its URL cannot have one set by the code either: the proposal is sizes only.
  const sizesOnly = loader !== undefined && loader.qualityParam !== "yes" && urlQuality === undefined;
  if (sizesOnly) notes.push(`loader ${loader.name} cannot set quality (sizes only)`);

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
  // next-default: every searched format must pass (R16). cdn: the format the page was served decides (R36).
  const deciding: Format[] = ctx.profile === "cdn" ? [served] : ctx.searchFormats;

  /**
   * The score a sample must reach in `format` at `width`. An absolute bar is the threshold. The relative rule (R38)
   * takes max(floor, current score - delta), with the current quality scored like the candidates at the same width.
   */
  const barAt = async (sample: Sample, format: Format, width: number): Promise<number> => {
    if (ctx.cfg.delta === undefined) return ctx.cfg.threshold;
    const current = await sampleEval(sample, format, quality, width);
    if (!current) throw new Error(`no current ${format} score for ${sample.src}`);
    return Math.max(ctx.cfg.threshold, current.ssim - ctx.cfg.delta);
  };

  // One search per width: the full correction and the final sizes often share one.
  const searches = new Map<number, Promise<QualityOutcome>>();
  /** Quality searched at the reference viewport's width under `sizes`. Samples are not searched without originals. */
  const searchAtWidth = (width: number): Promise<QualityOutcome> => {
    let pending = searches.get(width);
    if (!pending) {
      pending = searchAt(ctx, probe, quality, width, deciding, (sample, format) => barAt(sample, format, width));
      searches.set(width, pending);
    }
    return pending;
  };
  /**
   * The quality must hold at every width the usage is served at (R38: each sample's bar is per width), so every
   * projected viewport's width is searched and the highest target wins. A refusal at any width refuses the whole.
   */
  const searchAtSizes = async (sizes: string | undefined): Promise<QualityOutcome> => {
    if (sizesOnly || probe.samples.length === 0) return {};
    const widths = unique([widthFor(sizes, ref), ...stats.filter((s) => s.bytes !== undefined && s.servedWidth !== undefined).map((s) => widthFor(sizes, s))]);
    const outcomes = await Promise.all(widths.map((width) => searchAtWidth(width)));
    const refused = outcomes.find((o) => o.proposedQuality === undefined);
    if (refused) return refused;
    return { proposedQuality: Math.max(...outcomes.map((o) => o.proposedQuality as number)) };
  };

  /** Scores of each sample at `format`, quality `q` and `width`; a sample that cannot be scored is skipped. */
  const scoresAt = async (format: Format, q: number, width: number): Promise<number[]> => {
    const out: number[] = [];
    for (const sample of probe.samples) {
      try {
        const scored = await sampleEval(sample, format, q, width);
        if (scored) out.push(scored.ssim);
      } catch (err) {
        logOnce(ctx, `projection ${sample.src}`, `skipping projection for ${sample.src}: ${message(err)}`);
      }
    }
    return out;
  };

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
  const means: Partial<Record<Branch, BranchMeans>> = {};
  for (const key of BRANCHES) {
    const members = stats.filter((s) => s.mobile === (key === "mobile") && s.bytes !== undefined && projFull[s.name] !== undefined);
    if (members.length === 0) continue;
    means[key] = { current: mean(members.map((s) => s.bytes as number)), corrected: mean(members.map((s) => projFull[s.name])) };
  }
  const decision = decideBranches(fullBranches, means, sizesLiteral ?? ABSENT_SIZES);
  const branches = decision.branches;
  let proposedSizes = decision.sizes;
  result.grows = BRANCHES.some((key) => branches[key]?.grows === true);
  for (const key of BRANCHES) {
    const decision = branches[key];
    if (!decision?.grows) continue;
    const delta = (decision.deltaBytes / 1024).toFixed(1);
    const outcome = decision.kept
      ? "kept current — use --allow-growth"
      : "current sizes could not be kept, so no sizes proposed — use --allow-growth";
    notes.push(`${key}: corrected sizes is sharper but larger (+${delta} KB/img); ${outcome}`);
  }

  // A sizes change the page would not notice is no proposal: the same slot at every measured viewport, or a negligible
  // saving. Quality and bytes follow the sizes that remain.
  const sameSlotAsCurrent = (sizes: string, current: string): boolean =>
    stats.every((s) => {
      const a = sizesSlotAt(sizes, s.viewportWidth);
      const b = sizesSlotAt(current, s.viewportWidth);
      return a !== undefined && b !== undefined && Math.round(a) === Math.round(b);
    });
  const negligibleSaving = (proj: Record<string, number>): boolean => {
    const pairs = stats.filter((s) => s.bytes !== undefined && proj[s.name] !== undefined);
    if (pairs.length === 0) return false;
    const saved = mean(pairs.map((s) => (s.bytes as number) - proj[s.name]));
    const current = mean(pairs.map((s) => s.bytes as number));
    // Growth is not a saving: a proposal that grows bytes is judged by the branch rules, not here.
    return saved >= 0 && saved < NEGLIGIBLE_BYTES && saved < NEGLIGIBLE_RATIO * current;
  };
  const settle = async (sizes: string | undefined) => {
    const finalSizes = sizes ?? sizesLiteral;
    const sameAsFull = finalSizes === sizesFull;
    const search = sameAsFull ? fullSearch : await searchAtSizes(finalSizes);
    const qNew = search.proposedQuality ?? quality;
    // The projection under the full correction is kept as is; the final projection is copied so a confirmation can change it.
    const proj = { ...(sameAsFull ? projFull : await project(finalSizes, qNew)) };
    return { finalSizes, search, qNew, proj };
  };
  // An absent sizes is the 100vw default, so it is the current value for the slot comparison.
  const currentSizes = sizesLiteral ?? ABSENT_SIZES;
  let fits = proposedSizes !== undefined && sameSlotAsCurrent(proposedSizes, currentSizes);
  let settled = await settle(fits ? undefined : proposedSizes);
  if (!fits && proposedSizes !== undefined && negligibleSaving(settled.proj)) {
    fits = true;
    settled = await settle(undefined);
  }
  if (fits) {
    proposedSizes = undefined;
    notes.push(sizesLiteral === undefined ? NOTE_SIZES_NO_CHANGE : NOTE_SIZES_FITS);
  }
  const { finalSizes, qNew, proj: projFinal } = settled;
  if (settled.search.reason) notes.push(settled.search.reason);
  const proposedQuality = settled.search.proposedQuality;
  // The full correction is no proposal either when it resolves to the current slots (it is what --allow-growth writes).
  const sizesFullFits = sizesFull !== undefined && sameSlotAsCurrent(sizesFull, currentSizes);

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
  const ssims = await scoresAt(served, qNew, scoreWidth);
  // The bar each format's samples had to reach, at this width (R38), for display in the report.
  let minScore: { avif?: number; webp?: number } | undefined;
  if (ctx.cfg.delta !== undefined) {
    minScore = {};
    for (const format of ctx.searchFormats) {
      const bars: number[] = [];
      for (const sample of probe.samples) {
        try {
          bars.push(await barAt(sample, format, scoreWidth));
        } catch (err) {
          logOnce(ctx, `bar ${sample.src}`, `skipping bar for ${sample.src}: ${message(err)}`);
        }
      }
      minScore[format] = median(bars);
    }
  }
  // The format that does not decide is noted when the chosen quality costs it more than delta plus 3 points (R36, R38).
  // Only the relative rule has a delta, so an absolute bar gives no such note.
  if (ctx.profile === "cdn" && ctx.cfg.delta !== undefined) {
    for (const other of ctx.searchFormats.filter((format) => format !== served)) {
      const before = median(await scoresAt(other, quality, scoreWidth));
      const after = median(await scoresAt(other, qNew, scoreWidth));
      if (before === undefined || after === undefined) continue;
      const drop = before - after;
      if (drop > ctx.cfg.delta + FALLBACK_EXTRA_POINTS) {
        notes.push(`${other} fallback drops ${formatScore(ctx.cfg.metric, drop)} points at q${qNew}`);
      }
    }
  }

  let estimated = true;
  if (ctx.profile === "next-default") {
    if (!ctx.opts.confirm) {
      notes.push(NOTE_NOT_CONFIRMED);
    } else if (proposedQuality !== undefined && probe.samples.length > 0) {
      // A confirmed result uses the served bytes of the primary format (AVIF when searched, else WebP).
      const primary: Format = ctx.searchFormats.includes("avif") ? "avif" : "webp";
      const outcome = await confirmQuality(ctx, probe.samples, proposedQuality, scoreWidth, barAt);
      const confirmedBytes = outcome?.confirmed ? outcome.bytes[primary] : undefined;
      if (confirmedBytes !== undefined) {
        projFinal[ref.name] = confirmedBytes;
        estimated = false;
      }
    }
  }
  result.estimated = estimated;
  if (Object.keys(probe.offsets).length > 0) result.calibration = { ...probe.offsets };

  // Savings: each projected viewport's saving times its instances, averaged over the projected viewports.
  const pairs = stats.filter((s) => s.bytes !== undefined && projFinal[s.name] !== undefined);
  result.savedBytesTotal =
    pairs.length === 0
      ? 0
      : pairs.reduce((sum, s) => sum + ((s.bytes as number) - projFinal[s.name]) * s.instances, 0) / pairs.length;

  result.proposed = {
    width: widthAt(finalSizes, ref),
    sizes: proposedSizes,
    sizesFull: sizesFullFits ? undefined : sizesFull,
    quality: proposedQuality,
    qualityFull: fullSearch.proposedQuality,
    projectedBytes: projFinal[ref.name],
    ssim: median(ssims),
    minScore,
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
  const firstBySrc = new Map<string, ImageObservation>();
  for (const o of usageObs) if (o.originalSrc && !firstBySrc.has(o.originalSrc)) firstBySrc.set(o.originalSrc, o);
  const samples: Sample[] = [];
  for (const [src, o] of [...firstBySrc].slice(0, ctx.cfg.samplesPerComponent)) {
    const url = originalFor(o.currentSrc, src, ctx.baseUrl);
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

/**
 * Per-sample bisection per deciding format at `width`, then the component's 95th percentile mapped onto the project's
 * quality scale. For cdn every format the CDN can serve must be calibrated, since the other one is scored as fallback.
 */
async function searchAt(
  ctx: Context,
  probe: QualityProbe,
  quality: number,
  width: number,
  formats: Format[],
  barAt: (sample: Sample, format: Format) => Promise<number>,
): Promise<QualityOutcome> {
  const { cfg, deps } = ctx;
  if (ctx.profile === "cdn") {
    for (const format of ctx.searchFormats) {
      if (probe.offsets[format] === undefined) return { reason: `quality not proposed: no CDN ${format} variants observed for calibration` };
    }
  }
  const perSample: Record<Format, number[]> = { avif: [], webp: [] };
  for (const sample of probe.samples) {
    try {
      const ref = await loadReference(sample.buffer, width);
      const found: Partial<Record<Format, number>> = {};
      for (const format of formats) {
        const bar = await barAt(sample, format);
        found[format] = await minPassingQuality(ref, format, quality, ctx.profile, bar, cfg.tolerance, deps);
      }
      for (const format of formats) perSample[format].push(found[format] as number);
    } catch (err) {
      // One failing sample is skipped; the others still decide the component quality.
      logOnce(ctx, `search ${sample.src}`, `skipping quality search for ${sample.src}: ${message(err)}`);
    }
  }
  if (formats.some((format) => perSample[format].length === 0)) {
    return { reason: "quality not proposed: no sample could be searched" };
  }

  const targets: number[] = [];
  for (const format of formats) {
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
    const url = originalFor(o.currentSrc, o.originalSrc, ctx.baseUrl);
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
  const score = ctx.deps.score ?? ssim;
  return { bytes: enc.bytes, ssim: await score(ref, enc.decoded) };
}

type Scored = { bytes: number; ssim: number } | undefined;

/** `evaluate` memoised per usage: a (sample, format, quality, width) is encoded once however many viewports share it. */
export function evaluator(ctx: Context, offsets: Partial<Record<Format, number>>) {
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
  barAt: (sample: Sample, format: Format, width: number) => Promise<number>,
): Promise<{ confirmed: boolean; bytes: { avif?: number; webp?: number } } | undefined> {
  const confirm = ctx.opts.confirm;
  if (!confirm) return undefined;
  try {
    const picked: ConfirmSample[] = [];
    for (const s of samples.slice(0, CONFIRM_SAMPLES)) {
      // Each sample is judged against its own bar per format (R38), the same bars the search used.
      const minScore: Partial<Record<Format, number>> = {};
      try {
        for (const format of ctx.searchFormats) minScore[format] = await barAt(s, format, width);
      } catch (err) {
        logOnce(ctx, `confirm bar ${s.src}`, `skipping confirmation of ${s.src}: ${message(err)}`);
        continue;
      }
      picked.push({ src: s.src, ref: await loadReference(s.buffer, width), width, minScore });
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

/** The loader the usage's observed URLs came from (most frequent), its quality parameter and documented default. */
function loaderOfUsage(
  observations: ImageObservation[],
  baseUrl: string,
): { name: string; qualityParam: QualityParam; defaultQuality?: number } | undefined {
  const resolved = observations.flatMap((o) => {
    try {
      return [adapterFor(o.currentSrc, baseUrl)];
    } catch {
      return [];
    }
  });
  const name = mode(resolved.map((r) => r.adapter.name));
  const hit = resolved.find((r) => r.adapter.name === name);
  if (!hit) return undefined;
  return { name: hit.adapter.name, qualityParam: hit.adapter.qualityParam, defaultQuality: hit.adapter.defaultQuality };
}

/** The median quality the observed URLs ask for, through their loader. */
function currentQualityFromSrc(observations: ImageObservation[], baseUrl: string): number | undefined {
  const values = observations.flatMap((o) => {
    try {
      const { adapter, url } = adapterFor(o.currentSrc, baseUrl);
      const q = adapter.quality(url);
      return q === undefined ? [] : [q];
    } catch {
      return [];
    }
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
