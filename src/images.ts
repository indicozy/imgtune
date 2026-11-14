// The per-image fix records of a scan (`images[]`): one entry per distinct image element, merged across viewports, with
// its locator, what it can be tuned by, what it is served, its layout chain, the fix it gets and the evidence for it.
// Built from the instances the page analysis already measured: no measurement happens here.

import { sha1 } from "./atomic.js";
import {
  deriveSizesFromLayout,
  sameStructure,
  slotAt,
  type FormulaPoint,
  type LayoutNode,
  type SizesBasis,
  type SizesBranch,
  type SizesResult,
} from "./layout.js";
import { COMPONENT_NAME, loaderName, sanitizeText, urlPattern, type LocatorKind, type LocatorVia, type OwnerSource } from "./locate.js";
import { undersizedProposal, type ProposalPoint } from "./candidates.js";
import { sizesBranchAt, sizesSlotAt } from "./sizes.js";
import { parseSrcset } from "./srcset-parse.js";
import type { HiddenReason, Instance, ObservedImage, ViewportObservation } from "./remote.js";
import { animatedTarget } from "./media-model.js";
import type { AnimatedFix } from "./video-analysis.js";
import type { VectorFix } from "./vector-art.js";

export type { SizesBasis, SizesBranch };

/** The first path segment of a harness route: a page the agent adds to measure a component in isolation. */
export const HARNESS_SEGMENT = "__imgtune";

/** The evidence rung a scanned page's measurements earn (see DECISIONS: measured-page > measured-harness). */
export type MeasuredRung = "measured-page" | "measured-harness";

/**
 * The rung of a page's measurements: a harness route (`/__imgtune/<component>`) measures the component in isolation, not
 * the page the user sees, so its records are `measured-harness`. Any other scanned URL is `measured-page`.
 */
export function rungOfPage(pageUrl: string, harness = false): MeasuredRung {
  if (harness) return "measured-harness";
  try {
    return new URL(pageUrl).pathname.split("/")[1] === HARNESS_SEGMENT ? "measured-harness" : "measured-page";
  } catch {
    return "measured-page";
  }
}

export interface ImageLocator {
  /** Component names, nearest first (dev builds of React only). */
  component: string[];
  /** Project-relative source file and line of the element (dev builds, through the source map). */
  file?: string;
  /**
   * How the file:line was found: `react-dev` (the React owner's source, or its stack through the source map), or
   * `prod-sourcemap` (a production build: the owner component's definition, through its chunk's source map).
   */
  via?: LocatorVia;
  line?: number;
  /**
   * The check of the resolved file:line (see LocatorKind). `image`: the line renders the image, so the source is verified.
   * `owner`: the line is the call site of the component that renders the image; the image is inside that component.
   * `unread` and `unchecked`: the project file was not read (a non-local page, or no project file here).
   */
  kind?: LocatorKind;
  /** True only when the source was read from a local project and its line renders an image (kind `image`). */
  verified?: boolean;
  testid?: string;
  alt?: string;
  selector: string;
  /** The image's class attribute. */
  classes: string;
  /** The loader URL with w, q and the CDN transform taken out. */
  urlPattern?: string;
  /** next-default, a CDN's adapter name, cdn:<host>, plain-img, or unknown. */
  loader: string;
  /**
   * The project owner chain above the element, nearest first (dev builds of React; see OwnerSource). Its first entry is
   * file:line. The caller map (hints.ts) reads the entries above the first.
   */
  ownerChain?: OwnerSource[];
  /**
   * Where to look in the project when no source file resolved (a server component has a name but no file:line): the
   * component, its likely file name, a glob, and the alt and URL pattern. Clues only: nothing is read from the project.
   */
  searchHints?: SearchHints;
}

export interface SearchHints {
  component?: string;
  /** The file the component would be in, as a pattern. */
  fileName?: string;
  /** The glob to search the project with. */
  glob?: string;
  alt?: string;
  urlPattern?: string;
}

/**
 * Names the scanned app gives a component it cannot name. They say nothing about the file, so they are never searched for
 * (the hint says "owner unknown" instead).
 */
export const OWNER_PLACEHOLDERS: ReadonlySet<string> = new Set(["UnknownOwner", "Unknown", "Anonymous"]);

/** The search clues of an element without a resolved source; undefined when there are none. */
export function searchHintsOf(locator: Pick<ImageLocator, "component" | "alt" | "urlPattern">): SearchHints | undefined {
  const hints: SearchHints = {};
  const name = locator.component[0];
  if (name !== undefined && COMPONENT_NAME.test(name) && !OWNER_PLACEHOLDERS.has(name)) {
    hints.component = name;
    hints.fileName = `${name}.(tsx|jsx|ts|js)`;
    hints.glob = `**/${name}.*`;
  }
  if (locator.alt) hints.alt = locator.alt;
  if (locator.urlPattern) hints.urlPattern = locator.urlPattern;
  return Object.keys(hints).length > 0 ? hints : undefined;
}

export interface ImagePerViewport {
  viewport: string;
  /**
   * The element's place in the document among the page's <img> elements, at this viewport. The locate join pairs elements
   * of one URL in this order. Absent in scans from before --locate-only: such a scan cannot be joined.
   */
  domIndex?: number;
  dpr: number;
  renderedCssPx: number;
  /** Device pixels the image needs at this viewport (the scan's `needed`). */
  neededPx: number;
  /** Pixel width of the served file, when it was decoded. */
  servedPx?: number;
  servedBytes: number;
  /** The `sizes` value the browser resolved at this viewport, in CSS px (undefined without sizes). */
  sizesResolvedPx?: number;
  /** The media condition of the sizes branch that matched, or "default". */
  sizesMatchedCondition?: string;
  /** Served pixels per device pixel needed. Above 1 the file is larger than the screen can show. */
  overFetchRatio?: number;
  undersized: boolean;
  /** The element's own file was received at this viewport. */
  loaded: boolean;
  /**
   * The element is the page's largest contentful paint at this viewport (read before the scroll; see lcp.ts). Absent in
   * scans from before this field, and at a viewport whose LCP was not read (a resized viewport of --shared-loads).
   */
  lcp?: boolean;
  /** Why the element is not measured here (duplicate of another element, data URI, ...). */
  skipped?: string;
  /** The browser loaded the file but the element is not shown at this viewport (see HiddenReason). */
  hidden?: HiddenReason;
}

export interface ImageFix {
  sizes?: { value: string; basis: SizesBasis; rung: MeasuredRung; branches: SizesBranch[] };
  /** Plain images: the device pixel width the file needs at the reference viewport. */
  width?: number;
  quality?: {
    /** The max of the per-image targets of the group, per served format (the group rule). */
    perFormat: Record<string, number>;
    groupRule: "max-of-targets";
    /** The group (a component, or the URL pattern) the maximum comes from, and how many images were scored in it. */
    group: string;
    samples: number;
    current: number;
    qualityAssumed: boolean;
  };
  format?: string;
  /**
   * Two numbers, never netted: bytes the fix saves per page view, and sharpness bytes it adds on undersized images. The
   * saving is split: `sizes` is the measured saving of the smaller srcset candidate (exact), `quality` the estimated
   * quality and format saving on top of it (est.). sizes + quality = saved.
   */
  bytes: { saved: number; addedForSharpness: number; sizes?: number; quality?: number };
  /**
   * Set when the proposed sizes was dropped: its predicted outcome adds at least as many bytes as it saves (or saves none), so
   * it is not a saving. `sizes` is then absent (see sizes-outcome.ts).
   */
  noSaving?: string;
  /**
   * A CDN's auto quality (Cloudinary q_auto): `handled` when its est. quality saving is below the share that makes it worth
   * an explicit quality (see CDN_AUTO_QUALITY_SHARE). `saved` is the group's est. quality saving per view, which is left out
   * of `bytes` when handled, and named in the hint otherwise.
   */
  cdnQuality?: { handled: boolean; saved: number };
  /** The format is negotiated by the CDN (f_auto, auto=format) on a jpeg or png: no format saving is counted or proposed. */
  formatHandled?: true;
  /**
   * An animated image (GIF, animated WebP or APNG): its animation, and the encode it is a candidate for (see
   * video-analysis.ts). Absent for a still image. Its bytes stay in the image totals.
   */
  animated?: AnimatedFix;
  /**
   * A still raster that looks like vector art (flat colours): its flatness, and the traced SVG when the vector check ran (see
   * vector-art.ts and vector-phase.ts). Absent for a photo-like image.
   */
  vector?: VectorFix;
}

/**
 * Whether a served format takes the lossless rules (a local resize and the AVIF proposal): a jpeg or png, or a static GIF
 * (a palette file, judged as a PNG). An animated GIF does not: its saving is an encode.
 */
export function losslessServed(format: string | undefined, animated: boolean): boolean {
  return format === "jpeg" || format === "png" || (format === "gif" && !animated);
}

/** The fix of a loaded-but-not-shown element, by case (see HiddenFix.action). */
export type HiddenAction = "responsive" | "lazy" | "never-shown-on-load";

/**
 * An element (an image, or a CSS background layer) the browser loaded that is not shown on load at some viewports. Its bytes
 * are reported apart from the savings: the saving of a hidden file is not counted in the page numbers.
 */
export interface HiddenFix {
  /** The reasons the element is hidden, over its hidden viewports, each once. */
  reasons: HiddenReason[];
  /** The element is in a tab panel, a hidden subtree, an aria-hidden one or a closed <details>, at a hidden viewport. */
  inPanel: boolean;
  /** The element is shown by a :hover rule (a hover swap) at a hidden viewport. */
  hover?: true;
  /** A hidden viewport was not re-read (past REVEAL_CAP), so the reason is the snapshot's and unverified. */
  unstable?: "unknown";
  /** The viewports where it is not shown on load. */
  viewports: string[];
  /** The viewports of the scan: `viewports` of them hide it. */
  of: number;
  /** The width of each viewport the element was seen at, by viewport name (the media condition of a responsive twin uses it). */
  widths: Record<string, number>;
  /** The viewports where it is shown on load (empty when it is never shown on load). */
  shownIn: string[];
  /**
   * The fix, by case: `responsive` (shown on load at some viewports and hidden at others: a responsive twin, serve one file per
   * viewport), `lazy` (a carousel slide, a tab copy or a closed details, or a hover swap: loading="lazy", or load on demand),
   * `never-shown-on-load` (no viewport shows it on load: remove it, or load it on demand when the menu, modal or hover opens).
   */
  action: HiddenAction;
  /** The bytes per view the element downloads while it is not shown on load: the hidden viewports' bytes over all the viewports. */
  perViewBytes: number;
  /**
   * The element already has loading="lazy" and still downloads: it is within the browser's lazy-load distance of a hidden
   * viewport. Its fix is to render it on activation, not to add lazy again (see hiddenLines in hints.ts).
   */
  alreadyLazy?: true;
}

/** One viewport's entry of an element: its bytes and, when it is hidden there, why. */
export interface HiddenEntry {
  viewport: { name: string; width: number };
  bytes: number;
  hidden?: HiddenReason;
  inPanel: boolean;
  hover: boolean;
  /** The element has loading="lazy" (absent for a background layer). */
  lazy?: boolean;
  /** The reading was not re-read (see HiddenFix.unstable). */
  unstable?: boolean;
}

/** The hidden fix of an element from its entries (one per viewport it was measured at), or undefined when it is shown on load everywhere. */
export function hiddenFixCore(entries: HiddenEntry[], viewportCount: number): HiddenFix | undefined {
  const hidden = entries.filter((e) => e.hidden !== undefined);
  if (hidden.length === 0) return undefined;
  const reasons = [...new Set(hidden.map((e) => e.hidden).filter((r): r is HiddenReason => r !== undefined))];
  const inPanel = hidden.some((e) => e.inPanel);
  const hover = hidden.some((e) => e.hover);
  const unstable = hidden.some((e) => e.unstable === true);
  const shownIn = entries.filter((e) => e.hidden === undefined).map((e) => e.viewport.name);
  const alreadyLazy = hidden.some((e) => e.lazy === true);
  const onlyClipped = reasons.every((r) => r === "clipped");
  // A responsive twin: shown on load somewhere, and hidden by a rule that is not a carousel's clipping.
  const action: HiddenAction =
    shownIn.length > 0 && !onlyClipped ? "responsive" : reasons.includes("clipped") || inPanel || hover ? "lazy" : "never-shown-on-load";
  return {
    reasons,
    inPanel,
    ...(hover ? { hover: true as const } : {}),
    ...(unstable ? { unstable: "unknown" as const } : {}),
    viewports: hidden.map((e) => e.viewport.name),
    of: viewportCount,
    widths: Object.fromEntries(entries.map((e) => [e.viewport.name, e.viewport.width])),
    shownIn,
    action,
    ...(alreadyLazy ? { alreadyLazy: true as const } : {}),
    perViewBytes: hidden.reduce((sum, e) => sum + e.bytes, 0) / viewportCount,
  };
}

/** The hidden fix of an image element from its instances (one per viewport). */
export function hiddenFixOf(members: Instance[], viewportCount: number): HiddenFix | undefined {
  return hiddenFixCore(
    members.map((m) => ({
      viewport: { name: m.viewport.name, width: m.viewport.width },
      bytes: m.bytes,
      hidden: m.kind === "hidden" ? m.img.hidden : undefined,
      inPanel: m.img.inPanel === true,
      hover: m.img.hover === true,
      lazy: m.img.lazy === true,
      unstable: m.img.unstable === "unknown",
    })),
    viewportCount,
  );
}

/**
 * The page's loaded-but-not-shown totals, counted over the records (one record per element or background layer, so the
 * count and the cases are the same unit). Undefined when no record is hidden.
 */
export function hiddenTotalsOf(records: ImageRecord[], viewportCount: number): HiddenPage | undefined {
  const hidden = records.flatMap((r) => (r.hidden !== undefined ? [r.hidden] : []));
  if (hidden.length === 0) return undefined;
  const cases: Record<HiddenAction, number> = { responsive: 0, lazy: 0, "never-shown-on-load": 0 };
  for (const fix of hidden) cases[fix.action]++;
  return {
    images: hidden.length,
    bytesPerView: hidden.reduce((sum, fix) => sum + fix.perViewBytes, 0),
    cases,
  };
}

/** The loaded-but-not-shown totals of a page: the records that are hidden, their count, bytes per view and cases. */
export interface HiddenPage {
  /** The records (elements and background layers) that are hidden at some viewport. Equals the sum of `cases`. */
  images: number;
  /** Their files' bytes per view, summed over the records (not in the savings). */
  bytesPerView: number;
  cases: Record<HiddenAction, number>;
}

export interface ImageRecord {
  id: string;
  /** A CSS background layer (see backgrounds.ts). Absent for an <img>, srcset or picture element. */
  kind?: "css-background";
  page: string;
  locator: ImageLocator;
  tunable: { width: boolean; quality: boolean; reason?: string };
  current: {
    /** The URL the browser loaded at the reference viewport (recheck compares it to skip unchanged images). */
    src?: string;
    sizes?: string;
    srcsetCandidates: { url: string; width: number }[];
    quality?: number;
    qualityAssumed?: boolean;
    format?: string;
    naturalWidth?: number;
  };
  lazy?: boolean;
  /** The viewports at which the element is the page's largest contentful paint (see lcp.ts). Absent in older scans; [] when none. */
  lcpViewports?: string[];
  /** Set when the browser loaded the element's file but it is not shown at some viewport (see HiddenFix). */
  hidden?: HiddenFix;
  /** Set when the element's source was read from a dev page by `scan --locate-only` (see locate-join.ts). */
  locate?: { viewport: string; by: "alt-order" | "url-unique"; devIndex: number };
  /**
   * The record of a video's poster. Its locator is the video's, not an <img>'s, so it is never joined to an <img> of the dev
   * page (locate-join.ts): the poster's evidence names the video.
   */
  poster?: true;
  perViewport: ImagePerViewport[];
  layoutChain?: {
    viewport: string;
    nodes: LayoutNode[];
    skipped: string[];
    truncated: boolean;
    /** The viewports whose chain has another structure than the reference chain, in full. */
    diffs: { viewport: string; nodes: LayoutNode[] }[];
  };
  fix: ImageFix;
  evidence: { rung: MeasuredRung; notes: string[] };
}

/** A source resolved for one observed element: its file and line, and its component names. */
export interface ResolvedSource {
  file?: string;
  line?: number;
  component: string[];
  via?: LocatorVia;
  /** The check of file:line against the project file (see LocatorKind). */
  check?: LocatorKind;
  /** The project owners above the element, nearest first (dev builds; see OwnerSource). The first is file:line. */
  ownerChain?: OwnerSource[];
}

export interface BuildInput {
  pageUrl: string;
  /** --harness: the page is measured in isolation whatever its URL. */
  harness?: boolean;
  observations: ViewportObservation[];
  instances: Instance[];
  refName: string;
  resolved: Map<ObservedImage, ResolvedSource>;
  currentQuality: (src: string, pageUrl: string) => { quality: number; assumed: boolean };
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The key that finds an element across runs: its source file, else its components, else its test id, else its DOM path.
 * The line is not part of it: an edit above an element moves its line, and an id that moved with it would read as gone
 * on recheck. The ordinal among the elements of one file, in document order, tells them apart.
 */
function baseKey(img: ObservedImage, source: ResolvedSource | undefined): string {
  if (source?.file) return source.file;
  if (source && source.component.length > 0) return `component:${source.component.join(">")}`;
  if (img.locator?.testid) return `testid:${img.locator.testid}`;
  return `css:${img.locator?.selector ?? "img"}`;
}

/** The loader, the URL pattern, and the tunable flags of one element, from its reference instance. */
function locatorOf(member: Instance, pageUrl: string, source: ResolvedSource | undefined): ImageLocator {
  const img = member.img;
  const src = img.currentSrc || parseSrcset(img.srcset, pageUrl)[0]?.url || "";
  const locator: ImageLocator = {
    component: source?.component ?? [],
    selector: sanitizeText(img.locator?.selector ?? "img", 300),
    classes: sanitizeText(img.classes, 120),
    loader: src ? loaderName(src, pageUrl) : "unknown",
  };
  if (source?.file !== undefined) {
    locator.file = source.file;
    locator.line = source.line;
    if (source.via !== undefined) locator.via = source.via;
    locator.kind = source.check ?? "unchecked";
    locator.verified = locator.kind === "image";
    if (source.ownerChain?.length) locator.ownerChain = source.ownerChain;
  }
  if (img.locator?.testid !== undefined) locator.testid = sanitizeText(img.locator.testid, 120);
  if (img.locator?.alt !== undefined) locator.alt = sanitizeText(img.locator.alt, 120);
  if (src) locator.urlPattern = sanitizeText(urlPattern(src, pageUrl) ?? "", 300);
  if (source?.file === undefined) {
    const searchHints = searchHintsOf(locator);
    if (searchHints !== undefined) locator.searchHints = searchHints;
  }
  return locator;
}

/** What the element can be tuned by. A loader that ignores w (or q) is not tunable there: the fix is in the loader. */
function tunableOf(member: Instance, pageUrl: string, loader: string): { width: boolean; quality: boolean; reason?: string } {
  if (loader === "plain-img") return { width: true, quality: true };
  const img = member.img;
  const candidates = parseSrcset(img.srcset, pageUrl);
  const distinct = new Set(candidates.map((c) => c.url)).size;
  const url = img.currentSrc;
  const width = candidates.length > 0 ? distinct > 1 : /[?&](w|width)=/.test(url);
  const quality = member.qualityParam === "yes" && (member.loader !== "generic" || /[?&](q|quality)=/.test(url));
  if (width && quality) return { width, quality };
  return { width, quality, reason: "fix in the loader" };
}

/** The sizes value of one element, per media branch, from its measured points and their layout chains. */
/** The measured viewports of a group as the proposal check reads them. */
function measuredPoints(members: Instance[]): ProposalPoint[] {
  return members
    .filter((m) => m.renderedWidth >= 1 && m.kind !== "hidden")
    .map((m) => ({ viewport: m.viewport.name, viewportWidth: m.viewport.width, dpr: m.viewport.dpr, renderedWidth: m.renderedWidth, srcset: m.img.srcset }));
}

function sizesOf(measured: { viewportWidth: number; renderedWidth: number; chain?: LayoutNode[] }[]): SizesResult | undefined {
  const points: FormulaPoint[] = measured.map((m) => ({
    viewportWidth: m.viewportWidth,
    renderedWidth: m.renderedWidth,
    slot: m.chain ? slotAt(m.chain, m.viewportWidth) : undefined,
  }));
  return deriveSizesFromLayout(points);
}

/** An image record that has something to fix: bytes saved, or a sizes value that differs from the current one. */
export function hasFix(record: ImageRecord): boolean {
  return record.fix.bytes.saved > 0 || (record.fix.sizes !== undefined && record.fix.sizes.value !== record.current.sizes);
}

/** Builds the image records of one page from its analysed instances. */
export function buildImageRecords(input: BuildInput): ImageRecord[] {
  const { pageUrl, observations, instances, refName, resolved } = input;
  const viewportCount = observations.length;
  const rung = rungOfPage(pageUrl, input.harness);

  // One key per element and viewport: the source key plus the ordinal among elements sharing it, in document order.
  const keyOf = new Map<Instance, string>();
  for (const obs of observations) {
    const ordinals = new Map<string, number>();
    for (const inst of instances) {
      if (inst.viewport.name !== obs.viewport.name) continue;
      const base = baseKey(inst.img, resolved.get(inst.img));
      const n = ordinals.get(base) ?? 0;
      ordinals.set(base, n + 1);
      keyOf.set(inst, `${base}#${n}`);
    }
  }
  const byKey = new Map<string, Instance[]>();
  for (const inst of instances) {
    const key = keyOf.get(inst);
    if (key === undefined) continue;
    const list = byKey.get(key);
    if (list) list.push(inst);
    else byKey.set(key, [inst]);
  }

  const records: ImageRecord[] = [];
  // Quality targets per element (per served format, the max over its viewports), kept for the group rule.
  const targets = new Map<ImageRecord, Map<string, number>>();
  for (const [key, members] of byKey) {
    const member = members.find((m) => m.viewport.name === refName) ?? members[0];
    const source = resolved.get(member.img);
    const locator = locatorOf(member, pageUrl, source);
    const src = member.img.currentSrc || parseSrcset(member.img.srcset, pageUrl)[0]?.url || "";
    const current = src ? input.currentQuality(src, pageUrl) : undefined;
    const candidates = parseSrcset(member.img.srcset, pageUrl);

    const perViewport: ImagePerViewport[] = [];
    for (const obs of observations) {
      const inst = members.find((m) => m.viewport.name === obs.viewport.name);
      if (!inst) continue;
      const vw = obs.viewport.width;
      const sizes = inst.img.sizes;
      const branch = sizes ? sizesBranchAt(sizes, vw) : undefined;
      const sizesPx = sizes ? sizesSlotAt(sizes, vw) : undefined;
      const entry: ImagePerViewport = {
        viewport: obs.viewport.name,
        domIndex: inst.element,
        dpr: obs.viewport.dpr,
        renderedCssPx: round1(inst.renderedWidth),
        neededPx: inst.needed,
        servedBytes: inst.bytes,
        undersized: inst.undersized === true,
        loaded: inst.url !== "" && obs.responses.get(inst.url)?.buffer !== undefined,
        lcp: obs.lcp?.kind === "image" && obs.lcp.index === inst.element,
      };
      if (inst.kind === "hidden" && inst.img.hidden !== undefined) entry.hidden = inst.img.hidden;
      if (inst.pixelWidth > 0) entry.servedPx = inst.pixelWidth;
      if (inst.pixelWidth > 0 && inst.needed > 0) entry.overFetchRatio = round2(inst.pixelWidth / inst.needed);
      if (sizesPx !== undefined) entry.sizesResolvedPx = round1(sizesPx);
      if (branch) entry.sizesMatchedCondition = branch.condition;
      if (inst.skipped !== undefined) entry.skipped = inst.skipped;
      perViewport.push(entry);
    }

    const refLayout = member.img.layout;
    let layoutChain: ImageRecord["layoutChain"];
    if (refLayout) {
      const diffs = members
        .filter((m) => m !== member && m.img.layout && !sameStructure(refLayout.nodes, m.img.layout.nodes))
        .map((m) => ({ viewport: m.viewport.name, nodes: (m.img.layout as NonNullable<ObservedImage["layout"]>).nodes }));
      layoutChain = {
        viewport: member.viewport.name,
        nodes: refLayout.nodes,
        skipped: refLayout.skipped,
        truncated: refLayout.truncated,
        diffs,
      };
    }

    const measured = members
      .filter((m) => m.renderedWidth >= 1 && m.kind !== "hidden")
      .map((m) => ({
        viewportWidth: m.viewport.width,
        renderedWidth: m.renderedWidth,
        chain: m.img.layout?.nodes,
      }));
    const sizes = sizesOf(measured);
    const notes: string[] = [];

    const saved = members.reduce((sum, m) => sum + m.exact + m.est, 0) / viewportCount;
    const savedSizes = members.reduce((sum, m) => sum + m.exact, 0) / viewportCount;
    const addedForSharpness = members.reduce((sum, m) => sum + m.growth, 0) / viewportCount;
    // The proposal is checked at every measured viewport. One undersized there is not a saving: no sizes value, and its
    // bytes are left out (the quality part stays).
    const left = sizes === undefined ? undefined : undersizedProposal(sizes.value, measuredPoints(members), (srcset) => parseSrcset(srcset, pageUrl));
    const keepSizes = sizes !== undefined && left === undefined;
    const savedEff = keepSizes ? saved : saved - savedSizes;
    const savedSizesEff = keepSizes ? savedSizes : 0;
    const served = member.format;
    const animatedMember = members.find((m) => m.animated !== undefined);
    const lossless = losslessServed(served, animatedMember !== undefined);
    const best = lossless ? (saved > 0 ? "avif" : served) : served;

    // A hidden fix first: an element never shown on load gets no animated encode either (its bytes are not a saving).
    const hiddenFix = hiddenFixOf(members, viewportCount);
    const fix: ImageFix = { bytes: { saved: savedEff, addedForSharpness, sizes: savedSizesEff, quality: savedEff - savedSizesEff } };
    if (member.cdnQuality !== undefined) fix.cdnQuality = { ...member.cdnQuality };
    if (member.formatAuto === true && lossless) fix.formatHandled = true;
    if (animatedMember?.animated !== undefined && hiddenFix?.shownIn.length !== 0) {
      fix.animated = {
        info: animatedMember.animated,
        context: "img",
        target: animatedTarget("img", undefined),
        perViewBytes: members.reduce((sum, m) => sum + m.bytes, 0) / viewportCount,
      };
    }
    if (sizes && left !== undefined) {
      fix.noSaving = `sizes proposal left out: ${left}`;
      notes.push(`sizes proposal left out: ${left}`);
    }
    if (keepSizes) {
      fix.sizes = { value: sizes.value, basis: sizes.basis, rung, branches: sizes.branches };
      const sized = sizes.branches.map((b) => b.basis);
      const formulas = sized.filter((b) => b === "layout-formula").length;
      notes.push(
        `sizes: ${sizes.basis} (${formulas} of ${sized.length} media branch(es) from the layout formula, checked at ${measured.length} of ${viewportCount} viewports)`,
      );
    }
    const flatMember = members.find((m) => m.flatness?.flat === true);
    // Never on a hidden element: the vector check and the hidden fix do not stack on one record.
    if (flatMember?.flatness !== undefined && hiddenFix === undefined) fix.vector = { flatness: { ...flatMember.flatness } };
    if (member.kind === "plain") fix.width = member.needed;
    if (best !== undefined) fix.format = best;

    const record: ImageRecord = {
      id: sha1(`${pageUrl}\n${key}`).slice(0, 12),
      page: pageUrl,
      ...(member.img.posterOf !== undefined ? { poster: true as const } : {}),
      locator,
      tunable: tunableOf(member, pageUrl, locator.loader),
      current: {
        src: member.img.currentSrc || undefined,
        sizes: member.img.sizes,
        srcsetCandidates: candidates.map((c) => ({ url: c.url, width: c.width })),
        quality: current?.quality,
        qualityAssumed: current?.assumed,
        format: served,
        naturalWidth: member.pixelWidth > 0 ? member.pixelWidth : undefined,
      },
      lazy: member.img.lazy,
      lcpViewports: perViewport.filter((p) => p.lcp).map((p) => p.viewport),
      perViewport,
      layoutChain,
      fix,
      evidence: { rung, notes },
    };
    if (rung === "measured-harness") {
      notes.unshift(`measured in isolation: harness ${sanitizeText(new URL(pageUrl).pathname, 120)} (not the page a visitor sees)`);
    }
    if (source?.file) {
      const how = source.check === "owner" ? "owner call site, the image is inside its component" : source.check === "image" ? "verified: the line renders an image" : "not checked";
      const origin = source.via === "prod-sourcemap" ? "component definition, production source map" : "React owner, dev build";
      notes.push(`source: ${source.file}:${source.line ?? 0} (${origin}; ${how})`);
    }
    else if (locator.component.length > 0) notes.push(`component: ${locator.component.join(" > ")} (no project file resolved)`);
    else notes.push("source: not resolved (production build, or no React owner)");
    if (fix.cdnQuality?.handled === true) notes.push(`quality handled by ${locator.loader} (q_auto): its est. quality saving is not counted`);
    if (fix.formatHandled === true) notes.push(`format handled by ${locator.loader} (f_auto): no format change proposed`);
    if (member.img.posterOf !== undefined) notes.push(`poster of video ${sanitizeText(member.img.posterOf, 120)} (sized to its box)`);
    if (fix.animated !== undefined) {
      const { frames, durationMs, loop } = fix.animated.info;
      notes.push(`animated ${fix.animated.info.format}: ${frames} frame(s), ${Math.round(durationMs / 100) / 10} s per loop, loops ${loop === 0 ? "forever" : loop}`);
    }
    if (layoutChain?.truncated) notes.push("layout chain cut at the depth cap");
    if (layoutChain && layoutChain.skipped.length > 0) notes.push(`skipped ancestors: ${layoutChain.skipped.length}`);

    const own = new Map<string, number>();
    for (const m of members) {
      if (m.qualityInfo?.target === undefined || m.format === undefined) continue;
      own.set(m.format, Math.max(own.get(m.format) ?? -Infinity, m.qualityInfo.target));
    }
    // A loaded-but-not-shown element has no vector claim (the vector check and the hidden fix never stack), and a copy that
    // is never shown on load has no sizes claim either: its bytes are the hidden fix's. A responsive twin keeps the sizes of
    // the viewports that show it (see the hidden-images tests).
    if (hiddenFix !== undefined) {
      record.hidden = hiddenFix;
      delete record.fix.vector;
      if (hiddenFix.shownIn.length === 0) delete record.fix.sizes;
    }
    targets.set(record, own);
    records.push(record);
  }

  // The quality group rule: the max of the members' targets per served format, over a component, else a URL pattern.
  const groups = new Map<string, { records: ImageRecord[]; max: Map<string, number>; samples: number }>();
  for (const record of records) {
    const group = record.locator.component[0] ?? record.locator.urlPattern ?? record.locator.selector;
    const entry = groups.get(group) ?? { records: [], max: new Map<string, number>(), samples: 0 };
    entry.records.push(record);
    for (const [format, target] of targets.get(record) ?? []) {
      entry.max.set(format, Math.max(entry.max.get(format) ?? -Infinity, target));
    }
    if ((targets.get(record)?.size ?? 0) > 0) entry.samples++;
    groups.set(group, entry);
  }
  for (const [group, entry] of groups) {
    if (entry.max.size === 0) continue;
    const perFormat: Record<string, number> = {};
    for (const [format, target] of entry.max) perFormat[format] = target;
    for (const record of entry.records) {
      // An image never shown has no quality claim: its file is not on screen at any viewport.
      if (record.current.quality === undefined || record.hidden?.shownIn.length === 0) continue;
      record.fix.quality = {
        perFormat,
        groupRule: "max-of-targets",
        group,
        samples: entry.samples,
        current: record.current.quality,
        qualityAssumed: record.current.qualityAssumed === true,
      };
      record.evidence.notes.push(`quality: max of ${entry.samples} scored image(s) in ${group}`);
    }
  }
  return records;
}
