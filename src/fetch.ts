import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { guardedLookup, refusedAddress, systemResolver, type Resolver } from "./address.js";
import { sameSite } from "./site.js";
import { count, measure } from "./timing.js";

// ---------------------------------------------------------------------------------------------------------------------
// Extra fetches: one memo per scan, at most two in flight, 30 s each, capped bodies, checked destinations
// ---------------------------------------------------------------------------------------------------------------------

const EXTRA_FETCH_TIMEOUT_MS = 30_000;
const EXTRA_FETCH_CONCURRENCY = 2;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Chromium's Accept for images: a candidate is then fetched in the format the browser would have been served. */
const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

export interface FetchOptions {
  /** Largest body accepted; a larger one (declared or streamed) is refused. */
  maxBytes?: number;
  /** Whether destinations on loopback or private addresses are allowed (only when the scanned page is on one). */
  allowPrivate?: boolean;
  /** Every hop, redirects included, must stay on the registrable domain of this URL; a hop off it is refused. */
  sameSiteAs?: string;
}

export interface Fetcher {
  /**
   * The body, or undefined when the URL is not http(s), reaches a blocked address (unless allowed), fails, answers
   * non-2xx, redirects more than MAX_REDIRECTS times, takes longer than EXTRA_FETCH_TIMEOUT_MS, or is larger than its
   * limit. Each (URL, options) is fetched once for the run: callers that ask while it is in flight share the answer.
   * An undefined answer, or a body with Cache-Control: no-store, is not kept once those callers have it, so a later
   * page asks again.
   */
  get(url: string, opts?: FetchOptions): Promise<Buffer | undefined>;
  /**
   * Whether the host of `url` has an address refused for this target (see refusedAddress). A resolver failure rejects:
   * the caller decides, and the browser guard blocks.
   */
  hostIsBlocked(url: string, allowPrivate: boolean): Promise<boolean>;
}

/** True when a Cache-Control value carries the no-store directive. */
export function hasNoStore(cacheControl: string | undefined): boolean {
  return (cacheControl ?? "").split(",").some((directive) => directive.trim().toLowerCase() === "no-store");
}

/** A fetched body, and whether its response forbids keeping it (no-store). */
interface Fetched {
  body: Buffer;
  noStore: boolean;
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

function requestOnce(
  url: URL,
  headers: Record<string, string>,
  allowPrivate: boolean,
  resolver: Resolver,
  signal: AbortSignal,
  connectAddress?: (address: string) => string,
): Promise<IncomingMessage> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    // agent: false, so no pooled socket skips the connect-time lookup.
    const req = send(url, { method: "GET", headers, signal, agent: false, lookup: guardedLookup(resolver, allowPrivate, connectAddress) }, resolve);
    req.on("error", reject);
    req.end();
  });
}

export function makeFetcher(opts: { userAgent: string; resolver?: Resolver; connectAddress?: (address: string) => string }): Fetcher {
  const resolver = opts.resolver ?? systemResolver;
  /** Answers of this run by request key, in flight or settled; an answer that must not be kept is dropped once settled. */
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
  const fetchChecked = async (start: string, maxBytes: number, allowPrivate: boolean, sameSiteAs?: string): Promise<Fetched | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTRA_FETCH_TIMEOUT_MS);
    try {
      let current = start;
      for (let hop = 0; ; hop++) {
        const url = new URL(current);
        if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
        if (sameSiteAs !== undefined && !sameSite(url.href, sameSiteAs)) return undefined;
        // An IP literal never reaches the lookup, so it is checked here as well.
        const bare = url.hostname.replace(/^\[|\]$/g, "");
        if (isIP(bare) !== 0 && refusedAddress(bare, allowPrivate)) return undefined;
        const res = await requestOnce(
          url,
          { "User-Agent": opts.userAgent, Accept: IMAGE_ACCEPT },
          allowPrivate,
          resolver,
          controller.signal,
          opts.connectAddress,
        );
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
        const body = await readCapped(res, maxBytes);
        return body === undefined ? undefined : { body, noStore: hasNoStore(res.headers["cache-control"]) };
      }
    } finally {
      clearTimeout(timer);
    }
  };

  // One lookup per host for the whole scan: the route guard and the fetches share it. Only successful answers are kept;
  // a failed lookup is asked again next time.
  const hostMemo = new Map<string, Promise<boolean>>();
  const hostRefused = (bare: string, allowPrivate: boolean): Promise<boolean> => {
    const key = `${allowPrivate}|${bare}`;
    let pending = hostMemo.get(key);
    if (!pending) {
      pending = (async () => {
        const addresses = isIP(bare) !== 0 ? [{ address: bare, family: isIP(bare) }] : await resolver(bare);
        if (addresses.length === 0) throw new Error(`no address for ${bare}`);
        return addresses.some((a) => refusedAddress(a.address, allowPrivate));
      })();
      hostMemo.set(key, pending);
      pending.catch(() => hostMemo.delete(key));
    }
    return pending;
  };

  return {
    get(url, fetchOpts = {}) {
      const maxBytes = fetchOpts.maxBytes ?? MAX_IMAGE_BYTES;
      const allowPrivate = fetchOpts.allowPrivate ?? false;
      // The request headers are part of the key: a response can depend on them (the user agent and Accept are fixed per run).
      const key = JSON.stringify([url, maxBytes, allowPrivate, fetchOpts.sameSiteAs ?? "", opts.userAgent, IMAGE_ACCEPT]);
      const known = memo.get(key);
      if (known) {
        count("fetch memo hits");
        return known;
      }
      count("fetch requests");
      const fetched = measure("fetch: network", () => withSlot(() => fetchChecked(url, maxBytes, allowPrivate, fetchOpts.sameSiteAs))).catch(() => undefined);
      const pending: Promise<Buffer | undefined> = fetched.then((answer) => {
        // Settled: a failure or a no-store body is not kept for the next page (its callers above already have it).
        if (answer === undefined || answer.noStore) {
          if (memo.get(key) === pending) memo.delete(key);
        }
        return answer?.body;
      });
      memo.set(key, pending);
      return pending;
    },
    /**
     * Whether the host of `url` has an address that is refused for this target (see refusedAddress). A resolver failure
     * rejects: the caller decides, and the browser guard blocks.
     */
    hostIsBlocked(url, allowPrivate) {
      return hostRefused(new URL(url).hostname.replace(/^\[|\]$/g, ""), allowPrivate);
    },
  };
}
