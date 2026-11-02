// A same-origin link crawl for `imgtune audit`, used when a site has no sitemap: the home page, then the pages it links to,
// to CRAWL_DEPTH levels, at most CRAWL_MAX_PAGES pages. The pages are fetched with the checked fetcher (fetch.ts), the same
// one the sitemap reader uses: every redirect hop must stay on the site's registrable domain, each destination is checked
// at connect time (no loopback or private address unless the site is one), and the body is capped. No browser: the links
// are in the HTML the server sends. A page that does not answer 2xx, or whose body is not HTML, is skipped, not retried.
import { makeFetcher, type Fetcher } from "./fetch.js";
import { isLocalTarget, type Resolver } from "./address.js";
import { IMGTUNE_VERSION } from "./version.js";

export const CRAWL_DEPTH = 2;
export const CRAWL_MAX_PAGES = 500;
/** Pages fetched at once. */
export const CRAWL_CONCURRENCY = 4;
/** The largest HTML body read for one page, in bytes: a larger one is refused by the fetcher. */
export const CRAWL_MAX_HTML_BYTES = 2 * 1024 * 1024;
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

/** Fetches one page's body: the checked fetcher's answer, or undefined. Injected by the tests. */
export type PageGet = (url: string) => Promise<Buffer | undefined>;

export interface CrawlOptions {
  depth?: number;
  max?: number;
  /** Tests inject a fake page source. Production: the checked fetcher, with the site's own origin as the same-site rule. */
  get?: PageGet;
  /** Tests inject a resolver for the checked fetcher. Production uses the system resolver. */
  resolver?: Resolver;
}

/** The checked fetcher of a crawl: private destinations only for a site that is itself local (see isLocalTarget). */
function checkedGet(origin: string, fetcher: Fetcher): PageGet {
  const allowPrivate = isLocalTarget(origin);
  return (url) => fetcher.get(url, { maxBytes: CRAWL_MAX_HTML_BYTES, allowPrivate, sameSiteAs: origin });
}

/** The HTML text of a body, or undefined when the body does not start like an HTML document. */
function htmlOf(body: Buffer | undefined): string | undefined {
  if (body === undefined) return undefined;
  const text = body.toString("utf8");
  return HTML_START.test(text.slice(0, 4096)) ? text : undefined;
}

/**
 * The pages of a site found by following links from its home page: the home page first, then in the order they were found,
 * level by level. The list is capped at `max` pages.
 */
export async function crawlSite(originUrl: string, opts: CrawlOptions = {}): Promise<string[]> {
  const origin = new URL(originUrl).origin;
  const depthLimit = opts.depth ?? CRAWL_DEPTH;
  const max = opts.max ?? CRAWL_MAX_PAGES;
  const get = opts.get ?? checkedGet(origin, makeFetcher({ userAgent: `imgtune/${IMGTUNE_VERSION}`, resolver: opts.resolver }));
  const start = `${origin}/`;
  const seen = new Set<string>([start]);
  const pages: string[] = [];
  let level: string[] = [start];
  for (let depth = 0; depth <= depthLimit && level.length > 0 && pages.length < max; depth++) {
    const next: string[] = [];
    for (let i = 0; i < level.length && pages.length < max; i += CRAWL_CONCURRENCY) {
      const chunk = level.slice(i, i + CRAWL_CONCURRENCY);
      const bodies = await Promise.all(chunk.map((url) => get(url).catch(() => undefined)));
      chunk.forEach((url, k) => {
        const html = htmlOf(bodies[k]);
        if (html === undefined || pages.length >= max) return;
        pages.push(url);
        if (depth < depthLimit) {
          for (const link of linksOf(html, url, origin)) {
            if (!seen.has(link)) {
              seen.add(link);
              next.push(link);
            }
          }
        }
      });
    }
    level = next;
  }
  return pages;
}
