// The join between a measured scan (a built server or a preview: realistic bytes) and a dev page (React owner data: the
// source file and line). Records join on the page's image URL pattern and alt text, then on their order in the document:
// two elements join only when the measured side and the dev side hold the same number of them, in the same order. A
// count that differs joins nothing and is reported; a guess is never made. Pure: the caller reads the pages.

import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_VIEWPORTS } from "./config.js";
import type { ImageLocator, ImagePerViewport, ImageRecord, ResolvedSource } from "./images.js";
import { COMPONENT_NAME, projectPath, sanitizeText, urlPattern, type LocatorKind } from "./locate.js";
import { ID_PATTERN } from "./recheck.js";
import { parseSrcset } from "./srcset-parse.js";
import type { ObservedImage, PageResult, ViewportObservation } from "./remote.js";
import { safeText } from "./text.js";

/** Largest measured scan file read: a scan is one page, so this is generous. */
export const MAX_MEASURED_BYTES = 64 * 1024 * 1024;
/** Most image records a measured scan may hold. */
export const MAX_MEASURED_IMAGES = 20_000;

/** What a locate run recorded about itself, in the page's `locate` field. */
export interface LocateSummary {
  /** The dev page the sources were read from. */
  url: string;
  viewport: string;
  scannedAt: string;
  imgtuneVersion: string;
  seconds: number;
  /** Images the measured scan flagged (a saving or sharpness growth): the only ones located. */
  flagged: number;
  joined: number;
  /** Flagged images with no dev partner. */
  notJoined: number;
  /** Dev images of a flagged URL with no measured partner. */
  devLeft: number;
  /** Measured elements at the viewport that have no element order (the scan is older than this feature). */
  noOrder: number;
  /** How many flagged images were not joined, by reason. */
  reasons: Record<string, number>;
}

/** An image element of the dev page at the locate viewport, with its source when the dev build resolved one. */
export interface DevImage {
  /** Document order among the page's <img> elements, as observed. */
  index: number;
  /** The join key of the element (see joinKeyOfImage). */
  pattern: string;
  alt: string;
  renderedCssPx: number;
  currentSrc: string;
  srcset: string;
  sizes?: string;
  component: string[];
  file?: string;
  line?: number;
  kind?: LocatorKind;
}

/** Why a flagged record did not join: a code for the summary, and the text for the reader. */
export interface Reason {
  code: "not-measured" | "no-dev-image" | "count-differs" | "alt-differs";
  text: string;
}

/** Joined flagged record and its dev element; `by` says which rule joined them. */
export interface Joined {
  dev: DevImage;
  by: "alt-order" | "url-unique";
}

export interface LocateJoin {
  /** The joined flagged records. */
  pairs: Map<ImageRecord, Joined>;
  /** Why each flagged record did not join. */
  reasons: Map<ImageRecord, Reason>;
  /** Dev images of a flagged URL that no measured record joined. */
  devLeft: DevImage[];
  /** Measured elements at the viewport with no element order. */
  noOrder: number;
}

/** A record is flagged when the measured scan found a saving on it, or sharpness growth to undo. */
export function isFlagged(record: ImageRecord): boolean {
  return record.fix.bytes.saved > 0 || record.fix.bytes.addedForSharpness > 0;
}

/** A URL with the page's own origin taken out, so a built server and a dev server give the same pattern. */
export function joinUrl(url: string, pageUrl: string): string {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return url;
  }
  return url.startsWith(origin) ? url.slice(origin.length) : url;
}

/**
 * The join key of a set of image URLs: each URL's pattern (origin taken out), without repeats, sorted. The key is of the
 * whole srcset, not of the file the browser chose: a sizes edit makes the browser choose another candidate, and the element
 * is still the same one. A next/image srcset collapses to one pattern (its widths and qualities are taken out).
 */
export function joinKeyOfUrls(urls: string[], pageUrl: string): string {
  const patterns = new Set<string>();
  for (const url of urls) {
    const pattern = urlPattern(url, pageUrl);
    if (pattern !== undefined) patterns.add(joinUrl(sanitizeText(pattern, 300), pageUrl));
  }
  return [...patterns].sort().join(" | ");
}

/** The join key of a rendered element: its srcset candidates, else the URL it loaded. */
export function joinKeyOfImage(img: { currentSrc: string; srcset: string }, pageUrl: string): string {
  const candidates = parseSrcset(img.srcset, pageUrl).map((c) => c.url);
  return joinKeyOfUrls(candidates.length > 0 ? candidates : img.currentSrc ? [img.currentSrc] : [], pageUrl);
}

/** The join key of a measured record: the candidates the scan read from the page's srcset, else the URL it loaded. */
export function joinKeyOfRecord(record: ImageRecord): string {
  const candidates = (record.current.srcsetCandidates ?? []).map((c) => c.url);
  if (candidates.length > 0) return joinKeyOfUrls(candidates, record.page);
  if (record.current.src) return joinKeyOfUrls([record.current.src], record.page);
  return joinUrl(record.locator.urlPattern ?? "", record.page);
}

/** The elements of one observed viewport, as join candidates. Only the elements in `resolved` carry a source. */
export function devImagesOf(
  observation: ViewportObservation,
  pageUrl: string,
  resolved: Map<ObservedImage, ResolvedSource>,
): DevImage[] {
  return observation.images.map((img) => {
    const source = resolved.get(img);
    return {
      index: img.index,
      pattern: joinKeyOfImage(img, pageUrl),
      alt: sanitizeText(img.locator?.alt ?? "", 120),
      renderedCssPx: Math.round(img.renderedWidth * 10) / 10,
      currentSrc: img.currentSrc,
      srcset: img.srcset,
      sizes: img.sizes,
      component: source?.component ?? [],
      file: source?.file,
      line: source?.line,
      kind: source?.check,
    };
  });
}

interface Entry<T> {
  item: T;
  order: number;
  pattern: string;
  alt: string;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(key(item));
    if (list) list.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

const byOrder = <T>(a: Entry<T>, b: Entry<T>): number => a.order - b.order;

/**
 * The join at one viewport. Level 1: the measured and dev elements with the same URL pattern and alt text pair in document
 * order, when their counts are equal. Level 2: a URL that is unique on both sides, left over after level 1, pairs even when
 * its alt text differs. Everything else is left unjoined, with its reason. `flagged` says which records are located.
 */
export function joinLocate(
  records: ImageRecord[],
  viewport: string,
  devImages: DevImage[],
  flagged: (record: ImageRecord) => boolean,
): LocateJoin {
  const measured: Entry<ImageRecord>[] = [];
  const notMeasured: ImageRecord[] = [];
  let noOrder = 0;
  for (const record of records) {
    const entry: ImagePerViewport | undefined = record.perViewport.find((p) => p.viewport === viewport);
    if (!entry) {
      if (flagged(record)) notMeasured.push(record);
      continue;
    }
    if (entry.domIndex === undefined) {
      noOrder++;
      continue;
    }
    measured.push({
      item: record,
      order: entry.domIndex,
      pattern: joinKeyOfRecord(record),
      alt: record.locator.alt ?? "",
    });
  }
  const dev: Entry<DevImage>[] = devImages.map((d) => ({ item: d, order: d.index, pattern: d.pattern, alt: d.alt }));
  const pairs = new Map<ImageRecord, Joined>();
  const matchedMeasured = new Set<ImageRecord>();
  const matchedDev = new Set<DevImage>();

  const altKey = <T>(e: Entry<T>): string => JSON.stringify([e.pattern, e.alt]);
  const measuredByAlt = groupBy(measured, altKey);
  const devByAlt = groupBy(dev, altKey);
  for (const [key, ms] of measuredByAlt) {
    const ds = devByAlt.get(key) ?? [];
    if (ds.length === 0 || ds.length !== ms.length) continue;
    ms.sort(byOrder);
    ds.sort(byOrder);
    ms.forEach((m, i) => {
      matchedMeasured.add(m.item);
      matchedDev.add(ds[i].item);
      pairs.set(m.item, { dev: ds[i].item, by: "alt-order" });
    });
  }

  const leftMeasured = measured.filter((m) => !matchedMeasured.has(m.item));
  const leftDev = dev.filter((d) => !matchedDev.has(d.item));
  const leftByUrl = groupBy(leftMeasured, (e) => e.pattern);
  const devLeftByUrl = groupBy(leftDev, (e) => e.pattern);
  for (const [pattern, ms] of leftByUrl) {
    const ds = devLeftByUrl.get(pattern) ?? [];
    if (ms.length === 1 && ds.length === 1) {
      matchedMeasured.add(ms[0].item);
      matchedDev.add(ds[0].item);
      pairs.set(ms[0].item, { dev: ds[0].item, by: "url-unique" });
    }
  }

  const reasons = new Map<ImageRecord, Reason>();
  for (const record of notMeasured) reasons.set(record, { code: "not-measured", text: `not measured at ${viewport}` });
  const measuredByUrl = groupBy(measured, (e) => e.pattern);
  const devByUrlAll = groupBy(dev, (e) => e.pattern);
  for (const m of measured) {
    if (matchedMeasured.has(m.item) || !flagged(m.item)) continue;
    const measuredHere = measuredByUrl.get(m.pattern)?.length ?? 0;
    const devHere = devByUrlAll.get(m.pattern)?.length ?? 0;
    if (devHere === 0) {
      reasons.set(m.item, { code: "no-dev-image", text: `no image with this URL at ${viewport} on the dev page` });
    } else if (devByAlt.has(altKey(m))) {
      reasons.set(m.item, {
        code: "count-differs",
        text: `${measuredHere} measured and ${devHere} on the dev page with this URL: the counts differ`,
      });
    } else {
      reasons.set(m.item, {
        code: "alt-differs",
        text: `${measuredHere} measured and ${devHere} on the dev page with this URL: the alt text differs and the URL is not unique`,
      });
    }
  }

  const flaggedPatterns = new Set(measured.filter((m) => flagged(m.item)).map((m) => m.pattern));
  const devLeft = dev.filter((d) => !matchedDev.has(d.item) && flaggedPatterns.has(d.pattern)).map((d) => d.item);
  const flaggedPairs = new Map([...pairs].filter(([record]) => flagged(record)));
  return { pairs: flaggedPairs, reasons, devLeft, noOrder };
}

/** The reasons of a join, counted by code, for the summary. */
export function reasonCounts(join: LocateJoin): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of join.reasons.values()) counts[reason.code] = (counts[reason.code] ?? 0) + 1;
  return counts;
}

/** The records with the dev page's source written on the joined ones. The rest are returned unchanged. */
export function applyLocate(records: ImageRecord[], join: LocateJoin, viewport: string): ImageRecord[] {
  return records.map((record) => {
    const joined = join.pairs.get(record);
    if (joined === undefined) return record;
    const { dev, by } = joined;
    const locator: ImageLocator = { ...record.locator };
    delete locator.file;
    delete locator.line;
    delete locator.kind;
    delete locator.verified;
    if (dev.file !== undefined && dev.line !== undefined) {
      delete locator.searchHints;
      locator.file = dev.file;
      locator.line = dev.line;
      locator.kind = dev.kind ?? "unchecked";
      locator.verified = locator.kind === "image";
    }
    if (dev.component.length > 0) locator.component = dev.component;
    const notes = record.evidence.notes.filter((note) => !/^(source|component): /.test(note));
    const how = by === "alt-order" ? "URL, alt and order" : "unique URL";
    notes.push(
      dev.file !== undefined
        ? `source: ${dev.file}:${dev.line ?? 0} (located on the dev page at ${viewport}, joined by ${how})`
        : `located on the dev page at ${viewport} (joined by ${how}): no project file resolved`,
    );
    return { ...record, locator, locate: { viewport, by, devIndex: dev.index }, evidence: { ...record.evidence, notes } };
  });
}

/** A text for the page-level line of a summary, with the counts. */
export function locateLine(summary: LocateSummary): string {
  return `located ${summary.joined} of ${summary.flagged} flagged image(s) at ${summary.viewport}`;
}

const VIEWPORT_NAMES: readonly string[] = DEFAULT_VIEWPORTS.map((v) => v.name);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * One record of a measured scan, checked and cleaned: the fields the join and the sizes check read must be the right
 * type, and a source (file, line, component) must be a project path, an integer and an identifier. Undefined when the
 * record is not usable. The scan file is untrusted: nothing else from it is trusted.
 */
export function cleanRecord(raw: unknown): ImageRecord | undefined {
  const record = raw as ImageRecord | null;
  if (record === null || typeof record !== "object" || typeof record.id !== "string" || !ID_PATTERN.test(record.id)) return undefined;
  if (typeof record.page !== "string" || !Array.isArray(record.perViewport) || record.perViewport.length > 12) return undefined;
  const bytes = record.fix?.bytes;
  if (!bytes || !isFiniteNumber(bytes.saved) || !isFiniteNumber(bytes.addedForSharpness)) return undefined;
  if (typeof record.locator !== "object" || record.locator === null) return undefined;
  const perViewport: ImagePerViewport[] = [];
  for (const p of record.perViewport as ImagePerViewport[]) {
    if (!p || typeof p !== "object" || !VIEWPORT_NAMES.includes(p.viewport)) continue;
    if (!isFiniteNumber(p.renderedCssPx) || !isFiniteNumber(p.servedBytes)) continue;
    const entry: ImagePerViewport = { ...p };
    if (!(isFiniteNumber(p.domIndex) && Number.isInteger(p.domIndex) && p.domIndex >= 0)) delete entry.domIndex;
    perViewport.push(entry);
  }
  const locator: ImageLocator = { ...record.locator };
  if (locator.file !== undefined) {
    const file = typeof locator.file === "string" ? projectPath(locator.file) : undefined;
    if (file === undefined || file !== locator.file) {
      delete locator.file;
      delete locator.line;
      delete locator.kind;
      delete locator.verified;
    }
  }
  if (locator.line !== undefined && !(Number.isInteger(locator.line) && locator.line >= 0)) {
    delete locator.line;
  }
  locator.component = Array.isArray(locator.component)
    ? locator.component.filter((c): c is string => typeof c === "string" && COMPONENT_NAME.test(c)).slice(0, 8)
    : [];
  if (typeof locator.urlPattern !== "string") delete locator.urlPattern;
  if (typeof locator.alt !== "string") delete locator.alt;
  if (typeof locator.loader !== "string") locator.loader = "unknown";
  return { ...record, perViewport, locator };
}

/**
 * Reads a measured scan file and returns its page with only the usable records. A file that is not a finished page scan
 * is refused; records that are not usable are dropped and counted (the caller prints the count).
 */
export interface MeasuredPage extends PageResult {
  images: ImageRecord[];
}

export async function readMeasuredScan(file: string, cwd: string): Promise<{ page: MeasuredPage; dropped: number }> {
  const path = resolve(cwd, file);
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw new Error(`cannot read ${safeText(file)} as a scan file`);
  }
  if (size > MAX_MEASURED_BYTES) throw new Error(`${safeText(file)} is larger than ${MAX_MEASURED_BYTES / (1024 * 1024)} MB`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`cannot read ${safeText(file)} as a scan file`);
  }
  const page = parsed as PageResult | null;
  if (page === null || typeof page !== "object" || typeof page.url !== "string" || !Array.isArray(page.images)) {
    throw new Error(`${safeText(file)} has no image records: scan it with this version of imgtune`);
  }
  if (page.images.length > MAX_MEASURED_IMAGES) throw new Error(`${safeText(file)} has more than ${MAX_MEASURED_IMAGES} image records`);
  try {
    const url = new URL(page.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new Error(`${safeText(file)} names a page that is not an http or https URL`);
  }
  if (page.status !== "ok") throw new Error(`${safeText(file)} is a page scan with status ${safeText(String(page.status))}: only an ok page can be located or rechecked`);
  const images: ImageRecord[] = [];
  let dropped = 0;
  for (const raw of page.images) {
    const record = cleanRecord(raw);
    if (record === undefined) dropped++;
    else images.push(record);
  }
  return { page: { ...page, images }, dropped };
}
