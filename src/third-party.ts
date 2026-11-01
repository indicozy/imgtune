import { isIP } from "node:net";
import { registrableDomain } from "./site.js";

// ---------------------------------------------------------------------------------------------------------------------
// Third-party request blocking: the scan's browser aborts the requests that cannot change an image or the layout.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What the scan does with requests to other sites. `block` is on by default: a third-party script, fetch, websocket,
 * media file, beacon or iframe is aborted, which makes the page reach `load` and network idle sooner. `allowHosts` are
 * exact host names whose requests are kept even when blocking.
 */
export interface ThirdPartyPolicy {
  block: boolean;
  allowHosts: readonly string[];
}

export const DEFAULT_THIRD_PARTY: ThirdPartyPolicy = { block: true, allowHosts: [] };

/**
 * Hosting platforms whose subdomains belong to different owners (a.github.io and b.github.io are two sites). The
 * registrable domain of a host under one of them is the subdomain one label above the platform. A short list: a
 * platform that is missing here only makes its subdomains look alike, so its third-party requests are allowed.
 */
const PLATFORM_SUFFIXES: readonly string[] = [
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "azurewebsites.net",
  "cloudfront.net",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "onrender.com",
  "fly.dev",
  "surge.sh",
  "glitch.me",
  "replit.app",
  "ngrok-free.app",
];

const NETWORK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * Resource types that are never blocked from any host: the page's documents, its stylesheets, its fonts and its images
 * (images often come from a CDN on another domain). A document in an iframe is not in this set (see isThirdPartyBlocked).
 */
const KEPT_TYPES: ReadonlySet<string> = new Set(["document", "stylesheet", "font", "image"]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * The site a host belongs to, for the first-party test: the registrable domain (registrableDomain, which knows the
 * two-level suffixes such as co.uk), or, under a hosting platform in PLATFORM_SUFFIXES, one label above the platform.
 */
export function siteDomainOf(host: string): string {
  const name = host.toLowerCase().replace(/\.$/, "");
  for (const suffix of PLATFORM_SUFFIXES) {
    if (name.endsWith(`.${suffix}`)) {
      const keep = suffix.split(".").length + 1;
      return name.split(".").slice(-keep).join(".");
    }
  }
  return registrableDomain(name);
}

/**
 * Whether a request to `requestUrl` is first-party for a page at `pageUrl`: the same host, or the same site (siteDomainOf).
 * Localhost and IP addresses are their own site, so only the same host is first-party for them.
 */
export function isFirstParty(pageUrl: string, requestUrl: string): boolean {
  const page = hostOf(pageUrl);
  const request = hostOf(requestUrl);
  if (page === "" || request === "") return false;
  if (page === request) return true;
  if (isIP(page) !== 0 || isIP(request) !== 0 || !page.includes(".") || !request.includes(".")) return false;
  return siteDomainOf(page) === siteDomainOf(request);
}

/** What the decision needs to know about one request. */
export interface RequestFacts {
  /** The URL of the page the scan measures. */
  pageUrl: string;
  /** The URL the browser is requesting (http, https, ws or wss; other schemes are never blocked here). */
  requestUrl: string;
  /** Playwright's resource type: document, stylesheet, image, font, script, xhr, fetch, websocket, ... */
  resourceType: string;
  /** True for a document loaded into an iframe (not the page's own navigation). */
  subFrame: boolean;
}

/**
 * Whether the policy aborts this request. Order: a policy that does not block, a non-network scheme, a first-party
 * request and an allowed host are all kept. Then the kept resource types (documents, stylesheets, fonts, images) are
 * kept, and everything else from another site is aborted: scripts, fetch and xhr, websockets, event streams, media,
 * beacons and pings, manifests, iframes, and any other type.
 */
export function isThirdPartyBlocked(policy: ThirdPartyPolicy, facts: RequestFacts): boolean {
  if (!policy.block) return false;
  let scheme: string;
  try {
    scheme = new URL(facts.requestUrl).protocol;
  } catch {
    return false;
  }
  if (!NETWORK_SCHEMES.has(scheme)) return false;
  if (isFirstParty(facts.pageUrl, facts.requestUrl)) return false;
  if (policy.allowHosts.includes(hostOf(facts.requestUrl))) return false;
  const keptType = facts.resourceType === "document" ? !facts.subFrame : KEPT_TYPES.has(facts.resourceType);
  return !keptType;
}

/** A host name for --allow-host: labels of letters, digits and hyphens (an IPv4 address matches too); no scheme, port or path. */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The host names of an --allow-host list (comma-separated), lowercased, de-duplicated and sorted. Throws with the text
 * the CLI prints for a value that is not a bare host name (IPv6 literals are not accepted).
 */
export function parseAllowHosts(text: string): string[] {
  const hosts = text
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  if (hosts.length === 0) throw new Error("--allow-host needs at least one host name");
  for (const host of hosts) {
    if (!HOST_PATTERN.test(host)) {
      throw new Error(`--allow-host takes host names (example.com), not ${JSON.stringify(host.slice(0, 200))}`);
    }
  }
  return [...new Set(hosts)].sort();
}

/**
 * The policy the scan flags name: --allow-third-party turns blocking off, --allow-host keeps the named hosts while
 * blocking stays on. The two together are refused: a kept host means nothing when nothing is blocked.
 */
export function thirdPartyFromFlags(allowAll: boolean, hosts: readonly string[] | undefined): ThirdPartyPolicy {
  if (allowAll && hosts !== undefined) throw new Error("--allow-host has no effect with --allow-third-party");
  if (allowAll) return { block: false, allowHosts: [] };
  return { block: true, allowHosts: hosts ?? [] };
}
