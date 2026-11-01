/// <reference lib="dom" />
import { mkdir, readFile, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page, Response as BrowserResponse } from "playwright";
import { launchChromium } from "./browser.js";
import sharp, { type Sharp } from "sharp";
import { writeFileAtomic, sha1 } from "./atomic.js";
import { mdCode, mdText, safeText } from "./text.js";
import { commentHints } from "./hints.js";
import type { LocateSummary } from "./locate-join.js";
export { mdCode, mdText, safeText };
import { isLocalTarget, systemResolver, type Resolver } from "./address.js";
import { startEgressProxy, type EgressPolicy } from "./egress-proxy.js";
import { makeFetcher, MAX_IMAGE_BYTES, type Fetcher, type FetchOptions } from "./fetch.js";
import { sameSite } from "./site.js";
import { matchLocalQuality } from "./calibrate.js";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { encode, ENCODE_THREADS, ENCODER_ID } from "./encode.js";
import { adapterFor, originalOf, type QualityParam } from "./loaders.js";
import type { LayoutChainData, LayoutNode } from "./layout.js";
import type { LocatorKind, LocatorVia, OwnerSource, OwnerTrace, SourceMapData, StackFrame } from "./locate.js";
import { COMPONENT_NAME, MAX_SOURCE_READ, imageAtLine, parseSourceMap, resolveFunctionLocations, resolveOwnerChain, resolveOwners } from "./locate.js";
import { buildImageRecords, hasFix, rungOfPage, type ImageRecord, type ResolvedSource } from "./images.js";
import {
  backgroundPage,
  backgroundTotals,
  buildBackgroundRecords,
  type BackgroundPage,
  type BackgroundTotals,
  displayedCssWidth,
  MAX_BACKGROUND_ELEMENTS,
  MAX_BACKGROUND_VALUE,
  backgroundTooLarge,
  neededDevicePixels,
  parseBackgroundImage,
  parseBackgroundSize,
  pickLoaded,
  type BackgroundInstance,
  type BackgroundLayer,
  type ObservedBackground,
} from "./backgrounds.js";
import { applySizesOutcome } from "./sizes-outcome.js";
import { sampleByPattern, urlsFromSource } from "./urls.js";
import { countDocumentNavigations, gotoParsed, settlePage, settleWithin, waitForLoadWithin, BODY_READ_TIMEOUT_MS } from "./measure.js";
import { makeScorer, type Scorer } from "./metric.js";
import { gpuNote, parseGpuDevice, startGpuScorer, type GpuScorer } from "./gpu.js";
import { minPassingQuality } from "./search.js";
import { cacheScope, CACHE_DIR, contentHash, ResultCache } from "./result-cache.js";
import { isFolder, sourceRootOf, unreadSourceNote } from "./source-root.js";

import { MAX_WIDTH, parseSrcset, type Candidate } from "./srcset-parse.js";
import { deriveSizes, type SizePoint } from "./sizes.js";
import type { RawImage } from "./ssim.js";
import type { Viewport } from "./types.js";
import { IMGTUNE_VERSION } from "./version.js";
import { count, measure, renderTiming, resetTiming, TIMING_ENABLED } from "./timing.js";
import { mapLimit, settleLimit } from "./concurrency.js";

export { ipv6Bytes, isBlockedAddress, isLocalTarget, isPrivateAddress, refusedAddress, guardedLookup, type Resolver } from "./address.js";
export { makeFetcher, MAX_IMAGE_BYTES, type Fetcher, type FetchOptions } from "./fetch.js";
export { registrableDomain, sameSite } from "./site.js";

/** Thresholds of the report and the local search. */
const MIN_RENDERED_PX = 16;
/** A plain <img> wider than this multiple of what it needs is an estimated resize. */
const PLAIN_RESIZE_RATIO = 1.1;
/** At most this many images per group are scored for quality, at the reference viewport. */
const SAMPLES_PER_GROUP = 8;
/**
 * A served file below this size is not swept for quality: the sweep saves at most the file's own bytes, so the saving is
 * under 2 KB. Such an image gets its group's ratio (if the group has samples) and is marked sweep "skipped-small".
 */
export const SWEEP_MIN_BYTES = 2048;
/** Quality samples estimated at once: each encode runs ENCODE_THREADS libvips threads, so two pairs fill the CPUs without contention. */
const QUALITY_PARALLEL = Math.max(1, Math.min(2, Math.floor(availableParallelism() / ENCODE_THREADS)));
const TOP_GROUPS = 10;

/** How an image's quality was set: its own sample (sampled), its group's ratio, or no sweep (skipped-small). */
export interface QualityInfo {
  current: number;
  qualityAssumed: boolean;
  target?: number;
  format?: string;
  sampled: boolean;
  sweep?: "skipped-small";
}

/** Default output directory, relative to the working directory. */
export const DEFAULT_OUT = ".imgtune/scan";
/** How long a page may take to fire `load` after its document is parsed; the scan continues either way. */
export const LOAD_EVENT_CAP_MS = 30_000;
/** After load, a page that navigates (a reload, a script's location change) is observed again, at most this many times. */
export const MAX_POST_LOAD_NAVIGATIONS = 3;
/** Viewports of one page loaded at the same time (each in its own browser context). */
export const VIEWPORT_CONCURRENCY = 3;
const CHALLENGE_STATUS: readonly number[] = [403, 429, 503];
const CHALLENGE_MARKERS: readonly string[] = ["cf-chl", "captcha"];
/** Quality assumed for an image whose URL does not say (next/image's default). */
export const ASSUMED_QUALITY = 75;

// ---------------------------------------------------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------------------------------------------------

interface RobotsRule {
  allow: boolean;
  length: number;
  pattern: string;
}

/** Rules longer than this are ignored; a robots.txt is read up to MAX_ROBOTS_BYTES. */
const MAX_RULE_LENGTH = 1024;
export const MAX_ROBOTS_BYTES = 512 * 1024;

/**
 * Whether a robots path pattern matches the start of `path`, in linear-style time: the `*` parts are located greedily
 * from left to right (no backtracking), and a trailing `$` anchors the end of the path.
 */
export function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  if (parts.length === 1) return anchored ? path === parts[0] : path.startsWith(parts[0]);
  if (!path.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  const last = parts.length - 1;
  for (let i = 1; i < last; i++) {
    const found = path.indexOf(parts[i], pos);
    if (found === -1) return false;
    pos = found + parts[i].length;
  }
  const tail = parts[last];
  if (anchored) return path.length - tail.length >= pos && path.endsWith(tail);
  return path.indexOf(tail, pos) !== -1;
}

/** The Allow and Disallow rules of the `User-agent: *` group. Empty values allow everything, so they are no rule. */
function starRules(robotsTxt: string): RobotsRule[] {
  const rules: RobotsRule[] = [];
  let applies = false;
  let afterAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!afterAgent) applies = false;
      if (value === "*") applies = true;
      afterAgent = true;
      continue;
    }
    afterAgent = false;
    if (!applies || value === "" || value.length > MAX_RULE_LENGTH) continue;
    if (key === "allow" || key === "disallow") rules.push({ allow: key === "allow", length: value.length, pattern: value });
  }
  return rules;
}

/**
 * Whether robots.txt lets the `*` user agent fetch `target`. The longest matching rule decides; on a tie Allow wins;
 * no matching rule allows. `robotsTxt` is undefined when the site has no robots.txt.
 */
export function robotsAllows(robotsTxt: string | undefined, target: string): boolean {
  if (robotsTxt === undefined) return true;
  const best = decidingRule(robotsTxt, target);
  return best ? best.allow : true;
}

/** The rule that decides `target` for the `*` user agent, as robots.txt writes it ("Disallow: /cart"); undefined when none. */
export function robotsRuleFor(robotsTxt: string | undefined, target: string): string | undefined {
  if (robotsTxt === undefined) return undefined;
  const rule = decidingRule(robotsTxt, target);
  return rule ? `${rule.allow ? "Allow" : "Disallow"}: ${rule.pattern}` : undefined;
}

function decidingRule(robotsTxt: string, target: string): RobotsRule | undefined {
  const url = new URL(target);
  const path = url.pathname + url.search;
  let best: RobotsRule | undefined;
  for (const rule of starRules(robotsTxt)) {
    if (!ruleMatches(rule.pattern, path)) continue;
    if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) best = rule;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolution: srcset candidates and the right one
// ---------------------------------------------------------------------------------------------------------------------


import { UNDERSIZED_RATIO, isUndersized, neededWidth, rightCandidate, undersizedProposal } from "./candidates.js";
export { isUndersized, neededWidth, rightCandidate } from "./candidates.js";

// ---------------------------------------------------------------------------------------------------------------------
// References and the current quality of a URL
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The original an optimised image URL was made from, per its loader (`/_next/image?url=X`, a Cloudflare
 * `/cdn-cgi/image/<opts>/<path>`, a CDN's own original, ...). Any other URL has no known original.
 */
export function referenceUrl(src: string, pageUrl: string): string | undefined {
  try {
    return originalOf(src, pageUrl);
  } catch {
    return undefined;
  }
}

/**
 * The quality the URL asks for, per its loader. Without one in the URL, the loader's documented default (not assumed);
 * else ASSUMED_QUALITY, assumed.
 */
export function currentQuality(src: string, pageUrl = "http://localhost"): { quality: number; assumed: boolean } {
  try {
    const { adapter, url } = adapterFor(src, pageUrl);
    const fromUrl = adapter.quality(url);
    if (fromUrl !== undefined) return { quality: fromUrl, assumed: false };
    if (adapter.defaultQuality !== undefined) return { quality: adapter.defaultQuality, assumed: false };
  } catch {
    // An unparseable src has no quality: the assumed one below.
  }
  return { quality: ASSUMED_QUALITY, assumed: true };
}

/** The loader name and its quality parameter for one image URL; "generic" when the URL does not parse. */
export function loaderOf(src: string, pageUrl: string): { loader: string; qualityParam: QualityParam } {
  try {
    const { adapter } = adapterFor(src, pageUrl);
    return { loader: adapter.name, qualityParam: adapter.qualityParam };
  } catch {
    return { loader: "generic", qualityParam: "yes" };
  }
}

/**
 * One file's savings at one viewport, net of what the page would get instead: `exact` is the resolution saving (the
 * right candidate against the served file), `est` the quality or format saving on top of it, and `total` their sum.
 * The total never exceeds the served bytes, and a right file bigger than the served one saves nothing.
 */
export function netSavings(served: number, rightBytes: number, ratio: number): { exact: number; est: number; total: number } {
  const exact = Math.max(0, served - rightBytes);
  const total = Math.max(0, served - rightBytes * ratio);
  return { exact, est: Math.max(0, total - exact), total };
}

/** Representative order: the wider element, then one with a srcset (it alone has a right candidate), then the first. */
function beats(a: { index: number; width: number; srcset: boolean }, b: { index: number; width: number; srcset: boolean }): boolean {
  if (a.width !== b.width) return a.width > b.width;
  if (a.srcset !== b.srcset) return a.srcset;
  return a.index < b.index;
}

/**
 * The elements of one viewport that repeat a URL already shown by another element (carousel clones, for one). Each URL
 * is downloaded once, so only one element per URL is measured: the one with the largest rendered width (its slot needs
 * the most), ties to the first in document order. Returns element index -> the index of the element measured instead.
 */
export function duplicatesOf(
  images: { index: number; currentSrc: string; renderedWidth: number; srcset?: string }[],
): Map<number, number> {
  const representative = new Map<string, { index: number; width: number; srcset: boolean }>();
  for (const img of images) {
    if (!img.currentSrc) continue;
    const candidate = { index: img.index, width: img.renderedWidth, srcset: Boolean(img.srcset?.trim()) };
    const current = representative.get(img.currentSrc);
    if (!current || beats(candidate, current)) representative.set(img.currentSrc, candidate);
  }
  const out = new Map<number, number>();
  for (const img of images) {
    if (!img.currentSrc) continue;
    const rep = representative.get(img.currentSrc);
    if (rep && rep.index !== img.index) out.set(img.index, rep.index);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Aggregation: per viewport, per page, per site
// ---------------------------------------------------------------------------------------------------------------------

/** What one image element (at one viewport) contributes. Bytes are its served file's. */
export interface ImageFinding {
  bytes: number;
  exact: number;
  est: number;
  /** Quality and format savings at delta 4 (`--aggressive`); never used for the claim. */
  estAggressive: number;
  growth: number;
}

export interface ViewportTotals {
  /** All image bytes of the page view: the denominator. */
  imageBytes: number;
  exact: number;
  est: number;
  estAggressive: number;
  /** Sharpness growth, reported separately and never netted against savings. */
  growth: number;
  /** Bytes of the images that have a saving (exact or est). */
  fixableBytes: number;
}

export function viewportTotals(images: ImageFinding[], imageBytes: number): ViewportTotals {
  const totals: ViewportTotals = { imageBytes, exact: 0, est: 0, estAggressive: 0, growth: 0, fixableBytes: 0 };
  for (const img of images) {
    totals.exact += img.exact;
    totals.est += img.est;
    totals.estAggressive += img.estAggressive;
    totals.growth += img.growth;
    if (img.exact + img.est > 0) totals.fixableBytes += img.bytes;
  }
  return totals;
}

export interface PageNumbers {
  meanImageBytes: number;
  exactPct: number;
  exactEstPct: number;
  /** Savings as a share of the bytes of the images that have one. */
  fixablePct: number;
  sharpnessKB: number;
  /** Only with --aggressive. */
  aggressiveExactEstPct?: number;
}

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length);
const share = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);

/** Page numbers: the mean over viewports of each viewport's share of its image bytes. */
export function pageNumbers(perViewport: ViewportTotals[]): PageNumbers {
  return {
    meanImageBytes: mean(perViewport.map((v) => v.imageBytes)),
    exactPct: mean(perViewport.map((v) => share(v.exact, v.imageBytes))),
    exactEstPct: mean(perViewport.map((v) => share(v.exact + v.est, v.imageBytes))),
    fixablePct: mean(perViewport.map((v) => share(v.exact + v.est, v.fixableBytes))),
    sharpnessKB: mean(perViewport.map((v) => v.growth / 1024)),
    aggressiveExactEstPct: mean(perViewport.map((v) => share(v.exact + v.estAggressive, v.imageBytes))),
  };
}

export interface SiteNumbers extends PageNumbers {
  pages: number;
}

/** Site numbers: the mean of its pages. */
export function siteNumbers(pages: PageNumbers[]): SiteNumbers {
  const pick = (key: keyof PageNumbers) => mean(pages.map((p) => p[key] ?? 0));
  return {
    pages: pages.length,
    meanImageBytes: pick("meanImageBytes"),
    exactPct: pick("exactPct"),
    exactEstPct: pick("exactEstPct"),
    fixablePct: pick("fixablePct"),
    sharpnessKB: pick("sharpnessKB"),
    aggressiveExactEstPct: pick("aggressiveExactEstPct"),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Grouping, challenges, file names
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The report group of an image: its `sizes`, its class list (order ignored) and its rendered width at the reference
 * viewport, bucketed to 10 px. Images of one component usually share it.
 */
export function groupKey(sizes: string | undefined, classes: string, refWidth: number | undefined): string {
  const cls = classes.split(/\s+/).filter(Boolean).sort().join(" ");
  const bucket = refWidth === undefined ? "-" : String(Math.round(refWidth / 10) * 10);
  return [sizes ?? "-", cls || "-", bucket].join("|");
}

/** A page is a challenge when the document is refused or throttled, or it has no image and shows a challenge marker. */
export function isChallenge(status: number | undefined, imageCount: number, html: string): boolean {
  if (status !== undefined && CHALLENGE_STATUS.includes(status)) return true;
  if (imageCount > 0) return false;
  const lower = html.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

/** `<host>-<path-slug>.json`; a query gets a short hash so two queries of one path stay apart. */
export function pageFileName(url: URL): string {
  const host = url.host.replace(/:/g, "-");
  const slug =
    url.pathname
      .split("/")
      .filter(Boolean)
      .join("-")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "index";
  const query = url.search ? `-${sha1(url.search).slice(0, 8)}` : "";
  return `${host}-${slug}${query}.json`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------------

export interface ScanArgs {
  urls: string[];
  /** --root: the folder that project source files are read from. */
  root?: string;
  /** --no-cache: encode and score everything again, and keep nothing on disk. */
  noCache?: boolean;
  out: string;
  aggressive: boolean;
  quality: boolean;
  /** Viewport names; undefined means all of them. */
  viewports?: string[];
  /** Where to write the PR-comment Markdown summary. */
  markdown?: string;
  /** Exit 3 when a page's exact + est. share is above this percentage. Undefined: never fail. */
  failOver?: number;
  /** Where to write one JSON file with every page's status and numbers. */
  summaryJson?: string;
  /** Scan a page even when robots.txt disallows it (the verdict is still recorded). */
  ignoreRobots?: boolean;
  /** Reuse the complete pages already in --out with the same options. */
  resume?: boolean;
  /** Stop after this many pages (scanned or resumed). */
  maxPages?: number;
  /** Stop after the page that brings the images counted so far to this number. */
  maxImages?: number;
  /** A text list, a local sitemap or a remote sitemap URL, read by --urls-from. */
  urlsFrom?: string;
  /** At most this many URLs per route pattern of the --urls-from list. */
  samplePerPattern?: number;
  /** A Playwright storage state file (cookies and local storage) applied to every context. */
  storageState?: string;
  /** Score with the GPU scorer on this GPU index (--gpu, --gpu-device). Undefined: the CPU scores. */
  gpu?: { device: number };
  /** --harness: the pages are harness routes (Storybook, a temporary route): their records are measured-harness. */
  harness?: boolean;
}

/** The stderr warning for a page that robots.txt disallows and that is scanned anyway (--ignore-robots). */
export function robotsIgnoredWarning(url: string): string {
  return `robots.txt disallows ${safeText(url)}; scanning anyway (--ignore-robots). Only scan sites you own or are allowed to test.`;
}

function parseUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Invalid URL ${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`URL must be http or https: ${text}`);
  return url.toString();
}

function parseFailOver(text: string): number {
  const value = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || value > 100) throw new Error(`--fail-over needs a percentage from 0 to 100, not ${safeText(text)}`);
  return value;
}

export function parseViewports(text: string): string[] {
  const names = text.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const known = DEFAULT_VIEWPORTS.map((viewport) => viewport.name);
  if (names.length === 0) throw new Error("--viewports needs at least one name");
  for (const name of names) {
    if (!known.includes(name)) throw new Error(`Unknown viewport ${name} (expected ${known.join(", ")})`);
  }
  return names;
}

const VALUE_OPTIONS: readonly string[] = [
  "--out",
  "--root",
  "--viewports",
  "--markdown",
  "--fail-over",
  "--summary-json",
  "--max-pages",
  "--max-images",
  "--urls-from",
  "--sample-per-pattern",
  "--storage-state",
  "--gpu-device",
];

/** A whole number of at least 1, for a limit option. */
function parseLimit(name: string, text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new Error(`${name} needs a whole number of at least 1, not ${safeText(text)}`);
  return Number(text);
}

/** The arguments after `scan`: one or more page URLs and the options. Throws with a message the CLI prints. */
export function parseScanArgs(argv: string[]): ScanArgs {
  const args: ScanArgs = { urls: [], out: DEFAULT_OUT, aggressive: false, quality: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--aggressive") args.aggressive = true;
    else if (arg === "--no-quality") args.quality = false;
    else if (arg === "--ignore-robots") args.ignoreRobots = true;
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--gpu") args.gpu ??= { device: 0 };
    else if (arg === "--no-cache") args.noCache = true;
    else if (arg === "--harness") args.harness = true;
    else if (VALUE_OPTIONS.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      if (arg === "--out") args.out = value;
      else if (arg === "--root") args.root = value;
      else if (arg === "--viewports") args.viewports = parseViewports(value);
      else if (arg === "--markdown") args.markdown = value;
      else if (arg === "--summary-json") args.summaryJson = value;
      else if (arg === "--max-pages") args.maxPages = parseLimit(arg, value);
      else if (arg === "--max-images") args.maxImages = parseLimit(arg, value);
      else if (arg === "--urls-from") args.urlsFrom = value;
      else if (arg === "--sample-per-pattern") args.samplePerPattern = parseLimit(arg, value);
      else if (arg === "--storage-state") args.storageState = value;
      else if (arg === "--gpu-device") args.gpu = { device: parseGpuDevice(value) };
      else args.failOver = parseFailOver(value);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      args.urls.push(parseUrl(arg));
    }
  }
  if (args.urls.length === 0 && args.urlsFrom === undefined) throw new Error("scan needs at least one URL or --urls-from");
  if (args.samplePerPattern !== undefined && args.urlsFrom === undefined) throw new Error("--sample-per-pattern needs --urls-from");
  return args;
}


/** The most input pixels sharp accepts for a downloaded file. */
export const MAX_INPUT_PIXELS = 100_000_000;

/** A width clamped to 1..MAX_WIDTH. */
export function clampWidth(width: number): number {
  return Math.max(1, Math.min(MAX_WIDTH, Math.floor(width)));
}

/** sharp over a downloaded file, refusing inputs above `limit` pixels. */
export function openImage(buffer: Buffer, limit = MAX_INPUT_PIXELS): Sharp {
  return sharp(buffer, { limitInputPixels: limit });
}


// ---------------------------------------------------------------------------------------------------------------------
// Pixels and local encodes
// ---------------------------------------------------------------------------------------------------------------------

export interface PixelSize {
  width: number;
  height: number;
  /** sharp's format name: jpeg, png, webp, avif, gif, svg, ... */
  format?: string;
}

/**
 * sharp names an AVIF file "heif" (its compression is "av1"). Every other use in this file says "avif", so that is the
 * name a pixel size carries. A HEIF with another compression (HEVC) keeps sharp's name and gets no estimate.
 */
function pixelFormat(meta: { format?: string; compression?: string }): string | undefined {
  if (meta.format === "heif" && meta.compression === "av1") return "avif";
  return meta.format;
}

/** The pixel size and format of an image file, as displayed (EXIF orientation applied). Undefined when sharp cannot read it. */
export async function pixelSize(buffer: Buffer): Promise<PixelSize | undefined> {
  try {
    const meta = await openImage(buffer).metadata();
    if (!meta.width || !meta.height) return undefined;
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? meta.height : meta.width;
    const height = turned ? meta.width : meta.height;
    return { width, height, format: pixelFormat(meta) };
  } catch {
    return undefined;
  }
}

/** The file decoded to 8-bit RGBA; resized to `size` when given and different (the scorer needs equal dimensions). */
export async function decodeRaw(buffer: Buffer, size?: PixelSize): Promise<RawImage> {
  const { data, info } = await openImage(buffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let out = { data, width: info.width, height: info.height };
  if (size && (size.width !== out.width || size.height !== out.height)) {
    const resized = await sharp(out.data, { raw: { width: out.width, height: out.height, channels: 4 } })
      .resize(size.width, size.height, { kernel: "lanczos3", fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    out = { data: resized.data, width: resized.info.width, height: resized.info.height };
  }
  return { data: new Uint8ClampedArray(out.data.buffer, out.data.byteOffset, out.data.byteLength), width: out.width, height: out.height };
}

/** The original at `width` pixels wide (enlarged when it is smaller), decoded. */
async function referenceAt(original: Buffer, requestedWidth: number): Promise<RawImage> {
  const width = clampWidth(requestedWidth);
  const { data, info } = await openImage(original)
    .rotate()
    .resize({ width, kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

type EstimateFormat = "jpeg" | "webp" | "avif";

function isEstimateFormat(format: string): format is EstimateFormat {
  return format === "jpeg" || format === "webp" || format === "avif";
}

/** Local encode of an already resized image in `format` at `quality`. */
function encodeWith(img: Sharp, format: EstimateFormat, quality: number): Promise<Buffer> {
  if (format === "jpeg") return img.jpeg({ quality }).toBuffer();
  if (format === "webp") return img.webp({ quality }).toBuffer();
  return img.avif({ quality, effort: 4 }).toBuffer();
}

const QUALITY_BISECT_STEPS = 7;

/**
 * The file shrunk to `targetWidth` and encoded in its own format at the quality whose native-size bytes are closest to
 * the served bytes: a local estimate for a plain <img> that is wider than it needs to be (est.). PNG stays lossless.
 * Undefined for a format this cannot encode (gif, svg, ...).
 */
export async function resizedEstimate(
  buffer: Buffer,
  format: string,
  requestedWidth: number,
): Promise<{ bytes: number; buffer: Buffer } | undefined> {
  const targetWidth = clampWidth(requestedWidth);
  if (format === "png") {
    const out = await openImage(buffer).rotate().resize({ width: targetWidth, withoutEnlargement: true }).png().toBuffer();
    return { bytes: out.length, buffer: out };
  }
  if (!isEstimateFormat(format)) return undefined;
  const served = buffer.length;
  // Bisection over the quality scale on the native image: the lowest quality whose bytes reach the served bytes.
  let lo = 1;
  let hi = 100;
  for (let step = 0; step < QUALITY_BISECT_STEPS && lo < hi; step++) {
    const mid = Math.floor((lo + hi) / 2);
    const bytes = (await encodeWith(openImage(buffer).rotate(), format, mid)).length;
    if (bytes < served) lo = mid + 1;
    else hi = mid;
  }
  const shrunk = openImage(buffer).rotate().resize({ width: targetWidth, withoutEnlargement: true });
  const out = await encodeWith(shrunk, format, lo);
  return { bytes: out.length, buffer: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// Quality and format (est.)
// ---------------------------------------------------------------------------------------------------------------------

/** The relative rule's floor and tolerance for SSIMULACRA2 (the relaxed preset). */
export const SCAN_THRESHOLD = 70;
export const SCAN_TOLERANCE = 5;
/** The points a candidate may drop: the default, and the `--aggressive` column that is never the claim. */
export const SCAN_DELTA = 2;
export const SCAN_AGGRESSIVE_DELTA = 4;
/** AVIF start for a JPEG or PNG right file: the quality the search starts from. */
const FORMAT_START_QUALITY = 90;

export interface QualityInput {
  /** The original image the page's URL was made from. */
  original: Buffer;
  /** The file the browser would get at this width (the right candidate). */
  served: Buffer;
  /** Subtype of the served file: avif, webp, jpeg, png, ... */
  format: string;
  bytes: number;
  width: number;
  height: number;
  /** The quality the served URL asks for (or the assumed one). */
  current: number;
}

export interface QualityDeps {
  encode?: typeof encode;
  score: Scorer;
  /** The result cache of this run (see result-cache.ts); undefined: nothing is read from or written to disk. */
  cache?: ResultCache;
  /** Names the scorer in the cache key: "cpu", or the GPU that scored. */
  scorerId?: string;
  /**
   * The number of pairs the CPU has scored so far, when a GPU scorer is in use (see GpuScorer.cpuScores). A score is stored
   * under the GPU's key only when this did not move while it was computed: a fallback's CPU score is never kept under it.
   */
  cpuScored?: () => number;
}

export interface QualityEstimate {
  /** Projected bytes / served bytes, per delta (<= 1). */
  ratio: Record<number, number>;
  /** The quality, on the served file's own scale, that the default delta lands on (AVIF/WebP only). */
  target?: number;
  /** Set when the file is JPEG or PNG: the AVIF the ratio is for. */
  format?: "avif";
}

const clampQuality = (q: number): number => Math.min(100, Math.max(1, Math.round(q)));

/** The bytes of the AVIF that meets `bar`, or undefined when none from FORMAT_START_QUALITY up to 100 does. */
async function avifBytesAtBar(reference: RawImage, bar: number, enc: typeof encode, score: Scorer): Promise<number | undefined> {
  const passing = async (q: number) => {
    const out = await enc(reference, "avif", q, "cdn");
    return (await score(reference, out.decoded)) >= bar ? out.bytes : undefined;
  };
  // The bisection returns its start when the start fails, so the result is checked before it is taken.
  const best = await minPassingQuality(reference, "avif", FORMAT_START_QUALITY, "cdn", bar, SCAN_TOLERANCE, { encode: enc, score });
  const atBest = await passing(best);
  if (atBest !== undefined) return atBest;
  for (let q = FORMAT_START_QUALITY + 2; q <= 100; q += 2) {
    const bytes = await passing(q);
    if (bytes !== undefined) return bytes;
  }
  return undefined;
}

/**
 * Estimates the quality and format savings of one right file at its width. For AVIF and WebP the local `cdn` encoder is
 * calibrated to the file's bytes (calibrationOffset); the bar is the local encode's score at the current quality minus
 * delta (never under SCAN_THRESHOLD); the lowest passing quality gives the projected bytes by local ratio. For JPEG and
 * PNG (no local encoder) the bar is the file's own score minus delta, and the estimate is the AVIF that meets it.
 */
export async function estimateQuality(input: QualityInput, deltas: number[], deps: QualityDeps): Promise<QualityEstimate | undefined> {
  const enc = deps.encode ?? encode;
  const score = deps.score;
  const reference = await measure("resize reference", () => referenceAt(input.original, input.width));
  const ratio: Record<number, number> = {};

  if (input.format === "avif" || input.format === "webp") {
    const format = input.format;
    // The local encode's bytes and scores come from the result cache when it has them; the search is the same either way.
    const scope = deps.cache ? cacheScope(input.original, input.width, deps.scorerId ?? "cpu", ENCODER_ID) : undefined;
    const cpuScored = deps.cpuScored ?? (() => 0);
    // A score is kept only when the CPU did not score anything while it was computed (its key names the GPU).
    const cached = async (key: string, compute: () => Promise<number>, isScore = false): Promise<number> => {
      if (deps.cache === undefined || scope === undefined) return compute();
      const hit = await deps.cache.get(`${scope}|${key}`);
      if (hit !== undefined) {
        count("cache hits");
        return hit;
      }
      count("cache misses");
      const before = cpuScored();
      const value = await compute();
      if (!isScore || cpuScored() === before) await deps.cache.put(`${scope}|${key}`, value);
      else count("cache writes skipped: CPU score");
      return value;
    };
    const sizeAt = (q: number) => cached(`bytes|${format}|${q}|cdn`, async () => (await enc(reference, format, q, "cdn")).bytes);
    const scoreAt = (q: number) =>
      cached(`score|${format}|${q}|cdn`, async () => score(reference, (await enc(reference, format, q, "cdn")).decoded), true);
    // The offset of the local encoder: one sample, so the median is the sample itself (see calibrationOffset).
    const match = await measure("calibrate", () => matchLocalQuality(sizeAt, input.bytes));
    const offset = Math.round(input.current - match);
    const localCurrent = clampQuality(input.current - offset);
    const currentBytes = await sizeAt(localCurrent);
    // The bar is the served file's own score against the original, so it holds whatever quality the URL asks for.
    const servedScore = await cached(
      `served|${contentHash(input.served)}`,
      async () => score(reference, await measure("decode: served", () => decodeRaw(input.served, { width: reference.width, height: reference.height }))),
      true,
    );
    let target: number | undefined;
    for (const delta of deltas) {
      const bar = Math.max(SCAN_THRESHOLD, servedScore - delta);
      const best = await measure("bisect: quality", () =>
        minPassingQuality(reference, format, localCurrent, "cdn", bar, SCAN_TOLERANCE, { encode: enc, score, scoreAt }),
      );
      const bestBytes = await sizeAt(best);
      ratio[delta] = currentBytes > 0 ? Math.min(1, bestBytes / currentBytes) : 1;
      if (delta === deltas[0]) target = Math.min(input.current, clampQuality(best + offset));
    }
    return { ratio, target };
  }

  if (input.format === "jpeg" || input.format === "png") {
    const servedRaw = await measure("decode: served", () => decodeRaw(input.served, { width: reference.width, height: reference.height }));
    const ownScore = await score(reference, servedRaw);
    for (const delta of deltas) {
      const bar = Math.max(SCAN_THRESHOLD, ownScore - delta);
      const avifBytes = await measure("avif bar search", () => avifBytesAtBar(reference, bar, enc, score));
      ratio[delta] = avifBytes !== undefined && input.bytes > 0 ? Math.min(1, avifBytes / input.bytes) : 1;
    }
    return { ratio, format: "avif" };
  }

  return undefined;
}


// ---------------------------------------------------------------------------------------------------------------------
// Browser observation: one fresh context per page and viewport
// ---------------------------------------------------------------------------------------------------------------------

export interface ObservedImage {
  /** Position among all <img> elements of the page, in document order. Identifies the image across viewports. */
  index: number;
  currentSrc: string;
  renderedWidth: number;
  renderedHeight: number;
  srcset: string;
  sizes?: string;
  classes: string;
  nextImage: boolean;
  inFirstViewport: boolean;
  /** The element asks for lazy loading (loading="lazy"). */
  lazy?: boolean;
  /** The layout chain of the image at this viewport. */
  layout?: LayoutChainData;
  /** What identifies the element in its source. */
  locator?: ObservedLocator;
}

/** What the browser reads to find an image in the source: a React owner trace, a test id, an alt text and a DOM path. */
export interface ObservedLocator {
  testid?: string;
  alt?: string;
  selector: string;
  owners: OwnerTrace[];
  /**
   * Where the owner components are defined: each owner's function location, mapped to its chunk (the debugger's
   * [[FunctionLocation]], nearest first). Read only for the images a locate asks for (see observeViewport).
   */
  functionLocations?: StackFrame[];
}

/** The most owner components whose function location is read per image (nearest first). */
export const MAX_FUNCTION_LOCATIONS = 8;

export interface ResponseRecord {
  url: string;
  contentType?: string;
  /** Response body length: the bytes the browser transferred (the Content-Length header in a light observation). */
  bytes: number;
  /** False when a light observation found no Content-Length: `bytes` is then 0 and not a measurement. */
  bytesKnown?: boolean;
  buffer?: Buffer;
  pixels?: PixelSize;
}

export interface ViewportObservation {
  viewport: Viewport;
  status?: number;
  /** The URL the page ends on, after any navigation of its own. Absent in old observations: the page URL. */
  finalUrl?: string;
  /** True when the page's `load` event did not come within the cap; the figures were taken anyway. */
  loadTimedOut?: boolean;
  blocked: boolean;
  /** Requests the browser was stopped from making (the page is public and they reach a blocked address). */
  blockedRequests: number;
  nextjs: boolean;
  images: ObservedImage[];
  /** The elements with a CSS background image (none in a light read). */
  backgrounds?: ObservedBackground[];
  /** Stylesheets the page links that the server refused or the browser could not load (their styles are not applied): zero on a sound page. */
  stylesheetsFailed?: number;
  /** Every image response of the page view, by URL. */
  responses: Map<string, ResponseRecord>;
}

/**
 * The browser's requests are guarded in two layers, for every scan (a local target gets the same layers, with private
 * addresses allowed):
 * - the route guard decides the URL of each request and aborts a refused one, and it blocks refused websockets;
 * - the egress proxy (egress-proxy.ts) carries every request and tunnel the browser makes. It checks each destination at
 *   connect time, so every redirect hop, subresource and CONNECT is checked, and DNS rebinding cannot move a connection
 *   to a refused address. A refused request is dropped and counted as blocked.
 * Failing to decide counts as blocked. The Node-side fetcher (originals, candidates, robots, sitemaps) is checked at
 * connect time too, with each redirect hop checked.
 */
export interface RequestGuard {
  isBlocked(url: string): Promise<boolean>;
  /** What the egress proxy checks each destination against. */
  policy: EgressPolicy;
}

/** A navigation that destroyed the page's execution context in the middle of a read: the read is taken again. */
function isNavigationError(err: unknown): boolean {
  return err instanceof Error && /Execution context was destroyed|Frame was detached/i.test(err.message);
}

interface PageView {
  seen: { nextjs: boolean; images: ObservedImage[]; backgrounds: ObservedBackground[] };
  html: string;
}

/** A Playwright storage state: cookies and local storage of a logged-in session. */
export type StorageState = NonNullable<BrowserContextOptions["storageState"]>;

/** Ancestors walked for the layout chain of an image (the image itself included). */
export const LAYOUT_DEPTH = 15;
/** React owners read per image, nearest first. */
export const MAX_OWNERS = 8;

/** One read of the page as it stands: its images and whether it is a Next.js app. */
async function readView(page: Page, light = false): Promise<PageView> {
  const seen = await page.evaluate(
    ({ depth, maxOwners, maxBackgrounds, maxValue, light }) => {
      const num = (value: string): number => {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : 0;
      };
      // Frames in React, Next or the bundler runtime are not the app's own source.
      const NOT_APP = /node_modules|react-dom|react-server|react\/jsx|next[\/_.-]dist|scheduler|webpack\/runtime|turbopack/i;
      const FRAME = /((?:https?|file|webpack-internal|turbopack):\/\/[^\s)]+?):(\d+):(\d+)/g;
      const appFrames = (stack: string | undefined): StackFrame[] => {
        const out: StackFrame[] = [];
        for (const m of (stack ?? "").matchAll(FRAME)) {
          if (NOT_APP.test(m[1])) continue;
          out.push({ url: m[1], line: Number(m[2]), col: Number(m[3]) });
          if (out.length === 4) break;
        }
        return out;
      };
      interface Fiber {
        type?: unknown;
        return?: Fiber | null;
        _debugOwner?: Fiber | null;
        _debugStack?: { stack?: string } | null;
        _debugSource?: { fileName?: string; lineNumber?: number } | null;
      }
      const typeName = (t: unknown): string | undefined => {
        if (!t || typeof t === "string") return undefined;
        if (typeof t === "function") return (t as { displayName?: string }).displayName || t.name || undefined;
        const o = t as { displayName?: string; render?: unknown; type?: unknown };
        return o.displayName || typeName(o.render) || typeName(o.type);
      };
      // The fiber of the image, or of its nearest ancestor within five levels (React keys the DOM node by fiber).
      const fiberOf = (el: Element): Fiber | undefined => {
        let cur: Element | null = el;
        for (let i = 0; i < 5 && cur; i++) {
          const key = Object.keys(cur).find((k) => k.startsWith("__reactFiber$"));
          if (key) return (cur as unknown as Record<string, Fiber>)[key];
          cur = cur.parentElement;
        }
        return undefined;
      };
      // Walks _debugOwner (the component that created each element), then return where that is missing.
      // A server-created component has no type name in the browser; its stack's first named frame is the function's.
      const stackName = (stack: string | undefined): string | undefined => /\n\s+at ([A-Z][\w$]*) \(/.exec(stack ?? "")?.[1];
      const ownersOf = (start: Fiber | undefined): OwnerTrace[] => {
        const owners: OwnerTrace[] = [];
        let cur: Fiber | null | undefined = start;
        for (let hops = 0; cur && owners.length < maxOwners && hops < 200; hops++) {
          const name = typeName(cur.type) ?? stackName(cur._debugStack?.stack);
          const component = name !== undefined && /^[A-Z]/.test(name) ? name : undefined;
          const frames = appFrames(cur._debugStack?.stack);
          const src = cur._debugSource;
          const source = src?.fileName ? { file: src.fileName, line: src.lineNumber ?? 0 } : undefined;
          if (component !== undefined || frames.length > 0 || source !== undefined) {
            owners.push({ name: component, source, frames });
          }
          cur = cur._debugOwner ?? cur.return;
        }
        return owners;
      };
      const cssPath = (el: Element): string => {
        const parts: string[] = [];
        let cur: Element | null = el;
        for (let i = 0; i < 6 && cur && cur.tagName !== "HTML"; i++) {
          const node: Element = cur;
          const tag = node.tagName.toLowerCase();
          if (/^[A-Za-z][\w-]*$/.test(node.id)) {
            parts.unshift(`${tag}#${node.id}`);
            break;
          }
          const parent: Element | null = node.parentElement;
          const siblings = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName) : [node];
          parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
          cur = parent;
        }
        return parts.join(" > ");
      };
      // The columns an item spans, from its computed grid lines (a line is a number, "span N" or "auto"; -1 is the last line).
      const gridSpanOf = (start: string, end: string, cols: number): number => {
        const line = (v: string): number | undefined => (/^-?\d+$/.test(v) ? Number(v) : undefined);
        const spanOf = (v: string): number | undefined => {
          const m = /^span (\d+)$/.exec(v);
          return m ? Number(m[1]) : undefined;
        };
        const s = line(start);
        const e = line(end);
        if (s !== undefined && e !== undefined) return Math.max(1, (e < 0 ? cols + e + 2 : e) - s);
        if (s !== undefined && spanOf(end) !== undefined) return spanOf(end) as number;
        return spanOf(start) ?? 1;
      };
      // The image, then its ancestors up to the root. display: contents and inline wrappers do not constrain width: skipped.
      const layoutOf = (img: Element): LayoutChainData => {
        const nodes: LayoutNode[] = [];
        const skipped: string[] = [];
        let el: Element | null = img;
        while (el && nodes.length < depth) {
          const cs = getComputedStyle(el);
          if (el !== img && (cs.display === "contents" || cs.display === "inline")) {
            skipped.push(`${el.tagName.toLowerCase()}: display ${cs.display}`);
          } else {
            const paddingX = num(cs.paddingLeft) + num(cs.paddingRight);
            const borderX = num(cs.borderLeftWidth) + num(cs.borderRightWidth);
            const marginL = num(cs.marginLeft);
            const marginR = num(cs.marginRight);
            const maxWidth = cs.maxWidth.endsWith("px") ? num(cs.maxWidth) : undefined;
            const outer = cs.width === "auto" ? el.getBoundingClientRect().width : num(cs.width);
            const width = cs.boxSizing === "border-box" ? outer - paddingX - borderX : outer;
            const node: LayoutNode = {
              tag: el.tagName.toLowerCase(),
              classes: Array.from(el.classList).slice(0, 3).join(" "),
              width: Math.round(width * 100) / 100,
              paddingX,
              borderX,
              // A max-width with equal side margins is a centred box: its margins are auto and the max-width does the work.
              marginX: maxWidth !== undefined && marginL === marginR ? 0 : marginL + marginR,
              display: cs.display,
              flexBasis: cs.flexBasis,
              borderBox: cs.boxSizing === "border-box",
            };
            if (maxWidth !== undefined) node.maxWidth = maxWidth;
            if (cs.display === "grid") {
              const tracks = cs.gridTemplateColumns === "none" ? [] : cs.gridTemplateColumns.split(/\s+/).map(num);
              node.gridCols = tracks.length;
              node.gridUniform = tracks.length > 0 && tracks.every((t) => Math.abs(t - tracks[0]) <= 0.5);
            }
            if (cs.display === "grid" || cs.display === "flex") node.gap = num(cs.columnGap);
            if (cs.display === "flex") {
              node.flexDirection = cs.flexDirection;
              node.flexGrow = num(cs.flexGrow);
            }
            // The columns this item spans in a grid parent (grid-column: 1 / -1 spans all of them).
            const parentStyle = el.parentElement ? getComputedStyle(el.parentElement) : undefined;
            if (parentStyle?.display === "grid") {
              const cols = parentStyle.gridTemplateColumns === "none" ? 0 : parentStyle.gridTemplateColumns.split(/\s+/).length;
              node.gridSpan = gridSpanOf(cs.gridColumnStart, cs.gridColumnEnd, cols);
            }
            nodes.push(node);
          }
          el = el.parentElement;
        }
        return { nodes, skipped, truncated: el !== null };
      };
      const nextjs = document.querySelector('img[data-nimg], script[src*="/_next/"], link[href*="/_next/"]') !== null;
      const images = Array.from(document.querySelectorAll("img"), (img, index) => {
        const rect = img.getBoundingClientRect();
        return {
          index,
          currentSrc: img.currentSrc,
          renderedWidth: rect.width,
          renderedHeight: rect.height,
          srcset: img.getAttribute("srcset") ?? "",
          sizes: img.getAttribute("sizes") ?? undefined,
          classes: img.getAttribute("class") ?? "",
          nextImage: img.hasAttribute("data-nimg"),
          inFirstViewport: rect.bottom > 0 && rect.top < window.innerHeight,
          lazy: img.loading === "lazy",
          layout: light ? undefined : layoutOf(img),
          locator: {
            testid: img.closest("[data-testid]")?.getAttribute("data-testid") ?? undefined,
            alt: img.getAttribute("alt")?.slice(0, 120) ?? undefined,
            selector: cssPath(img),
            owners: ownersOf(fiberOf(img)),
          },
        };
      });
      // CSS background images: the elements whose computed background-image names a file (a gradient or none is not one).
      // Light reads (locate, sizes-only) take none. Inline data: URIs are replaced before they leave the browser.
      const NO_BACKGROUND = new Set(["IMG", "SVG", "PICTURE", "SOURCE", "SCRIPT", "STYLE", "LINK", "META", "HEAD", "TITLE", "NOSCRIPT", "IFRAME", "OBJECT", "VIDEO"]);
      const backgrounds: ObservedBackground[] = [];
      if (!light) {
        for (const el of Array.from(document.querySelectorAll("*"))) {
          if (backgrounds.length >= maxBackgrounds) break;
          if (NO_BACKGROUND.has(el.tagName.toUpperCase())) continue;
          const cs = getComputedStyle(el);
          const value = cs.backgroundImage;
          if (!value || value === "none" || !/url\(|image-set\(/.test(value)) continue;
          const rect = el.getBoundingClientRect();
          // The element's own fiber only: an ancestor's owner would name a component that does not draw this background.
          const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
          backgrounds.push({
            index: backgrounds.length,
            selector: cssPath(el),
            classes: el.getAttribute("class") ?? "",
            testid: el.closest("[data-testid]")?.getAttribute("data-testid") ?? undefined,
            owners: ownersOf(fiberKey ? (el as unknown as Record<string, Fiber>)[fiberKey] : undefined),
            width: rect.width,
            height: rect.height,
            hidden: cs.display === "none" || cs.visibility === "hidden" || rect.width === 0 || rect.height === 0,
            // Capped here as well: one character over the cap is enough for Node to skip the element.
            backgroundImage: (value.length > maxValue ? value.slice(0, maxValue + 1) : value).replace(/url\((["']?)data:[^)]*\)/g, 'url("data:")'),
            backgroundSize: cs.backgroundSize.slice(0, maxValue + 1),
          });
        }
      }
      return { nextjs, images, backgrounds };
    },
    { depth: LAYOUT_DEPTH, maxOwners: MAX_OWNERS, maxBackgrounds: MAX_BACKGROUND_ELEMENTS, maxValue: MAX_BACKGROUND_VALUE, light },
  );
  const html = seen.images.length === 0 ? await page.content() : "";
  return { seen, html };
}

/**
 * The settle step, then one read, taken again whenever the page navigated while it ran (a reload or a script's
 * location change after load). At most MAX_POST_LOAD_NAVIGATIONS repeats; past that, the last complete read is used.
 */
async function settledView(page: Page, navigations: () => number, loadCapMs: number, light = false): Promise<PageView> {
  let last: PageView | undefined;
  for (let repeat = 0; ; repeat++) {
    const start = navigations();
    let view: PageView | undefined;
    try {
      await settlePage(page, "img", { networkIdle: !light });
      view = await measure("read view", () => readView(page, light));
    } catch (err) {
      if (!isNavigationError(err)) throw err;
    }
    if (view) last = view;
    if (view && navigations() === start) return view;
    if (repeat === MAX_POST_LOAD_NAVIGATIONS) {
      if (last) return last;
      throw new Error(`the page kept navigating after load (${MAX_POST_LOAD_NAVIGATIONS + 1} attempts)`);
    }
    // The new document settles first: its load event, or the cap if it never comes.
    await waitForLoadWithin(page, loadCapMs).catch(() => false);
  }
}

/** A debugger session that knows each script's URL by id, with pauses skipped (a page's own `debugger;` must not stop it). */
async function startDebugger(
  context: BrowserContext,
  page: Page,
): Promise<{ session: CDPSession; scripts: Map<string, string> } | undefined> {
  try {
    const session = await context.newCDPSession(page);
    const scripts = new Map<string, string>();
    session.on("Debugger.scriptParsed", (event: { scriptId: string; url: string }) => {
      if (scripts.size < 5000) scripts.set(event.scriptId, event.url);
    });
    await session.send("Debugger.enable");
    await session.send("Debugger.setSkipAllPauses", { skip: true });
    return { session, scripts };
  } catch {
    return undefined;
  }
}

/**
 * The function locations of the owner components of the image at `index` (document order among the <img> elements): the
 * fiber chain's function types, each read as [[FunctionLocation]] (0-based in CDP, so 1-based here, as stack frames are).
 * Only functions whose script is known are returned. Nothing is written to the page.
 */
async function functionLocationsOf(session: CDPSession, index: number, scripts: Map<string, string>): Promise<StackFrame[]> {
  const expression = `(() => {
    const img = document.querySelectorAll("img")[${index}];
    if (!img) return [];
    const key = Object.keys(img).find((k) => k.startsWith("__reactFiber$"));
    const out = [];
    let fiber = key ? img[key] : undefined;
    for (let i = 0; fiber && i < 200 && out.length < ${MAX_FUNCTION_LOCATIONS}; i++, fiber = fiber.return) {
      if (typeof fiber.type === "function") out.push(fiber.type);
    }
    return out;
  })()`;
  const evaluated = await session.send("Runtime.evaluate", { expression, returnByValue: false });
  const arrayId = evaluated.result.objectId;
  if (arrayId === undefined) return [];
  const items = await session.send("Runtime.getProperties", { objectId: arrayId, ownProperties: true });
  const frames: StackFrame[] = [];
  for (const item of items.result) {
    if (!/^\d+$/.test(item.name) || item.value?.objectId === undefined) continue;
    const props = await session.send("Runtime.getProperties", { objectId: item.value.objectId, ownProperties: true });
    const location = props.internalProperties?.find((p) => p.name === "[[FunctionLocation]]")?.value?.value as
      | { scriptId?: string; lineNumber?: number; columnNumber?: number }
      | undefined;
    const url = location?.scriptId !== undefined ? scripts.get(location.scriptId) : undefined;
    if (url === undefined || location?.lineNumber === undefined) continue;
    frames.push({ url, line: location.lineNumber + 1, col: (location.columnNumber ?? 0) + 1 });
  }
  return frames;
}

/**
 * One viewport's read of a page. `light` (the locate and sizes-only paths) reads no image bodies and no layout chain: the
 * image sizes come from the response headers, and nothing is decoded or scored.
 */
async function observeViewport(
  browser: Browser,
  pageUrl: string,
  viewport: Viewport,
  guard: RequestGuard,
  loadCapMs: number = LOAD_EVENT_CAP_MS,
  storageState?: StorageState,
  light = false,
  functionsWanted?: (img: ObservedImage) => boolean,
): Promise<ViewportObservation> {
  const responses = new Map<string, ResponseRecord>();
  const bodyReads: Promise<void>[] = [];
  let blockedRequests = 0;
  // Stylesheet URLs the browser could not apply (refused, failed or blocked): one entry per URL.
  const failedSheets = new Set<string>();
  // Every request the browser makes goes through this proxy, so each redirect hop and each tunnel is checked at connect
  // time. Chromium gives the route handler no route for a redirect hop, so the route guard alone would miss them.
  const egress = await measure("egress proxy start", () =>
    startEgressProxy(guard.policy, () => {
      blockedRequests++;
    }),
  );
  try {
    const context = await measure("context start", () => browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.dpr,
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
      userAgent: viewport.userAgent,
      // A service worker could answer requests the route guard never sees, and would change what is measured.
      serviceWorkers: "block",
      // Loopback is proxied as well, so a request to 127.0.0.1 from a public page is checked like any other.
      proxy: { server: egress.url, bypass: "<-loopback>" },
      ...(storageState !== undefined ? { storageState } : {}),
    }));
    try {
      // The route guard decides the URL of each request and aborts it when refused. The proxy checks what it cannot see.
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
        let blocked = true;
        try {
          blocked = /^https?:/i.test(url) ? await guard.isBlocked(url) : true;
        } catch {
          blocked = true;
        }
        if (blocked) {
          blockedRequests++;
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
      await context.routeWebSocket("**/*", async (socket) => {
        let blocked = true;
        try {
          blocked = await guard.isBlocked(socket.url());
        } catch {
          blocked = true;
        }
        if (blocked) {
          blockedRequests++;
          await socket.close();
        } else {
          socket.connectToServer();
        }
      });
      context.on("requestfailed", (request) => {
        if (request.resourceType() === "stylesheet") failedSheets.add(request.url());
      });
      context.on("response", (response) => {
        // A stylesheet the server refused is not applied (Chromium still makes an empty sheet for it): counted for the scan's warning.
        if (response.request().resourceType() === "stylesheet" && response.status() >= 400) failedSheets.add(response.url());
        const contentType = response.headers()["content-type"];
        const isImage = response.request().resourceType() === "image" || (contentType ?? "").toLowerCase().startsWith("image/");
        if (!isImage) return;
        const record: ResponseRecord = { url: response.url(), contentType, bytes: 0 };
        responses.set(response.url(), record);
        if (light) {
          const length = Number(response.headers()["content-length"]);
          if (Number.isFinite(length) && length >= 0) record.bytes = length;
          else record.bytesKnown = false;
          return;
        }
        bodyReads.push(
          response.body().then(
            (body) => {
              record.bytes = body.length;
              record.buffer = body;
            },
            () => {},
          ),
        );
      });

      const page = await context.newPage();
      // Function locations (locate on a production build): the debugger reports each chunk's script, before the page runs.
      const debug = functionsWanted !== undefined ? await startDebugger(context, page) : undefined;
      // Main-frame navigations are counted, so the figures are taken once the page has stopped moving. A light read counts
      // document loads only: a page that rewrites its URL while it scrolls (same-document navigations) would never settle.
      let navigations: () => number;
      if (light) {
        let loads = 0;
        page.on("load", () => {
          loads++;
        });
        navigations = () => loads;
      } else {
        // Document navigations are counted, so the figures are taken once the page has stopped moving. Same-document URL
        // changes are not: a page that rewrites its URL while it scrolls would otherwise never settle.
        navigations = await countDocumentNavigations(context, page);
      }
      const loaded = await measure(`page load ${viewport.name}`, () => gotoParsed(page, pageUrl, loadCapMs));
      const docResponse: BrowserResponse | null = loaded.response;
      const { seen, html } = await settledView(page, navigations, loadCapMs, light);
      const status = docResponse?.status();
      if (debug !== undefined && functionsWanted !== undefined) {
        for (const img of seen.images) {
          if (!img.locator || !functionsWanted(img)) continue;
          const frames = await measure("function locations", () => functionLocationsOf(debug.session, img.index, debug.scripts)).catch(() => []);
          if (frames.length > 0) img.locator.functionLocations = frames;
        }
        await debug.session.detach().catch(() => undefined);
      }
      await measure("body reads", () => settleWithin(bodyReads, BODY_READ_TIMEOUT_MS));
      count("image responses", responses.size);
      for (const record of responses.values()) {
        if (record.buffer) record.pixels = await measure("decode: pixel size", () => pixelSize(record.buffer as Buffer));
      }
      return {
        viewport,
        status,
        finalUrl: page.url(),
        loadTimedOut: loaded.loadTimedOut,
        blocked: isChallenge(status, seen.images.length, html),
        blockedRequests,
        nextjs: seen.nextjs,
        images: seen.images,
        backgrounds: seen.backgrounds,
        stylesheetsFailed: failedSheets.size,
        responses,
      };
    } finally {
      await context.close();
    }
  } finally {
    await egress.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Analysis of one page
// ---------------------------------------------------------------------------------------------------------------------

/** One image element at one viewport, with what it saves. */
export interface Instance {
  viewport: Viewport;
  element: number;
  img: ObservedImage;
  url: string;
  bytes: number;
  format?: string;
  pixelWidth: number;
  renderedWidth: number;
  needed: number;
  kind: "srcset" | "plain" | "skipped";
  skipped?: string;
  /** The served file is undersized: it has growth, and no saving of its own. */
  undersized?: boolean;
  /** The right candidate (srcset) and its file, kept for the quality step. */
  right?: { url: string; bytes: number; width: number; height: number; format: string; buffer: Buffer };
  exact: number;
  est: number;
  estAggressive: number;
  growth: number;
  group: string;
  /** Quality ratio per delta (projected / served bytes): the image's own, or its group's median. */
  qualityRatio?: Record<number, number>;
  qualityInfo?: QualityInfo;
  /** Set on an element that repeats a URL measured at another element of the viewport: it contributes nothing. */
  duplicateOf?: number;
  loader: string;
  qualityParam: QualityParam;
}

export interface AnalysisContext {
  pageUrl: string;
  fetcher: Fetcher;
  /** The page is on a loopback or private host, so its candidates and originals may be too. */
  allowPrivate: boolean;
  deps: QualityDeps;
  quality: boolean;
  /** Only the images for which this is true get the quality and format search (recheck skips unchanged ones). */
  qualityFor?: (inst: Instance) => boolean;
  aggressive: boolean;
  resized: Map<string, Promise<{ bytes: number; buffer: Buffer } | undefined>>;
  /** Source maps read so far, by chunk URL (the locator reads each chunk's map once). */
  sourceMaps?: Map<string, Promise<SourceMapData | undefined>>;
  /** The project the scan runs in: resolved source files are read from here (local pages only). */
  projectDir?: string;
  /** The --root given on the command line (absolute), or undefined: see source-root.ts. */
  projectRoot?: string;
  /** The pages are harness routes (--harness): the records are measured-harness whatever their URL. */
  harness?: boolean;
}

/** Largest source map read for a chunk: the scanned site is untrusted, so a map is capped in size. */
export const MAX_MAP_BYTES = 20 * 1024 * 1024;
/** Most distinct chunk maps read in one scan (all pages together). */
export const MAX_MAPS_PER_SCAN = 64;

/**
 * The source map of a bundled chunk (`<chunk>.map`), read once per scan. Only a chunk on the page's own origin is read,
 * and at most MAX_MAPS_PER_SCAN maps are read in all. Undefined when it is refused, absent or unreadable.
 */
export function loadSourceMap(ctx: AnalysisContext, chunk: string): Promise<SourceMapData | undefined> {
  const cache = (ctx.sourceMaps ??= new Map());
  let pending = cache.get(chunk);
  if (pending) return pending;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(chunk).origin === new URL(ctx.pageUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin || cache.size >= MAX_MAPS_PER_SCAN) return Promise.resolve(undefined);
  pending = ctx.fetcher
    .get(`${chunk}.map`, { allowPrivate: ctx.allowPrivate, maxBytes: MAX_MAP_BYTES })
    .then((body) => (body ? parseSourceMap(body.toString("utf8")) : undefined))
    .catch(() => undefined);
  cache.set(chunk, pending);
  return pending;
}

/** Each observed image's source (through its React owner trace) and component names. */
/**
 * What a resolved source is: on a local page, the project file is read (once per file, capped in size) and its line is
 * checked for an image; on any other page nothing is read from the project and the source stays unchecked.
 */
async function checkSource(
  ctx: AnalysisContext,
  texts: Map<string, Promise<string | undefined>>,
  file: string,
  line: number,
  component: string | undefined,
): Promise<LocatorKind> {
  if (!isLocalTarget(ctx.pageUrl)) return "unchecked";
  if (ctx.projectDir === undefined) return "unread";
  let text = texts.get(file);
  if (!text) {
    text = sourceRootOf(ctx.projectDir, file, ctx.projectRoot).then((root) => readProjectSource(root, file));
    texts.set(file, text);
  }
  const source = await text;
  if (source === undefined) return "unread";
  return imageAtLine(source, line, component) ? "image" : "owner";
}

/** A project file's text, or undefined when it is outside the project, not a file, too large, or unreadable. */
async function readProjectSource(projectDir: string, file: string): Promise<string | undefined> {
  const root = resolve(projectDir);
  const path = resolve(root, file);
  if (!path.startsWith(`${root}/`)) return undefined;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SOURCE_READ) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Component names from an owner trace. They come from the scanned page, so only identifiers are kept. A production build
 * leaves one- and two-letter minified names, which say nothing about the source, so they are dropped too.
 */
function componentNamesOf(owners: OwnerTrace[]): string[] {
  return owners
    .flatMap((o) => (o.name !== undefined && COMPONENT_NAME.test(o.name) && o.name.length > 2 ? [o.name] : []))
    .slice(0, MAX_OWNERS);
}

async function resolveSources(
  ctx: AnalysisContext,
  observations: ViewportObservation[],
  wanted?: (img: ObservedImage) => boolean,
): Promise<Map<ObservedImage, ResolvedSource>> {
  const resolved = new Map<ObservedImage, ResolvedSource>();
  const texts = new Map<string, Promise<string | undefined>>();
  for (const obs of observations) {
    for (const img of obs.images) {
      if (wanted && !wanted(img)) continue;
      const owners = img.locator?.owners ?? [];
      const chain: OwnerSource[] = owners.length > 0 ? await resolveOwnerChain(owners, (chunk) => loadSourceMap(ctx, chunk)) : [];
      const dev = chain[0] !== undefined ? { file: chain[0].file, line: chain[0].line } : undefined;
      // A production build has no owner source: the function locations of the owners stand in (prod-sourcemap).
      const prod = dev === undefined && img.locator?.functionLocations?.length
        ? await resolveFunctionLocations(img.locator.functionLocations, (chunk) => loadSourceMap(ctx, chunk))
        : undefined;
      const found = dev ?? prod;
      const via: LocatorVia | undefined = dev ? "react-dev" : prod ? "prod-sourcemap" : undefined;
      const component = componentNamesOf(owners);
      const check = found ? await checkSource(ctx, texts, found.file, found.line, component[0]) : undefined;
      resolved.set(img, { file: found?.file, line: found?.line, component, check, via, ownerChain: chain.length > 0 ? chain : undefined });
    }
  }
  return resolved;
}

const formatName = (format: string | undefined): string | undefined => (format === "jpg" ? "jpeg" : format);

/**
 * The owner of each CSS background element, by its index (the first viewport that has it). Owners give the component
 * and, when the source resolves, its file. No project file is checked: a background's owner is not an image line.
 */
async function resolveBackgroundSources(ctx: AnalysisContext, observations: ViewportObservation[]): Promise<Map<number, ResolvedSource>> {
  const resolved = new Map<number, ResolvedSource>();
  for (const obs of observations) {
    for (const bg of obs.backgrounds ?? []) {
      if (resolved.has(bg.index)) continue;
      const found = bg.owners.length > 0 ? await resolveOwners(bg.owners, (chunk) => loadSourceMap(ctx, chunk)) : undefined;
      resolved.set(bg.index, { file: found?.file, line: found?.line, component: componentNamesOf(bg.owners) });
    }
  }
  return resolved;
}

/**
 * One layer of a CSS background at one viewport. The file is the candidate the browser loaded; the needed pixels come from
 * the box and the background-size (see backgrounds.ts). The saving is a local resize to the needed width at the same
 * format (est.): a layer has no alternative file to measure, and no quality sweep.
 */
async function measureBackground(
  ctx: AnalysisContext,
  obs: ViewportObservation,
  bg: ObservedBackground,
  layerIndex: number,
  layer: BackgroundLayer,
  size: string,
): Promise<BackgroundInstance> {
  const dpr = obs.viewport.dpr;
  const instance: BackgroundInstance = {
    viewport: obs.viewport,
    bg,
    layer: layerIndex,
    url: "",
    bytes: 0,
    pixelWidth: 0,
    displayedCss: 0,
    needed: 0,
    undersized: false,
    est: 0,
    estAggressive: 0,
    size,
  };
  const skip = (reason: string): BackgroundInstance => ({ ...instance, skipped: reason });
  if (bg.hidden) return skip("hidden");
  if (bg.width < MIN_RENDERED_PX || bg.height < MIN_RENDERED_PX) return skip("under 16 px");
  if (layer.dataUri) return skip("data URI");
  const chosen = pickLoaded(layer.candidates, (url) => obs.responses.get(url)?.buffer !== undefined, dpr);
  if (!chosen) return skip("not loaded");
  const response = obs.responses.get(chosen.url) as ResponseRecord;
  const served = response.pixels;
  if (response.contentType?.toLowerCase().includes("svg") || served?.format === "svg") return skip("vector");
  if (!served) return skip("not decodable");
  const natural = { width: served.width / chosen.resolution, height: served.height / chosen.resolution };
  const displayed = displayedCssWidth(size, { width: bg.width, height: bg.height }, natural);
  if (displayed === undefined || !Number.isFinite(displayed) || displayed <= 0) return skip("background-size not read");
  const needed = neededDevicePixels(displayed, dpr);
  Object.assign(instance, {
    url: chosen.url,
    bytes: response.bytes,
    pixelWidth: served.width,
    format: formatName(served.format),
    displayedCss: displayed,
    needed,
    undersized: served.width < UNDERSIZED_RATIO * needed,
  });
  if (served.width > PLAIN_RESIZE_RATIO * needed && served.format) {
    const key = `${chosen.url}|${needed}`;
    let pending = ctx.resized.get(key);
    if (!pending) {
      count("background resize estimates");
      pending = measure("background resize estimate", () => resizedEstimate(response.buffer as Buffer, served.format as string, needed)).catch(() => undefined);
      ctx.resized.set(key, pending);
    }
    const resized = await pending;
    if (resized) instance.est = instance.estAggressive = Math.max(0, response.bytes - resized.bytes);
  }
  return instance;
}

async function baseline(ctx: AnalysisContext, obs: ViewportObservation, img: ObservedImage): Promise<Instance> {
  const dpr = obs.viewport.dpr;
  const needed = Math.ceil(img.renderedWidth * dpr);
  const instance: Instance = {
    viewport: obs.viewport,
    element: img.index,
    img,
    url: img.currentSrc,
    bytes: 0,
    pixelWidth: 0,
    renderedWidth: img.renderedWidth,
    needed,
    kind: "skipped",
    exact: 0,
    est: 0,
    estAggressive: 0,
    growth: 0,
    group: "",
    ...loaderOf(img.currentSrc, ctx.pageUrl),
  };
  const skip = (reason: string): Instance => ({ ...instance, skipped: reason });

  if (img.renderedWidth < MIN_RENDERED_PX) return skip("under 16 px");
  if (!img.currentSrc || img.currentSrc.startsWith("data:")) return skip("data URI");
  const response = obs.responses.get(img.currentSrc);
  if (!response?.buffer) return skip("not loaded");
  const served = response.pixels;
  if (response.contentType?.toLowerCase().includes("svg") || served?.format === "svg") return skip("vector");
  if (!served) return skip("not decodable");
  Object.assign(instance, { bytes: response.bytes, pixelWidth: served.width, format: formatName(served.format) });

  const candidates = parseSrcset(img.srcset, ctx.pageUrl);
  if (candidates.length > 0) {
    const largest = Math.max(...candidates.map((c) => c.width));
    const need = neededWidth(img.renderedWidth, dpr, largest);
    const right = rightCandidate(candidates, need);
    instance.kind = "srcset";
    instance.needed = need;
    let rightBuffer: Buffer | undefined;
    if (right.url === img.currentSrc) {
      rightBuffer = response.buffer;
    } else {
      // A candidate the browser loaded at this viewport is reused; otherwise it is fetched once, as the page advertises it.
      rightBuffer =
        obs.responses.get(right.url)?.buffer ??
        (await measure("fetch: srcset candidate", () => ctx.fetcher.get(right.url, { allowPrivate: ctx.allowPrivate })));
    }
    if (rightBuffer) {
      const rightPixels = right.url === img.currentSrc ? served : await measure("decode: pixel size", () => pixelSize(rightBuffer as Buffer));
      const rightBytes = rightBuffer.length;
      if (isUndersized(served.width, need, largest)) {
        instance.undersized = true;
        instance.growth = Math.max(0, rightBytes - response.bytes);
      }
      if (rightPixels?.format) {
        instance.right = {
          url: right.url,
          bytes: rightBytes,
          width: rightPixels.width,
          height: rightPixels.height,
          format: formatName(rightPixels.format) ?? rightPixels.format,
          buffer: rightBuffer,
        };
      }
    }
    return instance;
  }

  // No w-descriptor srcset: a wider file than needed is estimated by a local resize at its own format (est.).
  instance.kind = "plain";
  if (served.width > PLAIN_RESIZE_RATIO * needed && served.format) {
    const key = `${img.currentSrc}|${needed}`;
    let pending = ctx.resized.get(key);
    if (!pending) {
      count("plain resize estimates");
      pending = measure("plain resize estimate", () => resizedEstimate(response.buffer as Buffer, served.format as string, needed)).catch(() => undefined);
      ctx.resized.set(key, pending);
    }
    const resized = await pending;
    if (resized) instance.est = instance.estAggressive = Math.max(0, response.bytes - resized.bytes);
  }
  return instance;
}

/** The most frequent value, the first seen among ties. */
function modeOf(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  for (const [v, n] of counts) if (n > (counts.get(best) ?? 0)) best = v;
  return best;
}

/**
 * The hint for a group whose loader limits the quality: none (re-export the sources), auto (set an explicit q_N), or
 * tunable (the quality the estimate lands on, once there is one).
 */
export function qualityHintFor(loader: string, qualityParam: QualityParam, estQuality: number | undefined): string | undefined {
  if (qualityParam === "none") return `${loader}: no quality parameter — re-export sources at lower quality`;
  if (qualityParam === "auto") return `${loader}: q_auto in use — set an explicit q_<N>`;
  return estQuality === undefined ? undefined : `${loader}: set quality=${estQuality}`;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The quality step: per group, up to SAMPLES_PER_GROUP images are scored at the reference viewport (those with a known
 * original). Their median ratio applies to every other image of the group that has a reference.
 */
async function estimateQualities(ctx: AnalysisContext, all: Instance[], refName: string): Promise<void> {
  const groups = new Map<string, Instance[]>();
  for (const inst of all) {
    if (inst.kind !== "srcset" || !inst.right) continue;
    if (ctx.qualityFor && !ctx.qualityFor(inst)) continue;
    const list = groups.get(inst.group);
    if (list) list.push(inst);
    else groups.set(inst.group, [inst]);
  }
  // The samples of each group, in document order: the first SAMPLES_PER_GROUP images at the reference viewport that have a
  // known original and a file a sweep can save on (see sweepMark). Planned first, so the estimates can run side by side.
  const plans = [...groups.values()].map((members) => {
    const samples: Instance[] = [];
    for (const member of members.filter((m) => m.viewport.name === refName)) {
      if (samples.length >= SAMPLES_PER_GROUP) break;
      if (!referenceUrl(member.url, ctx.pageUrl) || sweepMark(member)) continue;
      samples.push(member);
    }
    return { members, samples };
  });
  const sampled = plans.flatMap((plan) => plan.samples);
  const outcomes = await mapLimit(sampled, QUALITY_PARALLEL, (member) => sampleQuality(ctx, member));
  const outcomeOf = new Map(sampled.map((member, i) => [member, outcomes[i]]));
  for (const { members, samples } of plans) {
    const ratios2: number[] = [];
    const ratios4: number[] = [];
    for (const member of samples) {
      const outcome = outcomeOf.get(member);
      if (!outcome) continue;
      member.qualityRatio = { ...outcome.ratio };
      member.qualityInfo = outcome.info;
      ratios2.push(outcome.ratio[SCAN_DELTA]);
      if (ctx.aggressive) ratios4.push(outcome.ratio[SCAN_AGGRESSIVE_DELTA]);
    }
    const group2 = median(ratios2);
    const group4 = median(ratios4);
    for (const member of members) {
      if (member.qualityRatio || !referenceUrl(member.url, ctx.pageUrl)) continue;
      const mark = sweepMark(member);
      // A member with no group ratio gets no quality info, unless it is marked skipped-small (then the mark says why).
      if (group2 === undefined && mark === undefined) continue;
      const current = currentQuality(member.url, ctx.pageUrl);
      if (group2 !== undefined) {
        member.qualityRatio = ctx.aggressive && group4 !== undefined ? { [SCAN_DELTA]: group2, [SCAN_AGGRESSIVE_DELTA]: group4 } : { [SCAN_DELTA]: group2 };
      }
      member.qualityInfo = { current: current.quality, qualityAssumed: current.assumed, sampled: false, ...mark };
    }
  }
}

/** One quality sample: the original's body and the estimate for the member's served file. Undefined when either is missing. */
async function sampleQuality(ctx: AnalysisContext, member: Instance): Promise<{ ratio: Record<number, number>; info: QualityInfo } | undefined> {
  const original = referenceUrl(member.url, ctx.pageUrl);
  const right = member.right;
  if (!original || !right) return undefined;
  count("quality samples");
  const buffer = await measure("fetch: original", () => ctx.fetcher.get(original, { allowPrivate: ctx.allowPrivate }));
  if (!buffer) return undefined;
  const current = currentQuality(member.url, ctx.pageUrl);
  const deltas = ctx.aggressive ? [SCAN_DELTA, SCAN_AGGRESSIVE_DELTA] : [SCAN_DELTA];
  const estimate = await measure("quality estimate", () => estimateQuality(
    {
      original: buffer,
      served: right.buffer,
      format: right.format,
      bytes: right.bytes,
      width: right.width,
      height: right.height,
      current: current.quality,
    },
    deltas,
    ctx.deps,
  )).catch(() => undefined);
  if (!estimate) return undefined;
  return {
    ratio: { ...estimate.ratio },
    info: { current: current.quality, qualityAssumed: current.assumed, target: estimate.target, format: estimate.format, sampled: true },
  };
}

/**
 * The sweep mark of a member whose served file is too small for a sweep to matter: the quality and format sweep saves at
 * most the bytes of the file it acts on, so below SWEEP_MIN_BYTES the saving is under 2 KB. Such a member is not sampled.
 */
function sweepMark(member: Instance): { sweep: "skipped-small" } | undefined {
  return member.right !== undefined && member.right.bytes < SWEEP_MIN_BYTES ? { sweep: "skipped-small" } : undefined;
}

/**
 * Turns the quality ratios into savings on top of the right file (est.). An undersized image saves nothing: its growth is
 * reported apart, and is never subtracted from another image's saving.
 */
export function applyQuality(inst: Instance): void {
  if (inst.undersized) {
    inst.exact = 0;
    inst.est = 0;
    inst.estAggressive = 0;
    return;
  }
  if (!inst.right) return;
  const r2 = inst.qualityRatio?.[SCAN_DELTA] ?? 1;
  const r4 = inst.qualityRatio?.[SCAN_AGGRESSIVE_DELTA] ?? r2;
  const net = netSavings(inst.bytes, inst.right.bytes, r2);
  inst.exact = net.exact;
  inst.est = net.est;
  inst.estAggressive = netSavings(inst.bytes, inst.right.bytes, r4).est;
}

export interface ImageReport {
  url: string;
  bytes: number;
  format?: string;
  pixelWidth: number;
  renderedWidth: number;
  dpr: number;
  needed: number;
  firstViewport: boolean;
  kind: "srcset" | "plain" | "skipped";
  skipped?: string;
  sizes?: string;
  right?: { url: string; bytes: number; width: number };
  exactSaved: number;
  estSaved: number;
  estAggressiveSaved?: number;
  sharpnessGrowth: number;
  group: string;
  quality?: QualityInfo;
  qualityNA: boolean;
  loader: string;
  /** Index of the element measured instead, when this element repeats its URL (its savings are zero). */
  duplicateOf?: number;
}

export interface ViewportReport {
  imageBytes: number;
  exactSaved: number;
  estSaved: number;
  estAggressiveSaved?: number;
  sharpnessGrowth: number;
  images: ImageReport[];
  /** The CSS background layers at this viewport (not in the totals above). Absent in a light read. */
  backgrounds?: BackgroundTotals;
}

export interface GroupReport {
  key: string;
  sizes?: string;
  suggestedSizes?: string;
  estQuality?: number;
  /** The loader most of the group's images come from. */
  loader?: string;
  /** How the loader's quality parameter limits the saving: the hint for the quality step. */
  qualityHint?: string;
  /** Mean over the viewports the group is shown at: exact + est. bytes per page view. */
  savedBytes: number;
  members: number;
  samples: string[];
  hint?: string;
}

/**
 * ok: measured. blocked: a challenge page. robots: robots.txt disallows the page. redirected: the page ends on another
 * site, or on a URL robots.txt disallows, so nothing is measured (finalUrl says where it went). failed: an error.
 */
export type PageStatus = "ok" | "blocked" | "robots" | "redirected" | "failed";

/** The `robots` value recorded for a page on a loopback or private host: its owner's own server is not checked. */
export const ROBOTS_SKIPPED_LOCAL = "skipped (local host)";

/**
 * Which scorer made a page's SSIMULACRA2 numbers. `cpuFallbacks` counts the scores the CPU took after the GPU scorer
 * failed during this page; it is absent when there were none.
 */
export interface PageScorer {
  name: "cpu" | "gpu";
  /** The device index the scorer opened (CUDA's numbering within the visible devices, see deviceOrder). */
  device?: number;
  deviceName?: string;
  /** CUDA_DEVICE_ORDER as the scorer ran with it (FASTEST_FIRST when unset). */
  deviceOrder?: string;
  /** CUDA_VISIBLE_DEVICES as the scorer ran with it (imgtune's own restriction when the user set none). */
  visibleDevices?: string;
  cpuFallbacks?: number;
}

export interface PageResult {
  url: string;
  host: string;
  scannedAt: string;
  imgtuneVersion: string;
  metric: "ssimulacra2";
  /** The scorer that made the numbers: the CPU, or the GPU (see PageScorer). Absent in scans from before --gpu. */
  scorer?: PageScorer;
  delta: number;
  aggressiveDelta?: number;
  viewports: string[];
  status: PageStatus;
  error?: string;
  /** Set when robots.txt was not checked: the page is on a loopback or private host. */
  robots?: string;
  /** True when robots.txt disallowed the page (or the URL it ended on) and it was scanned anyway (--ignore-robots). */
  robotsIgnored?: true;
  /** The URL the page ended on, when it differs from `url` (a navigation of its own). */
  finalUrl?: string;
  /** True when the page's `load` event did not come within the cap; its figures were taken anyway. */
  loadTimedOut?: boolean;
  /** Linked stylesheets that did not load, per viewport (only when some did): the widths measured there are not valid. */
  stylesheetsFailed?: Record<string, number>;
  /** The robots.txt rule that disallowed the page, when it was scanned anyway (--ignore-robots). */
  robotsRule?: string;
  /** A note that the page ended on another URL, with the URL in it. */
  redirectNote?: string;
  nextjs: boolean;
  perViewport: Record<string, ViewportReport>;
  page?: PageNumbers;
  groups: GroupReport[];
  counts: { images: number; qualityNA: number; skipped: number; blockedRequests: number; byLoader: Record<string, number> };
  /** One fix record per distinct image element, merged across viewports (see images.ts). */
  images?: ImageRecord[];
  /** Lazy images that never loaded at any viewport. */
  notLoaded?: number;
  /** The CSS background layers of the page: a separate line, not in the headline (see backgrounds.ts). */
  backgrounds?: BackgroundPage;
  /** Scanned with --harness: measured in isolation (the rung of every record is measured-harness). */
  harness?: true;
  /** Written once the page is done: a page without it (an interrupted run) is scanned again by --resume. */
  complete?: true;
  /** The options the page was scanned with: --resume reuses a page only when they are the same. */
  options?: ScanRecordOptions;
  /** Set on a page that `scan --locate-only` read the sources of from a dev page (see locate-join.ts). */
  locate?: LocateSummary;
}

/** What a page's output depends on: the scan options and the imgtune version. */
export interface ScanRecordOptions {
  imgtuneVersion: string;
  aggressive: boolean;
  quality: boolean;
  viewports: string[];
  ignoreRobots: boolean;
  /** A storage state (logged-in session) was applied to every context. Its contents are not recorded. */
  storageState: boolean;
  /** The scorer asked for. Scans from before --gpu have none: that is "cpu". */
  scorer: "cpu" | "gpu";
  /** --harness: the pages are measured in isolation. Absent (not false) otherwise, so older scans still match. */
  harness?: true;
}

/** The options of one page's output, for the completeness check of --resume. */
export function recordOptionsOf(
  opts: Pick<ScanOptions, "aggressive" | "quality" | "viewports" | "ignoreRobots" | "storageState" | "gpu" | "harness">,
): ScanRecordOptions {
  return {
    imgtuneVersion: IMGTUNE_VERSION,
    aggressive: opts.aggressive,
    quality: opts.quality,
    viewports: opts.viewports.map((v) => v.name),
    ignoreRobots: opts.ignoreRobots === true,
    storageState: opts.storageState !== undefined,
    scorer: opts.gpu !== undefined ? "gpu" : "cpu",
    ...(opts.harness === true ? { harness: true as const } : {}),
  };
}

/** Whether two recorded option sets are the same (the viewports in order; a missing scorer is the CPU). */
export function sameRecordOptions(a: ScanRecordOptions | undefined, b: ScanRecordOptions): boolean {
  if (!a) return false;
  return JSON.stringify({ ...a, scorer: a.scorer ?? "cpu" }) === JSON.stringify(b);
}

/** The scorer a page was measured with. `fallbacksBefore`: the GPU's fallback count when the page started. */
export function scorerOf(gpu: GpuScorer | undefined, fallbacksBefore = 0): PageScorer {
  if (gpu === undefined) return { name: "cpu" };
  const cpuFallbacks = gpu.fallbackScores - fallbacksBefore;
  return { name: "gpu", device: gpu.device, deviceName: gpu.deviceName, ...gpu.cuda, ...(cpuFallbacks > 0 ? { cpuFallbacks } : {}) };
}

/** The line that names the GPU scorer when the GPU made any of the numbers; undefined for a CPU run. */
export function scorerNote(results: PageResult[]): string | undefined {
  const gpuPages = results.filter((r) => r.scorer?.name === "gpu");
  if (gpuPages.length === 0) return undefined;
  const first = gpuPages[0].scorer as PageScorer;
  const fallbacks = gpuPages.reduce((sum, r) => sum + (r.scorer?.cpuFallbacks ?? 0), 0);
  return gpuNote(first.device ?? 0, first.deviceName ?? "unknown", fallbacks);
}

function toReport(inst: Instance): ImageReport {
  const quality = inst.qualityInfo;
  return {
    url: inst.url,
    bytes: inst.bytes,
    format: inst.format,
    pixelWidth: inst.pixelWidth,
    renderedWidth: inst.renderedWidth,
    dpr: inst.viewport.dpr,
    needed: inst.needed,
    firstViewport: inst.img.inFirstViewport,
    kind: inst.kind,
    skipped: inst.skipped,
    sizes: inst.img.sizes,
    right: inst.right ? { url: inst.right.url, bytes: inst.right.bytes, width: inst.right.width } : undefined,
    exactSaved: inst.exact,
    estSaved: inst.est,
    estAggressiveSaved: inst.kind === "skipped" ? undefined : inst.estAggressive,
    sharpnessGrowth: inst.growth,
    group: inst.group,
    quality: quality ? { ...quality } : undefined,
    qualityNA: inst.kind !== "skipped" && inst.qualityRatio === undefined,
    loader: inst.loader,
    duplicateOf: inst.duplicateOf,
  };
}

/**
 * Groups by saving: the group's exact + est. bytes per page view, summed over the page's viewports and divided by their
 * count (as pageNumbers does), with two sample URLs and a sizes hint.
 */
export function groupReports(instances: Instance[], viewportCount: number): GroupReport[] {
  const byKey = new Map<string, Instance[]>();
  for (const inst of instances) {
    if (inst.kind === "skipped") continue;
    const list = byKey.get(inst.group);
    if (list) list.push(inst);
    else byKey.set(inst.group, [inst]);
  }
  const reports: GroupReport[] = [];
  for (const [key, members] of byKey) {
    const sizes = members[0].img.sizes;
    const points: SizePoint[] = members
      .filter((m) => m.renderedWidth >= 1)
      .map((m) => ({ viewportWidth: m.viewport.width, renderedWidth: m.renderedWidth, mobile: m.viewport.mobile }));
    // A proposal that leaves any measured viewport undersized is not a saving: it is dropped, with its exact bytes.
    const proposed = deriveSizes(points);
    const undersized =
      proposed === undefined
        ? undefined
        : undersizedProposal(
            proposed,
            members.map((m) => ({ viewport: m.viewport.name, viewportWidth: m.viewport.width, dpr: m.viewport.dpr, renderedWidth: m.renderedWidth, srcset: m.img.srcset })),
            (srcset) => parseSrcset(srcset, "http://imgtune.invalid/"),
          );
    const suggestedSizes = undersized === undefined ? proposed : undefined;
    const perViewport = new Map<string, number>();
    for (const inst of members) {
      const name = inst.viewport.name;
      perViewport.set(name, (perViewport.get(name) ?? 0) + (suggestedSizes === undefined ? 0 : inst.exact) + inst.est);
    }
    const savedBytes = [...perViewport.values()].reduce((sum, bytes) => sum + bytes, 0) / viewportCount;
    if (savedBytes <= 0) continue;
    const targets = members.flatMap((m) => (m.qualityInfo?.target !== undefined ? [m.qualityInfo.target] : []));
    const samples = [...new Set(members.map((m) => m.url))].slice(0, 2);
    const loader = modeOf(members.map((m) => m.loader));
    const lead = members.find((m) => m.loader === loader) as Instance;
    const estQuality = median(targets);
    reports.push({
      key,
      sizes,
      suggestedSizes,
      estQuality,
      loader,
      qualityHint: qualityHintFor(loader, lead.qualityParam, estQuality),
      savedBytes,
      members: new Set(members.map((m) => m.element)).size,
      samples,
      hint: suggestedSizes && suggestedSizes !== sizes ? `set sizes="${suggestedSizes}"` : undefined,
    });
  }
  return reports.sort((a, b) => b.savedBytes - a.savedBytes).slice(0, TOP_GROUPS);
}

/** The viewport the quality step scores at: iphone-15 when it is measured, else the first mobile one, else the first. */
function referenceViewportName(viewports: Viewport[]): string {
  return viewports.find((v) => v.name === "iphone-15")?.name ?? viewports.find((v) => v.mobile)?.name ?? viewports[0].name;
}

/** Turns the observations of one page into the report. Fetches and local encodes happen here. */
export async function analysePage(ctx: AnalysisContext, observations: ViewportObservation[], base: PageResult): Promise<PageResult> {
  const refName = referenceViewportName(observations.map((o) => o.viewport));
  const instances: Instance[] = [];
  for (const obs of observations) {
    const duplicates = duplicatesOf(obs.images);
    for (const img of obs.images) {
      const rep = duplicates.get(img.index);
      if (rep === undefined) {
        instances.push(await baseline(ctx, obs, img));
      } else {
        instances.push({
          viewport: obs.viewport,
          element: img.index,
          img,
          url: img.currentSrc,
          bytes: 0,
          pixelWidth: 0,
          renderedWidth: img.renderedWidth,
          needed: Math.ceil(img.renderedWidth * obs.viewport.dpr),
          kind: "skipped",
          skipped: "duplicate",
          exact: 0,
          est: 0,
          estAggressive: 0,
          growth: 0,
          group: "",
          duplicateOf: rep,
          ...loaderOf(img.currentSrc, ctx.pageUrl),
        });
      }
    }
  }
  const refWidth = new Map<number, number>();
  for (const inst of instances) {
    if (inst.viewport.name === refName && inst.renderedWidth >= 1) refWidth.set(inst.element, inst.renderedWidth);
  }
  for (const inst of instances) {
    inst.group = groupKey(inst.img.sizes, inst.img.classes, refWidth.get(inst.element));
  }
  const sources = await resolveSources(ctx, observations);
  if (ctx.quality) await estimateQualities(ctx, instances, refName);
  for (const inst of instances) applyQuality(inst);
  // CSS background layers: measured apart. They stay out of the totals, the groups and the counts below (the page's
  // `backgrounds` line reports them), so the headline numbers are the images' alone.
  const bgInstances: BackgroundInstance[] = [];
  for (const obs of observations) {
    for (const bg of obs.backgrounds ?? []) {
      // Too long or too many layers: not read at all (see backgroundTooLarge).
      if (backgroundTooLarge(bg)) continue;
      const layers = parseBackgroundImage(bg.backgroundImage);
      const sizes = parseBackgroundSize(bg.backgroundSize);
      for (let k = 0; k < layers.length; k++) {
        const layer = layers[k];
        // A gradient or none layer is not an image. Its size still counts in the list, so the index of the layers match.
        if (layer.candidates.length === 0 && !layer.dataUri) continue;
        bgInstances.push(await measureBackground(ctx, obs, bg, k, layer, sizes[k % sizes.length]));
      }
    }
  }
  const bgSources = await resolveBackgroundSources(ctx, observations);

  const perViewport: Record<string, ViewportReport> = {};
  const totals: ViewportTotals[] = [];
  for (const obs of observations) {
    const own = instances.filter((i) => i.viewport.name === obs.viewport.name);
    const imageBytes = [...obs.responses.values()].reduce((sum, r) => sum + r.bytes, 0);
    const vt = viewportTotals(
      own.map((i) => ({ bytes: i.bytes, exact: i.exact, est: i.est, estAggressive: i.estAggressive, growth: i.growth })),
      imageBytes,
    );
    totals.push(vt);
    perViewport[obs.viewport.name] = {
      imageBytes,
      exactSaved: vt.exact,
      estSaved: vt.est,
      estAggressiveSaved: ctx.aggressive ? vt.estAggressive : undefined,
      sharpnessGrowth: vt.growth,
      images: own.map(toReport),
      ...(obs.backgrounds !== undefined
        ? { backgrounds: backgroundTotals(bgInstances.filter((i) => i.viewport.name === obs.viewport.name)) }
        : {}),
    };
  }

  const elements = new Set(instances.map((i) => i.element));
  count("images", elements.size);
  const byLoader: Record<string, number> = {};
  for (const e of elements) {
    const first = instances.find((i) => i.element === e) as Instance;
    byLoader[first.loader] = (byLoader[first.loader] ?? 0) + 1;
  }
  const skippedElements = new Set<number>();
  const naElements = new Set<number>();
  for (const e of elements) {
    const mine = instances.filter((i) => i.element === e);
    if (mine.every((i) => i.kind === "skipped" && i.skipped !== "duplicate")) skippedElements.add(e);
    if (mine.some((i) => i.kind !== "skipped" && i.qualityRatio === undefined)) naElements.add(e);
  }

  const numbers = measure("aggregate", () => pageNumbers(totals));
  const { aggressiveExactEstPct, ...withoutAggressive } = numbers;
  const images = buildImageRecords({
    pageUrl: ctx.pageUrl,
    harness: ctx.harness,
    observations,
    instances,
    refName,
    resolved: sources,
    currentQuality,
  });
  // A proposed sizes is a saving only when its predicted outcome saves more bytes than it adds (sizes-outcome.ts).
  const widths = new Map(observations.map((o) => [o.viewport.name, o.viewport.width]));
  await measure("sizes outcome", () =>
    applySizesOutcome(images, widths, observations.length, async (url) => (await ctx.fetcher.get(url, { allowPrivate: ctx.allowPrivate }))?.length),
  );
  const backgroundRecords = buildBackgroundRecords({
    pageUrl: ctx.pageUrl,
    harness: ctx.harness,
    viewports: observations.map((o) => o.viewport),
    instances: bgInstances,
    refName,
    sources: bgSources,
  });
  return {
    ...base,
    nextjs: observations.some((o) => o.nextjs),
    perViewport,
    page: ctx.aggressive ? { ...withoutAggressive, aggressiveExactEstPct } : withoutAggressive,
    groups: measure("aggregate", () => groupReports(instances, observations.length)),
    counts: {
      images: elements.size,
      qualityNA: naElements.size,
      skipped: skippedElements.size,
      blockedRequests: observations.reduce((sum, o) => sum + o.blockedRequests, 0),
      byLoader,
    },
    images: [...images, ...backgroundRecords],
    notLoaded: images.filter((r) => r.lazy === true && !r.perViewport.some((p) => p.loaded)).length,
    ...(bgInstances.length > 0 ? { backgrounds: backgroundPage(bgInstances, observations.length, backgroundRecords) } : {}),
    ...(ctx.harness === true ? { harness: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Run: pages in order, one JSON file each
// ---------------------------------------------------------------------------------------------------------------------

export interface ScanOptions {
  /** A browser the caller started and closes (several scans share it). Without it, the scan starts and closes its own. */
  browser?: Browser;
  outDir: string;
  cwd: string;
  /** --root, absolute: the folder source files are read from (default: see source-root.ts). */
  root?: string;
  /** Viewports of this page loaded at once (default VIEWPORT_CONCURRENCY). Recheck lowers it when pages run together. */
  viewportConcurrency?: number;
  /** Read and write the result cache under the scan's folder (default true; --no-cache turns it off). */
  cache?: boolean;
  aggressive: boolean;
  quality: boolean;
  viewports: Viewport[];
  log: (message: string) => void;
  /** How long a page may take to fire `load` (default LOAD_EVENT_CAP_MS). */
  loadCapMs?: number;
  /** Scan pages that robots.txt disallows, with a warning (--ignore-robots). Default false. */
  ignoreRobots?: boolean;
  /** Host resolver for the connect-time check (tests inject one; production uses the system resolver). */
  resolver?: Resolver;
  /**
   * Test seam: the address a checked destination is really connected to (see EgressPolicy). Production leaves it unset.
   */
  connectAddress?: (address: string) => string;
  /** Reuse the complete pages already in outDir with the same options (--resume). */
  resume?: boolean;
  /** Stop after this many pages, scanned or resumed (--max-pages). */
  maxPages?: number;
  /** Stop after the page that brings the images counted so far to this number (--max-images). */
  maxImages?: number;
  /** A Playwright storage state applied to every context (--storage-state). Never recorded. */
  storageState?: StorageState;
  /** Only the images for which this is true get the quality and format search (see AnalysisContext). */
  qualityFor?: (inst: Instance) => boolean;
  /** Score with the GPU scorer on this GPU index (--gpu, --gpu-device). Undefined: the CPU scores. */
  gpu?: { device: number };
  /** Filled with why the run stopped early, if it did. */
  report?: ScanReport;
  /** The pages are harness routes measured in isolation (--harness): records carry the measured-harness rung. */
  harness?: boolean;
}

/** How a run ended early: the limit that was reached, and how far the scan got. */
export interface ScanReport {
  stopped?: {
    reason: "max-pages" | "max-images";
    limit: number;
    pages: number;
    total: number;
    images: number;
  };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));


/**
 * Whether a page may be scanned under robots.txt. robots.txt is etiquette toward third parties, so a page on a loopback
 * or private host (its owner's own server) is not checked and the skip is recorded; `fetchRobots` is not called then.
 * A public host is checked as before. With `ignoreRobots`, a disallowed page is allowed anyway and `ignored` is set.
 */
export async function checkRobots(
  pageUrl: string,
  allowPrivate: boolean,
  fetchRobots: () => Promise<string | undefined>,
  ignoreRobots = false,
): Promise<{ allowed: boolean; skipped?: string; ignored?: boolean }> {
  if (allowPrivate) return { allowed: true, skipped: ROBOTS_SKIPPED_LOCAL };
  if (robotsAllows(await fetchRobots(), pageUrl)) return { allowed: true };
  return ignoreRobots ? { allowed: true, ignored: true } : { allowed: false };
}

async function scanPage(
  browser: Browser,
  run: {
    viewports: Viewport[];
    aggressive: boolean;
    quality: boolean;
    fetcher: Fetcher;
    deps: QualityDeps;
    loadCapMs: number;
    resolver: Resolver;
    connectAddress?: (address: string) => string;
    ignoreRobots: boolean;
    harness: boolean;
    /** Source maps read in this scan, shared by its pages (see MAX_MAPS_PER_SCAN). */
    sourceMaps: Map<string, Promise<SourceMapData | undefined>>;
    storageState?: StorageState;
    qualityFor?: (inst: Instance) => boolean;
    /** The project directory the scan runs in: resolved sources are checked against its files. */
    projectDir?: string;
    projectRoot?: string;
    viewportConcurrency: number;
    log: (message: string) => void;
    /** The GPU scorer of this run, when --gpu was given and it started. */
    gpu?: GpuScorer;
  },
  pageUrl: string,
  robotsFor: (origin: string, allowPrivate: boolean) => Promise<string | undefined>,
): Promise<PageResult> {
  const url = new URL(pageUrl);
  const allowPrivate = isLocalTarget(pageUrl);
  const base: PageResult = {
    url: pageUrl,
    host: url.host,
    scannedAt: new Date().toISOString(),
    imgtuneVersion: IMGTUNE_VERSION,
    metric: "ssimulacra2",
    delta: SCAN_DELTA,
    aggressiveDelta: run.aggressive ? SCAN_AGGRESSIVE_DELTA : undefined,
    viewports: run.viewports.map((v) => v.name),
    status: "ok",
    nextjs: false,
    perViewport: {},
    groups: [],
    counts: { images: 0, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
  };
  // The robots.txt text is kept, so an ignored page can name the rule that disallowed it.
  let robotsTxt: string | undefined;
  const robots = await checkRobots(
    pageUrl,
    allowPrivate,
    async () => (robotsTxt = await robotsFor(url.origin, false)),
    run.ignoreRobots,
  );
  if (!robots.allowed) return { ...base, status: "robots" };
  if (robots.skipped !== undefined) base.robots = robots.skipped;
  if (robots.ignored) {
    base.robotsIgnored = true;
    base.robotsRule = robotsRuleFor(robotsTxt, pageUrl);
    run.log(robotsIgnoredWarning(pageUrl));
  }
  let robotsIgnored = robots.ignored === true;
  let robotsRule = robots.ignored ? robotsRuleFor(robotsTxt, pageUrl) : undefined;

  // A page that ends on another URL is measured only when that URL is on the same registrable domain and robots.txt
  // allows it; otherwise the page is reported as redirected, with the URL it ended on.
  const landedOk = async (landing: string): Promise<boolean> => {
    if (!sameSite(landing, pageUrl)) return false;
    const landingOrigin = new URL(landing).origin;
    let landingTxt: string | undefined;
    const landingRobots = await checkRobots(
      landing,
      allowPrivate,
      async () => (landingTxt = await robotsFor(landingOrigin, false)),
      run.ignoreRobots,
    );
    if (landingRobots.ignored) {
      robotsIgnored = true;
      robotsRule ??= robotsRuleFor(landingTxt, landing);
      run.log(robotsIgnoredWarning(landing));
    }
    return landingRobots.allowed;
  };

  // One pass per viewport, a few at a time, each in its own context. The outcomes are read in viewport order, so the first
  // challenge, redirect or error decides the status as it does when the viewports load one after another. A challenge
  // is still not retried.
  const policy: EgressPolicy = { resolver: run.resolver, allowPrivate, connectAddress: run.connectAddress };
  const guard: RequestGuard = { isBlocked: (u) => run.fetcher.hostIsBlocked(u, allowPrivate), policy };
  const outcomes = await settleLimit(run.viewports, run.viewportConcurrency, (viewport) => {
    count("viewport loads");
    return observeViewport(browser, pageUrl, viewport, guard, run.loadCapMs, run.storageState);
  });
  const observations: ViewportObservation[] = [];
  let finalUrl: string | undefined;
  let loadTimedOut = false;
  const sheetsFailed: Record<string, number> = {};
  try {
    for (const [index, outcome] of outcomes.entries()) {
      const viewport = run.viewports[index];
      if (!outcome.ok) throw outcome.error;
      const obs = outcome.value;
      if (obs.blocked) {
        return { ...base, status: "blocked", error: `challenge at ${viewport.name}${obs.status ? ` (HTTP ${obs.status})` : ""}` };
      }
      if (obs.loadTimedOut) loadTimedOut = true;
      if ((obs.stylesheetsFailed ?? 0) > 0) sheetsFailed[viewport.name] = obs.stylesheetsFailed as number;
      if (obs.finalUrl !== undefined && new URL(obs.finalUrl).href !== url.href) {
        if (!(await landedOk(obs.finalUrl))) {
          return { ...base, status: "redirected", finalUrl: obs.finalUrl, error: `redirected to ${obs.finalUrl}` };
        }
        if (finalUrl === undefined) finalUrl = obs.finalUrl;
      }
      observations.push(obs);
    }
  } catch (err) {
    return { ...base, status: "failed", error: messageOf(err) };
  }
  const described: PageResult = { ...base };
  if (finalUrl !== undefined) described.finalUrl = finalUrl;
  if (loadTimedOut) described.loadTimedOut = true;
  if (Object.keys(sheetsFailed).length > 0) {
    described.stylesheetsFailed = sheetsFailed;
    run.log(
      `warning: ${safeText(pageUrl)}: a linked stylesheet did not load at ${Object.keys(sheetsFailed).map((name) => safeText(name)).join(", ")}; the page is not styled as the app is, so its widths and sizes verdicts are not valid (check the asset prefix the server was started with)`,
    );
  }
  if (robotsIgnored) described.robotsIgnored = true;
  if (robotsRule !== undefined) described.robotsRule = robotsRule;
  if (finalUrl !== undefined) described.redirectNote = `the page ends on ${finalUrl}; measured there`;
  return analysePage(
    {
      pageUrl,
      fetcher: run.fetcher,
      allowPrivate,
      deps: run.deps,
      quality: run.quality,
      qualityFor: run.qualityFor,
      aggressive: run.aggressive,
      resized: new Map(),
      harness: run.harness,
      sourceMaps: run.sourceMaps,
      projectDir: run.projectDir,
      projectRoot: run.projectRoot,
    },
    observations,
    described,
  );
}

/** The run's shared state: the browser's fetcher, the scorer, the robots cache and the options each page reads. */
async function withScanRun<T>(
  opts: ScanOptions,
  body: (browser: Browser, run: Parameters<typeof scanPage>[1], robotsFor: (origin: string, allowPrivate: boolean) => Promise<string | undefined>) => Promise<T>,
): Promise<T> {
  resetTiming();
  // The GPU program is started once per run and closed however the run ends: a left-open child keeps the CLI alive.
  const gpu = opts.gpu !== undefined ? await startGpuScorer(opts.gpu.device, opts.log) : undefined;
  try {
    return await withBrowser(opts, gpu, body);
  } finally {
    gpu?.close();
  }
}

async function withBrowser<T>(
  opts: ScanOptions,
  gpu: GpuScorer | undefined,
  body: (browser: Browser, run: Parameters<typeof scanPage>[1], robotsFor: (origin: string, allowPrivate: boolean) => Promise<string | undefined>) => Promise<T>,
): Promise<T> {
  const shared = opts.browser;
  const browser = shared ?? (await measure("browser launch", () => launchChromium()));
  try {
    // The fetches send the desktop viewport's user agent: the default one of a fresh context.
    const probe = await browser.newContext();
    const userAgent = await (await probe.newPage()).evaluate(() => navigator.userAgent);
    await probe.close();
    const resolver = opts.resolver ?? systemResolver;
    const fetcher = makeFetcher({ userAgent, resolver, connectAddress: opts.connectAddress });
    // The result cache (see result-cache.ts): under the scan's folder, bounded, and off with --no-cache.
    const cache = opts.cache === false ? undefined : new ResultCache(join(opts.cwd, CACHE_DIR));
    await cache?.trim();
    const deps: QualityDeps = {
      score: makeScorer("ssimulacra2", { projectDir: opts.cwd, gpu }),
      cache,
      scorerId: gpu !== undefined ? `gpu:${gpu.deviceName}` : "cpu",
      cpuScored: gpu !== undefined ? () => gpu.cpuScores : undefined,
    };
    const run = {
      viewports: opts.viewports,
      aggressive: opts.aggressive,
      quality: opts.quality,
      fetcher,
      deps,
      loadCapMs: opts.loadCapMs ?? LOAD_EVENT_CAP_MS,
      resolver,
      connectAddress: opts.connectAddress,
      ignoreRobots: opts.ignoreRobots === true,
      harness: opts.harness === true,
      sourceMaps: new Map(),
      storageState: opts.storageState,
      qualityFor: opts.qualityFor,
      projectDir: opts.cwd,
      projectRoot: opts.root,
      viewportConcurrency: opts.viewportConcurrency ?? VIEWPORT_CONCURRENCY,
      log: opts.log,
      gpu,
    };

    const robotsCache = new Map<string, Promise<string | undefined>>();
    const robotsFor = (origin: string, allowPrivate: boolean) => {
      let pending = robotsCache.get(origin);
      if (!pending) {
        pending = fetcher
          .get(`${origin}/robots.txt`, { maxBytes: MAX_ROBOTS_BYTES, allowPrivate })
          .then((body) => body?.toString("utf8"));
        robotsCache.set(origin, pending);
      }
      return pending;
    };
    return await body(browser, run, robotsFor);
  } finally {
    if (shared === undefined) await browser.close();
    for (const line of renderTiming()) process.stderr.write(`${line}\n`);
  }
}

/**
 * A complete page left by an earlier run with the same options, or undefined. A page with other options is scanned again,
 * with a warning: its numbers would not be comparable.
 */
async function resumable(
  outDir: string,
  pageUrl: string,
  options: ScanRecordOptions,
  log: (message: string) => void,
): Promise<PageResult | undefined> {
  let parsed: PageResult;
  try {
    parsed = JSON.parse(await readFile(join(outDir, pageFileName(new URL(pageUrl))), "utf8")) as PageResult;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.complete !== true || parsed.url !== pageUrl) return undefined;
  if (!sameRecordOptions(parsed.options, options)) {
    log(`warning: ${safeText(pageUrl)} was scanned with other options or another imgtune version; scanning it again`);
    return undefined;
  }
  return parsed;
}

/** The progress line after a page: the pages done, the image bytes measured so far, and the site's estimated share. */
export function progressLine(done: PageResult[], total: number): string {
  const last = done[done.length - 1];
  const ok = done.filter((r) => r.status === "ok" && r.page !== undefined).map((r) => r.page as PageNumbers);
  const measured = ok.reduce((sum, p) => sum + p.meanImageBytes, 0);
  const estimated = ok.length > 0 ? siteNumbers(ok).exactEstPct : 0;
  const status = last.status === "ok" ? "" : ` (${last.status})`;
  return `page ${done.length}/${total} done${status} · ${(measured / (1024 * 1024)).toFixed(1)} MB measured · est. ${estimated.toFixed(0)}%`;
}

/**
 * Scans each page in order and writes its JSON to `outDir` as soon as the page is done, with a progress line after each.
 * With `resume`, a complete page with the same options is taken from `outDir` instead. The run stops early at --max-pages
 * (pages scanned or resumed) or --max-images (checked after each page, so the page that reaches it is finished).
 */
export async function runScan(urls: string[], opts: ScanOptions): Promise<PageResult[]> {
  return withScanRun(opts, async (browser, run, robotsFor) => {
    await mkdir(opts.outDir, { recursive: true });
    const options = recordOptionsOf(opts);
    const results: PageResult[] = [];
    let images = 0;
    for (const url of urls) {
      if (opts.maxPages !== undefined && results.length >= opts.maxPages) break;
      const kept = opts.resume ? await resumable(opts.outDir, url, options, opts.log) : undefined;
      let result: PageResult;
      if (kept) {
        result = kept;
        opts.log(`resumed ${safeText(url)}`);
      } else {
        opts.log(`scanning ${safeText(url)}`);
        const started = performance.now();
        const fallbacksBefore = run.gpu?.fallbackScores ?? 0;
        result = { ...(await scanPage(browser, run, url, robotsFor)), complete: true, options };
        result.scorer = scorerOf(run.gpu, fallbacksBefore);
        if (TIMING_ENABLED) process.stderr.write(`imgtune timing: ${safeText(url)} ${((performance.now() - started) / 1000).toFixed(1)} s\n`);
        await writeFileAtomic(join(opts.outDir, pageFileName(new URL(url))), `${JSON.stringify(result, null, 2)}\n`, {
          root: opts.outDir,
        });
      }
      results.push(result);
      images += result.counts?.images ?? 0;
      opts.log(progressLine(results, urls.length));
      if (opts.maxImages !== undefined && images >= opts.maxImages && results.length < urls.length) {
        if (opts.report) opts.report.stopped = { reason: "max-images", limit: opts.maxImages, pages: results.length, total: urls.length, images };
        break;
      }
    }
    if (opts.maxPages !== undefined && results.length < urls.length && opts.report?.stopped === undefined) {
      if (opts.report) opts.report.stopped = { reason: "max-pages", limit: opts.maxPages, pages: results.length, total: urls.length, images };
    }
    return results;
  });
}

/**
 * One page scanned in memory, with nothing written: the run recheck uses. Its images are the page's own records.
 */
export async function scanOnce(pageUrl: string, opts: ScanOptions): Promise<PageResult> {
  return withScanRun(opts, async (browser, run, robotsFor) => {
    const fallbacksBefore = run.gpu?.fallbackScores ?? 0;
    const result = await scanPage(browser, run, pageUrl, robotsFor);
    return { ...result, scorer: scorerOf(run.gpu, fallbacksBefore) };
  });
}

/** Options of a light observation (see observeLight). */
export interface LightOptions {
  cwd: string;
  /** --root, absolute (see source-root.ts). */
  root?: string;
  viewports: Viewport[];
  log: (message: string) => void;
  ignoreRobots: boolean;
  /** Which elements get their source walked and checked (the flagged ones); the others are observed only. */
  wanted: (img: ObservedImage, pageUrl: string) => boolean;
  resolver?: Resolver;
  loadCapMs?: number;
}

/** A light observation of a page: one read per viewport, and the sources of the wanted elements. */
export interface LightObservation {
  status: PageStatus;
  error?: string;
  observations: ViewportObservation[];
  /** The resolved source of each wanted element (see resolveSources). */
  resolved: Map<ObservedImage, ResolvedSource>;
}

/**
 * Reads a page at the given viewports without measuring it: the images as rendered, their layout-independent attributes,
 * the headers of the responses, and the React owner source of the wanted elements. No body is read, nothing is decoded,
 * nothing is encoded or scored. robots.txt and the request guard apply as in a scan.
 */
export async function observeLight(pageUrl: string, opts: LightOptions): Promise<LightObservation> {
  return withScanRun(
    {
      outDir: opts.cwd,
      cwd: opts.cwd,
      root: opts.root,
      aggressive: false,
      quality: false,
      viewports: opts.viewports,
      log: opts.log,
      ignoreRobots: opts.ignoreRobots,
      resolver: opts.resolver,
      loadCapMs: opts.loadCapMs,
    },
    async (browser, run, robotsFor): Promise<LightObservation> => {
      const url = new URL(pageUrl);
      const allowPrivate = isLocalTarget(pageUrl);
      const empty = (status: PageStatus, error: string): LightObservation => ({ status, error, observations: [], resolved: new Map() });
      const robots = await checkRobots(pageUrl, allowPrivate, () => robotsFor(url.origin, false), run.ignoreRobots);
      if (!robots.allowed) return empty("robots", "robots.txt disallows the page");
      if (robots.ignored) run.log(robotsIgnoredWarning(pageUrl));
      const policy: EgressPolicy = { resolver: run.resolver, allowPrivate, connectAddress: run.connectAddress };
      const guard: RequestGuard = { isBlocked: (u) => run.fetcher.hostIsBlocked(u, allowPrivate), policy };
      const outcomes = await settleLimit(run.viewports, VIEWPORT_CONCURRENCY, (viewport) =>
        observeViewport(browser, pageUrl, viewport, guard, run.loadCapMs, undefined, true, (img) => opts.wanted(img, pageUrl)),
      );
      const observations: ViewportObservation[] = [];
      for (const [index, outcome] of outcomes.entries()) {
        const viewport = run.viewports[index];
        if (!outcome.ok) return empty("failed", messageOf(outcome.error));
        const obs = outcome.value;
        if (obs.blocked) return empty("blocked", `challenge at ${viewport.name}${obs.status ? ` (HTTP ${obs.status})` : ""}`);
        if (obs.finalUrl !== undefined && new URL(obs.finalUrl).pathname !== url.pathname) {
          return empty("redirected", `the page ends on ${obs.finalUrl}, not ${url.pathname}`);
        }
        observations.push(obs);
      }
      const ctx: AnalysisContext = {
        pageUrl,
        fetcher: run.fetcher,
        allowPrivate,
        deps: run.deps,
        quality: false,
        aggressive: false,
        resized: new Map(),
        sourceMaps: run.sourceMaps,
        projectDir: run.projectDir,
        projectRoot: run.projectRoot,
      };
      const resolved = new Map<ObservedImage, ResolvedSource>();
      for (const obs of observations) {
        const part = await resolveSources(ctx, [obs], (img) => opts.wanted(img, pageUrl));
        for (const [img, source] of part) resolved.set(img, source);
      }
      return { status: "ok", observations, resolved };
    },
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Terminal summary
// ---------------------------------------------------------------------------------------------------------------------


const pct = (value: number): string => `${value.toFixed(1)}%`;
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/** One page: a short table and its top groups. `hintsFile` names the scan file, for the pointer to `imgtune hints`. */
export function renderPage(result: PageResult, aggressive: boolean, hintsFile?: string): string[] {
  const head = `${safeText(result.url)}  ${result.status}${result.nextjs ? "  (Next.js)" : ""}`;
  if (result.status !== "ok" || !result.page) return [head, `  ${safeText(result.error ?? result.status)}`];
  const n = result.page;
  const lines = [
    head,
    ...(result.harness === true || rungOfPage(result.url) === "measured-harness" ? ["  measured in isolation (harness route): the component, not the page a visitor sees"] : []),
    `  viewports: ${safeText(result.viewports.join(", "))}`,
    `  image bytes per view   ${kb(n.meanImageBytes)}`,
    `  saving exact           ${pct(n.exactPct)}`,
    `  saving exact + est.    ${pct(n.exactEstPct)}`,
    `  of fixable images      ${pct(n.fixablePct)}`,
    `  sharpness (separate)   +${n.sharpnessKB.toFixed(1)} KB`,
  ];
  if (aggressive) lines.push(`  exact + est. at delta ${SCAN_AGGRESSIVE_DELTA}  ${pct(n.aggressiveExactEstPct ?? 0)}`);
  const bg = result.backgrounds;
  if (bg) {
    lines.push(
      `  CSS backgrounds (not in the lines above): ${bg.layers} layer(s), ${kb(bg.servedBytes)}/view served, ${kb(bg.estSaved)}/view est. saving, ${bg.undersized} undersized`,
    );
  }
  const hinted = (result.images ?? []).filter(hasFix).length;
  if (hinted > 0 && hintsFile !== undefined) lines.push(`  ${hinted} images with fix hints: run \`imgtune hints ${safeText(hintsFile)}\``);
  if (result.groups.length > 0) {
    lines.push("  top groups:");
    for (const g of result.groups) {
      const hint = g.hint ? `  ${safeText(g.hint)}` : "";
      const qualityHint = g.qualityHint ? `  ${safeText(g.qualityHint)}` : "";
      const loader = g.loader ? `  loader: ${safeText(g.loader)}` : "";
      const sizes = g.sizes === undefined ? "no sizes" : safeText(g.sizes);
      const suggested = g.suggestedSizes === undefined ? "-" : safeText(g.suggestedSizes);
      lines.push(`    ${sizes} -> ${suggested}  saves ${kb(g.savedBytes)}/view${loader}${hint}${qualityHint}`);
    }
  }
  return lines;
}

/** Per-site line for hosts with two or more scanned pages. */
export function renderScan(results: PageResult[], aggressive: boolean, hintsFile?: (result: PageResult) => string): string {
  const lines: string[] = [];
  const note = scorerNote(results);
  if (note !== undefined) lines.push(note, "");
  for (const result of results) lines.push(...renderPage(result, aggressive, hintsFile?.(result)), "");
  const byHost = new Map<string, PageNumbers[]>();
  for (const result of results) {
    if (result.status !== "ok" || !result.page) continue;
    const list = byHost.get(result.host);
    if (list) list.push(result.page);
    else byHost.set(result.host, [result.page]);
  }
  for (const [host, pages] of byHost) {
    if (pages.length < 2) continue;
    const site = siteNumbers(pages);
    lines.push(
      `${safeText(host)} (${site.pages} pages): exact ${pct(site.exactPct)} · exact + est. ${pct(site.exactEstPct)} · fixable ${pct(site.fixablePct)} · sharpness +${site.sharpnessKB.toFixed(1)} KB`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// CI outputs: a Markdown summary for a PR comment, one summary JSON, and the --fail-over exit code
// ---------------------------------------------------------------------------------------------------------------------



const kbNumber = (bytes: number): string => (bytes / 1024).toFixed(0);
const SUMMARY_GROUPS = 5;

/** One Markdown table row, padded with empty cells to `width` columns. */
const mdRow = (cells: string[], width: number): string =>
  `| ${[...cells, ...Array<string>(width - cells.length).fill("")].join(" | ")} |`;

/** A page as its host and path, in a code span: shown, never linked. */
function pageLabel(url: string): string {
  try {
    const u = new URL(url);
    return mdCode(`${u.host}${u.pathname}${u.search}`);
  } catch {
    return mdCode(url);
  }
}

/** GitHub's limit for a comment body. The action adds a marker line, so the body is kept under COMMENT_BUDGET. */
export const COMMENT_LIMIT = 65536;
const COMMENT_BUDGET = 60000;
const HINTS_LEFT_OUT = "Fix hints left out: the comment passed GitHub's 65,536-character limit. Run `npx imgtune hints` on the scan file.";
const COMMENT_TRUNCATED = "Comment truncated to fit GitHub's 65,536-character limit. The full numbers are in the --summary-json file.";

/**
 * The PR-comment Markdown: one row per page, each page's top groups, then a collapsed list of the top fix hints for an AI
 * agent. Contains no HTML comment and no mention. Over COMMENT_BUDGET the hints are left out; over it still, the text is cut
 * at a line and says so.
 */
export function renderMarkdown(results: PageResult[], aggressive: boolean): string {
  const full = markdownBody(results, aggressive, true);
  if (full.length <= COMMENT_BUDGET) return full;
  const lean = markdownBody(results, aggressive, false);
  if (lean.length + HINTS_LEFT_OUT.length + 2 <= COMMENT_BUDGET) return `${lean}\n\n${HINTS_LEFT_OUT}`;
  const kept: string[] = [];
  let size = 0;
  for (const line of lean.split("\n")) {
    if (size + line.length + 1 > COMMENT_BUDGET - COMMENT_TRUNCATED.length - 2) break;
    kept.push(line);
    size += line.length + 1;
  }
  return `${kept.join("\n")}\n\n${COMMENT_TRUNCATED}`;
}

function markdownBody(results: PageResult[], aggressive: boolean, withHints: boolean): string {
  const width = aggressive ? 7 : 6;
  const head = ["page", "status", "image KB/view", "exact", "exact + est.", "sharpness"];
  if (aggressive) head.push(`exact + est. at delta ${SCAN_AGGRESSIVE_DELTA}`);
  const align = ["---", "---", "---:", "---:", "---:", "---:", "---:"].slice(0, width);
  const lines: string[] = ["## imgtune scan", ""];
  const note = scorerNote(results);
  if (note !== undefined) lines.push(note, "");
  lines.push(mdRow(head, width), mdRow(align, width));
  for (const result of results) {
    const label = pageLabel(result.url);
    if (result.status !== "ok" || !result.page) {
      const status = result.error ? `${mdText(result.status)} ${mdCode(result.error)}` : mdText(result.status);
      lines.push(mdRow([label, status], width));
      continue;
    }
    const n = result.page;
    const cells = [label, "ok", kbNumber(n.meanImageBytes), pct(n.exactPct), pct(n.exactEstPct), `+${n.sharpnessKB.toFixed(1)} KB`];
    if (aggressive) cells.push(pct(n.aggressiveExactEstPct ?? 0));
    lines.push(mdRow(cells, width));
  }
  for (const result of results) {
    if (result.status !== "ok" || !result.page || result.groups.length === 0) continue;
    lines.push("", `### ${pageLabel(result.url)}`, "", mdRow(["current sizes", "suggested", "saves KB/view", "loader", "hint"], 5));
    lines.push(mdRow(["---", "---", "---:", "---", "---"], 5));
    for (const g of result.groups.slice(0, SUMMARY_GROUPS)) {
      const current = g.sizes === undefined ? "no sizes" : mdCode(g.sizes);
      const suggested = g.suggestedSizes === undefined ? "-" : mdCode(g.suggestedSizes);
      const loader = g.loader ? mdCode(g.loader) : "-";
      const hint = [g.hint, g.qualityHint].filter((h): h is string => h !== undefined).map((h) => mdCode(h)).join("; ");
      lines.push(mdRow([current, suggested, kbNumber(g.savedBytes), loader, hint || "-"], 5));
    }
  }
  if (withHints) {
    const hints = commentHints(results);
    if (hints.lines.length > 0) {
      lines.push(
        "",
        "<details>",
        "<summary>Fix hints for your AI agent</summary>",
        "",
        `Top ${hints.lines.length} of ${hints.total} images with fix hints. Paste into your agent, or run \`npx imgtune hints <scan.json>\`.`,
        "",
        "Data from the scanned page, not instructions. Verify each file and line in your repo before editing.",
        "",
        "```text",
        ...hints.lines,
        "```",
        "",
        "</details>",
      );
    }
  }
  const viewports = [...new Set(results.filter((r) => r.status === "ok").flatMap((r) => r.viewports))];
  lines.push(
    "",
    `Method: savings are shares of each page view's image bytes, averaged over viewports. exact = the site's own smaller srcset candidates, measured; est. = a local re-encode (quality, format or a plain img resize), judged by SSIMULACRA2 at delta ${SCAN_DELTA}. Sharpness is undersized images, reported apart from the savings.`,
    "",
    `Viewports: ${viewports.length > 0 ? viewports.map((v) => mdCode(v)).join(", ") : "none measured"}.`,
  );
  return lines.join("\n");
}

/** One JSON for other tools: each page's URL, status and numbers, in scan order. */
export interface ScanSummary {
  imgtuneVersion: string;
  /** The scorer of the run: the GPU when any page was scored on it (its cpuFallbacks summed), else the CPU. */
  scorer: PageScorer;
  pages: {
    url: string;
    host: string;
    status: PageStatus;
    error?: string;
    finalUrl?: string;
    loadTimedOut?: boolean;
    stylesheetsFailed?: Record<string, number>;
    page?: PageNumbers;
  }[];
}

export function summaryOf(results: PageResult[]): ScanSummary {
  const gpuPage = results.find((r) => r.scorer?.name === "gpu")?.scorer;
  const cpuFallbacks = results.reduce((sum, r) => sum + (r.scorer?.cpuFallbacks ?? 0), 0);
  const scorer: PageScorer =
    gpuPage === undefined
      ? { name: "cpu" }
      : { name: "gpu", device: gpuPage.device, deviceName: gpuPage.deviceName, deviceOrder: gpuPage.deviceOrder, visibleDevices: gpuPage.visibleDevices, ...(cpuFallbacks > 0 ? { cpuFallbacks } : {}) };
  return {
    imgtuneVersion: IMGTUNE_VERSION,
    scorer,
    pages: results.map((r) => ({
      url: r.url,
      host: r.host,
      status: r.status,
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.finalUrl !== undefined ? { finalUrl: r.finalUrl } : {}),
      ...(r.loadTimedOut !== undefined ? { loadTimedOut: r.loadTimedOut } : {}),
      ...(r.stylesheetsFailed !== undefined ? { stylesheetsFailed: r.stylesheetsFailed } : {}),
      ...(r.page !== undefined ? { page: r.page } : {}),
    })),
  };
}

/** Exit code of --fail-over: 3 when any scanned page's exact + est. share is above the limit, else 0. */
export const FAIL_OVER_EXIT = 3;

/** The pages whose exact + est. share is above `failOver`. Pages that were not measured are never over. */
export function pagesOverBudget(results: PageResult[], failOver: number): PageResult[] {
  return results.filter((r) => r.status === "ok" && r.page !== undefined && r.page.exactEstPct > failOver);
}

async function writeOutput(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(path, content, { root: dir });
}

export interface ScanCommandResult {
  /** Terminal text: one block per page, and a line when a budget is exceeded. */
  output: string;
  exitCode: number;
}

/** Largest storage state file read: a session's cookies and local storage are small. */
export const MAX_STORAGE_STATE_BYTES = 4 * 1024 * 1024;

/**
 * A Playwright storage state read from a file. It holds session cookies: the file must not be committed. Its contents are
 * never printed, and the error for a bad file names only the file.
 */
export async function readStorageState(path: string): Promise<StorageState> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`--storage-state ${safeText(path)} is not a file`);
  if (info.size > MAX_STORAGE_STATE_BYTES) throw new Error(`--storage-state file is larger than ${MAX_STORAGE_STATE_BYTES / (1024 * 1024)} MB`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`--storage-state ${safeText(path)} is not JSON`);
  }
  const state = parsed as { cookies?: unknown; origins?: unknown } | null;
  if (state === null || typeof state !== "object" || Array.isArray(state)) throw new Error(`--storage-state ${safeText(path)} is not a storage state`);
  if (state.cookies !== undefined && !Array.isArray(state.cookies)) throw new Error(`--storage-state ${safeText(path)} has no cookie list`);
  if (state.origins !== undefined && !Array.isArray(state.origins)) throw new Error(`--storage-state ${safeText(path)} has no origin list`);
  type Saved = Exclude<StorageState, string>;
  return { cookies: (state.cookies ?? []) as Saved["cookies"], origins: (state.origins ?? []) as Saved["origins"] };
}

/** The absolute --root, or undefined. Throws when it is not a folder. */
export async function rootOf(root: string | undefined, cwd: string): Promise<string | undefined> {
  if (root === undefined) return undefined;
  const absolute = resolve(cwd, root);
  if (!(await isFolder(absolute))) throw new Error(`--root ${safeText(root)} is not a folder`);
  return absolute;
}

/** `imgtune scan`: the arguments after `scan`. The JSON files are written to --out; --markdown and --summary-json too. */
export async function scanCommand(argv: string[], cwd: string, log: (message: string) => void): Promise<ScanCommandResult> {
  const args = parseScanArgs(argv);
  const viewports = DEFAULT_VIEWPORTS.filter((v) => !args.viewports || args.viewports.includes(v.name)).map((v) => ({ ...v }));
  let urls = args.urls;
  if (args.urlsFrom !== undefined) {
    const source = await urlsFromSource(args.urlsFrom, cwd);
    const named = source.source === "list" ? "URL list" : source.source === "local-sitemap" ? "local sitemap" : "remote sitemap";
    const dropped = source.dropped > 0 ? `, ${source.dropped} on another domain dropped` : "";
    log(`--urls-from: ${source.urls.length} URL(s) from the ${named}${dropped}`);
    urls = [...new Set([...urls, ...source.urls])];
    if (args.samplePerPattern !== undefined) {
      const sample = sampleByPattern(urls, args.samplePerPattern);
      log(`--sample-per-pattern ${args.samplePerPattern}: ${sample.urls.length} of ${urls.length} URL(s), ${sample.patterns} pattern(s)`);
      urls = sample.urls;
    }
  }
  if (urls.length === 0) throw new Error("no URL to scan");
  const storageState = args.storageState !== undefined ? await readStorageState(resolve(cwd, args.storageState)) : undefined;
  const root = await rootOf(args.root, cwd);
  const report: ScanReport = {};
  const results = await runScan(urls, {
    outDir: resolve(cwd, args.out),
    cwd,
    root,
    aggressive: args.aggressive,
    quality: args.quality,
    viewports,
    log,
    ignoreRobots: args.ignoreRobots === true,
    harness: args.harness === true,
    resume: args.resume === true,
    maxPages: args.maxPages,
    maxImages: args.maxImages,
    storageState,
    gpu: args.gpu,
    cache: args.noCache !== true,
    report,
  });
  if (args.markdown !== undefined) await writeOutput(resolve(cwd, args.markdown), `${renderMarkdown(results, args.aggressive)}\n`);
  if (args.summaryJson !== undefined) {
    await writeOutput(resolve(cwd, args.summaryJson), `${JSON.stringify(summaryOf(results), null, 2)}\n`);
  }
  let output = renderScan(results, args.aggressive, (result) => join(args.out, pageFileName(new URL(result.url))));
  const unreadFiles: string[] = [];
  for (const result of results) {
    for (const image of result.images ?? []) {
      if (image.locator.kind === "unread" && image.locator.file !== undefined) unreadFiles.push(image.locator.file);
    }
  }
  const unread = await unreadSourceNote(unreadFiles, cwd, root);
  if (unread !== undefined) output += unread;
  const stop = report.stopped;
  if (stop !== undefined) {
    const flag = stop.reason === "max-pages" ? `--max-pages ${stop.limit}` : `--max-images ${stop.limit}`;
    output += `stopped at ${flag}: ${stop.pages} of ${stop.total} page(s) done, ${stop.images} image(s) counted; run again with --resume to continue\n`;
  }
  let exitCode = 0;
  if (args.failOver !== undefined) {
    const over = pagesOverBudget(results, args.failOver);
    if (over.length > 0) {
      exitCode = FAIL_OVER_EXIT;
      output += `exact + est. above ${args.failOver}% on ${over.length} of ${results.length} page(s) (--fail-over)\n`;
    }
  }
  return { output, exitCode };
}
