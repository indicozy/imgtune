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
import { COMPONENT_NAME, loaderName, sanitizeText, urlPattern, type LocatorKind } from "./locate.js";
import { sizesBranchAt, sizesSlotAt } from "./sizes.js";
import { parseSrcset } from "./srcset-parse.js";
import type { Instance, ObservedImage, ViewportObservation } from "./remote.js";

export type { SizesBasis, SizesBranch };

export interface ImageLocator {
  /** Component names, nearest first (dev builds of React only). */
  component: string[];
  /** Project-relative source file and line of the element (dev builds, through the source map). */
  file?: string;
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
  /** Why the element is not measured here (duplicate of another element, data URI, ...). */
  skipped?: string;
}

export interface ImageFix {
  sizes?: { value: string; basis: SizesBasis; rung: "measured-page"; branches: SizesBranch[] };
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
  /** Set when the element's source was read from a dev page by `scan --locate-only` (see locate-join.ts). */
  locate?: { viewport: string; by: "alt-order" | "url-unique"; devIndex: number };
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
  evidence: { rung: "measured-page"; notes: string[] };
}

/** A source resolved for one observed element: its file and line, and its component names. */
export interface ResolvedSource {
  file?: string;
  line?: number;
  component: string[];
  /** The check of file:line against the project file (see LocatorKind). */
  check?: LocatorKind;
}

export interface BuildInput {
  pageUrl: string;
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
    locator.kind = source.check ?? "unchecked";
    locator.verified = locator.kind === "image";
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
      };
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
      .filter((m) => m.renderedWidth >= 1)
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
    const served = member.format;
    const best = served === "jpeg" || served === "png" ? (saved > 0 ? "avif" : served) : served;

    const fix: ImageFix = { bytes: { saved, addedForSharpness, sizes: savedSizes, quality: saved - savedSizes } };
    if (sizes) {
      fix.sizes = { value: sizes.value, basis: sizes.basis, rung: "measured-page", branches: sizes.branches };
      const sized = sizes.branches.map((b) => b.basis);
      const formulas = sized.filter((b) => b === "layout-formula").length;
      notes.push(
        `sizes: ${sizes.basis} (${formulas} of ${sized.length} media branch(es) from the layout formula, checked at ${measured.length} of ${viewportCount} viewports)`,
      );
    }
    if (member.kind === "plain") fix.width = member.needed;
    if (best !== undefined) fix.format = best;

    const record: ImageRecord = {
      id: sha1(`${pageUrl}\n${key}`).slice(0, 12),
      page: pageUrl,
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
      perViewport,
      layoutChain,
      fix,
      evidence: { rung: "measured-page", notes },
    };
    if (source?.file) {
      const how = source.check === "owner" ? "owner call site, the image is inside its component" : source.check === "image" ? "verified: the line renders an image" : "not checked";
      notes.push(`source: ${source.file}:${source.line ?? 0} (React owner, dev build; ${how})`);
    }
    else if (locator.component.length > 0) notes.push(`component: ${locator.component.join(" > ")} (no project file resolved)`);
    else notes.push("source: not resolved (production build, or no React owner)");
    if (layoutChain?.truncated) notes.push("layout chain cut at the depth cap");
    if (layoutChain && layoutChain.skipped.length > 0) notes.push(`skipped ancestors: ${layoutChain.skipped.length}`);

    const own = new Map<string, number>();
    for (const m of members) {
      if (m.qualityInfo?.target === undefined || m.format === undefined) continue;
      own.set(m.format, Math.max(own.get(m.format) ?? -Infinity, m.qualityInfo.target));
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
      if (record.current.quality === undefined) continue;
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
