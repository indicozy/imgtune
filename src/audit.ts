// `imgtune audit`: the deep mode for your own Next.js app. It reads the app's route files (app/ and pages/, with src/) and its
// next.config (the allowed qualities), measures the production origin (--prod) the way `check` does, and, with --dev,
// locates the deep pages' images in the sources through the dev server. The report (report.md) names the file:line of every
// located fix and the route file of every route type. Preflight: the production home must load its stylesheets, or the
// audit stops with the likely cause (a CSS host the machine cannot reach: the CDN variable must be empty for next build and
// next start).
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { BROKEN_EXIT, brokenOf, type BrokenInfo } from "./broken.js";
import { locateCommand } from "./locate-only.js";
import { isLocalTarget } from "./address.js";
import { learnedValues, matchRoute, routeFileOf, routesFromFiles, seedUrlsOf, staticRouteUrls, type AppRoute } from "./app-routes.js";
import { CRAWL_DEPTH, crawlSite } from "./crawl.js";
import { nextQualities } from "./next-config.js";
import { DEFAULT_CHECK_SAMPLE, finishCheck, parseCheckFlags, routeMapOf, sampleUrls, scanCheckPages, type CheckArgs, type CheckSettings } from "./check.js";
import { groupRoutes, routeGrouping, type RouteGrouping, type RouteMapRule, type RouteOf } from "./routes.js";
import { urlsFromSource } from "./urls.js";
import { devUrlOf, type RunManifest } from "./run.js";
import { pageFileName, parseLimit, readStorageState, runScan, scanPlan, type PageResult, type StorageState } from "./remote.js";
import { safeText, shellWord } from "./text.js";
import type { Viewport } from "./types.js";

/** Where an audit's directory goes when --out is not given: a timestamped folder under this. */
export const DEFAULT_AUDIT_DIR = ".imgtune/audit";

/** The folders under the app root that hold route files. */
const SOURCE_DIRS = ["app", "src/app", "pages", "src/pages"];

const AUDIT_USAGE =
  "usage: imgtune audit --app <dir> --prod <origin> [--dev <origin>] [--urls-from <file|sitemap-url>] [--max-locales N] [--sample-per-pattern N] [--deep N] [--route-map file] [--out dir] [--qualities list] [--gpu] [--gpu-device n] [--page-concurrency N] [--idle-timeout ms] [--no-cache] [--ignore-robots] [--storage-state file] [--block-third-party] [--allow-host h1,h2]";

/** The values of a dynamic first segment (`[store]`, `[locale]`) the crawl expands, when --max-locales is not given. */
export const DEFAULT_MAX_LOCALES = 3;
/** The sitemap URLs an audit takes, at most: the rest are not listed (the report says how many there were). */
export const SITEMAP_URL_CAP = 5000;

export interface AuditArgs {
  /** --app: the Next.js app's root (the folder with app/ or pages/, and next.config). */
  app: string;
  /** --prod: the production origin that is measured. */
  prod: string;
  /** --dev: the dev server origin the deep pages are located on (optional). */
  dev?: string;
  /** --max-locales: the values of a dynamic first segment the crawl expands (see crawl.ts). */
  maxLocales: number;
  /** The check flags (the URL source is --urls-from, or the sitemap and crawl of --prod). */
  flags: CheckArgs;
}

function originOf(text: string, name: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} needs an http or https origin, not ${safeText(text)} (${AUDIT_USAGE})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} needs an http or https origin (${AUDIT_USAGE})`);
  return url.origin;
}

/** The arguments after `audit`. Throws with the message the CLI prints. */
export function parseAuditArgs(argv: string[]): AuditArgs {
  let app: string | undefined;
  let prod: string | undefined;
  let dev: string | undefined;
  let maxLocales = DEFAULT_MAX_LOCALES;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--max-locales") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value (${AUDIT_USAGE})`);
      maxLocales = parseLimit(arg, value);
      i++;
    } else if (arg === "--app" || arg === "--prod" || arg === "--dev") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value (${AUDIT_USAGE})`);
      i++;
      if (arg === "--app") app = value;
      else if (arg === "--prod") prod = originOf(value, "--prod");
      else dev = originOf(value, "--dev");
    } else {
      rest.push(arg);
    }
  }
  if (app === undefined) throw new Error(`audit needs --app <dir> (${AUDIT_USAGE})`);
  if (prod === undefined) throw new Error(`audit needs --prod <origin> (${AUDIT_USAGE})`);
  const flags = parseCheckFlags(rest);
  if (flags.target !== undefined) throw new Error(`audit takes --prod for the site, not the URL ${safeText(flags.target)} (${AUDIT_USAGE})`);
  return { app, prod, dev, maxLocales, flags };
}

const stamp = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");
const secondsSince = (startedAt: number): number => Math.round((performance.now() - startedAt) / 100) / 10;
const viewportsOf = (names: string[] | undefined): Viewport[] => DEFAULT_VIEWPORTS.filter((v) => names === undefined || names.includes(v.name)).map((v) => ({ ...v }));

/** The route files of an app: the files under app/, src/app/, pages/ and src/pages/ (paths relative to the app root). */
export async function sourceFilesOf(appRoot: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (absolute: string, relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return; // no such folder
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(absolute, entry.name), path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const dir of SOURCE_DIRS) await walk(join(appRoot, dir), dir);
  return files;
}

/**
 * The URLs of an audit. --urls-from replaces the discovery: its URLs as given, and no seeds are added. Otherwise the site is
 * crawled from its home page and from the app's seeds (its static routes, and its dynamic first segments expanded for the
 * values the home page leads to; see crawl.ts). The sitemap of --prod adds its URLs (capped, see SITEMAP_URL_CAP). A sitemap
 * that lists another host, when --prod is local, is read on --prod: its URLs are moved onto that origin, and the audit says so.
 */
export async function auditUrls(args: AuditArgs, appRoutes: AppRoute[], cwd: string, log: (message: string) => void): Promise<string[]> {
  if (args.flags.urlsFrom !== undefined) {
    const source = await urlsFromSource(args.flags.urlsFrom, cwd);
    log(`--urls-from: ${source.urls.length} URL(s) from ${safeText(args.flags.urlsFrom)}`);
    return [...new Set(source.urls)];
  }
  const prod = args.prod;
  const sitemap = `${prod}/sitemap.xml`;
  let sitemapUrls: string[] = [];
  try {
    const source = await urlsFromSource(sitemap, cwd, { rewriteOriginTo: isLocalTarget(prod) ? prod : undefined });
    if (source.urls.length > 0) {
      sitemapUrls = source.urls.slice(0, SITEMAP_URL_CAP);
      log(`sitemap ${sitemap}: ${source.urls.length} URL(s)${source.urls.length > sitemapUrls.length ? `, the first ${sitemapUrls.length} are used` : ""}`);
    }
    if (source.rewritten > 0) {
      log(`sitemap ${sitemap} lists ${source.rewritten} URL(s) on another host: they are read on ${safeText(prod)} instead (the other host is not fetched)`);
    }
  } catch (err) {
    log(`no sitemap at ${sitemap} (${safeText((err as Error).message, 200)})`);
  }

  const seeds = staticRouteUrls(prod, appRoutes);
  const dynamicFirst = appRoutes.some((r) => r.segments[0] === "*");
  const crawled = await crawlSite(prod, {
    depth: CRAWL_DEPTH,
    seeds,
    seedsAfterHome: (seen) => {
      if (!dynamicFirst) return [];
      const values = learnedValues(seen, appRoutes, args.maxLocales);
      log(`dynamic first segment: ${values.length} value(s) learned from the home page: ${values.map((v) => safeText(v, 80)).join(", ") || "none"}`);
      return seedUrlsOf(prod, appRoutes, values);
    },
  });
  log(`crawl from ${safeText(prod)}: ${crawled.length} page(s) from ${seeds.length} static seed(s) and the home page, up to ${CRAWL_DEPTH} links deep`);
  return [...new Set([...crawled, ...sitemapUrls])];
}

/**
 * The route types of an audit: groupRoutes (routes.ts) over the URLs, where the first segment of a URL that the app takes as a
 * dynamic segment (`[store]`, `[locale]`) is stripped first. That segment is a dimension of the site, not part of the page's
 * template, whatever its shape: groupRoutes strips only a locale-shaped one (`ae-en`), and a store named `el-seed` would
 * otherwise be a route type of its own. The device variant after it (`desktop`, `mobile`) is stripped the same way, as groupRoutes
 * strips it after a locale. The stripped values are kept as the URL's locale and variant. --route-map patterns match the path
 * after those segments.
 */
export function groupAuditRoutes(urls: string[], routes: AppRoute[], routeMap: RouteMapRule[]): RouteGrouping {
  const distinct = [...new Set(urls)];
  const keyOf = new Map<string, string>();
  const dimensionOf = new Map<string, { locale: string; variant?: string }>();
  for (const url of distinct) {
    const route = matchRoute(url, routes);
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    if (route === undefined || route.segments[0] !== "*" || parsed === undefined) {
      keyOf.set(url, url);
      continue;
    }
    const segments = parsed.pathname.split("/").filter((s) => s !== "");
    let rest = segments.slice(1);
    const variant = rest[0] === "desktop" || rest[0] === "mobile" ? rest[0] : undefined;
    if (variant !== undefined) rest = rest.slice(1);
    dimensionOf.set(url, variant === undefined ? { locale: segments[0] } : { locale: segments[0], variant });
    const stripped = new URL(url);
    stripped.pathname = `/${rest.join("/")}`;
    keyOf.set(url, stripped.href);
  }
  const grouped = groupRoutes([...new Set(keyOf.values())], { routeMap });
  const byKey = new Map(grouped.routes.map((r) => [r.url, r]));
  const out: RouteOf[] = distinct.map((url) => {
    const key = keyOf.get(url) as string;
    const found = byKey.get(key) as RouteOf;
    const route: RouteOf = { url, type: found.type, mapped: found.mapped };
    const dimension = dimensionOf.get(url);
    if (dimension !== undefined) {
      route.locale = dimension.locale;
      if (dimension.variant !== undefined) route.variant = dimension.variant;
    }
    return route;
  });
  return routeGrouping(out);
}

/** The route files of each route type: the files of its URLs' most specific routes, in the order the types are listed. */
export function routeFilesByType(grouping: RouteGrouping, routes: AppRoute[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const type of grouping.types) {
    const files = new Set<string>();
    for (const url of type.urls) {
      const file = routeFileOf(url, routes);
      if (file !== undefined) files.add(file);
    }
    out.set(type.type, [...files]);
  }
  return out;
}

/**
 * The preflight: the production home is loaded once (survey viewports). A home page whose stylesheets did not load is
 * returned as the broken info (the audit stops); any other outcome lets the audit go on.
 */
async function preflight(
  prod: string,
  settings: CheckSettings,
  outRoot: string,
  cwd: string,
  log: (message: string) => void,
  storageState: StorageState | undefined,
): Promise<BrokenInfo | undefined> {
  const plan = scanPlan({ urls: [], out: outRoot, aggressive: false, quality: true, thirdParty: settings.thirdParty, survey: true });
  const pages = await runScan([`${prod}/`], {
    cwd,
    log,
    storageState,
    cache: !settings.noCache,
    ignoreRobots: settings.ignoreRobots,
    aggressive: false,
    quality: false,
    thirdParty: settings.thirdParty,
    outDir: join(outRoot, "preflight"),
    viewports: viewportsOf(plan.viewports),
    survey: true,
    pageConcurrency: plan.pageConcurrency,
    idleTimeoutMs: plan.idleTimeoutMs,
  });
  const home = pages[0];
  if (home === undefined) return undefined;
  const info = home.broken ?? brokenOf(home);
  return info?.kind === "stylesheet" ? info : undefined;
}

/** The terminal text of a failed preflight: the cause, and the fix for it. */
function preflightText(info: BrokenInfo, prod: string): string {
  return [
    `imgtune audit: the home page of ${safeText(prod)} did not load its stylesheets, so its images would be measured on an unstyled page.`,
    "likely cause: the CSS is served from a CDN host this machine cannot reach. Rebuild and restart the app with the CDN variable",
    "empty for BOTH `next build` and `next start` (for example NEXT_PUBLIC_CDN_URL= ), then run the audit again.",
    `reason: ${safeText(info.reason, 300)}`,
    `fix: ${safeText(info.fix, 300)}`,
    "",
  ].join("\n");
}

/**
 * The locate step: each measured deep page is located at the same path on the dev server, with the app as the source root.
 * A page that does not locate keeps its measured record; the warnings name it.
 */
async function locateDeep(input: {
  dev: string;
  appRoot: string;
  cwd: string;
  log: (message: string) => void;
  outRoot: string;
  deep: PageResult[];
  ignoreRobots: boolean;
  warnings: string[];
  commands: RunManifest["commands"];
}): Promise<{ deep: PageResult[]; phase: RunManifest["phases"][number] }> {
  const started = performance.now();
  const deepDir = join(input.outRoot, "deep");
  const locatedDir = join(input.outRoot, "located");
  const out: PageResult[] = [];
  let attempted = 0;
  let located = 0;
  for (const page of input.deep) {
    if (page.status !== "ok" || page.page === undefined) {
      out.push(page);
      continue;
    }
    attempted++;
    const name = pageFileName(new URL(page.url));
    const from = join(deepDir, name);
    const to = join(locatedDir, name.replace(/\.json$/, ".located.json"));
    // The dev server is asked for the page the measure ended on: a page that redirects (the home page to its locale) would be refused.
    const dev = devUrlOf(input.dev, page.finalUrl ?? page.url);
    const args = [dev, "--locate-only", "--from", from, "--locate-out", to, "--root", input.appRoot];
    if (input.ignoreRobots) args.push("--ignore-robots");
    input.commands.push({
      phase: "locate",
      command: ["imgtune scan", shellWord(dev), "--locate-only", "--from", shellWord(from), "--locate-out", shellWord(to), "--root", shellWord(input.appRoot)].join(" "),
    });
    try {
      const outcome = await locateCommand(args, input.cwd, input.log);
      if (outcome.exitCode !== 0) input.warnings.push(`located ${safeText(page.url, 200)}: nothing located at the dev server`);
      out.push(JSON.parse(await readFile(to, "utf8")) as PageResult);
      located++;
    } catch (err) {
      input.warnings.push(`located ${safeText(page.url, 200)}: ${safeText((err as Error).message, 300)}`);
      out.push(page);
    }
  }
  return { deep: out, phase: { name: "locate", seconds: secondsSince(started), pages: attempted, ok: located } };
}

/** `imgtune audit`: the arguments after `audit`. Writes the audit directory and returns the terminal text and the exit code. */
export async function auditCommand(argv: string[], cwd: string, log: (message: string) => void): Promise<{ output: string; exitCode: number }> {
  const args = parseAuditArgs(argv);
  const started = new Date();
  const appRoot = resolve(cwd, args.app);
  const outRoot = resolve(cwd, args.flags.out ?? join(DEFAULT_AUDIT_DIR, stamp(started)));

  // 1. The source: the route files, and the allowed qualities (--qualities overrides next.config).
  const appRoutes = routesFromFiles(await sourceFilesOf(appRoot));
  if (appRoutes.length === 0) throw new Error(`no route files under ${safeText(args.app)}: expected app/**/page.* (or src/app) or pages/**`);
  const quality =
    args.flags.qualities !== undefined ? { qualities: args.flags.qualities, note: "allowed qualities from --qualities" } : await nextQualities(appRoot);
  log(`app: ${appRoutes.length} route(s); ${safeText(quality.note)}`);
  const settings: CheckSettings = { ...args.flags, qualities: quality.qualities };

  // 2. Preflight: the production home must load its stylesheets.
  await mkdir(outRoot, { recursive: true });
  const storageState = args.flags.storageState !== undefined ? await readStorageState(resolve(cwd, args.flags.storageState)) : undefined;
  const broken = await preflight(args.prod, settings, outRoot, cwd, log, storageState);
  if (broken !== undefined) return { output: preflightText(broken, args.prod), exitCode: BROKEN_EXIT };

  // 3. URLs, route types (the route file of each URL), the sample, and the survey and deep scan.
  const listed = await auditUrls(args, appRoutes, cwd, log);
  if (listed.length === 0) throw new Error("no URL to audit");
  const routeMap = await routeMapOf(args.flags.routeMap, cwd);
  const fullRoutes = groupAuditRoutes(listed, appRoutes, routeMap);
  const routeFiles = routeFilesByType(fullRoutes, appRoutes);
  const sample = args.flags.samplePerPattern ?? DEFAULT_CHECK_SAMPLE;
  const picked = sampleUrls(listed, fullRoutes, sample, log);
  const scans = await scanCheckPages({ cwd, log, outRoot, urls: picked.urls, routes: picked.routes, settings, storageState });

  // 4. Locate the deep pages on the dev server, when --dev is given.
  const warnings: string[] = [];
  const extraCommands: RunManifest["commands"] = [];
  const extraPhases: RunManifest["phases"] = [];
  if (args.dev !== undefined) {
    const located = await locateDeep({
      dev: args.dev,
      appRoot,
      cwd,
      log,
      outRoot,
      deep: scans.deep,
      ignoreRobots: settings.ignoreRobots,
      warnings,
      commands: extraCommands,
    });
    scans.deep = located.deep;
    extraPhases.push(located.phase);
  }

  // 5. The report and the manifest.
  const finished = await finishCheck({
    mode: "audit",
    title: "imgtune audit",
    cwd,
    outRoot,
    started,
    site: args.prod,
    listed: listed.length,
    routes: picked.routes,
    settings,
    sample,
    scans,
    storageState: args.flags.storageState !== undefined,
    extraPhases,
    extraCommands,
    warnings,
    qualitiesNote: quality.note,
    dev: args.dev,
    routeFiles,
  });
  return { output: finished.output, exitCode: finished.exitCode };
}

