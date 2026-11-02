// The route patterns of a Next.js app, read from its route files: `app/**/page.*` (the App Router) and `pages/**` (the
// Pages Router). Only the file names are read, not the source. A dynamic segment `[slug]` is `*`; a catch-all `[...slug]`
// is `**` (one segment or more), and an optional catch-all `[[...slug]]` is `**?` (none or more). Route groups `(shop)` are
// dropped; parallel slots `@modal`, intercepting routes `(.)photo` and private folders `_lib` are not routes. A URL maps to
// its most specific matching pattern, and that pattern's route file is the URL's file. Pure functions over the file list and
// the URLs: no files are read here.
import { stripControls } from "./text.js";

/** The App Router page file, under app/ or src/app/ (the segment path before `page.*`). */
const APP_PAGE = /^(?:src\/)?app\/(?:(.*)\/)?page\.(?:tsx|ts|jsx|js|mdx)$/;
/** The Pages Router file, under pages/ or src/pages/ (the path before the extension). */
const PAGES_FILE = /^(?:src\/)?pages\/(.+)\.(?:tsx|ts|jsx|js|mdx)$/;
/** Pages Router files that are not routes of their own. */
const PAGES_SPECIAL = new Set(["_app", "_document", "_error", "404", "500"]);

/** One route of the app: its pattern, its segments, and the file that renders it. */
export interface AppRoute {
  /** The pattern as a path: `/`, `/blog/*`, `/docs/**`, `/shop/**?`. */
  pattern: string;
  /** Its segments: a static text, `*` for one segment, `**` for one or more of the rest, `**?` for zero or more. */
  segments: string[];
  /** The route file, relative to the app folder's root (e.g. `app/blog/[slug]/page.tsx`). */
  file: string;
}

/** The segment list of a route folder or page path, or undefined when the path is not a route. */
function segmentsOf(folders: string[], app: boolean): string[] | undefined {
  const out: string[] = [];
  for (const seg of folders) {
    if (seg === "") continue;
    if (app) {
      if (seg.startsWith("@")) return undefined; // a parallel slot
      if (/^\(\.{1,3}\)/.test(seg)) return undefined; // an intercepting route: (.) (..) (...)
      if (seg.startsWith("_")) return undefined; // a private folder
      if (/^\(.*\)$/.test(seg)) continue; // a route group
    }
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) {
      out.push("**?");
    } else if (/^\[\.\.\.[^\]]+\]$/.test(seg)) {
      out.push("**");
    } else if (/^\[[^\]]+\]$/.test(seg)) {
      out.push("*");
    } else {
      out.push(seg);
    }
  }
  return out;
}

/** The route of one file, or undefined when the file is not a page. */
function routeOf(file: string): AppRoute | undefined {
  let segments: string[] | undefined;
  const app = APP_PAGE.exec(file);
  if (app) {
    segments = segmentsOf((app[1] ?? "").split("/"), true);
  } else {
    const pages = PAGES_FILE.exec(file);
    if (pages === null) return undefined;
    const parts = pages[1].split("/");
    if (parts[0] === "api" || PAGES_SPECIAL.has(parts[parts.length - 1])) return undefined;
    if (parts[parts.length - 1] === "index") parts.pop();
    segments = segmentsOf(parts, false);
  }
  if (segments === undefined) return undefined;
  const pattern = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  return { pattern, segments, file };
}

/**
 * The routes of a list of files (paths relative to the app folder's root, forward slashes). A pattern that two files give
 * keeps the first one in path order, so the result is the same on every run.
 */
export function routesFromFiles(files: string[]): AppRoute[] {
  const seen = new Map<string, AppRoute>();
  for (const file of [...files].sort()) {
    const route = routeOf(file);
    if (route !== undefined && !seen.has(route.pattern)) seen.set(route.pattern, route);
  }
  return [...seen.values()];
}

/** The rank of each segment of a pattern that matches a path: static 3, one segment 2, the rest of the path 1. */
function rankOf(segments: string[], path: string[]): number[] | undefined {
  const wild = segments.findIndex((s) => s.startsWith("**"));
  const head = wild === -1 ? segments : segments.slice(0, wild);
  // A required catch-all needs one segment or more; an optional one (**?) matches the head alone too.
  if (wild === -1 ? segments.length !== path.length : path.length < head.length + (segments[wild] === "**" ? 1 : 0)) return undefined;
  const ranks: number[] = [];
  for (let i = 0; i < head.length; i++) {
    if (head[i] === "*") {
      if (path[i] === "") return undefined;
      ranks.push(2);
    } else if (head[i] === path[i]) {
      ranks.push(3);
    } else {
      return undefined;
    }
  }
  if (wild !== -1) ranks.push(1);
  return ranks;
}

/** Negative when `a` is more specific than `b` (the first differing segment rank decides; a missing rank is 0). */
function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The path segments of a URL (decoded), or undefined when the URL does not parse. */
export function pathSegmentsOf(url: string): string[] | undefined {
  try {
    return new URL(url).pathname
      .split("/")
      .filter((s) => s !== "")
      .map((s) => {
        // Control characters out of decoded segments (see text.ts): a route type is printed as it is.
        try {
          return stripControls(decodeURIComponent(s));
        } catch {
          return stripControls(s);
        }
      });
  } catch {
    return undefined;
  }
}

/** The most specific route that matches a URL's path, or undefined. Ties keep the earlier route of the list. */
export function matchRoute(url: string, routes: AppRoute[]): AppRoute | undefined {
  const path = pathSegmentsOf(url);
  if (path === undefined) return undefined;
  let best: { route: AppRoute; ranks: number[] } | undefined;
  for (const route of routes) {
    const ranks = rankOf(route.segments, path);
    if (ranks === undefined) continue;
    if (best === undefined || compareRanks(ranks, best.ranks) < 0) best = { route, ranks };
  }
  return best?.route;
}

/**
 * The route file of each URL of a set: the file of its most specific matching route, or undefined when no route matches.
 * The route type of a URL is its URL template (routes.ts); the file is an attribute of the URL, for the report and the
 * locate step.
 */
export function routeFileOf(url: string, routes: AppRoute[]): string | undefined {
  return matchRoute(url, routes)?.file;
}

/** A segment of a pattern that takes any value (`*`, `**`, `**?`). */
const isDynamic = (segment: string): boolean => segment.startsWith("*");

/** The static routes (no parameters) as URLs of an origin: they are seeds of a crawl even when no link reaches them. */
export function staticRouteUrls(origin: string, routes: AppRoute[]): string[] {
  return seedUrlsOf(origin, routes, []);
}

/**
 * The seed URLs of an origin from the app's routes: every static route, and every route under a dynamic first segment
 * (`/[store]/about-us`) once for each learned value of that segment (see learnedValues). A route with a dynamic segment
 * after its first one is not a seed: a crawl finds those pages from links.
 */
export function seedUrlsOf(origin: string, routes: AppRoute[], values: string[]): string[] {
  const out: string[] = [];
  for (const route of routes) {
    if (!route.segments.some(isDynamic)) {
      out.push(route.pattern === "/" ? `${origin}/` : `${origin}${route.pattern}`);
    } else if (route.segments[0] === "*" && !route.segments.slice(1).some(isDynamic)) {
      const rest = route.segments.slice(1);
      for (const value of values) out.push([origin, value, ...rest].join("/"));
    }
  }
  return [...new Set(out)];
}

/** The first path segment of a URL as written (not decoded), or undefined for the home page or a URL that does not parse. */
function firstSegmentOf(url: string): string | undefined {
  try {
    return new URL(url).pathname.split("/").filter((s) => s !== "")[0];
  } catch {
    return undefined;
  }
}

/**
 * The values a dynamic first segment (`[store]`, `[locale]`) takes on a site, learned from the URLs the home page led to.
 * `seen` is the home page's final URL first, then its links. The first segment of the final URL (where the home page
 * redirects) comes first; the other values follow, most frequent first. A segment that names a static route of the app
 * (`about-us`, `api`) is not a value, and nor is one with a dot. At most `max` values.
 */
export function learnedValues(seen: string[], routes: AppRoute[], max: number): string[] {
  const reserved = new Set(routes.filter((r) => r.segments[0] !== undefined && !isDynamic(r.segments[0])).map((r) => r.segments[0]));
  const valid = (segment: string | undefined): segment is string =>
    segment !== undefined && segment !== "" && !segment.includes(".") && !segment.startsWith("_") && !reserved.has(segment) && segment !== "api";
  const counts = new Map<string, number>();
  for (const url of seen.slice(1)) {
    const segment = firstSegmentOf(url);
    if (valid(segment)) counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  const first = firstSegmentOf(seen[0] ?? "");
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([segment]) => segment);
  const values = valid(first) ? [first, ...ranked.filter((segment) => segment !== first)] : ranked;
  return values.slice(0, Math.max(0, max));
}
