// A same-origin link crawl for `imgtune audit`, used to find the pages of a site that has no usable sitemap. It starts from
// the home page, then from the seeds the caller gives (the app's static routes, and its dynamic first segments expanded
// for the values the home page leads to). Every page is read with the checked fetcher (fetch.ts): each redirect hop must
// stay on the exact origin of the site (a sibling subdomain is refused), each destination is checked at connect time (no
// loopback or private address unless the site is one), and the body is capped. The page recorded is the URL the body was
// finally read from. No browser: the links are in the HTML the server sends. A page that does not answer 2xx, whose body is
// not HTML, or whose final URL leaves the origin, is skipped, not retried.
//
// The queue is grouped by the first path segment of a URL (a locale or a store, for a multi-locale site) and taken round
// robin, one URL from each group in turn, so one group cannot use up the page budget before the others are reached.
import { makeFetcher, type Fetcher, type PageAnswer } from "./fetch.js";
import { isLocalTarget, type Resolver } from "./address.js";
import { IMGTUNE_VERSION } from "./version.js";

export const CRAWL_DEPTH = 2;
export const CRAWL_MAX_PAGES = 500;
/** Pages fetched at once. */
export const CRAWL_CONCURRENCY = 4;
/** The largest HTML body read for one page, in bytes: a larger one is refused by the fetcher. */
export const CRAWL_MAX_HTML_BYTES = 2 * 1024 * 1024;
/** Requests a crawl may make, as a multiple of its page cap: the answers that are not HTML count too. */
const FETCH_FACTOR = 3;
const FILE_LINK = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|gz|css|js|mjs|json|xml|txt|mp4|webm|mp3|woff2?|ttf|otf)$/i;
/** The start of an HTML document in its first bytes: a doctype, an html, head or body element, or an anchor. */
const HTML_START = /<(?:!doctype\s+html|html|head|body|a)[\s>]/i;

/** The same-origin page links of an HTML document, absolute and without fragments, in document order and unique. */
export function linksOf(html: string, pageUrl: string, origin: string): string[] {
  const out = new Set<string>();
  const anchor = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw === "" || raw.startsWith("#") || /^(?:mailto|tel|javascript|data):/i.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    url.hash = "";
    if (FILE_LINK.test(url.pathname)) continue;
    out.add(url.href);
  }
  return [...out];
}

/** A `<link ...>` tag, and the attributes of one tag by name (case-insensitive: hrefLang is written in camel case). */
const LINK_TAG = /<link\s[^>]*>/gi;
const attributeOf = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : undefined;
};

/**
 * The hreflang alternates of an HTML document: the `<link rel="alternate" hreflang href>` tags of a multi-locale site, which
 * name the same page in each other locale. The page URLs of the site's origin, in document order and unique. An alternate on
 * another origin is read on this origin when `local` is set (the site is a local --prod): the same rule as a sitemap's URLs,
 * so the other host is never fetched. Otherwise it is dropped.
 */
export function alternatesOf(html: string, pageUrl: string, origin: string, local: boolean): string[] {
  const out = new Set<string>();
  for (const tag of html.match(LINK_TAG) ?? []) {
    const rel = attributeOf(tag, "rel");
    const href = attributeOf(tag, "href");
    if (rel === undefined || href === undefined || attributeOf(tag, "hreflang") === undefined || !/\balternate\b/i.test(rel)) continue;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    url.hash = "";
    if (url.origin === origin) out.add(url.href);
    else if (local) out.add(`${origin}${url.pathname}${url.search}`);
  }
  return [...out];
}

/** Fetches one page: the body and the URL it was finally read from, or undefined. Injected by the tests. */
export type PageGet = (url: string) => Promise<PageAnswer | undefined>;

export interface CrawlOptions {
  depth?: number;
  max?: number;
  /** Tests inject a fake page source. Production: the checked fetcher, on the exact origin of the site. */
  get?: PageGet;
  /** Tests inject a resolver for the checked fetcher. Production uses the system resolver. */
  resolver?: Resolver;
  /** Seed URLs on the site's origin, crawled at depth 0 next to the home page. Off-origin seeds are dropped. */
  seeds?: string[];
  /**
   * Called once, after the home page is read, with the URLs it led to: its final URL, then its links. The URLs it returns
   * are more seeds (depth 0). This is how a site's locales are learned before the crawl spreads over them.
   */
  seedsAfterHome?: (seen: string[]) => string[];
}

/** The checked fetcher of a crawl: private destinations only for a site that is itself local (see isLocalTarget). */
function checkedGet(origin: string, fetcher: Fetcher): PageGet {
  const allowPrivate = isLocalTarget(origin);
  return (url) => fetcher.getPage(url, { maxBytes: CRAWL_MAX_HTML_BYTES, allowPrivate, sameOriginAs: origin });
}

/** The HTML text of a body, or undefined when the body does not start like an HTML document. */
function htmlOf(body: Buffer | undefined): string | undefined {
  if (body === undefined) return undefined;
  const text = body.toString("utf8");
  return HTML_START.test(text.slice(0, 4096)) ? text : undefined;
}

/** The first path segment of a URL, or "" for the home page (the queue's group). */
function groupOf(url: string): string {
  return new URL(url).pathname.split("/").filter((s) => s !== "")[0] ?? "";
}

interface Item {
  url: string;
  depth: number;
}

/**
 * The pages of a site found by following links from its home page and from the seeds: the home page first, then in the
 * order they were found, level by level within each group. The list is capped at `max` pages. Every page is on `originUrl`'s
 * exact origin, and every page listed answered with an HTML body.
 */
export async function crawlSite(originUrl: string, opts: CrawlOptions = {}): Promise<string[]> {
  const origin = new URL(originUrl).origin;
  const depthLimit = opts.depth ?? CRAWL_DEPTH;
  const max = opts.max ?? CRAWL_MAX_PAGES;
  const get = opts.get ?? checkedGet(origin, makeFetcher({ userAgent: `imgtune/${IMGTUNE_VERSION}`, resolver: opts.resolver }));
  const home = `${origin}/`;
  // An alternate on another origin is read on this one only for a local site (see alternatesOf).
  const local = isLocalTarget(origin);
  const onOrigin = (url: string | undefined): url is string => {
    if (url === undefined) return false;
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  const queued = new Set<string>([home]);
  const found = new Set<string>();
  const pages: string[] = [];
  const groups = new Map<string, Item[]>();
  let waiting = 0;
  let fetches = 0;
  const fetchCap = max * FETCH_FACTOR;

  const enqueue = (url: string, depth: number): void => {
    if (queued.has(url) || !onOrigin(url)) return;
    queued.add(url);
    const key = groupOf(url);
    const list = groups.get(key);
    if (list) list.push({ url, depth });
    else groups.set(key, [{ url, depth }]);
    waiting++;
  };

  /** Up to `n` queued items, one from each group in turn. */
  const take = (n: number): Item[] => {
    const out: Item[] = [];
    while (out.length < n && waiting > 0) {
      for (const list of groups.values()) {
        if (list.length > 0 && out.length < n) {
          out.push(list.shift() as Item);
          waiting--;
        }
      }
    }
    return out;
  };

  /** Records an answered page (an HTML page of the origin, once) and queues its links and alternates one level down. Returns them. */
  const accept = (item: Item, answer: PageAnswer | undefined): string[] => {
    if (answer === undefined || !onOrigin(answer.finalUrl) || pages.length >= max) return [];
    const html = htmlOf(answer.body);
    if (html === undefined || found.has(answer.finalUrl)) return [];
    found.add(answer.finalUrl);
    pages.push(answer.finalUrl);
    const links = [...new Set([...linksOf(html, answer.finalUrl, origin), ...alternatesOf(html, answer.finalUrl, origin, local)])];
    if (item.depth < depthLimit) for (const link of links) enqueue(link, item.depth + 1);
    return links;
  };

  // The home page alone first: the URLs it leads to (where it redirects, and its links) decide the seeds.
  const homeAnswer = await get(home).catch(() => undefined);
  fetches++;
  const homeLinks = accept({ url: home, depth: 0 }, homeAnswer);
  const seenFromHome = [homeAnswer?.finalUrl, ...homeLinks].filter(onOrigin);
  for (const seed of opts.seeds ?? []) enqueue(seed, 0);
  for (const seed of opts.seedsAfterHome?.(seenFromHome) ?? []) enqueue(seed, 0);

  while (pages.length < max && fetches < fetchCap && waiting > 0) {
    const batch = take(Math.min(CRAWL_CONCURRENCY, fetchCap - fetches));
    const answers = await Promise.all(batch.map((item) => get(item.url).catch(() => undefined)));
    fetches += batch.length;
    batch.forEach((item, k) => accept(item, answers[k]));
  }
  return pages;
}
