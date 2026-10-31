// `--urls-from`: the pages to scan, from a text file (one URL per line), a local sitemap.xml, or a remote sitemap URL.
// Sitemaps are untrusted: a child sitemap is fetched only on the top one's registrable domain, the depth and the number of
// children are capped, and each fetch goes through the checked fetcher (connect-time address check, redirect hops on the
// same site, a size cap and a timeout). No XML library: the `<loc>` values are read by a linear scan.

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isLocalTarget } from "./address.js";
import { makeFetcher, type Fetcher } from "./fetch.js";
import { sameSite } from "./site.js";
import { IMGTUNE_VERSION } from "./version.js";

/** Sitemap indexes are followed this many levels deep (the top-level index is level 0). */
export const MAX_INDEX_DEPTH = 2;
export const MAX_CHILD_SITEMAPS = 50;
const CHILD_CONCURRENCY = 4;
/** Timeout for a sitemap read through an injected fetch (the default guarded fetch has its own). */
const SITEMAP_TIMEOUT_MS = 15_000;
/** A sitemap is read up to this many bytes (the sitemap protocol's uncompressed limit). Compressed files are not read. */
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
/** A sitemap lists at most this many URLs (the protocol's limit); the rest are not read. */
export const MAX_SITEMAP_URLS = 50_000;
/** A text list of URLs is read up to this many bytes. */
export const MAX_LIST_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------------
// Text lists and sitemap text
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The URLs of a text list: one per line, `#` starts a comment, blank lines are skipped. Each URL must be http(s); a line
 * that is not throws with its line number. Duplicates are kept once, in order.
 */
export function parseUrlList(text: string): string[] {
  const urls: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") return;
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      throw new Error(`line ${i + 1} of the URL list is not a URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`line ${i + 1} of the URL list is not http or https`);
    urls.push(url.toString());
  });
  return [...new Set(urls)];
}

/** Whether a text is an XML sitemap or sitemap index (its root element). */
export function isSitemapText(text: string): boolean {
  return /<(urlset|sitemapindex)[\s>]/.test(text.slice(0, 64 * 1024));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The text of an XML character reference or predefined entity; anything else is left as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (match, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body] ?? match;
  });
}

export interface SitemapText {
  kind: "urlset" | "index";
  /** The `<loc>` values, in document order, decoded and trimmed (at most MAX_SITEMAP_URLS). */
  locs: string[];
}

/**
 * The root kind and the `<loc>` values of a sitemap's text. Comments and CDATA markers are removed first. Undefined when
 * the text is not a sitemap or sitemap index.
 */
export function parseSitemapText(xml: string): SitemapText | undefined {
  const clean = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[|\]\]>/g, "");
  const root = /<(urlset|sitemapindex)[\s>]/.exec(clean);
  if (!root) return undefined;
  const locs: string[] = [];
  const pattern = /<loc>([^<]*)<\/loc>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null && locs.length < MAX_SITEMAP_URLS) {
    const loc = decodeEntities(match[1]).trim();
    if (loc !== "") locs.push(loc);
  }
  return { kind: root[1] === "urlset" ? "urlset" : "index", locs };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fetching child sitemaps under the limits
// ---------------------------------------------------------------------------------------------------------------------

/** Whether a URL is an http(s) address on the same registrable domain as `top`: the only sitemaps that are fetched. */
export function sitemapMayBeFetched(child: string, top: string): boolean {
  try {
    const protocol = new URL(child).protocol;
    if (protocol !== "http:" && protocol !== "https:") return false;
  } catch {
    return false;
  }
  return sameSite(child, top);
}

async function fetchXml(url: string, top: string, fetchImpl: typeof fetch | undefined, guarded: Fetcher | undefined): Promise<string | undefined> {
  if (fetchImpl) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS) });
    return res.ok ? res.text() : undefined;
  }
  const body = await guarded!.get(url, { maxBytes: MAX_SITEMAP_BYTES, allowPrivate: isLocalTarget(url), sameSiteAs: top });
  return body?.toString("utf8");
}

/** Maps `items` with at most `limit` calls in flight; results keep the input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The page URLs of a sitemap (and of its child sitemaps). A `<sitemapindex>` is followed into its children, at most
 * MAX_INDEX_DEPTH levels and MAX_CHILD_SITEMAPS children in all, each on the top sitemap's registrable domain. A page URL
 * is kept only when it is http(s) on that domain too. A top-level failure throws; a child that is refused, fails or does
 * not parse contributes nothing.
 */
async function collectUrls(top: SitemapText, topUrl: string, fetchImpl: typeof fetch | undefined, guarded: Fetcher | undefined): Promise<string[]> {
  const pages: string[] = [];
  let remainingChildren = MAX_CHILD_SITEMAPS;
  const keepPage = (loc: string) => sitemapMayBeFetched(loc, topUrl) && pages.length < MAX_SITEMAP_URLS;
  const visit = async (doc: SitemapText, depth: number): Promise<void> => {
    if (doc.kind === "urlset") {
      for (const loc of doc.locs) if (keepPage(loc)) pages.push(loc);
      return;
    }
    if (depth >= MAX_INDEX_DEPTH) return;
    const children = doc.locs.filter((loc) => sitemapMayBeFetched(loc, topUrl)).slice(0, remainingChildren);
    remainingChildren -= children.length;
    const childDocs = await mapWithConcurrency(children, CHILD_CONCURRENCY, async (child) => {
      try {
        const xml = await fetchXml(child, topUrl, fetchImpl, guarded);
        return xml === undefined ? undefined : parseSitemapText(xml);
      } catch {
        return undefined;
      }
    });
    for (const childDoc of childDocs) if (childDoc) await visit(childDoc, depth + 1);
  };
  await visit(top, 0);
  return [...new Set(pages)];
}

/**
 * The page URLs of a remote sitemap. Throws when the top sitemap cannot be read or is not a sitemap. `fetchImpl` is a
 * test seam; without it the sitemap is read through the checked fetcher.
 */
export async function fetchSitemapUrls(sitemapUrl: string, fetchImpl?: typeof fetch): Promise<string[]> {
  const guarded = fetchImpl === undefined ? makeFetcher({ userAgent: `imgtune/${IMGTUNE_VERSION}` }) : undefined;
  const topXml = await fetchXml(sitemapUrl, sitemapUrl, fetchImpl, guarded);
  const top = topXml === undefined ? undefined : parseSitemapText(topXml);
  if (!top) throw new Error(`${sitemapUrl} is not an XML sitemap`);
  return collectUrls(top, sitemapUrl, fetchImpl, guarded);
}

/**
 * The page URLs of a local sitemap file. Its own URLs and child sitemaps must be on the registrable domain of its first
 * `<loc>`; anything else is dropped, and the count is returned for the report.
 */
async function urlsFromLocalSitemap(text: string): Promise<{ urls: string[]; dropped: number }> {
  const top = parseSitemapText(text);
  if (!top || top.locs.length === 0) throw new Error("the sitemap lists no URL");
  const siteRef = top.locs.find((loc) => /^https?:\/\//.test(loc));
  if (siteRef === undefined) throw new Error("the sitemap has no http(s) URL");
  const guarded = makeFetcher({ userAgent: `imgtune/${IMGTUNE_VERSION}` });
  const urls = await collectUrls(top, siteRef, undefined, guarded);
  // Page URLs of a plain sitemap that are on another domain are counted; a child sitemap is not a page.
  const dropped = top.kind === "urlset" ? top.locs.filter((loc) => !sitemapMayBeFetched(loc, siteRef)).length : 0;
  return { urls, dropped };
}

// ---------------------------------------------------------------------------------------------------------------------
// --urls-from: one source, and sampling per route pattern
// ---------------------------------------------------------------------------------------------------------------------

export interface UrlSourceResult {
  urls: string[];
  /** Where the URLs came from, for the report. */
  source: "list" | "local-sitemap" | "remote-sitemap";
  /** Sitemap URLs dropped for being on another registrable domain (local sitemap files). */
  dropped: number;
}

/**
 * The page URLs named by a `--urls-from` argument: an http(s) sitemap URL (fetched under the limits), a local file that
 * is a sitemap (read under the size cap), or any other local file, read as a text list.
 */
export async function urlsFromSource(arg: string, cwd: string): Promise<UrlSourceResult> {
  if (/^https?:\/\//i.test(arg)) {
    const urls = await fetchSitemapUrls(arg);
    return { urls, source: "remote-sitemap", dropped: 0 };
  }
  const path = resolve(cwd, arg);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${arg} is not a file`);
  if (info.size > MAX_SITEMAP_BYTES) throw new Error(`${arg} is larger than ${MAX_SITEMAP_BYTES / (1024 * 1024)} MB`);
  const text = await readFile(path, "utf8");
  if (isSitemapText(text)) {
    const { urls, dropped } = await urlsFromLocalSitemap(text);
    return { urls, source: "local-sitemap", dropped };
  }
  if (info.size > MAX_LIST_BYTES) throw new Error(`${arg} is larger than ${MAX_LIST_BYTES / (1024 * 1024)} MB`);
  return { urls: parseUrlList(text), source: "list", dropped: 0 };
}

/** Whether a first path segment is a locale such as `en`, `ae-en` or `pt-br`: it is skipped when grouping. */
const LOCALE = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;

/**
 * The route pattern of a page, by path template: the first path segment after a leading locale names the group, and the
 * rest is a wildcard (`/p/*` for `/p/some-product-1234`, `/ae-en/c/*` for `/ae-en/c/bags`). A page with no segment after
 * the locale is its own pattern (`/`, `/about`). Unparseable URLs group under themselves.
 */
export function patternOf(url: string): string {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/").filter((s) => s !== "");
  } catch {
    return url;
  }
  const locale = segments.length > 0 && LOCALE.test(segments[0]) && segments.length > 1 ? segments[0] : undefined;
  const rest = locale === undefined ? segments : segments.slice(1);
  const prefix = locale === undefined ? "" : `/${locale}`;
  if (rest.length <= 1) return `${prefix}/${rest.join("/")}`.replace(/\/$/, "") || "/";
  return `${prefix}/${rest[0]}/*`;
}

/**
 * At most `perPattern` URLs of each route pattern, spread evenly over the pattern's URLs in their own order. A pattern with
 * fewer URLs keeps them all. Returns the sample in the input order.
 */
export function sampleByPattern(urls: string[], perPattern: number): { urls: string[]; patterns: number } {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const key = patternOf(url);
    const list = groups.get(key);
    if (list) list.push(url);
    else groups.set(key, [url]);
  }
  const chosen = new Set<string>();
  for (const members of groups.values()) {
    if (members.length <= perPattern) {
      for (const url of members) chosen.add(url);
      continue;
    }
    for (let i = 0; i < perPattern; i++) {
      const index = perPattern === 1 ? 0 : Math.round((i * (members.length - 1)) / (perPattern - 1));
      chosen.add(members[index]);
    }
  }
  return { urls: urls.filter((url) => chosen.has(url)), patterns: groups.size };
}
