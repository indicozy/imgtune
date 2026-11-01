// `imgtune compare <before.json> <after.json>`: the per-image before and after of two scans of the same page. Images are
// paired by the join key (their srcset URL patterns and alt, see joinKeyOfRecord). Where several elements share a key, they
// are paired by their rendered layout first (so a page whose products moved between the scans does not move bytes onto the
// wrong card), then in document order. Three kinds of difference are drift, not a claim, and are excluded from the saving and
// the sharpness bytes, with their totals printed: an image whose rendered width changed (the page is not the same page),
// the same file served again with different bytes (server variance), and a view where one scan did not receive the file
// (lazy-load timing). Unpaired images are listed apart and never counted. The saving and the sharpness bytes are two numbers,
// never netted.

import { DEFAULT_VIEWPORTS } from "./config.js";
import type { ImageRecord, ImagePerViewport } from "./images.js";
import { joinKeyOfRecord, readMeasuredScan, type MeasuredPage } from "./locate-join.js";
import { safeText } from "./text.js";

export interface CompareArgs {
  before: string;
  after: string;
  format: "text" | "json";
  limit: number;
}

const USAGE = "usage: imgtune compare <before.json> <after.json> [--format text|json] [--limit N]";

const DEFAULT_COMPARE_LIMIT = 10;

/** A rendered width this much apart (CSS px) at a shared viewport is a different layout, not rounding. */
export const LAYOUT_TOLERANCE_PX = 1;

/** The distance of two elements that share no measured viewport: they never pair inside a group that has a better choice. */
const NO_SHARED_LAYOUT = 1e9;

/** The arguments after `compare`: two scan files and the output options. Throws with the message the CLI prints. */
export function parseCompareArgs(argv: string[]): CompareArgs {
  const files: string[] = [];
  let format: "text" | "json" = "text";
  let limit = DEFAULT_COMPARE_LIMIT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      files.push(arg);
      continue;
    }
    if (arg !== "--format" && arg !== "--limit") throw new Error(`Unknown option ${safeText(arg)} (${USAGE})`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value (${USAGE})`);
    i++;
    if (arg === "--format") {
      if (value !== "text" && value !== "json") throw new Error(`--format is text or json, not ${safeText(value)}`);
      format = value;
    } else {
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`--limit needs a number of at least 1, not ${safeText(value)}`);
      limit = Number(value);
    }
  }
  if (files.length !== 2) throw new Error(USAGE);
  return { before: files[0], after: files[1], format, limit };
}

/** The image as one line names it: its file and line, else its component, else its selector. */
export function whereOfRecord(record: ImageRecord): string {
  const { file, line, component, selector } = record.locator;
  if (file !== undefined) return `${file}:${line ?? 0}`;
  return component.length > 0 ? component[0] : selector;
}

/** One paired image: its bytes per view before and after, and the two numbers of its change (per view). */
export interface ComparedImage {
  beforeId: string;
  afterId: string;
  where: string;
  /** Bytes per page view of the file served before and after (mean over the views both scans measured it at). */
  beforeBytes: number;
  afterBytes: number;
  /** Bytes per view the change saves (served file got smaller). */
  saved: number;
  /** Bytes per view the change adds on an image that was undersized before: the sharpness fix. */
  addedForSharpness: number;
  /** Bytes per view the change adds on an image that was not undersized: not a sharpness fix; reported as a warning. */
  grew: number;
  /** The viewports both scans measured this image at. */
  views: number;
}

/** An image in one scan only: it is not counted (data drift). */
export interface UnpairedImage {
  id: string;
  where: string;
  bytes: number;
  views: number;
}

/** A paired image left out of the saving because the page changed under it (its rendered width differs). */
export interface LayoutChangedImage {
  beforeId: string;
  afterId: string;
  where: string;
  beforeBytes: number;
  afterBytes: number;
}

export interface CompareReport {
  before: string;
  after: string;
  /** The viewports both scans measured. */
  views: string[];
  paired: {
    /** Paired images that are compared (layout unchanged, with at least one view both scans loaded). */
    images: number;
    beforeBytes: number;
    afterBytes: number;
    saved: number;
    addedForSharpness: number;
    grewWithoutSharpness: { images: number; bytes: number };
  };
  /**
   * Drift that is excluded from the saving and the sharpness bytes, with its totals. Bytes are per view, summed over the
   * images, so the totals read the same way as the saving.
   */
  excluded: {
    layoutChanged: { images: number; beforeBytes: number; afterBytes: number; list: LayoutChangedImage[] };
    /** Same file (same URL at the same served width) served with different bytes: the server, not the change. */
    serverVariance: { images: number; views: number; bytes: number };
    /** Views where one of the two scans did not receive the file. */
    notLoaded: { views: number };
  };
  /** The page's own image total per view, from each scan (includes data drift; the claim is the paired numbers). */
  pageTotal: { before: number; after: number };
  appeared: UnpairedImage[];
  disappeared: UnpairedImage[];
  /** Every paired image with a change, largest saving first. */
  changes: ComparedImage[];
  dropped: { before: number; after: number };
}

interface ServedAt {
  bytes: number;
  undersized: boolean;
  loaded: boolean;
  servedPx: number | undefined;
}

/** The served bytes of an image at a viewport, when the scan measured it there (undefined otherwise). */
function bytesAt(record: ImageRecord, view: string): ServedAt | undefined {
  const p: ImagePerViewport | undefined = record.perViewport.find((v) => v.viewport === view);
  if (!p || p.skipped !== undefined || !(p.servedBytes > 0)) return undefined;
  return { bytes: p.servedBytes, undersized: p.undersized === true, loaded: p.loaded !== false, servedPx: p.servedPx };
}

/** The rendered width of an image at a viewport, when the scan measured it there. */
function renderedAt(record: ImageRecord, view: string): number | undefined {
  const p = record.perViewport.find((v) => v.viewport === view);
  if (!p || p.skipped !== undefined || !(p.renderedCssPx > 0)) return undefined;
  return p.renderedCssPx;
}

/**
 * The URL the browser asked for to get the file served at `servedPx`: the srcset candidate of that width, or the image's own
 * source when it has no srcset. Undefined when the scan cannot say (the file is then not known to be the same).
 */
function servedUrlOf(record: ImageRecord, servedPx: number | undefined): string | undefined {
  if (servedPx === undefined) return undefined;
  const candidates = record.current.srcsetCandidates ?? [];
  const url = candidates.find((c) => c.width === servedPx)?.url ?? (candidates.length === 0 ? record.current.src : undefined);
  if (!url) return undefined;
  try {
    return new URL(url, record.page).href;
  } catch {
    return undefined;
  }
}

/** The layout distance of two elements: their rendered widths summed over the viewports both scans measured. */
function layoutDistance(x: ImageRecord, y: ImageRecord): number {
  let distance = 0;
  let shared = 0;
  for (const p of x.perViewport) {
    const before = renderedAt(x, p.viewport);
    const after = renderedAt(y, p.viewport);
    if (before === undefined || after === undefined) continue;
    distance += Math.abs(before - after);
    shared++;
  }
  return shared === 0 ? NO_SHARED_LAYOUT : distance;
}

/**
 * The elements of one key group: each before element goes with the after element of the closest layout (greedy, closest
 * pair first, ties in document order). With one element on each side, or equal layouts, this is document order.
 */
function pairGroup(bl: ImageRecord[], al: ImageRecord[]): { pairs: [ImageRecord, ImageRecord][]; before: ImageRecord[]; after: ImageRecord[] } {
  if (bl.length === 1 && al.length === 1) return { pairs: [[bl[0], al[0]]], before: [], after: [] };
  const candidates: { d: number; i: number; j: number }[] = [];
  bl.forEach((x, i) => al.forEach((y, j) => candidates.push({ d: layoutDistance(x, y), i, j })));
  candidates.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j);
  const usedBefore = new Set<number>();
  const usedAfter = new Set<number>();
  const matched: [number, number][] = [];
  for (const c of candidates) {
    if (usedBefore.has(c.i) || usedAfter.has(c.j)) continue;
    usedBefore.add(c.i);
    usedAfter.add(c.j);
    matched.push([c.i, c.j]);
  }
  matched.sort((p, q) => p[0] - q[0]);
  return {
    pairs: matched.map(([i, j]): [ImageRecord, ImageRecord] => [bl[i], al[j]]),
    before: bl.filter((_, i) => !usedBefore.has(i)),
    after: al.filter((_, j) => !usedAfter.has(j)),
  };
}

/** The join of the two scans: images paired by key (then by layout, then in document order); the rest unpaired. */
export function pairImages(before: ImageRecord[], after: ImageRecord[]): { pairs: [ImageRecord, ImageRecord][]; before: ImageRecord[]; after: ImageRecord[] } {
  const groups = (records: ImageRecord[]) => {
    const map = new Map<string, ImageRecord[]>();
    for (const r of records) {
      const key = `${joinKeyOfRecord(r)}\u0000${r.locator.alt ?? ""}`;
      const list = map.get(key);
      if (list) list.push(r);
      else map.set(key, [r]);
    }
    return map;
  };
  const b = groups(before);
  const a = groups(after);
  const pairs: [ImageRecord, ImageRecord][] = [];
  const onlyBefore: ImageRecord[] = [];
  const onlyAfter: ImageRecord[] = [];
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const grouped = pairGroup(b.get(key) ?? [], a.get(key) ?? []);
    pairs.push(...grouped.pairs);
    onlyBefore.push(...grouped.before);
    onlyAfter.push(...grouped.after);
  }
  return { pairs, before: onlyBefore, after: onlyAfter };
}

const DEFAULT_ORDER = DEFAULT_VIEWPORTS.map((v) => v.name);

/** The viewports both pages were scanned at, in the default order. */
function commonViews(a: MeasuredPage, b: MeasuredPage): string[] {
  const inBoth = (name: string) => a.perViewport[name] !== undefined && b.perViewport[name] !== undefined;
  const ordered = DEFAULT_ORDER.filter(inBoth);
  const extra = Object.keys(a.perViewport).filter((name) => !DEFAULT_ORDER.includes(name) && inBoth(name));
  return [...ordered, ...extra];
}

/** True when the rendered width of the pair differs at a shared viewport: the page's layout is not the same. */
function layoutChanged(x: ImageRecord, y: ImageRecord, views: string[]): boolean {
  return views.some((v) => {
    const before = renderedAt(x, v);
    const after = renderedAt(y, v);
    return before !== undefined && after !== undefined && Math.abs(before - after) > LAYOUT_TOLERANCE_PX;
  });
}

/** Compares two scans of one page. Pure: the caller loads the files. */
export function compareScans(before: MeasuredPage, after: MeasuredPage, dropped: { before: number; after: number }): CompareReport {
  const views = commonViews(before, after);
  const { pairs, before: onlyBefore, after: onlyAfter } = pairImages(before.images, after.images);
  const changes: ComparedImage[] = [];
  const excluded: CompareReport["excluded"] = {
    layoutChanged: { images: 0, beforeBytes: 0, afterBytes: 0, list: [] },
    serverVariance: { images: 0, views: 0, bytes: 0 },
    notLoaded: { views: 0 },
  };
  let compared = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  let saved = 0;
  let added = 0;
  let grew = 0;
  let grewImages = 0;
  for (const [b, a] of pairs) {
    if (layoutChanged(b, a, views)) {
      const bView = views.map((v) => bytesAt(b, v)).filter((x): x is ServedAt => x !== undefined);
      const aView = views.map((v) => bytesAt(a, v)).filter((x): x is ServedAt => x !== undefined);
      if (bView.length === 0 || aView.length === 0) continue;
      const beforeMean = bView.reduce((s, x) => s + x.bytes, 0) / bView.length;
      const afterMean = aView.reduce((s, x) => s + x.bytes, 0) / aView.length;
      excluded.layoutChanged.images++;
      excluded.layoutChanged.beforeBytes += beforeMean;
      excluded.layoutChanged.afterBytes += afterMean;
      excluded.layoutChanged.list.push({ beforeId: b.id, afterId: a.id, where: whereOfRecord(a), beforeBytes: beforeMean, afterBytes: afterMean });
      continue;
    }
    const measured = views.filter((v) => bytesAt(b, v) !== undefined && bytesAt(a, v) !== undefined);
    const comparable = measured.filter((v) => {
      const loaded = bytesAt(b, v)?.loaded === true && bytesAt(a, v)?.loaded === true;
      if (!loaded) excluded.notLoaded.views++;
      return loaded;
    });
    if (comparable.length === 0) continue;
    let sumBefore = 0;
    let sumAfter = 0;
    let sumSaved = 0;
    let sumAdded = 0;
    let sumGrew = 0;
    let sumVariance = 0;
    let varianceViews = 0;
    for (const v of comparable) {
      const x = bytesAt(b, v) as ServedAt;
      const y = bytesAt(a, v) as ServedAt;
      sumBefore += x.bytes;
      sumAfter += y.bytes;
      if (x.bytes === y.bytes) continue;
      const urlBefore = servedUrlOf(b, x.servedPx);
      if (urlBefore !== undefined && x.servedPx === y.servedPx && urlBefore === servedUrlOf(a, y.servedPx)) {
        sumVariance += Math.abs(y.bytes - x.bytes);
        varianceViews++;
        continue;
      }
      sumSaved += Math.max(0, x.bytes - y.bytes);
      if (y.bytes > x.bytes) {
        if (x.undersized) sumAdded += y.bytes - x.bytes;
        else sumGrew += y.bytes - x.bytes;
      }
    }
    const n = comparable.length;
    const row: ComparedImage = {
      beforeId: b.id,
      afterId: a.id,
      where: whereOfRecord(a),
      beforeBytes: sumBefore / n,
      afterBytes: sumAfter / n,
      saved: sumSaved / n,
      addedForSharpness: sumAdded / n,
      grew: sumGrew / n,
      views: n,
    };
    compared++;
    beforeBytes += row.beforeBytes;
    afterBytes += row.afterBytes;
    saved += row.saved;
    added += row.addedForSharpness;
    grew += row.grew;
    if (row.grew > 0) grewImages++;
    if (varianceViews > 0) {
      excluded.serverVariance.images++;
      excluded.serverVariance.views += varianceViews;
      excluded.serverVariance.bytes += sumVariance / n;
    }
    if (row.saved > 0 || row.addedForSharpness > 0 || row.grew > 0) changes.push(row);
  }
  const unpaired = (records: ImageRecord[]): UnpairedImage[] =>
    records.flatMap((r) => {
      const seen = views.map((v) => bytesAt(r, v)).filter((x): x is ServedAt => x !== undefined);
      if (seen.length === 0) return [];
      const bytes = seen.reduce((s, x) => s + x.bytes, 0) / seen.length;
      return [{ id: r.id, where: whereOfRecord(r), bytes, views: seen.length }];
    });
  const pageTotal = (page: MeasuredPage): number => {
    if (views.length === 0) return 0;
    return views.reduce((s, v) => s + (page.perViewport[v]?.imageBytes ?? 0), 0) / views.length;
  };
  changes.sort((x, y) => y.saved - x.saved || x.afterId.localeCompare(y.afterId));
  return {
    before: before.url,
    after: after.url,
    views,
    paired: {
      images: compared,
      beforeBytes,
      afterBytes,
      saved,
      addedForSharpness: added,
      grewWithoutSharpness: { images: grewImages, bytes: grew },
    },
    excluded,
    pageTotal: { before: pageTotal(before), after: pageTotal(after) },
    appeared: unpaired(onlyAfter),
    disappeared: unpaired(onlyBefore),
    changes,
    dropped,
  };
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/** The path of a page URL for the output (no host, no query: the host is the built or dev server's). */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return safeText(`${u.host}${u.pathname}`);
  } catch {
    return safeText(url);
  }
}

/** The compare report as text: the paired numbers first, then the excluded drift, the page total and the unpaired images. */
export function renderCompare(report: CompareReport, limit: number): string {
  const { paired, excluded } = report;
  const lines: string[] = [];
  lines.push(`compare: ${pathOf(report.before)} (before) -> ${pathOf(report.after)} (after), ${report.views.length} viewport(s) in both`);
  lines.push(`paired images: ${paired.images} compared (matched by srcset URL pattern and alt, then rendered layout, in document order)`);
  lines.push(`  per view, paired images: before ${kb(paired.beforeBytes)}, after ${kb(paired.afterBytes)}`);
  lines.push(`  saved: ${kb(paired.saved)}/view`);
  lines.push(`  added for sharpness: ${kb(paired.addedForSharpness)}/view (undersized before the change)`);
  if (paired.grewWithoutSharpness.images > 0) {
    lines.push(
      `  warning: grew without a sharpness reason: ${kb(paired.grewWithoutSharpness.bytes)}/view on ${paired.grewWithoutSharpness.images} image(s) (not counted as saved)`,
    );
  }
  const drift: string[] = [];
  if (excluded.layoutChanged.images > 0) {
    drift.push(
      `    layout changed (rendered width differs, not compared): ${excluded.layoutChanged.images} image(s), ${kb(excluded.layoutChanged.beforeBytes)} -> ${kb(excluded.layoutChanged.afterBytes)}/view`,
    );
  }
  if (excluded.serverVariance.views > 0) {
    drift.push(
      `    server variance (same URL and width, different bytes): ${excluded.serverVariance.images} image(s), ${excluded.serverVariance.views} view(s), ${kb(excluded.serverVariance.bytes)}/view`,
    );
  }
  if (excluded.notLoaded.views > 0) {
    drift.push(`    not loaded in one scan (lazy-load timing): ${excluded.notLoaded.views} view(s)`);
  }
  if (drift.length > 0) {
    lines.push("  excluded, not claimed (drift):");
    lines.push(...drift);
  }
  lines.push(
    `page total (includes data drift, not the claim): before ${kb(report.pageTotal.before)}/view, after ${kb(report.pageTotal.after)}/view`,
  );
  lines.push(
    `unpaired, not counted (data drift): appeared ${report.appeared.length}, disappeared ${report.disappeared.length}`,
  );
  const top = report.changes.slice(0, limit);
  if (top.length > 0) {
    lines.push(`largest changes (top ${top.length} of ${report.changes.length}):`);
    top.forEach((row, i) => {
      lines.push(
        `  ${i + 1}. ${JSON.stringify(safeText(row.where))}  ${row.beforeId} -> ${row.afterId}  ${kb(row.beforeBytes)} -> ${kb(row.afterBytes)}  saved ${kb(row.saved)}, sharpness +${kb(row.addedForSharpness)}`,
      );
    });
  }
  const layoutList = excluded.layoutChanged.list;
  if (layoutList.length > 0) {
    lines.push(`layout changed (excluded, not compared): ${layoutList.length}`);
    layoutList.slice(0, limit).forEach((row) =>
      lines.push(`  ${JSON.stringify(safeText(row.where))}  ${row.beforeId} -> ${row.afterId}  ${kb(row.beforeBytes)} -> ${kb(row.afterBytes)}/view`),
    );
    if (layoutList.length > limit) lines.push(`  ... ${layoutList.length - limit} more (--format json lists all)`);
  }
  for (const [label, list] of [
    ["appeared", report.appeared],
    ["disappeared", report.disappeared],
  ] as const) {
    if (list.length === 0) continue;
    lines.push(`${label} (data drift, not counted): ${list.length}`);
    list.slice(0, limit).forEach((row) => lines.push(`  ${JSON.stringify(safeText(row.where))}  ${row.id}  ${kb(row.bytes)}/view`));
    if (list.length > limit) lines.push(`  ... ${list.length - limit} more (--format json lists all)`);
  }
  return `${lines.join("\n")}\n`;
}

/** `imgtune compare <before.json> <after.json> ...`: reads both scans, returns the text or JSON to print. */
export async function compareCommand(argv: string[], cwd: string): Promise<{ output: string; exitCode: number }> {
  const args = parseCompareArgs(argv);
  const before = await readMeasuredScan(args.before, cwd);
  const after = await readMeasuredScan(args.after, cwd);
  const report = compareScans(before.page, after.page, { before: before.dropped, after: after.dropped });
  if (args.format === "json") return { output: `${JSON.stringify(report, null, 2)}\n`, exitCode: 0 };
  return { output: renderCompare(report, args.limit), exitCode: 0 };
}
