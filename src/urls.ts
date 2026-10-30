import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { isLocalTarget } from "./address.js";
import { makeFetcher, type Fetcher } from "./fetch.js";
import { sameSite } from "./site.js";
import type { ImgtuneConfig } from "./types.js";
import { IMGTUNE_VERSION } from "./version.js";

export type UrlSource = "config" | "sitemap" | "static" | "none";

export interface ResolvedUrls {
  paths: string[];
  source: UrlSource;
}

/** Sitemap indexes are followed this many levels deep (the top-level index is level 0). */
const MAX_INDEX_DEPTH = 2;
const MAX_CHILD_SITEMAPS = 50;
const CHILD_CONCURRENCY = 4;
/** Timeout for a sitemap read through an injected fetch (the default guarded fetch has its own). */
const SITEMAP_TIMEOUT_MS = 15_000;
/** A sitemap is read up to this many bytes (the sitemap protocol's uncompressed limit). Compressed files are not read. */
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
const ENV_FILES = [".env.local", ".env.development.local", ".env.development", ".env"];
const DOMAIN_KEY = "NEXT_PUBLIC_DOMAIN_BASE_URL";

const OPTIONAL_CATCH_ALL = /^\[\[\.\.\..+\]\]$/;
const CATCH_ALL = /^\[\.\.\..+\]$/;
const SINGLE = /^\[[^\]]+\]$/;

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === "url" || name === "sitemap",
});

function segmentsOf(pattern: string): string[] {
  return pattern.split("/").filter((s) => s !== "");
}

function isDynamic(segment: string): boolean {
  return OPTIONAL_CATCH_ALL.test(segment) || CATCH_ALL.test(segment) || SINGLE.test(segment);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function segmentRegExp(segment: string): string {
  if (OPTIONAL_CATCH_ALL.test(segment)) return "(?:\\/[^/]+)*";
  if (CATCH_ALL.test(segment)) return "(?:\\/[^/]+)+";
  if (SINGLE.test(segment)) return "\\/[^/]+";
  return "\\/" + escapeRegExp(segment);
}

/** Anchored matcher for pathnames: `[x]` one segment, `[...x]` one or more, `[[...x]]` zero or more. */
export function patternToRegExp(pattern: string): RegExp {
  const body = segmentsOf(pattern).map(segmentRegExp).join("");
  return new RegExp(`^${body}\\/?(?:[?#].*)?$`);
}

/** Number of static (non-dynamic) segments; a higher number is more specific. */
export function specificity(pattern: string): number {
  return segmentsOf(pattern).filter((s) => !isDynamic(s)).length;
}

function dynamicCount(pattern: string): number {
  return segmentsOf(pattern).filter(isDynamic).length;
}

/** Pathname of an absolute, relative or path-only URL, without query, hash or trailing slash. */
function toPathname(input: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(input, "http://placeholder.invalid").pathname;
  } catch {
    return undefined;
  }
  return pathname.replace(/\/+$/, "") || "/";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Resolves each route pattern to example paths. Static patterns map to themselves, config entries
 * win over the sitemap, and each sitemap path belongs only to its most specific matching pattern.
 */
export function resolveUrls(
  patterns: string[],
  sitemapPaths: string[],
  config: Pick<ImgtuneConfig, "urls" | "market" | "maxPagesPerPattern">,
): Map<string, ResolvedUrls> {
  const resolved = new Map<string, ResolvedUrls>();
  const dynamic: string[] = [];
  for (const pattern of patterns) {
    if (segmentsOf(pattern).some(isDynamic)) {
      dynamic.push(pattern);
    } else {
      resolved.set(pattern, { paths: ["/" + segmentsOf(pattern).join("/")], source: "static" });
    }
  }

  const configured = new Set<string>();
  for (const pattern of dynamic) {
    const entries = unique((config.urls[pattern] ?? []).flatMap((u) => toPathname(u) ?? []));
    if (entries.length > 0) {
      resolved.set(pattern, { paths: entries, source: "config" });
      configured.add(pattern);
    }
  }

  // Static and dynamic patterns compete. Most specific first; ties: fewer dynamic segments, then
  // pattern text for determinism. A path whose owner is static belongs to nobody else.
  const ranked = [...patterns].sort(
    (a, b) =>
      specificity(b) - specificity(a) ||
      dynamicCount(a) - dynamicCount(b) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  const regexps = new Map(ranked.map((p) => [p, patternToRegExp(p)]));
  const claimed = new Map<string, string[]>();
  for (const raw of unique(sitemapPaths.flatMap((p) => toPathname(p) ?? []))) {
    const owner = ranked.find((p) => regexps.get(p)!.test(raw));
    if (!owner || !dynamic.includes(owner)) continue;
    const list = claimed.get(owner) ?? [];
    list.push(raw);
    claimed.set(owner, list);
  }

  const isMarket = (path: string) => `${path}/`.includes(`/${config.market}/`);
  for (const pattern of dynamic) {
    if (configured.has(pattern)) continue;
    const candidates = claimed.get(pattern) ?? [];
    const paths = [...candidates.filter(isMarket), ...candidates.filter((p) => !isMarket(p))].slice(
      0,
      config.maxPagesPerPattern,
    );
    resolved.set(pattern, paths.length > 0 ? { paths, source: "sitemap" } : { paths: [], source: "none" });
  }

  return new Map(patterns.map((p) => [p, resolved.get(p)!]));
}

type SitemapDocument = { kind: "urlset" | "index"; locs: string[] };

function locsOf(parent: unknown, child: "url" | "sitemap"): string[] {
  if (typeof parent !== "object" || parent === null) return [];
  const entries = (parent as Record<string, unknown>)[child];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const loc = typeof entry === "object" && entry !== null ? (entry as { loc?: unknown }).loc : undefined;
    return typeof loc === "string" && loc.trim() !== "" ? [loc.trim()] : [];
  });
}

/** undefined when the XML is not a sitemap or sitemap index. */
function parseSitemap(xml: string): SitemapDocument | undefined {
  let doc: Record<string, unknown>;
  try {
    doc = xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (doc.urlset !== undefined) return { kind: "urlset", locs: locsOf(doc.urlset, "url") };
  if (doc.sitemapindex !== undefined) return { kind: "index", locs: locsOf(doc.sitemapindex, "sitemap") };
  return undefined;
}

/**
 * The text of one sitemap. Without an injected fetch, the sitemap is read through the checked fetcher: the destination is
 * checked at connect time, every redirect hop must stay on the top sitemap's site, the body is capped, and the request
 * has the fetcher's 30 s timeout. Private addresses are allowed only when the sitemap URL itself is local.
 */
async function fetchXml(url: string, top: string, fetchImpl: typeof fetch | undefined, guarded: Fetcher | undefined): Promise<string | undefined> {
  if (fetchImpl) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS) });
    return res.ok ? res.text() : undefined;
  }
  const body = await guarded!.get(url, { maxBytes: MAX_SITEMAP_BYTES, allowPrivate: isLocalTarget(url), sameSiteAs: top });
  return body?.toString("utf8");
}

/**
 * A child sitemap is fetched only when it is http(s) and on the same registrable domain as the top sitemap. Page URLs
 * are not fetched from their own host at all: they are reduced to paths on the scanned server (see fetchSitemapUrls).
 */
export function sitemapMayBeFetched(child: string, top: string): boolean {
  try {
    const protocol = new URL(child).protocol;
    if (protocol !== "http:" && protocol !== "https:") return false;
  } catch {
    return false;
  }
  return sameSite(child, top);
}

/**
 * Pathnames listed by a sitemap. A `<sitemapindex>` is followed into its children (at most MAX_INDEX_DEPTH levels and
 * MAX_CHILD_SITEMAPS children, on the top sitemap's registrable domain only). A top-level failure throws; a child that
 * is refused, fails to fetch, or does not parse contributes nothing. Page `<loc>`s are never requested: each is reduced
 * to its pathname, which is then measured on the scanned server.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  const guarded = fetchImpl === undefined ? makeFetcher({ userAgent: `imgtune/${IMGTUNE_VERSION}` }) : undefined;
  const topXml = await fetchXml(sitemapUrl, sitemapUrl, fetchImpl, guarded);
  const top = topXml === undefined ? undefined : parseSitemap(topXml);
  if (!top) throw new Error(`${sitemapUrl} is not an XML sitemap`);

  const paths: string[] = [];
  let remainingChildren = MAX_CHILD_SITEMAPS;
  const visit = async (doc: SitemapDocument, depth: number): Promise<void> => {
    if (doc.kind === "urlset") {
      for (const loc of doc.locs) {
        const path = toPathname(loc);
        if (path !== undefined) paths.push(path);
      }
      return;
    }
    if (depth >= MAX_INDEX_DEPTH) return;
    const children = doc.locs.filter((loc) => sitemapMayBeFetched(loc, sitemapUrl)).slice(0, remainingChildren);
    remainingChildren -= children.length;
    const childDocs = await mapWithConcurrency(children, CHILD_CONCURRENCY, (child) =>
      loadChild(child, sitemapUrl, fetchImpl, guarded),
    );
    for (const childDoc of childDocs) {
      if (childDoc) await visit(childDoc, depth + 1);
    }
  };
  await visit(top, 0);
  return paths;
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

async function loadChild(
  url: string,
  top: string,
  fetchImpl: typeof fetch | undefined,
  guarded: Fetcher | undefined,
): Promise<SitemapDocument | undefined> {
  try {
    const xml = await fetchXml(url, top, fetchImpl, guarded);
    return xml === undefined ? undefined : parseSitemap(xml);
  } catch {
    return undefined;
  }
}

/** Value of `key` in dotenv-style text: the last definition wins; quotes and `export ` are handled. */
function envValue(text: string, key: string): string | undefined {
  let found: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq === -1 || body.slice(0, eq).trim() !== key) continue;
    found = unquote(body.slice(eq + 1).trim());
  }
  return found;
}

/** A quoted value ends at its matching quote (anything after it is ignored); otherwise a ` #` starts a comment. */
function unquote(value: string): string {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    return close === -1 ? value.slice(1) : value.slice(1, close);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

/** `NEXT_PUBLIC_DOMAIN_BASE_URL` from the first project env file that defines it, like Next. */
function domainFromEnvFiles(projectDir: string): string | undefined {
  for (const name of ENV_FILES) {
    const file = join(projectDir, name);
    if (!existsSync(file)) continue;
    const value = envValue(readFileSync(file, "utf8"), DOMAIN_KEY);
    if (value !== undefined) return value.replace(/\/+$/, "") || undefined;
  }
  return undefined;
}

/** Sitemap URLs to try, in order: config, the project's public domain, then the local server. */
export function sitemapCandidates(
  projectDir: string,
  config: Pick<ImgtuneConfig, "sitemapUrl">,
  baseUrl: string,
): string[] {
  const candidates: string[] = [];
  if (config.sitemapUrl) candidates.push(config.sitemapUrl);
  const domain = domainFromEnvFiles(projectDir);
  if (domain) candidates.push(`${domain}/sitemap.xml`);
  candidates.push(`${baseUrl.replace(/\/+$/, "")}/sitemap.xml`);
  return unique(candidates);
}
