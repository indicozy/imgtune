// The route patterns of a Next.js app, read from its route files: `app/**/page.*` (the App Router) and `pages/**` (the
// Pages Router). Only the file names are read, not the source. A dynamic segment `[slug]` is `*`, a catch-all `[...slug]`
// and an optional catch-all `[[...slug]]` are `**`; route groups `(shop)` are dropped; parallel slots `@modal`, intercepting
// routes `(.)photo` and private folders `_lib` are not routes. A URL maps to its most specific matching pattern, and that
// pattern's route file is the URL's route type. Pure functions over the file list and the URLs: no files are read here.
import { routeGrouping, type RouteGrouping, type RouteOf } from "./routes.js";

/** The App Router page file, under app/ or src/app/ (the segment path before `page.*`). */
const APP_PAGE = /^(?:src\/)?app\/(?:(.*)\/)?page\.(?:tsx|ts|jsx|js|mdx)$/;
/** The Pages Router file, under pages/ or src/pages/ (the path before the extension). */
const PAGES_FILE = /^(?:src\/)?pages\/(.+)\.(?:tsx|ts|jsx|js|mdx)$/;
/** Pages Router files that are not routes of their own. */
const PAGES_SPECIAL = new Set(["_app", "_document", "_error", "404", "500"]);

/** One route of the app: its pattern, its segments, and the file that renders it. */
export interface AppRoute {
  /** The pattern as a path: `/`, `/blog/*`, `/docs/**`. */
  pattern: string;
  /** Its segments: a static text, `*` for one segment, `**` for the rest of the path. */
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
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg) || /^\[\.\.\.[^\]]+\]$/.test(seg)) {
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
  const wild = segments.indexOf("**");
  const head = wild === -1 ? segments : segments.slice(0, wild);
  if (wild === -1 ? segments.length !== path.length : path.length < head.length) return undefined;
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
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
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
 * The route types of a URL set with the app's routes: a URL's type is its route file. A URL no route matches, or one that
 * does not parse, takes its type from `fallback` (the route grouping of the URLs, see routes.ts).
 */
export function appRouteGrouping(urls: string[], routes: AppRoute[], fallback: RouteGrouping): RouteGrouping {
  const distinct = [...new Set(urls)];
  const out: RouteOf[] = distinct.map((url) => {
    const route = matchRoute(url, routes);
    return route !== undefined ? { url, type: route.file, mapped: true } : { url, type: fallback.typeOf(url), mapped: false };
  });
  return routeGrouping(out);
}

/** The static routes (no parameters) as URLs of an origin: they are added to a URL list even when no sitemap lists them. */
export function staticRouteUrls(origin: string, routes: AppRoute[]): string[] {
  return routes
    .filter((r) => r.segments.every((s) => s !== "*" && s !== "**"))
    .map((r) => (r.pattern === "/" ? `${origin}/` : `${origin}${r.pattern}`));
}
