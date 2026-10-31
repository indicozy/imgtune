// The per-image fix records of a scan (`images[]`): one entry per distinct image element, merged across viewports, with
// its locator, what it can be tuned by, what it is served, its layout chain, the fix it gets and the evidence for it.
// Built from the instances the page analysis already measured: no measurement happens here.

import { sha1 } from "./atomic.js";
import { deriveSizesFormula, slotExpr, sameStructure, withinTolerance, type FormulaPoint, type LayoutNode } from "./layout.js";
import { isLocalTarget } from "./address.js";
import { loaderName, sanitizeText, urlPattern } from "./locate.js";
import { deriveSizes, sizesBranchAt, sizesSlotAt, type SizePoint } from "./sizes.js";
import { parseSrcset } from "./srcset-parse.js";
import type { Instance, ObservedImage, ViewportObservation } from "./remote.js";

/** Where a sizes value came from: a layout formula, a fitted line, or the largest measured width. */
export type SizesBasis = "layout-formula" | "fit" | "measured-max";

export interface ImageLocator {
  /** Component names, nearest first (dev builds of React only). */
  component: string[];
  /** Project-relative source file and line of the element (dev builds, through the source map). */
  file?: string;
  line?: number;
  /**
   * Whether the source came from a local development server (the page is on loopback or a private host). A source from
   * any other origin is unverified: it is printed as such, and must be checked before it is trusted.
   */
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
}

export interface ImagePerViewport {
  viewport: string;
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
  sizes?: { value: string; basis: SizesBasis; rung: "measured-page" };
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
  /** Two numbers, never netted: bytes the fix saves per page view, and sharpness bytes it adds on undersized images. */
  bytes: { saved: number; addedForSharpness: number };
}

export interface ImageRecord {
  id: string;
  page: string;
  locator: ImageLocator;
  tunable: { width: boolean; quality: boolean; reason?: string };
  current: {
    sizes?: string;
    srcsetCandidates: { url: string; width: number }[];
    quality?: number;
    qualityAssumed?: boolean;
    format?: string;
    naturalWidth?: number;
  };
  lazy?: boolean;
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

/** The key that finds an element across runs: its source, else its components, else its test id, else its DOM path. */
function baseKey(img: ObservedImage, source: ResolvedSource | undefined): string {
  if (source?.file) return `${source.file}:${source.line ?? 0}`;
  if (source && source.component.length > 0) return `component:${source.component.join(">")}`;
  if (img.locator?.testid) return `testid:${img.locator.testid}`;
  return `css:${img.locator?.selector ?? "img"}`;
}

/** Whether a source resolved on this page is verified: only a page on a local (loopback or private) origin is. */
export function locatorVerified(file: string | undefined, pageUrl: string): boolean | undefined {
  return file === undefined ? undefined : isLocalTarget(pageUrl);
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
    locator.verified = locatorVerified(source.file, pageUrl);
  }
  if (img.locator?.testid !== undefined) locator.testid = sanitizeText(img.locator.testid, 120);
  if (img.locator?.alt !== undefined) locator.alt = sanitizeText(img.locator.alt, 120);
  if (src) locator.urlPattern = sanitizeText(urlPattern(src, pageUrl) ?? "", 300);
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

/** The sizes value of one element and its basis, from its measured points and its layout chains. */
function sizesOf(
  measured: { viewportWidth: number; renderedWidth: number; mobile: boolean; chain?: LayoutNode[] }[],
): { value: string; basis: SizesBasis } | undefined {
  if (measured.length === 0) return undefined;
  const formulaPoints: FormulaPoint[] = [];
  for (const m of measured) {
    const expr = m.chain ? slotExpr(m.chain) : undefined;
    if (expr) formulaPoints.push({ viewportWidth: m.viewportWidth, renderedWidth: m.renderedWidth, expr });
  }
  if (formulaPoints.length === measured.length) {
    const formula = deriveSizesFormula(formulaPoints);
    if (formula !== undefined) return { value: formula, basis: "layout-formula" };
  }
  const points: SizePoint[] = measured.map((m) => ({ viewportWidth: m.viewportWidth, renderedWidth: m.renderedWidth, mobile: m.mobile }));
  const fit = deriveSizes(points);
  if (fit !== undefined && measured.every((m) => withinTolerance(sizesSlotAt(fit, m.viewportWidth), m.renderedWidth))) {
    return { value: fit, basis: "fit" };
  }
  return { value: `${Math.ceil(Math.max(...measured.map((m) => m.renderedWidth)))}px`, basis: "measured-max" };
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
        mobile: m.viewport.mobile,
        chain: m.img.layout?.nodes,
      }));
    const sizes = sizesOf(measured);
    const notes: string[] = [];

    const saved = members.reduce((sum, m) => sum + m.exact + m.est, 0) / viewportCount;
    const addedForSharpness = members.reduce((sum, m) => sum + m.growth, 0) / viewportCount;
    const served = member.format;
    const best = served === "jpeg" || served === "png" ? (saved > 0 ? "avif" : served) : served;

    const fix: ImageFix = { bytes: { saved, addedForSharpness } };
    if (sizes) {
      fix.sizes = { value: sizes.value, basis: sizes.basis, rung: "measured-page" };
      notes.push(
        sizes.basis === "layout-formula"
          ? `sizes: layout formula, checked at ${measured.length} of ${viewportCount} viewports`
          : `sizes: ${sizes.basis} (no layout formula matched every viewport)`,
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
    if (source?.file) notes.push(`source: ${source.file}:${source.line ?? 0} (React owner, dev build)`);
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
