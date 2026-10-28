/// <reference lib="dom" />
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Browser, Response as BrowserResponse } from "playwright";
import { launchChromium } from "./browser.js";
import sharp, { type Sharp } from "sharp";
import { writeFileAtomic, sha1 } from "./atomic.js";
import { calibrationOffset } from "./calibrate.js";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { encode } from "./encode.js";
import { adapterFor, type QualityParam } from "./loaders.js";
import { loadSettled, settleWithin, BODY_READ_TIMEOUT_MS } from "./measure.js";
import { makeScorer, type Scorer } from "./metric.js";
import { minPassingQuality } from "./search.js";
import { deriveSizes, type SizePoint } from "./sizes.js";
import type { RawImage } from "./ssim.js";
import type { Viewport } from "./types.js";
import { IMGTUNE_VERSION } from "./version.js";

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
 * The original an optimised image URL was made from, per its loader (`/_next/image?url=X`, a Cloudflare
 * `/cdn-cgi/image/<opts>/<path>`, a CDN's own original, ...). Any other URL has no known original.
 */
export function referenceUrl(src: string, pageUrl: string): string | undefined {
  try {
    const { adapter, url } = adapterFor(src, pageUrl);
    return adapter.original(url);
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

function parseViewports(text: string): string[] {
  const names = text.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const known = DEFAULT_VIEWPORTS.map((viewport) => viewport.name);
  if (names.length === 0) throw new Error("--viewports needs at least one name");
  for (const name of names) {
    if (!known.includes(name)) throw new Error(`Unknown viewport ${name} (expected ${known.join(", ")})`);
  }
  return names;
}

const VALUE_OPTIONS: readonly string[] = ["--out", "--viewports", "--markdown", "--fail-over", "--summary-json"];

/** The arguments after `scan`: one or more page URLs and the options. Throws with a message the CLI prints. */
export function parseScanArgs(argv: string[]): ScanArgs {
  const args: ScanArgs = { urls: [], out: DEFAULT_OUT, aggressive: false, quality: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--aggressive") args.aggressive = true;
    else if (arg === "--no-quality") args.quality = false;
    else if (VALUE_OPTIONS.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i++;
      if (arg === "--out") args.out = value;
      else if (arg === "--viewports") args.viewports = parseViewports(value);
      else if (arg === "--markdown") args.markdown = value;
      else if (arg === "--summary-json") args.summaryJson = value;
      else args.failOver = parseFailOver(value);
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
/** Chromium's Accept for images: a candidate is then fetched in the format the browser would have been served. */
const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

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

/** Resolves a host to every address it has (dns.lookup with all: true). */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true });

/** Blocked ranges, from the IANA special-purpose registries. Checked with net.BlockList, never with patterns. */
const BLOCKED = new BlockList();
const BLOCKED_IPV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];
const BLOCKED_IPV6: [string, number][] = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["2002::", 16],
];
for (const [net, prefix] of BLOCKED_IPV4) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of BLOCKED_IPV6) BLOCKED.addSubnet(net, prefix, "ipv6");

/** An IPv6 address (any textual form, with an optional dotted tail and zone) as its 16 bytes; undefined if malformed. */
export function ipv6Bytes(text: string): Uint8Array | undefined {
  let s = text.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tail) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[2 * i] = g >> 8;
    bytes[2 * i + 1] = g & 0xff;
  });
  return bytes;
}

/**
 * Whether an address (IPv4 or IPv6 in any textual form) is one a scan must not reach. IPv4-mapped (::ffff:a.b.c.d) and
 * IPv4-compatible (::a.b.c.d) IPv6 addresses are unwrapped and their IPv4 part is checked too. Unparsable text is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const zeroPrefix = bytes.subarray(0, 10).every((b) => b === 0);
  const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes[10] === 0 && bytes[11] === 0;
  // NAT64 well-known prefix 64:ff9b::/96: the IPv4 address is the last 32 bits.
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.subarray(4, 12).every((b) => b === 0);
  // ::ffff:0:0/96 (IPv4-mapped) is blocked as a whole. It is not a BlockList entry: an IPv6 subnet there also matches
  // plain IPv4 checks, which would block public IPv4 addresses.
  if (mapped && zeroPrefix) return true;
  if ((zeroPrefix && compatible) || nat64) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    if (BLOCKED.check(embedded, "ipv4")) return true;
  }
  return BLOCKED.check(address, "ipv6");
}

/**
 * A `lookup` for a socket that resolves the host with `resolver` and refuses the connection when any address is blocked.
 * The socket then connects to the address that was checked, so a DNS answer that changes later cannot redirect it.
 */
export function guardedLookup(resolver: Resolver): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
          callback(new Error(`refused: ${hostname} resolves to a blocked address`));
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (err: unknown) => callback(err),
    );
  }) as unknown as LookupFunction;
}

export interface FetchOptions {
  /** Largest body accepted; a larger one (declared or streamed) is refused. */
  maxBytes?: number;
  /** Whether destinations on loopback or private addresses are allowed (only when the scanned page is on one). */
  allowPrivate?: boolean;
}

export interface Fetcher {
  /**
   * The body, or undefined when the URL is not http(s), reaches a blocked address (unless allowed), fails, answers
   * non-2xx, redirects more than MAX_REDIRECTS times, takes longer than EXTRA_FETCH_TIMEOUT_MS, or is larger than its
   * limit. Each (URL, options) is fetched once.
   */
  get(url: string, opts?: FetchOptions): Promise<Buffer | undefined>;
  /** Whether the host of `url` resolves to a blocked address: a page that does is allowed private destinations. */
  isPrivateHost(url: string): Promise<boolean>;
  /** Like isPrivateHost, but a resolver failure rejects instead of answering: the caller decides (the browser guard blocks). */
  hostIsBlocked(url: string): Promise<boolean>;
}

/** The body up to `maxBytes`; undefined when it is larger (checked on Content-Length and while streaming). */
async function readCapped(res: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res) {
      const piece = chunk as Buffer;
      total += piece.length;
      if (total > maxBytes) {
        res.destroy();
        return undefined;
      }
      chunks.push(piece);
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(chunks, total);
}

function requestOnce(url: URL, headers: Record<string, string>, allowPrivate: boolean, resolver: Resolver, signal: AbortSignal): Promise<IncomingMessage> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    // agent: false, so no pooled socket skips the connect-time lookup.
    const req = send(url, { method: "GET", headers, signal, agent: false, lookup: allowPrivate ? undefined : guardedLookup(resolver) }, resolve);
    req.on("error", reject);
    req.end();
  });
}

export function makeFetcher(opts: { userAgent: string; resolver?: Resolver }): Fetcher {
  const resolver = opts.resolver ?? systemResolver;
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

  /** Each hop is checked at connect time (guardedLookup); redirects are followed here, not by the client. */
  const fetchChecked = async (start: string, maxBytes: number, allowPrivate: boolean): Promise<Buffer | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTRA_FETCH_TIMEOUT_MS);
    try {
      let current = start;
      for (let hop = 0; ; hop++) {
        const url = new URL(current);
        if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
        // An IP literal never reaches the lookup, so it is checked here as well.
        const bare = url.hostname.replace(/^\[|\]$/g, "");
        if (!allowPrivate && isIP(bare) !== 0 && isBlockedAddress(bare)) return undefined;
        const res = await requestOnce(url, { "User-Agent": opts.userAgent, Accept: IMAGE_ACCEPT }, allowPrivate, resolver, controller.signal);
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (hop >= MAX_REDIRECTS) return undefined;
          current = new URL(location, url).toString();
          continue;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return undefined;
        }
        return await readCapped(res, maxBytes);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  // One lookup per host for the whole scan: the route guard and the fetches share it. Only successful answers are kept;
  // a failed lookup is asked again next time.
  const hostMemo = new Map<string, Promise<boolean>>();
  const hostIsPrivate = (bare: string): Promise<boolean> => {
    let pending = hostMemo.get(bare);
    if (!pending) {
      pending = (async () => {
        const addresses = isIP(bare) !== 0 ? [{ address: bare, family: isIP(bare) }] : await resolver(bare);
        if (addresses.length === 0) throw new Error(`no address for ${bare}`);
        return addresses.some((a) => isBlockedAddress(a.address));
      })();
      hostMemo.set(bare, pending);
      pending.catch(() => hostMemo.delete(bare));
    }
    return pending;
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
    /**
     * Whether the page's own host is private, which allows private destinations for its fetches. Used only as that
     * allowance: an error answers false, the safe direction. Never a request guard: the browser guard uses hostIsBlocked.
     */
    async isPrivateHost(url) {
      try {
        return await hostIsPrivate(new URL(url).hostname.replace(/^\[|\]$/g, ""));
      } catch {
        return false;
      }
    },
    hostIsBlocked(url) {
      return hostIsPrivate(new URL(url).hostname.replace(/^\[|\]$/g, ""));
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
    // The bar is the served file's own score against the original, so it holds whatever quality the URL asks for.
    const servedScore = await score(reference, await decodeRaw(input.served, { width: reference.width, height: reference.height }));
    let target: number | undefined;
    for (const delta of deltas) {
      const bar = Math.max(SCAN_THRESHOLD, servedScore - delta);
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
  /** Requests the browser was stopped from making (the page is public and they reach a blocked address). */
  blockedRequests: number;
  nextjs: boolean;
  images: ObservedImage[];
  /** Every image response of the page view, by URL. */
  responses: Map<string, ResponseRecord>;
}

/**
 * Whether a browser request may be made. Only consulted when the scanned page is public. Failing to decide counts as
 * blocked. Residual risk, accepted: in-browser HTTP redirects and DNS rebinding can still reach a private address; the
 * browser guard is defense in depth for a CLI that visits user-chosen URLs, comparable to opening them in a normal
 * browser. The Node-side fetcher (originals, candidates) is fully guarded at connect time.
 */
export interface RequestGuard {
  isBlocked(url: string): Promise<boolean>;
}

async function observeViewport(browser: Browser, pageUrl: string, viewport: Viewport, guard?: RequestGuard): Promise<ViewportObservation> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    userAgent: viewport.userAgent,
    // A service worker could answer requests the route guard never sees, and would change what is measured.
    serviceWorkers: "block",
  });
  try {
    const responses = new Map<string, ResponseRecord>();
    const bodyReads: Promise<void>[] = [];
    let blockedRequests = 0;
    if (guard) {
      // Every request of the page goes through the guard, so a sub-resource cannot reach a blocked address either.
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
    }
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
      blockedRequests,
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
      rightBuffer = obs.responses.get(right.url)?.buffer ?? (await ctx.fetcher.get(right.url, { allowPrivate: ctx.allowPrivate }));
    }
    if (rightBuffer) {
      const rightPixels = right.url === img.currentSrc ? served : await pixelSize(rightBuffer);
      const rightBytes = rightBuffer.length;
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
      const current = currentQuality(member.url, ctx.pageUrl);
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
      const current = currentQuality(member.url, ctx.pageUrl);
      member.qualityRatio = ctx.aggressive && group4 !== undefined ? { [SCAN_DELTA]: group2, [SCAN_AGGRESSIVE_DELTA]: group4 } : { [SCAN_DELTA]: group2 };
      member.qualityInfo = { current: current.quality, qualityAssumed: current.assumed, sampled: false };
    }
  }
}

/** Turns the quality ratios into savings on top of the right file (est.). */
function applyQuality(inst: Instance): void {
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
  quality?: { current: number; qualityAssumed: boolean; target?: number; format?: string; sampled: boolean };
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
  counts: { images: number; qualityNA: number; skipped: number; blockedRequests: number; byLoader: Record<string, number> };
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

  const numbers = pageNumbers(totals);
  const { aggressiveExactEstPct, ...withoutAggressive } = numbers;
  return {
    ...base,
    nextjs: observations.some((o) => o.nextjs),
    perViewport,
    page: ctx.aggressive ? { ...withoutAggressive, aggressiveExactEstPct } : withoutAggressive,
    groups: groupReports(instances),
    counts: {
      images: elements.size,
      qualityNA: naElements.size,
      skipped: skippedElements.size,
      blockedRequests: observations.reduce((sum, o) => sum + o.blockedRequests, 0),
      byLoader,
    },
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
  /** Host resolver for the connect-time check (tests inject one; production uses the system resolver). */
  resolver?: Resolver;
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
  if (!robotsAllows(await robotsFor(url.origin, allowPrivate), pageUrl)) return { ...base, status: "robots" };

  // One pass per viewport; a challenge stops the page at once, with no retry.
  const guard: RequestGuard | undefined = allowPrivate ? undefined : { isBlocked: (u) => run.fetcher.hostIsBlocked(u) };
  const observations: ViewportObservation[] = [];
  try {
    for (const viewport of run.viewports) {
      const obs = await observeViewport(browser, pageUrl, viewport, guard);
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
  const browser = await launchChromium();
  try {
    // The fetches send the desktop viewport's user agent: the default one of a fresh context.
    const probe = await browser.newContext();
    const userAgent = await (await probe.newPage()).evaluate(() => navigator.userAgent);
    await probe.close();
    const fetcher = makeFetcher({ userAgent, resolver: opts.resolver });
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
      opts.log(`scanning ${safeText(url)}`);
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

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const TEXT_LIMIT = 200;

/**
 * Page-derived text as it may be printed: C0 and C1 control characters removed (no escape sequences reach the
 * terminal), and at most TEXT_LIMIT characters, the last three of them "...". JSON output is not passed through here.
 */
export function safeText(text: string, limit = TEXT_LIMIT): string {
  const clean = text.replace(CONTROL_CHARS, "");
  return clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean;
}

const pct = (value: number): string => `${value.toFixed(1)}%`;
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/** One page: a short table, its top groups and, for Next.js, the pointer to audit. */
export function renderPage(result: PageResult, aggressive: boolean): string[] {
  const head = `${safeText(result.url)}  ${result.status}${result.nextjs ? "  (Next.js)" : ""}`;
  if (result.status !== "ok" || !result.page) return [head, `  ${safeText(result.error ?? result.status)}`];
  const n = result.page;
  const lines = [
    head,
    `  viewports: ${safeText(result.viewports.join(", "))}`,
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
      const hint = g.hint ? `  ${safeText(g.hint)}` : "";
      const qualityHint = g.qualityHint ? `  ${safeText(g.qualityHint)}` : "";
      const loader = g.loader ? `  loader: ${safeText(g.loader)}` : "";
      const sizes = g.sizes === undefined ? "no sizes" : safeText(g.sizes);
      const suggested = g.suggestedSizes === undefined ? "-" : safeText(g.suggestedSizes);
      lines.push(`    ${sizes} -> ${suggested}  saves ${kb(g.savedBytes)}/view${loader}${hint}${qualityHint}`);
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
      `${safeText(host)} (${site.pages} pages): exact ${pct(site.exactPct)} · exact + est. ${pct(site.exactEstPct)} · fixable ${pct(site.fixablePct)} · sharpness +${site.sharpnessKB.toFixed(1)} KB`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// CI outputs: a Markdown summary for a PR comment, one summary JSON, and the --fail-over exit code
// ---------------------------------------------------------------------------------------------------------------------

/** Markdown-significant characters, replaced by HTML entities so page data cannot format, link or mention anything. */
const MD_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "[": "&#91;",
  "]": "&#93;",
  "`": "&#96;",
  "*": "&#42;",
  _: "&#95;",
  "|": "&#124;",
  "\\": "&#92;",
  "@": "&#64;",
};

/** Page-derived text for a Markdown table cell: control characters removed and length limited (safeText), then escaped. */
export function mdText(text: string): string {
  return safeText(text).replace(/[&<>[\]`*_|\\@]/g, (ch) => MD_ENTITIES[ch]);
}

const kbNumber = (bytes: number): string => (bytes / 1024).toFixed(0);
const SUMMARY_GROUPS = 5;

/** One Markdown table row, padded with empty cells to `width` columns. */
const mdRow = (cells: string[], width: number): string =>
  `| ${[...cells, ...Array<string>(width - cells.length).fill("")].join(" | ")} |`;

/** The PR-comment Markdown: one row per page, then each page's top groups. Contains no HTML comment and no mention. */
export function renderMarkdown(results: PageResult[], aggressive: boolean): string {
  const width = aggressive ? 7 : 6;
  const head = ["page", "status", "image KB/view", "exact", "exact + est.", "sharpness"];
  if (aggressive) head.push(`exact + est. at delta ${SCAN_AGGRESSIVE_DELTA}`);
  const align = ["---", "---", "---:", "---:", "---:", "---:", "---:"].slice(0, width);
  const lines: string[] = ["## imgtune scan", "", mdRow(head, width), mdRow(align, width)];
  for (const result of results) {
    const url = mdText(result.url);
    if (result.status !== "ok" || !result.page) {
      const status = result.error ? `${mdText(result.status)}: ${mdText(result.error)}` : mdText(result.status);
      lines.push(mdRow([url, status], width));
      continue;
    }
    const n = result.page;
    const cells = [url, "ok", kbNumber(n.meanImageBytes), pct(n.exactPct), pct(n.exactEstPct), `+${n.sharpnessKB.toFixed(1)} KB`];
    if (aggressive) cells.push(pct(n.aggressiveExactEstPct ?? 0));
    lines.push(mdRow(cells, width));
  }
  for (const result of results) {
    if (result.status !== "ok" || !result.page || result.groups.length === 0) continue;
    lines.push("", `### ${mdText(result.url)}`, "", mdRow(["current sizes", "suggested", "saves KB/view", "loader", "hint"], 5));
    lines.push(mdRow(["---", "---", "---:", "---", "---"], 5));
    for (const g of result.groups.slice(0, SUMMARY_GROUPS)) {
      const current = g.sizes === undefined ? "no sizes" : mdText(g.sizes);
      const suggested = g.suggestedSizes === undefined ? "-" : mdText(g.suggestedSizes);
      const loader = g.loader ? mdText(g.loader) : "-";
      const hint = [g.hint, g.qualityHint].filter((h): h is string => h !== undefined).map((h) => mdText(h)).join("; ");
      lines.push(mdRow([current, suggested, kbNumber(g.savedBytes), loader, hint || "-"], 5));
    }
  }
  const viewports = [...new Set(results.filter((r) => r.status === "ok").flatMap((r) => r.viewports))];
  lines.push(
    "",
    `Method: savings are shares of each page view's image bytes, averaged over viewports. exact = the site's own smaller srcset candidates, measured; est. = a local re-encode (quality, format or a plain img resize), judged by SSIMULACRA2 at delta ${SCAN_DELTA}. Sharpness is undersized images, reported apart from the savings.`,
    "",
    `Viewports: ${viewports.length > 0 ? viewports.map((v) => mdText(v)).join(", ") : "none measured"}.`,
  );
  return lines.join("\n");
}

/** One JSON for other tools: each page's URL, status and numbers, in scan order. */
export interface ScanSummary {
  imgtuneVersion: string;
  pages: { url: string; host: string; status: PageStatus; error?: string; page?: PageNumbers }[];
}

export function summaryOf(results: PageResult[]): ScanSummary {
  return {
    imgtuneVersion: IMGTUNE_VERSION,
    pages: results.map((r) => ({
      url: r.url,
      host: r.host,
      status: r.status,
      ...(r.error !== undefined ? { error: r.error } : {}),
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

/** `imgtune scan`: the arguments after `scan`. The JSON files are written to --out; --markdown and --summary-json too. */
export async function scanCommand(argv: string[], cwd: string, log: (message: string) => void): Promise<ScanCommandResult> {
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
  if (args.markdown !== undefined) await writeOutput(resolve(cwd, args.markdown), `${renderMarkdown(results, args.aggressive)}\n`);
  if (args.summaryJson !== undefined) {
    await writeOutput(resolve(cwd, args.summaryJson), `${JSON.stringify(summaryOf(results), null, 2)}\n`);
  }
  let output = renderScan(results, args.aggressive);
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
