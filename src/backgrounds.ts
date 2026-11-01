// CSS background images: the elements whose computed `background-image` has a url() or an image-set(). Each layer is
// measured like an image: the box it is drawn in, the `background-size` that scales it, the file the browser loaded and
// the device pixels the layer needs. There is no `sizes` in CSS, so the fix is a smaller file or an image-set() with
// the sizes the layer needs; the record keeps the `kind: "css-background"` so the hints and the report say so.
//
// Pure parsing and sizing here; the measurement (fetches, decodes, resize estimates) is in remote.ts, and the records are
// built in buildBackgroundRecords below.

import { sha1 } from "./atomic.js";
import { searchHintsOf, type ImageLocator, type ImageRecord, type ImagePerViewport, type ResolvedSource } from "./images.js";
import { loaderName, sanitizeText, urlPattern, type OwnerTrace } from "./locate.js";
import type { Viewport } from "./types.js";

/** The most background elements read per viewport: a page with more keeps the first of them in document order. */
export const MAX_BACKGROUND_ELEMENTS = 1000;

/** One candidate of a layer: a url() or an image-set() entry, with its density (1 for url()). */
export interface BackgroundCandidate {
  url: string;
  resolution: number;
}

/** One layer of a computed background-image list. A gradient or `none` layer has no candidates. */
export interface BackgroundLayer {
  candidates: BackgroundCandidate[];
  /** A data: URI (inline). It is not a request, so it is not measured. */
  dataUri: boolean;
}

/** One element with a background image, as the browser read it at one viewport. */
export interface ObservedBackground {
  /** Position among the background elements of the page, in document order (stable across viewports). */
  index: number;
  selector: string;
  classes: string;
  testid?: string;
  /** The React owner trace of the element itself (dev and production builds; names are minified in production). */
  owners: OwnerTrace[];
  /** Border box, CSS px. */
  width: number;
  height: number;
  /** Not displayed: display none, visibility hidden, or no box. */
  hidden: boolean;
  /** The computed background-image (inline data: URIs replaced by a placeholder before they leave the browser). */
  backgroundImage: string;
  /** The computed background-size, one entry per layer. */
  backgroundSize: string;
}

/** One layer of one element at one viewport, measured. */
export interface BackgroundInstance {
  viewport: Viewport;
  bg: ObservedBackground;
  /** The layer's place in the background-image list. */
  layer: number;
  /** The candidate the browser loaded for the layer ("" when none was loaded). */
  url: string;
  bytes: number;
  pixelWidth: number;
  format?: string;
  /** The CSS px the layer is drawn at (from box and background-size). */
  displayedCss: number;
  /** Device pixels the layer needs at this viewport. */
  needed: number;
  skipped?: string;
  /** The served file is below 0.9 x needed: its pixels are too few for the layer (no alternative file was offered). */
  undersized: boolean;
  /** Bytes a resize to the needed width (same format) would save, estimated locally. */
  est: number;
  estAggressive: number;
  size: string;
}

/** Splits at the top-level separator: not inside parentheses or quotes. */
export function splitTop(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

/** The URL of a `url(...)` token (quoted or bare), or undefined when the text does not start with one. */
function urlToken(text: string): { url: string; rest: string } | undefined {
  const m = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/.exec(text);
  if (!m) return undefined;
  return { url: (m[1] ?? m[2] ?? m[3] ?? "").trim(), rest: text.slice(m[0].length).trim() };
}

/** The URL of an image-set() entry: a url() token or a bare quoted string. */
function entryUrl(entry: string): { url: string; rest: string } | undefined {
  const quoted = /^(?:"([^"]*)"|'([^']*)')/.exec(entry);
  if (quoted) return { url: (quoted[1] ?? quoted[2] ?? "").trim(), rest: entry.slice(quoted[0].length).trim() };
  return urlToken(entry);
}

/** The density of an image-set() entry: `2x` or `192dppx` (1 when absent or unreadable). */
function resolutionOf(rest: string): number {
  const m = /(\d*\.?\d+)\s*(x|dppx)\b/.exec(rest);
  const value = m ? Number(m[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * The layers of a computed background-image, in order (the same count as the list, so a layer's index matches its
 * background-size). A url() layer has one candidate; an image-set() layer has one per entry; a data: layer is marked.
 */
export function parseBackgroundImage(value: string): BackgroundLayer[] {
  return splitTop(value).map((part): BackgroundLayer => {
    const text = part.trim();
    const set = /^(?:-webkit-)?image-set\(([\s\S]*)\)$/.exec(text);
    if (set) {
      const candidates: BackgroundCandidate[] = [];
      let dataUri = false;
      for (const entry of splitTop(set[1])) {
        const found = entryUrl(entry.trim());
        if (!found || found.url === "") continue;
        if (found.url.startsWith("data:")) {
          dataUri = true;
          continue;
        }
        candidates.push({ url: found.url, resolution: resolutionOf(found.rest) });
      }
      return { candidates, dataUri };
    }
    const single = urlToken(text);
    if (single && single.url !== "") {
      if (single.url.startsWith("data:")) return { candidates: [], dataUri: true };
      return { candidates: [{ url: single.url, resolution: 1 }], dataUri: false };
    }
    // A gradient, `none` or an unreadable value: not an image.
    return { candidates: [], dataUri: false };
  });
}

/** The background-size of each layer (the computed value has one entry per layer). */
export function parseBackgroundSize(value: string): string[] {
  const sizes = splitTop(value).map((s) => s.trim().replace(/\s+/g, " "));
  return sizes.length > 0 && sizes.every((s) => s !== "") ? sizes : ["auto"];
}

/**
 * The CSS px a length takes: a px value, a percentage of the base, or undefined for `auto`. Null for any other unit (the
 * layer is then not measured: the browser's own layout is not reproduced for it).
 */
function lengthOf(token: string | undefined, base: number): number | undefined | null {
  if (token === undefined || token === "auto") return undefined;
  if (/^[+-]?\d*\.?\d+px$/.test(token)) return parseFloat(token);
  if (/^[+-]?\d*\.?\d+%$/.test(token)) return (parseFloat(token) / 100) * base;
  return null;
}

/**
 * The CSS width the layer is drawn at, from its box and its background-size. `cover` covers the box: the larger of the
 * box width and the box height scaled by the image's aspect ratio. `contain` fits it inside. A length (px or %) gives
 * the width; with `auto` height or width it follows the aspect ratio. `auto` is the natural width. Undefined for a unit
 * this does not read. Background position only crops, so it does not change the width needed (an upper bound).
 */
export function displayedCssWidth(
  size: string,
  box: { width: number; height: number },
  natural: { width: number; height: number },
): number | undefined {
  const aspect = natural.height > 0 ? natural.width / natural.height : NaN;
  const [first, second] = size.trim().split(/\s+/);
  if (first === "cover") return Math.max(box.width, box.height * aspect);
  if (first === "contain") return Math.min(box.width, box.height * aspect);
  const w = lengthOf(first, box.width);
  if (w === null) return undefined;
  if (second === undefined || second === "auto") return w ?? natural.width;
  const h = lengthOf(second, box.height);
  if (h === null) return undefined;
  if (w !== undefined) return w;
  return h === undefined ? natural.width : h * aspect;
}

/** Device pixels for a CSS width at a device pixel ratio (rounded up, as the images are). */
export function neededDevicePixels(cssWidth: number, dpr: number): number {
  return Math.ceil(cssWidth * dpr);
}

/** The candidate the layer draws from: among those loaded, the lowest density at or above the DPR, else the highest. */
export function pickLoaded(candidates: BackgroundCandidate[], loaded: (url: string) => boolean, dpr: number): BackgroundCandidate | undefined {
  const found = candidates.filter((c) => loaded(c.url)).sort((a, b) => a.resolution - b.resolution);
  return found.find((c) => c.resolution >= dpr - 1e-6) ?? found[found.length - 1];
}

/** The group key of a background element: its owner component, else its test id, else its DOM path (and the layer). */
export function backgroundBaseKey(bg: ObservedBackground, source: ResolvedSource | undefined, layer: number): string {
  let base: string;
  if (source?.file) base = source.file;
  else if (source && source.component.length > 0) base = `component:${source.component.join(">")}`;
  else if (bg.testid) base = `testid:${bg.testid}`;
  else base = `css:${bg.selector}`;
  return layer > 0 ? `${base}/layer${layer}` : base;
}

/** The locator of a background element: its owner names and file (unchecked), and the selector as the fallback. */
function locatorOfBackground(
  pageUrl: string,
  url: string,
  bg: ObservedBackground,
  source: ResolvedSource | undefined,
): ImageLocator {
  const locator: ImageLocator = {
    component: source?.component ?? [],
    selector: sanitizeText(bg.selector, 300),
    classes: sanitizeText(bg.classes, 120),
    loader: url ? loaderName(url, pageUrl) : "unknown",
  };
  if (source?.file !== undefined) {
    locator.file = source.file;
    locator.line = source.line;
    // The owner's file is read from the page's own trace, not checked against an image line: never verified.
    locator.kind = "unchecked";
    locator.verified = false;
  }
  if (bg.testid !== undefined) locator.testid = sanitizeText(bg.testid, 120);
  if (url) locator.urlPattern = sanitizeText(urlPattern(url, pageUrl) ?? "", 300);
  if (source?.file === undefined) {
    const search = searchHintsOf(locator);
    if (search !== undefined) locator.searchHints = search;
  }
  return locator;
}

/**
 * The image records of the background layers of one page: one record per layer of a distinct element, merged across
 * viewports. `sources` is the owner resolution by element index (see resolveBackgroundSources in remote.ts).
 */
export function buildBackgroundRecords(input: {
  pageUrl: string;
  viewports: Viewport[];
  instances: BackgroundInstance[];
  refName: string;
  sources: Map<number, ResolvedSource>;
}): ImageRecord[] {
  const { pageUrl, viewports, instances, refName, sources } = input;
  const viewportCount = viewports.length;

  // One key per layer and viewport: the base key plus the ordinal among those sharing it, in document order.
  const keyOf = new Map<BackgroundInstance, string>();
  for (const view of viewports) {
    const ordinals = new Map<string, number>();
    for (const inst of instances) {
      if (inst.viewport.name !== view.name) continue;
      const base = backgroundBaseKey(inst.bg, sources.get(inst.bg.index), inst.layer);
      const n = ordinals.get(base) ?? 0;
      ordinals.set(base, n + 1);
      keyOf.set(inst, `${base}#${n}`);
    }
  }
  const byKey = new Map<string, BackgroundInstance[]>();
  for (const inst of instances) {
    const key = keyOf.get(inst);
    if (key === undefined) continue;
    const list = byKey.get(key);
    if (list) list.push(inst);
    else byKey.set(key, [inst]);
  }

  const records: ImageRecord[] = [];
  for (const [key, members] of byKey) {
    const member = members.find((m) => m.viewport.name === refName) ?? members[0];
    const source = sources.get(member.bg.index);
    const url = member.url;
    const perViewport: ImagePerViewport[] = [];
    for (const view of viewports) {
      const inst = members.find((m) => m.viewport.name === view.name);
      if (!inst) continue;
      const entry: ImagePerViewport = {
        viewport: view.name,
        dpr: view.dpr,
        renderedCssPx: Math.round(inst.displayedCss * 10) / 10,
        neededPx: inst.needed,
        servedBytes: inst.bytes,
        undersized: inst.undersized,
        loaded: inst.url !== "" && inst.bytes > 0,
      };
      if (inst.pixelWidth > 0) entry.servedPx = inst.pixelWidth;
      if (inst.pixelWidth > 0 && inst.needed > 0) entry.overFetchRatio = Math.round((inst.pixelWidth / inst.needed) * 100) / 100;
      if (inst.skipped !== undefined) entry.skipped = inst.skipped;
      perViewport.push(entry);
    }
    const saved = members.reduce((sum, m) => sum + m.est, 0) / viewportCount;
    const served = member.format;
    const best = served === "jpeg" || served === "png" ? (saved > 0 ? "avif" : served) : served;
    const locator = locatorOfBackground(pageUrl, url, member.bg, source);
    const notes: string[] = [
      `css background: layer ${member.layer + 1}, background-size "${sanitizeText(member.size, 60)}", drawn ${Math.round(member.displayedCss)} CSS px at the reference viewport`,
      "no sizes attribute in CSS: fix with a smaller file, or image-set() with the density or width variants the layer needs",
    ];
    if (source?.file) notes.push(`source: ${source.file}:${source.line ?? 0} (React owner, not checked against an image line)`);
    else if (locator.component.length > 0) notes.push(`component: ${locator.component.join(" > ")} (no project file resolved)`);
    else notes.push(`not located: selector ${locator.selector} (no React owner; the stylesheet rule is not read)`);
    if (members.some((m) => m.skipped !== undefined)) {
      notes.push(`skipped at ${members.filter((m) => m.skipped !== undefined).length} viewport(s)`);
    }
    if (members.some((m) => m.undersized)) notes.push("undersized at some viewport: the file has fewer pixels than the layer needs (blur, not a saving)");
    const record: ImageRecord = {
      id: sha1(`${pageUrl}\n${key}`).slice(0, 12),
      kind: "css-background",
      page: pageUrl,
      locator,
      tunable: { width: true, quality: false, reason: "no quality estimate for background images" },
      current: {
        src: url || undefined,
        srcsetCandidates: [],
        format: served,
        naturalWidth: member.pixelWidth > 0 ? member.pixelWidth : undefined,
      },
      perViewport,
      fix: {
        width: member.needed > 0 ? member.needed : undefined,
        bytes: { saved, addedForSharpness: 0, sizes: 0, quality: saved },
      },
      evidence: { rung: "measured-page", notes },
    };
    if (best !== undefined) record.fix.format = best;
    records.push(record);
  }
  return records.filter((r) => r.perViewport.some((p) => p.loaded || p.skipped !== undefined));
}

/** The background layers of one viewport: the measured ones (served bytes, est. saving, undersized count). */
export interface BackgroundTotals {
  measured: number;
  servedBytes: number;
  estSaved: number;
  undersized: number;
}

export function backgroundTotals(instances: BackgroundInstance[]): BackgroundTotals {
  const measured = instances.filter((i) => i.skipped === undefined);
  return {
    measured: measured.length,
    servedBytes: measured.reduce((sum, i) => sum + i.bytes, 0),
    estSaved: measured.reduce((sum, i) => sum + i.est, 0),
    undersized: measured.filter((i) => i.undersized).length,
  };
}

/** The page's background layers: counts, and the served bytes and est. saving per page view (mean over the viewports). */
export interface BackgroundPage {
  /** Layers measured at some viewport. */
  layers: number;
  servedBytes: number;
  estSaved: number;
  /** Layers undersized at some viewport. */
  undersized: number;
}

export function backgroundPage(instances: BackgroundInstance[], viewportCount: number, records: ImageRecord[]): BackgroundPage {
  const measured = instances.filter((i) => i.skipped === undefined);
  return {
    layers: records.filter((r) => r.perViewport.some((p) => p.loaded)).length,
    servedBytes: measured.reduce((sum, i) => sum + i.bytes, 0) / viewportCount,
    estSaved: measured.reduce((sum, i) => sum + i.est, 0) / viewportCount,
    undersized: records.filter((r) => r.perViewport.some((p) => p.undersized)).length,
  };
}
