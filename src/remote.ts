import sharp, { type Sharp } from "sharp";
import { sha1 } from "./atomic.js";
import { originalUrlFor } from "./analyse.js";
import { calibrationOffset } from "./calibrate.js";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { encode } from "./encode.js";
import type { Scorer } from "./metric.js";
import { minPassingQuality } from "./search.js";
import type { RawImage } from "./ssim.js";

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
  pattern: RegExp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** A robots path pattern: `*` matches any run of characters, a trailing `$` anchors the end, the rest is a prefix. */
function patternRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
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
    if (!applies || value === "") continue;
    if (key === "allow" || key === "disallow") {
      rules.push({ allow: key === "allow", length: value.length, pattern: patternRegExp(value) });
    }
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
    if (!rule.pattern.test(path)) continue;
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
    try {
      out.push({ url: new URL(urlText, base).toString(), width: Number(match[1]) });
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
  aggressiveExactEstPct: number;
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
  const pick = (key: keyof PageNumbers) => mean(pages.map((p) => p[key]));
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
// Extra fetches: one memo per scan, at most two in flight, 30 s each
// ---------------------------------------------------------------------------------------------------------------------

const EXTRA_FETCH_TIMEOUT_MS = 30_000;
const EXTRA_FETCH_CONCURRENCY = 2;

export interface Fetcher {
  /** The body, or undefined when the URL fails or answers non-2xx. Each URL is fetched at most once. */
  get(url: string): Promise<Buffer | undefined>;
}

export function makeFetcher(opts: { userAgent: string; fetchImpl?: typeof fetch }): Fetcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
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
  return {
    get(url) {
      let pending = memo.get(url);
      if (!pending) {
        pending = withSlot(async () => {
          const res = await fetchImpl(url, {
            headers: { "User-Agent": opts.userAgent },
            signal: AbortSignal.timeout(EXTRA_FETCH_TIMEOUT_MS),
          });
          if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return undefined;
          }
          return Buffer.from(await res.arrayBuffer());
        }).catch(() => undefined);
        memo.set(url, pending);
      }
      return pending;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pixels and local encodes
// ---------------------------------------------------------------------------------------------------------------------

export interface PixelSize {
  width: number;
  height: number;
}

/** The pixel size of an image file, as displayed (EXIF orientation applied). Undefined when sharp cannot read it. */
export async function pixelSize(buffer: Buffer): Promise<PixelSize | undefined> {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return undefined;
    const turned = (meta.orientation ?? 1) >= 5;
    return turned ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
  } catch {
    return undefined;
  }
}

/** The file decoded to 8-bit RGBA; resized to `size` when given and different (the scorer needs equal dimensions). */
export async function decodeRaw(buffer: Buffer, size?: PixelSize): Promise<RawImage> {
  const { data, info } = await sharp(buffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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
async function referenceAt(original: Buffer, width: number): Promise<RawImage> {
  const { data, info } = await sharp(original)
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
  targetWidth: number,
): Promise<{ bytes: number; buffer: Buffer } | undefined> {
  if (format === "png") {
    const out = await sharp(buffer).rotate().resize({ width: targetWidth, withoutEnlargement: true }).png().toBuffer();
    return { bytes: out.length, buffer: out };
  }
  if (!isEstimateFormat(format)) return undefined;
  const served = buffer.length;
  // Bisection over the quality scale on the native image: the lowest quality whose bytes reach the served bytes.
  let lo = 1;
  let hi = 100;
  for (let step = 0; step < QUALITY_BISECT_STEPS && lo < hi; step++) {
    const mid = Math.floor((lo + hi) / 2);
    const bytes = (await encodeWith(sharp(buffer).rotate(), format, mid)).length;
    if (bytes < served) lo = mid + 1;
    else hi = mid;
  }
  const shrunk = sharp(buffer).rotate().resize({ width: targetWidth, withoutEnlargement: true });
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
