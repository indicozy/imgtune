// A same-origin link crawl for `imgtune audit`, used when a site has no sitemap: the home page, then the pages it links to,
// to CRAWL_DEPTH levels, at most CRAWL_MAX_PAGES pages. It reads the HTML of each page with fetch (no browser: the links
// are in the HTML the server sends). Only pages that answer 2xx with an HTML type are listed; a page that does not is
// skipped, not retried. Links to other origins, to files (images, scripts, PDFs) and to fragments are not followed.
export const CRAWL_DEPTH = 2;
export const CRAWL_MAX_PAGES = 500;
/** Pages fetched at once. */
export const CRAWL_CONCURRENCY = 4;
/** Longest wait for one page, in ms. */
const CRAWL_TIMEOUT_MS = 15_000;
/** The HTML read of one page, in characters: the links of a page are in its first part in practice. */
const MAX_HTML_CHARS = 2 * 1024 * 1024;
const FILE_LINK = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|gz|css|js|mjs|json|xml|txt|mp4|webm|mp3|woff2?|ttf|otf)$/i;

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

export interface CrawlOptions {
  depth?: number;
  max?: number;
  /** Tests inject a fake; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

/** The HTML of a page, or undefined when it is not an HTML page that answers 2xx on the same origin. */
async function htmlOf(url: string, origin: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, { redirect: "follow", headers: { accept: "text/html" }, signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    if (new URL(response.url || url).origin !== origin) return undefined;
    if (!/text\/html|application\/xhtml/i.test(response.headers.get("content-type") ?? "")) return undefined;
    return (await response.text()).slice(0, MAX_HTML_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * The pages of a site found by following links from its home page: the home page first, then in the order they were found,
 * level by level. The list is capped at `max` pages.
 */
export async function crawlSite(originUrl: string, opts: CrawlOptions = {}): Promise<string[]> {
  const origin = new URL(originUrl).origin;
  const depthLimit = opts.depth ?? CRAWL_DEPTH;
  const max = opts.max ?? CRAWL_MAX_PAGES;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const start = `${origin}/`;
  const seen = new Set<string>([start]);
  const pages: string[] = [];
  let level: string[] = [start];
  for (let depth = 0; depth <= depthLimit && level.length > 0 && pages.length < max; depth++) {
    const next: string[] = [];
    for (let i = 0; i < level.length && pages.length < max; i += CRAWL_CONCURRENCY) {
      const chunk = level.slice(i, i + CRAWL_CONCURRENCY);
      const bodies = await Promise.all(chunk.map((url) => htmlOf(url, origin, fetchImpl)));
      chunk.forEach((url, k) => {
        const html = bodies[k];
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
