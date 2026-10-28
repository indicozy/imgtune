/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Response as BrowserResponse } from "playwright";
import sharp, { type Sharp } from "sharp";
import { writeFileAtomic, sha1 } from "./atomic.js";
import { originalUrlFor } from "./analyse.js";
import { calibrationOffset } from "./calibrate.js";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { encode } from "./encode.js";
import { loadSettled, settleWithin, BODY_READ_TIMEOUT_MS } from "./measure.js";
import { assertMetricAvailable, makeScorer, type Scorer } from "./metric.js";
import { minPassingQuality } from "./search.js";
import { deriveSizes, type SizePoint } from "./sizes.js";
import type { RawImage } from "./ssim.js";
import type { Viewport } from "./types.js";

/** Thresholds of the report and the local search. */
const MIN_RENDERED_PX = 16;
/** A plain <img> wider than this multiple of what it needs is an estimated resize. */
const PLAIN_RESIZE_RATIO = 1.1;
/** At most this many images per group are scored for quality, at the reference viewport. */
const SAMPLES_PER_GROUP = 8;
const TOP_GROUPS = 10;

/** Default output directory, relative to the working directory. */
export const DEFAULT_OUT = ".imgtune/scan";
/** A srcset candidate that is this far below the need (and below the largest) is an undersized file. */
const UNDERSIZED_RATIO = 0.9;
const CHALLENGE_STATUS: readonly number[] = [403, 429, 503];
const CHALLENGE_MARKERS: readonly string[] = ["cf-chl", "captcha"];
/** Quality assumed for an image whose URL does not say (next/image's default, and the audit's). */
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
  const url = new URL(target);
  const path = url.pathname + url.search;
  let best: RobotsRule | undefined;
  for (const rule of starRules(robotsTxt)) {
    if (!ruleMatches(rule.pattern, path)) continue;
    if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolution: srcset candidates and the right one
// ---------------------------------------------------------------------------------------------------------------------

export interface Candidate {
  url: string;
  width: number;
}

/** The w-descriptor candidates of a srcset attribute, with absolute URLs. x-descriptors are not candidates here. */
export function parseSrcset(srcset: string, base: string): Candidate[] {
  const out: Candidate[] = [];
  for (const part of srcset.split(/,\s+/)) {
    const [urlText, descriptor] = part.trim().split(/\s+/);
    const match = descriptor ? /^(\d+)w$/.exec(descriptor) : null;
    if (!urlText || !match) continue;
    const width = Number(match[1]);
    if (width <= 0 || width > MAX_WIDTH) continue;
    try {
      out.push({ url: new URL(urlText, base).toString(), width });
    } catch {
      // An unparsable candidate is not one the page advertises, so it is left out.
    }
  }
  return out;
}

/** Device pixels the image needs: rendered CSS width x dpr, capped at the largest candidate. */
export function neededWidth(renderedWidth: number, dpr: number, largest: number): number {
  return Math.min(Math.ceil(renderedWidth * dpr), largest);
}

/** The smallest candidate at or above `needed`; the largest when none reaches it. Candidates must not be empty. */
export function rightCandidate(candidates: Candidate[], needed: number): Candidate {
  const sorted = [...candidates].sort((a, b) => a.width - b.width);
  return sorted.find((c) => c.width >= needed) ?? sorted[sorted.length - 1];
}

/** The served file is undersized: its pixels are below 0.9 x need, and a larger candidate exists. */
export function isUndersized(servedWidth: number, needed: number, largest: number): boolean {
  return servedWidth < UNDERSIZED_RATIO * needed && servedWidth < largest;
}

// ---------------------------------------------------------------------------------------------------------------------
// References and the current quality of a URL
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The original an optimised image URL was made from: `/_next/image?url=X` gives X (resolved against the page), a
 * Cloudflare `/cdn-cgi/image/<opts>/<path>` gives `<path>` (R19). Any other URL has no known original.
 */
export function referenceUrl(src: string, pageUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(src, pageUrl);
  } catch {
    return undefined;
  }
  if (url.pathname === "/_next/image") {
    const inner = url.searchParams.get("url");
    if (!inner) return undefined;
    try {
      return new URL(inner, pageUrl).toString();
    } catch {
      return undefined;
    }
  }
  if (/\/cdn-cgi\/image\/[^/]+\/.+/.test(url.pathname)) return originalUrlFor(url.toString(), pageUrl);
  return undefined;
}

/** The quality the URL asks for (`q=` of /_next/image, `quality=` of cdn-cgi options), else ASSUMED_QUALITY. */
export function currentQuality(src: string): { quality: number; assumed: boolean } {
  let url: URL;
  try {
    url = new URL(src, "http://localhost");
  } catch {
    return { quality: ASSUMED_QUALITY, assumed: true };
  }
  const fromNext = url.pathname === "/_next/image" ? url.searchParams.get("q") : null;
  if (fromNext && /^\d+$/.test(fromNext)) return { quality: Number(fromNext), assumed: false };
  const options = /\/cdn-cgi\/image\/([^/]+)\//.exec(url.pathname);
  const fromCdn = options ? /(?:^|,)quality=(\d+)/.exec(options[1]) : null;
  if (fromCdn) return { quality: Number(fromCdn[1]), assumed: false };
  return { quality: ASSUMED_QUALITY, assumed: true };
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
  out: string;
  aggressive: boolean;
  quality: boolean;
  /** Viewport names; undefined means all of them. */
  viewports?: string[];
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

function parseViewports(text: string): string[] {
  const names = text.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const known = DEFAULT_VIEWPORTS.map((viewport) => viewport.name);
  if (names.length === 0) throw new Error("--viewports needs at least one name");
  for (const name of names) {
    if (!known.includes(name)) throw new Error(`Unknown viewport ${name} (expected ${known.join(", ")})`);
  }
  return names;
}

/** The arguments after `scan`: one or more page URLs and the options. Throws with a message the CLI prints. */
export function parseScanArgs(argv: string[]): ScanArgs {
  const args: ScanArgs = { urls: [], out: DEFAULT_OUT, aggressive: false, quality: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--aggressive") args.aggressive = true;
    else if (arg === "--no-quality") args.quality = false;
    else if (arg === "--out" || arg === "--viewports") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      if (arg === "--out") args.out = value;
      else args.viewports = parseViewports(value);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      args.urls.push(parseUrl(arg));
    }
  }
  if (args.urls.length === 0) throw new Error("scan needs at least one URL");
  return args;
}

// ---------------------------------------------------------------------------------------------------------------------
// Extra fetches: one memo per scan, at most two in flight, 30 s each, capped bodies, checked destinations
// ---------------------------------------------------------------------------------------------------------------------

const EXTRA_FETCH_TIMEOUT_MS = 30_000;
const EXTRA_FETCH_CONCURRENCY = 2;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** Largest width the tool decodes or encodes at, and the most input pixels sharp accepts for a downloaded file. */
export const MAX_WIDTH = 8192;
export const MAX_INPUT_PIXELS = 100_000_000;

/** A width clamped to 1..MAX_WIDTH. */
export function clampWidth(width: number): number {
  return Math.max(1, Math.min(MAX_WIDTH, Math.floor(width)));
}

/** sharp over a downloaded file, refusing inputs above `limit` pixels. */
export function openImage(buffer: Buffer, limit = MAX_INPUT_PIXELS): Sharp {
  return sharp(buffer, { limitInputPixels: limit });
}

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** Loopback, private, link-local and unspecified addresses (IPv4, IPv6, and IPv4-mapped IPv6). */
export function isBlockedAddress(address: string): boolean {
  const a = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isBlockedAddress(mapped[1]);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  // fc00::/7 (unique local), fe80::/10 (link-local), ::1 and :: (loopback, unspecified).
  return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

export interface FetchOptions {
  /** Largest body accepted; a larger one (declared or streamed) is refused. */
  maxBytes?: number;
  /** Whether destinations on loopback or private addresses are allowed (only when the scanned page is on one). */
  allowPrivate?: boolean;
}

export interface Fetcher {
  /**
   * The body, or undefined when the URL is not http(s), resolves to a blocked address (unless allowed), fails, answers
   * non-2xx, redirects more than MAX_REDIRECTS times, or is larger than its limit. Each (URL, options) is fetched once.
   */
  get(url: string, opts?: FetchOptions): Promise<Buffer | undefined>;
  /** Whether the host of `url` resolves to a blocked address: a page that does is allowed private destinations. */
  isPrivateHost(url: string): Promise<boolean>;
}

async function addressesOf(hostname: string, lookup: Lookup): Promise<string[]> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return [bare];
  return (await lookup(bare)).map((r) => r.address);
}

/** The body up to `maxBytes`; undefined when it is larger (checked on Content-Length and while streaming). */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export function makeFetcher(opts: { userAgent: string; fetchImpl?: typeof fetch; lookup?: Lookup }): Fetcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup: Lookup = opts.lookup ?? ((hostname) => dnsLookup(hostname, { all: true }));
  const memo = new Map<string, Promise<Buffer | undefined>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  // A finishing fetch hands its slot to the next waiter, so no more than the limit run at once.
  const withSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running < EXTRA_FETCH_CONCURRENCY) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };

  /** Each hop is checked before it is requested; redirects are followed here, not by fetch. */
  const fetchChecked = async (start: string, maxBytes: number, allowPrivate: boolean): Promise<Buffer | undefined> => {
    let current = start;
    for (let hop = 0; ; hop++) {
      const url = new URL(current);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      if (!allowPrivate) {
        const addresses = await addressesOf(url.hostname, lookup);
        if (addresses.length === 0 || addresses.some(isBlockedAddress)) return undefined;
      }
      const res = await fetchImpl(url.toString(), {
        headers: { "User-Agent": opts.userAgent },
        redirect: "manual",
        signal: AbortSignal.timeout(EXTRA_FETCH_TIMEOUT_MS),
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) return undefined;
        current = new URL(location, url).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return undefined;
      }
      return readCapped(res, maxBytes);
    }
  };

  return {
    get(url, fetchOpts = {}) {
      const maxBytes = fetchOpts.maxBytes ?? MAX_IMAGE_BYTES;
      const allowPrivate = fetchOpts.allowPrivate ?? false;
      const key = `${maxBytes}|${allowPrivate}|${url}`;
      let pending = memo.get(key);
      if (!pending) {
        pending = withSlot(() => fetchChecked(url, maxBytes, allowPrivate)).catch(() => undefined);
        memo.set(key, pending);
      }
      return pending;
    },
    async isPrivateHost(url) {
      try {
        const addresses = await addressesOf(new URL(url).hostname, lookup);
        return addresses.some(isBlockedAddress);
      } catch {
        return false;
      }
    },
  };
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

/** The pixel size and format of an image file, as displayed (EXIF orientation applied). Undefined when sharp cannot read it. */
export async function pixelSize(buffer: Buffer): Promise<PixelSize | undefined> {
  try {
    const meta = await openImage(buffer).metadata();
    if (!meta.width || !meta.height) return undefined;
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? meta.height : meta.width;
    const height = turned ? meta.width : meta.height;
    return { width, height, format: meta.format };
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

/** The relative rule's floor and tolerance for SSIMULACRA2 (the relaxed preset the audit uses). */
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

/**
 * Estimates the quality and format savings of one right file at its width. For AVIF and WebP the local `cdn` encoder is
 * calibrated to the file's bytes (calibrationOffset); the bar is the local encode's score at the current quality minus
 * delta (never under SCAN_THRESHOLD); the lowest passing quality gives the projected bytes by local ratio. For JPEG and
 * PNG (no local encoder) the bar is the file's own score minus delta, and the estimate is the AVIF that meets it.
 */
export async function estimateQuality(input: QualityInput, deltas: number[], deps: QualityDeps): Promise<QualityEstimate | undefined> {
  const enc = deps.encode ?? encode;
  const score = deps.score;
  const reference = await referenceAt(input.original, input.width);
  const ratio: Record<number, number> = {};

  if (input.format === "avif" || input.format === "webp") {
    const format = input.format;
    const fit = await calibrationOffset(
      [{ ref: reference, format, cdnQuality: input.current, cdnBytes: input.bytes }],
      { encode: enc },
    );
    if (!fit) return undefined;
    const offset = fit.offset;
    const localCurrent = clampQuality(input.current - offset);
    const currentOut = await enc(reference, format, localCurrent, "cdn");
    const currentScore = await score(reference, currentOut.decoded);
    let target: number | undefined;
    for (const delta of deltas) {
      const bar = Math.max(SCAN_THRESHOLD, currentScore - delta);
      const best = await minPassingQuality(reference, format, localCurrent, "cdn", bar, SCAN_TOLERANCE, { encode: enc, score });
      const bestBytes = (await enc(reference, format, best, "cdn")).bytes;
      ratio[delta] = currentOut.bytes > 0 ? Math.min(1, bestBytes / currentOut.bytes) : 1;
      if (delta === deltas[0]) target = Math.min(input.current, clampQuality(best + offset));
    }
    return { ratio, target };
  }

  if (input.format === "jpeg" || input.format === "png") {
    const servedRaw = await decodeRaw(input.served, { width: reference.width, height: reference.height });
    const ownScore = await score(reference, servedRaw);
    for (const delta of deltas) {
      const bar = Math.max(SCAN_THRESHOLD, ownScore - delta);
      const best = await minPassingQuality(reference, "avif", FORMAT_START_QUALITY, "cdn", bar, SCAN_TOLERANCE, { encode: enc, score });
      const avifBytes = (await enc(reference, "avif", best, "cdn")).bytes;
      ratio[delta] = input.bytes > 0 ? Math.min(1, avifBytes / input.bytes) : 1;
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
}

export interface ResponseRecord {
  url: string;
  contentType?: string;
  /** Response body length: the bytes the browser transferred. */
  bytes: number;
  buffer?: Buffer;
  pixels?: PixelSize;
}

export interface ViewportObservation {
  viewport: Viewport;
  status?: number;
  blocked: boolean;
  nextjs: boolean;
  images: ObservedImage[];
  /** Every image response of the page view, by URL. */
  responses: Map<string, ResponseRecord>;
}

async function observeViewport(browser: Browser, pageUrl: string, viewport: Viewport): Promise<ViewportObservation> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    userAgent: viewport.userAgent,
  });
  try {
    const responses = new Map<string, ResponseRecord>();
    const bodyReads: Promise<void>[] = [];
    context.on("response", (response) => {
      const contentType = response.headers()["content-type"];
      const isImage = response.request().resourceType() === "image" || (contentType ?? "").toLowerCase().startsWith("image/");
      if (!isImage) return;
      const record: ResponseRecord = { url: response.url(), contentType, bytes: 0 };
      responses.set(response.url(), record);
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
    const docResponse: BrowserResponse | null = await loadSettled(page, pageUrl, "img");
    const seen = await page.evaluate(() => {
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
        };
      });
      return { nextjs, images };
    });
    const html = seen.images.length === 0 ? await page.content() : "";
    const status = docResponse?.status();
    await settleWithin(bodyReads, BODY_READ_TIMEOUT_MS);
    for (const record of responses.values()) {
      if (record.buffer) record.pixels = await pixelSize(record.buffer);
    }
    return {
      viewport,
      status,
      blocked: isChallenge(status, seen.images.length, html),
      nextjs: seen.nextjs,
      images: seen.images,
      responses,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Analysis of one page
// ---------------------------------------------------------------------------------------------------------------------

/** One image element at one viewport, with what it saves. */
interface Instance {
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
  /** The right candidate (srcset) and its file, kept for the quality step. */
  right?: { url: string; bytes: number; width: number; height: number; format: string; buffer: Buffer };
  exact: number;
  est: number;
  estAggressive: number;
  growth: number;
  group: string;
  /** Quality ratio per delta (projected / served bytes): the image's own, or its group's median. */
  qualityRatio?: Record<number, number>;
  qualityInfo?: { current: number; qualityAssumed: boolean; target?: number; format?: string; sampled: boolean };
}

interface AnalysisContext {
  pageUrl: string;
  fetcher: Fetcher;
  /** The page is on a loopback or private host, so its candidates and originals may be too. */
  allowPrivate: boolean;
  deps: QualityDeps;
  quality: boolean;
  aggressive: boolean;
  resized: Map<string, Promise<{ bytes: number; buffer: Buffer } | undefined>>;
}

const formatName = (format: string | undefined): string | undefined => (format === "jpg" ? "jpeg" : format);

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
      rightBuffer = obs.responses.get(right.url)?.buffer ?? (await ctx.fetcher.get(right.url, { allowPrivate: ctx.allowPrivate }));
    }
    if (rightBuffer) {
      const rightPixels = right.url === img.currentSrc ? served : await pixelSize(rightBuffer);
      const rightBytes = rightBuffer.length;
      if (right.url !== img.currentSrc) instance.exact = Math.max(0, response.bytes - rightBytes);
      if (isUndersized(served.width, need, largest)) instance.growth = Math.max(0, rightBytes - response.bytes);
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
      pending = resizedEstimate(response.buffer, served.format, needed).catch(() => undefined);
      ctx.resized.set(key, pending);
    }
    const resized = await pending;
    if (resized) instance.est = instance.estAggressive = Math.max(0, response.bytes - resized.bytes);
  }
  return instance;
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
async function estimateQualities(ctx: AnalysisContext, instances: Instance[], refName: string): Promise<void> {
  const groups = new Map<string, Instance[]>();
  for (const inst of instances) {
    if (inst.kind !== "srcset" || !inst.right) continue;
    const list = groups.get(inst.group);
    if (list) list.push(inst);
    else groups.set(inst.group, [inst]);
  }
  for (const members of groups.values()) {
    const ratios2: number[] = [];
    const ratios4: number[] = [];
    let attempts = 0;
    for (const member of members.filter((m) => m.viewport.name === refName)) {
      if (attempts >= SAMPLES_PER_GROUP) break;
      const original = referenceUrl(member.url, ctx.pageUrl);
      if (!original) continue;
      attempts++;
      const buffer = await ctx.fetcher.get(original, { allowPrivate: ctx.allowPrivate });
      if (!buffer || !member.right) continue;
      const current = currentQuality(member.url);
      const deltas = ctx.aggressive ? [SCAN_DELTA, SCAN_AGGRESSIVE_DELTA] : [SCAN_DELTA];
      const estimate = await estimateQuality(
        {
          original: buffer,
          served: member.right.buffer,
          format: member.right.format,
          bytes: member.right.bytes,
          width: member.right.width,
          height: member.right.height,
          current: current.quality,
        },
        deltas,
        ctx.deps,
      ).catch(() => undefined);
      if (!estimate) continue;
      member.qualityRatio = { ...estimate.ratio };
      member.qualityInfo = { current: current.quality, qualityAssumed: current.assumed, target: estimate.target, format: estimate.format, sampled: true };
      ratios2.push(estimate.ratio[SCAN_DELTA]);
      if (ctx.aggressive) ratios4.push(estimate.ratio[SCAN_AGGRESSIVE_DELTA]);
    }
    const group2 = median(ratios2);
    const group4 = median(ratios4);
    if (group2 === undefined) continue;
    for (const member of members) {
      if (member.qualityRatio || !referenceUrl(member.url, ctx.pageUrl)) continue;
      const current = currentQuality(member.url);
      member.qualityRatio = ctx.aggressive && group4 !== undefined ? { [SCAN_DELTA]: group2, [SCAN_AGGRESSIVE_DELTA]: group4 } : { [SCAN_DELTA]: group2 };
      member.qualityInfo = { current: current.quality, qualityAssumed: current.assumed, sampled: false };
    }
  }
}

/** Turns the quality ratios into savings on top of the right file (est.). */
function applyQuality(inst: Instance): void {
  if (!inst.right || !inst.qualityRatio) return;
  inst.est += Math.max(0, inst.right.bytes * (1 - inst.qualityRatio[SCAN_DELTA]));
  const r4 = inst.qualityRatio[SCAN_AGGRESSIVE_DELTA];
  if (r4 !== undefined) inst.estAggressive += Math.max(0, inst.right.bytes * (1 - r4));
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
  quality?: { current: number; qualityAssumed: boolean; target?: number; format?: string; sampled: boolean };
  qualityNA: boolean;
}

export interface ViewportReport {
  imageBytes: number;
  exactSaved: number;
  estSaved: number;
  estAggressiveSaved?: number;
  sharpnessGrowth: number;
  images: ImageReport[];
}

export interface GroupReport {
  key: string;
  sizes?: string;
  suggestedSizes?: string;
  estQuality?: number;
  /** Mean over the viewports the group is shown at: exact + est. bytes per page view. */
  savedBytes: number;
  members: number;
  samples: string[];
  hint?: string;
}

export type PageStatus = "ok" | "blocked" | "robots" | "failed";

export interface PageResult {
  url: string;
  host: string;
  scannedAt: string;
  imgtuneVersion: string;
  metric: "ssimulacra2";
  delta: number;
  aggressiveDelta?: number;
  viewports: string[];
  status: PageStatus;
  error?: string;
  nextjs: boolean;
  perViewport: Record<string, ViewportReport>;
  page?: PageNumbers;
  groups: GroupReport[];
  counts: { images: number; qualityNA: number; skipped: number };
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
  };
}

/** Groups by saving: the mean over viewports of the group's exact + est. bytes, with two sample URLs and a sizes hint. */
function groupReports(instances: Instance[]): GroupReport[] {
  const byKey = new Map<string, Instance[]>();
  for (const inst of instances) {
    if (inst.kind === "skipped") continue;
    const list = byKey.get(inst.group);
    if (list) list.push(inst);
    else byKey.set(inst.group, [inst]);
  }
  const reports: GroupReport[] = [];
  for (const [key, members] of byKey) {
    const perViewport = new Map<string, number>();
    for (const inst of members) {
      const name = inst.viewport.name;
      perViewport.set(name, (perViewport.get(name) ?? 0) + inst.exact + inst.est);
    }
    const savedBytes = mean([...perViewport.values()]);
    if (savedBytes <= 0) continue;
    const sizes = members[0].img.sizes;
    const points: SizePoint[] = members
      .filter((m) => m.renderedWidth >= 1)
      .map((m) => ({ viewportWidth: m.viewport.width, renderedWidth: m.renderedWidth, mobile: m.viewport.mobile }));
    const suggestedSizes = deriveSizes(points);
    const targets = members.flatMap((m) => (m.qualityInfo?.target !== undefined ? [m.qualityInfo.target] : []));
    const samples = [...new Set(members.map((m) => m.url))].slice(0, 2);
    reports.push({
      key,
      sizes,
      suggestedSizes,
      estQuality: median(targets),
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
async function analysePage(ctx: AnalysisContext, observations: ViewportObservation[], base: PageResult): Promise<PageResult> {
  const refName = referenceViewportName(observations.map((o) => o.viewport));
  const instances: Instance[] = [];
  for (const obs of observations) {
    for (const img of obs.images) instances.push(await baseline(ctx, obs, img));
  }
  const refWidth = new Map<number, number>();
  for (const inst of instances) {
    if (inst.viewport.name === refName && inst.renderedWidth >= 1) refWidth.set(inst.element, inst.renderedWidth);
  }
  for (const inst of instances) {
    inst.group = groupKey(inst.img.sizes, inst.img.classes, refWidth.get(inst.element));
  }
  if (ctx.quality) await estimateQualities(ctx, instances, refName);
  for (const inst of instances) applyQuality(inst);

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
    };
  }

  const elements = new Set(instances.map((i) => i.element));
  const skippedElements = new Set<number>();
  const naElements = new Set<number>();
  for (const e of elements) {
    const mine = instances.filter((i) => i.element === e);
    if (mine.every((i) => i.kind === "skipped")) skippedElements.add(e);
    if (mine.some((i) => i.kind !== "skipped" && i.qualityRatio === undefined)) naElements.add(e);
  }

  const numbers = pageNumbers(totals);
  const { aggressiveExactEstPct, ...withoutAggressive } = numbers;
  return {
    ...base,
    nextjs: observations.some((o) => o.nextjs),
    perViewport,
    page: ctx.aggressive ? { ...withoutAggressive, aggressiveExactEstPct } : withoutAggressive,
    groups: groupReports(instances),
    counts: { images: elements.size, qualityNA: naElements.size, skipped: skippedElements.size },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Run: pages in order, one JSON file each
// ---------------------------------------------------------------------------------------------------------------------

export interface ScanOptions {
  outDir: string;
  cwd: string;
  aggressive: boolean;
  quality: boolean;
  viewports: Viewport[];
  log: (message: string) => void;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
}

let cachedVersion: string | undefined;
function imgtuneVersion(): string {
  if (cachedVersion === undefined) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function scanPage(
  browser: Browser,
  run: { viewports: Viewport[]; aggressive: boolean; quality: boolean; fetcher: Fetcher; deps: QualityDeps },
  pageUrl: string,
  robotsFor: (origin: string, allowPrivate: boolean) => Promise<string | undefined>,
): Promise<PageResult> {
  const url = new URL(pageUrl);
  const allowPrivate = await run.fetcher.isPrivateHost(pageUrl);
  const base: PageResult = {
    url: pageUrl,
    host: url.host,
    scannedAt: new Date().toISOString(),
    imgtuneVersion: imgtuneVersion(),
    metric: "ssimulacra2",
    delta: SCAN_DELTA,
    aggressiveDelta: run.aggressive ? SCAN_AGGRESSIVE_DELTA : undefined,
    viewports: run.viewports.map((v) => v.name),
    status: "ok",
    nextjs: false,
    perViewport: {},
    groups: [],
    counts: { images: 0, qualityNA: 0, skipped: 0 },
  };
  if (!robotsAllows(await robotsFor(url.origin, allowPrivate), pageUrl)) return { ...base, status: "robots" };

  // One pass per viewport; a challenge stops the page at once, with no retry.
  const observations: ViewportObservation[] = [];
  try {
    for (const viewport of run.viewports) {
      const obs = await observeViewport(browser, pageUrl, viewport);
      if (obs.blocked) {
        return { ...base, status: "blocked", error: `challenge at ${viewport.name}${obs.status ? ` (HTTP ${obs.status})` : ""}` };
      }
      observations.push(obs);
    }
  } catch (err) {
    return { ...base, status: "failed", error: messageOf(err) };
  }
  return analysePage(
    { pageUrl, fetcher: run.fetcher, allowPrivate, deps: run.deps, quality: run.quality, aggressive: run.aggressive, resized: new Map() },
    observations,
    base,
  );
}

/** Scans each page in order and writes its JSON to `outDir`. Nothing else is written, except the scorer's temp files. */
export async function runScan(urls: string[], opts: ScanOptions): Promise<PageResult[]> {
  if (opts.quality) await assertMetricAvailable("ssimulacra2");
  const browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
  try {
    // The fetches send the desktop viewport's user agent: the default one of a fresh context.
    const probe = await browser.newContext();
    const userAgent = await (await probe.newPage()).evaluate(() => navigator.userAgent);
    await probe.close();
    const fetcher = makeFetcher({ userAgent, fetchImpl: opts.fetchImpl, lookup: opts.lookup });
    const deps: QualityDeps = { score: makeScorer("ssimulacra2", { projectDir: opts.cwd }) };
    const run = { viewports: opts.viewports, aggressive: opts.aggressive, quality: opts.quality, fetcher, deps };

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

    await mkdir(opts.outDir, { recursive: true });
    const results: PageResult[] = [];
    for (const url of urls) {
      opts.log(`scanning ${url}`);
      const result = await scanPage(browser, run, url, robotsFor);
      await writeFileAtomic(join(opts.outDir, pageFileName(new URL(url))), `${JSON.stringify(result, null, 2)}\n`, {
        root: opts.outDir,
      });
      results.push(result);
    }
    return results;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Terminal summary
// ---------------------------------------------------------------------------------------------------------------------

const pct = (value: number): string => `${value.toFixed(1)}%`;
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/** One page: a short table, its top groups and, for Next.js, the pointer to audit. */
export function renderPage(result: PageResult, aggressive: boolean): string[] {
  const head = `${result.url}  ${result.status}${result.nextjs ? "  (Next.js)" : ""}`;
  if (result.status !== "ok" || !result.page) return [head, `  ${result.error ?? result.status}`];
  const n = result.page;
  const lines = [
    head,
    `  viewports: ${result.viewports.join(", ")}`,
    `  image bytes per view   ${kb(n.meanImageBytes)}`,
    `  saving exact           ${pct(n.exactPct)}`,
    `  saving exact + est.    ${pct(n.exactEstPct)}`,
    `  of fixable images      ${pct(n.fixablePct)}`,
    `  sharpness (separate)   +${n.sharpnessKB.toFixed(1)} KB`,
  ];
  if (aggressive) lines.push(`  exact + est. at delta ${SCAN_AGGRESSIVE_DELTA}  ${pct(n.aggressiveExactEstPct ?? 0)}`);
  if (result.groups.length > 0) {
    lines.push("  top groups:");
    for (const g of result.groups) {
      const hint = g.hint ? `  ${g.hint}` : "";
      lines.push(`    ${g.sizes ?? "no sizes"} -> ${g.suggestedSizes ?? "-"}  saves ${kb(g.savedBytes)}/view${hint}`);
    }
  }
  if (result.nextjs) lines.push('  Next.js detected: run "npx imgtune audit" in the project to fix these in code');
  return lines;
}

/** Per-site line for hosts with two or more scanned pages. */
export function renderScan(results: PageResult[], aggressive: boolean): string {
  const lines: string[] = [];
  for (const result of results) lines.push(...renderPage(result, aggressive), "");
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
      `${host} (${site.pages} pages): exact ${pct(site.exactPct)} · exact + est. ${pct(site.exactEstPct)} · fixable ${pct(site.fixablePct)} · sharpness +${site.sharpnessKB.toFixed(1)} KB`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** `imgtune scan`: the arguments after `scan`. Returns the terminal text; the JSON files are written to --out. */
export async function scanCommand(argv: string[], cwd: string, log: (message: string) => void): Promise<string> {
  const args = parseScanArgs(argv);
  const viewports = DEFAULT_VIEWPORTS.filter((v) => !args.viewports || args.viewports.includes(v.name)).map((v) => ({ ...v }));
  const results = await runScan(args.urls, {
    outDir: resolve(cwd, args.out),
    cwd,
    aggressive: args.aggressive,
    quality: args.quality,
    viewports,
    log,
  });
  return renderScan(results, args.aggressive);
}
