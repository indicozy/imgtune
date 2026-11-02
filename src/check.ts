// `imgtune check`: the production check. Browser only, no source, no dev server. The URLs (a site's sitemap, an origin's
// sitemap, one page, or a list) are surveyed on two viewports with exact savings only, then the heaviest page of each route
// type is full-scanned (six viewports, the quality estimate). It writes the run directory: the survey and deep JSON, the
// urls.txt, run.json (the manifest: `imgtune summary` reads it) and report.md (the report, built by check-report.ts).
// The phases are shared with `imgtune audit` (audit.ts): scanCheckPages and finishCheck.
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { writeFileAtomic } from "./atomic.js";
import { parseGpuDevice } from "./gpu.js";
import { parseQualities } from "./hints.js";
import { BROKEN_EXIT, surveyStop, type SurveyStop } from "./broken.js";
import { DEFAULT_THIRD_PARTY, parseAllowHosts, thirdPartyFromFlags, type ThirdPartyPolicy } from "./third-party.js";
import {
  MAX_IDLE_TIMEOUT_MS,
  MAX_PAGE_CONCURRENCY,
  parseLimit,
  parseRange,
  readStorageState,
  runScan,
  scanPlan,
  type PageResult,
  type StorageState,
} from "./remote.js";
import type { Viewport } from "./types.js";
import { restrictRoutes, groupRoutes, parseRouteMap, type RouteGrouping, type RouteMapRule } from "./routes.js";
import { sampleByPattern, urlsFromSource } from "./urls.js";
import { deepRetries, selectDeepPages, type DeepRetry, type DeepSelection } from "./deep.js";
import { buildCheckReport } from "./check-report.js";
import { DEFAULT_DEEP, deepSelectionNote, filesOf, type RunManifest } from "./run.js";
import { safeText, shellWord } from "./text.js";
import { IMGTUNE_VERSION } from "./version.js";

/** Where a check's directory goes when --out is not given: a timestamped folder under this. */
export const DEFAULT_CHECK_DIR = ".imgtune/check";
/** The URLs per route type the survey measures when --sample-per-pattern is not given. */
export const DEFAULT_CHECK_SAMPLE = 3;

/** The options a check and an audit share: the scan, the deep selection and the report. */
export interface CheckSettings {
  deep: number;
  /** --route-map: the file of route rules, relative to the cwd. */
  routeMap?: string;
  /** At most this many URLs per route type in the survey. Undefined: DEFAULT_CHECK_SAMPLE. */
  samplePerPattern?: number;
  gpu?: { device: number };
  pageConcurrency?: number;
  /** The framework's allowed qualities (--qualities): targets are snapped up to them. */
  qualities?: number[];
  idleTimeoutMs?: number;
  noCache: boolean;
  ignoreRobots: boolean;
  thirdParty: ThirdPartyPolicy;
}

/** The flags of `check` as parsed. The URL source (target or --urls-from) is checked by parseCheckArgs. */
export interface CheckArgs extends CheckSettings {
  /** The site origin, a sitemap URL, or one page URL (the positional argument). */
  target?: string;
  /** --urls-from: a URL list, a local sitemap, or a remote sitemap (instead of the target). */
  urlsFrom?: string;
  out?: string;
  storageState?: string;
}

const CHECK_USAGE =
  "usage: imgtune check <origin | sitemap-url | page-url> | --urls-from <file|sitemap-url> [--sample-per-pattern N] [--deep N] [--route-map file] [--out dir] [--qualities list] [--gpu] [--gpu-device n] [--page-concurrency N] [--idle-timeout ms] [--no-cache] [--ignore-robots] [--storage-state file] [--block-third-party] [--allow-host h1,h2]";

/**
 * The flags of `check`, with the positional URL as the target. Does not check that a URL source was given: audit uses it
 * too, with its own source. Throws with the message the CLI prints.
 */
export function parseCheckFlags(argv: string[]): CheckArgs {
  const args: CheckArgs = { deep: DEFAULT_DEEP, noCache: false, ignoreRobots: false, thirdParty: DEFAULT_THIRD_PARTY };
  let blockThirdParty = false;
  let allowHosts: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-cache") args.noCache = true;
    else if (arg === "--ignore-robots") args.ignoreRobots = true;
    else if (arg === "--block-third-party") blockThirdParty = true;
    // --allow-third-party: deprecated, accepted as a no-op (the note is printed by the CLI).
    else if (arg === "--allow-third-party") continue;
    else if (arg === "--gpu") args.gpu ??= { device: 0 };
    else if (arg === "--gpu-device") {
      args.gpu = { device: parseGpuDevice(valueOf(argv, i, arg)) };
      i++;
    } else if (
      arg === "--urls-from" ||
      arg === "--out" ||
      arg === "--sample-per-pattern" ||
      arg === "--deep" ||
      arg === "--route-map" ||
      arg === "--page-concurrency" ||
      arg === "--qualities" ||
      arg === "--idle-timeout" ||
      arg === "--storage-state" ||
      arg === "--allow-host"
    ) {
      const value = valueOf(argv, i, arg);
      i++;
      if (arg === "--urls-from") args.urlsFrom = value;
      else if (arg === "--out") args.out = value;
      else if (arg === "--sample-per-pattern") args.samplePerPattern = parseLimit(arg, value);
      else if (arg === "--deep") args.deep = parseLimit(arg, value);
      else if (arg === "--route-map") args.routeMap = value;
      else if (arg === "--page-concurrency") args.pageConcurrency = parseRange(arg, value, 1, MAX_PAGE_CONCURRENCY);
      else if (arg === "--qualities") args.qualities = parseQualities(value);
      else if (arg === "--idle-timeout") args.idleTimeoutMs = parseRange(arg, value, 0, MAX_IDLE_TIMEOUT_MS);
      else if (arg === "--storage-state") args.storageState = value;
      else allowHosts = parseAllowHosts(value);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${safeText(arg)} (${CHECK_USAGE})`);
    } else {
      if (args.target !== undefined) throw new Error(`check takes one site, sitemap or page URL, not two (${CHECK_USAGE})`);
      args.target = parseHttpUrl(arg);
    }
  }
  args.thirdParty = thirdPartyFromFlags(blockThirdParty, allowHosts);
  return args;
}

/** The arguments after `check`. Throws with the message the CLI prints. */
export function parseCheckArgs(argv: string[]): CheckArgs {
  const args = parseCheckFlags(argv);
  if (args.target === undefined && args.urlsFrom === undefined) throw new Error(CHECK_USAGE);
  if (args.target !== undefined && args.urlsFrom !== undefined) throw new Error("check takes a URL or --urls-from, not both");
  return args;
}

function valueOf(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function parseHttpUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${safeText(text)} is not a URL (${CHECK_USAGE})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${safeText(text)} is not an http or https URL`);
  return url.href;
}

/**
 * The URLs of a check and where they came from: --urls-from as given; an origin (no path) reads its /sitemap.xml, and
 * falls back to the home page alone when there is none; a URL that ends in .xml is a sitemap; any other URL is one page.
 */
export async function resolveCheckUrls(
  args: CheckArgs,
  cwd: string,
  log: (message: string) => void,
): Promise<{ urls: string[]; site: string }> {
  if (args.urlsFrom !== undefined) {
    const source = await urlsFromSource(args.urlsFrom, cwd);
    log(`--urls-from: ${source.urls.length} URL(s) from ${safeText(args.urlsFrom)}`);
    return { urls: source.urls, site: args.urlsFrom };
  }
  const target = new URL(args.target as string);
  if (target.pathname === "/" && target.search === "") {
    const sitemap = `${target.origin}/sitemap.xml`;
    try {
      const source = await urlsFromSource(sitemap, cwd);
      if (source.urls.length > 0) {
        log(`sitemap ${sitemap}: ${source.urls.length} URL(s)`);
        return { urls: source.urls, site: target.origin };
      }
    } catch (err) {
      log(`no sitemap at ${sitemap} (${safeText((err as Error).message, 200)}); checking the home page alone`);
    }
    return { urls: [target.href], site: target.origin };
  }
  if (/\.xml$/i.test(target.pathname)) {
    const source = await urlsFromSource(target.href, cwd);
    log(`sitemap ${target.href}: ${source.urls.length} URL(s)`);
    return { urls: source.urls, site: target.href };
  }
  return { urls: [target.href], site: target.href };
}

/** The route rules of a --route-map file (read relative to cwd). Empty when there is none. */
export async function routeMapOf(path: string | undefined, cwd: string): Promise<RouteMapRule[]> {
  if (path === undefined) return [];
  return parseRouteMap(await readFile(resolve(cwd, path), "utf8"));
}

/**
 * The URLs to survey: the list as read (deduplicated), and at most `perType` of each route type, spread over the type. The
 * grouping is read from the whole list, then restricted to the sample (see restrictRoutes).
 */
export function sampleUrls(
  urls: string[],
  fullRoutes: RouteGrouping,
  perType: number,
  log: (message: string) => void,
): { urls: string[]; routes: RouteGrouping } {
  const sample = sampleByPattern(urls, perType, fullRoutes);
  log(`--sample-per-pattern ${perType}: ${sample.urls.length} of ${urls.length} URL(s), ${sample.patterns} route type(s)`);
  return { urls: sample.urls, routes: restrictRoutes(fullRoutes, sample.urls) };
}

const stamp = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");
const secondsSince = (startedAt: number): number => Math.round((performance.now() - startedAt) / 100) / 10;
const viewportsOf = (names: string[] | undefined): Viewport[] => DEFAULT_VIEWPORTS.filter((v) => names === undefined || names.includes(v.name)).map((v) => ({ ...v }));

/** What the survey and the deep phase measured, and what the report and the manifest need from them. */
export interface CheckScans {
  survey: PageResult[];
  deep: PageResult[];
  selection: DeepSelection;
  /** The deep pages that failed to load, each with the page scanned in its place (one retry). */
  retries: DeepRetry[];
  /** Why the deep phase did not run, when it did not (the survey was mostly broken or measured nothing). */
  stop: SurveyStop;
  surveyViewports: string[];
  surveySeconds: number;
  deepSeconds: number;
  broken: RunManifest["broken"];
  commands: RunManifest["commands"];
}

/** The survey (every URL given, exact savings only) and the deep scan of the heaviest page of each route type. */
export async function scanCheckPages(input: {
  cwd: string;
  log: (message: string) => void;
  outRoot: string;
  urls: string[];
  routes: RouteGrouping;
  settings: CheckSettings;
  storageState?: StorageState;
}): Promise<CheckScans> {
  const { cwd, log, outRoot, urls, routes, settings } = input;
  const common = {
    cwd,
    log,
    storageState: input.storageState,
    cache: !settings.noCache,
    ignoreRobots: settings.ignoreRobots,
    aggressive: false,
    thirdParty: settings.thirdParty,
  };
  const base = { urls: [], out: outRoot, aggressive: false, quality: true, thirdParty: settings.thirdParty };
  const surveyPlan = scanPlan({ ...base, survey: true });
  const fullPlan = scanPlan({ ...base, pageConcurrency: settings.pageConcurrency, idleTimeoutMs: settings.idleTimeoutMs });
  const commands: RunManifest["commands"] = [];
  const broken: RunManifest["broken"] = [];

  const urlsFile = join(outRoot, "urls.txt");
  await writeFileAtomic(urlsFile, `${urls.join("\n")}\n`, { root: outRoot });

  // 1. Survey: every URL given (or the sample), exact savings only.
  const surveyDir = join(outRoot, "survey");
  commands.push({
    phase: "survey",
    command: [
      "imgtune scan",
      "--urls-from",
      shellWord(urlsFile),
      "--survey",
      "--out",
      shellWord(surveyDir),
      ...(settings.thirdParty.block ? ["--block-third-party"] : []),
      ...(settings.noCache ? ["--no-cache"] : []),
    ].join(" "),
  });
  log(`survey: ${urls.length} URL(s), ${routes.types.length} route type(s)`);
  const surveyStart = performance.now();
  const survey = await runScan(urls, {
    ...common,
    outDir: surveyDir,
    viewports: viewportsOf(surveyPlan.viewports),
    quality: false,
    survey: true,
    pageConcurrency: surveyPlan.pageConcurrency,
    idleTimeoutMs: surveyPlan.idleTimeoutMs,
  });
  const surveySeconds = secondsSince(surveyStart);
  for (const page of survey) if (page.status === "broken" && page.broken !== undefined) broken.push({ url: page.url, phase: "survey", kind: page.broken.kind, reason: page.broken.reason, fix: page.broken.fix });

  // 2. Deep: the heaviest page of each route type, full scan. Skipped when the survey is mostly broken or measured nothing.
  const stop = surveyStop(survey);
  let selection: DeepSelection = { picks: [], leftOut: [] };
  let deep: PageResult[] = [];
  let retries: DeepRetry[] = [];
  let deepSeconds = 0;
  if (!stop.stop) {
    const deepDir = join(outRoot, "deep");
    selection = selectDeepPages(survey, routes, settings.deep);
    log(deepSelectionNote(selection.picks, selection.leftOut));
    const deepUrls = selection.picks.map((pick) => pick.url);
    const expected = new Map<string, number>();
    for (const page of survey) if (page.status === "ok") expected.set(page.url, page.counts.images);
    const flags = [
      ...(settings.gpu !== undefined ? ["--gpu-device", String(settings.gpu.device)] : []),
      ...(settings.thirdParty.block ? ["--block-third-party"] : []),
      ...(settings.thirdParty.allowHosts.length > 0 ? ["--allow-host", shellWord(settings.thirdParty.allowHosts.join(","))] : []),
      ...(settings.noCache ? ["--no-cache"] : []),
      ...(settings.ignoreRobots ? ["--ignore-robots"] : []),
      ...(settings.pageConcurrency !== undefined ? ["--page-concurrency", String(settings.pageConcurrency)] : []),
      ...(settings.idleTimeoutMs !== undefined ? ["--idle-timeout", String(settings.idleTimeoutMs)] : []),
    ];
    commands.push({ phase: "deep", command: ["imgtune scan", ...deepUrls.map(shellWord), "--out", shellWord(deepDir), ...flags].join(" ") });
    log(`deep: ${deepUrls.length} page(s), full scan`);
    const deepRun = {
      ...common,
      outDir: deepDir,
      viewports: viewportsOf(fullPlan.viewports),
      quality: true,
      pageConcurrency: fullPlan.pageConcurrency,
      idleTimeoutMs: fullPlan.idleTimeoutMs,
      gpu: settings.gpu,
      expectImages: (url: string) => expected.get(url),
    };
    const deepStart = performance.now();
    deep = await runScan(deepUrls, deepRun);
    // A deep page the browser could not load (status failed) gets one retry: the next-heaviest measured page of its route
    // type, scanned in its place. The failed page stays in the results, so the counts and the report say it failed.
    retries = deepRetries(
      deep.filter((page) => page.status === "failed").map((page) => page.url),
      survey,
      routes,
      deepUrls,
    );
    if (retries.length > 0) {
      const replacements = retries.map((retry) => retry.replacement);
      commands.push({ phase: "deep", command: ["imgtune scan", ...replacements.map(shellWord), "--out", shellWord(deepDir), ...flags].join(" ") });
      log(`deep: ${retries.length} failed page(s) retried with the next-heaviest page of their route type`);
      deep = [...deep, ...(await runScan(replacements, deepRun))];
    }
    deepSeconds = secondsSince(deepStart);
    for (const page of deep) if (page.status === "broken" && page.broken !== undefined) broken.push({ url: page.url, phase: "deep", kind: page.broken.kind, reason: page.broken.reason, fix: page.broken.fix });
  }
  return {
    survey,
    deep,
    selection,
    retries,
    stop,
    surveyViewports: [...(surveyPlan.viewports ?? [])],
    surveySeconds,
    deepSeconds,
    broken,
    commands,
  };
}

/** What finishCheck writes and prints: the mode, the names, and the numbers the report and the manifest carry. */
export interface FinishInput {
  mode: "check" | "audit";
  /** The report's title and the first word of the terminal line: "imgtune check" or "imgtune audit". */
  title: string;
  cwd: string;
  outRoot: string;
  started: Date;
  /** The site as the reader named it (origin, sitemap, list, or the --prod origin). */
  site: string;
  /** The URLs the list had before sampling, and the URLs surveyed. */
  listed: number;
  routes: RouteGrouping;
  settings: CheckSettings;
  sample: number;
  scans: CheckScans;
  storageState: boolean;
  /** Extra phases after the survey and the deep scan (audit: locate). */
  extraPhases?: RunManifest["phases"];
  /** Extra commands the run executed (audit: locate). */
  extraCommands?: RunManifest["commands"];
  /** Extra warnings for the manifest (audit: a located page that failed). */
  warnings?: string[];
  /** The qualities note for the report (audit: assumed or read from next.config). */
  qualitiesNote?: string;
  /** The dev origin of an audit (--dev). */
  dev?: string;
  /** The route files of each route type (audit): the report's route-file column. */
  routeFiles?: Map<string, string[]>;
}

/** Writes report.md and run.json for a check or an audit, and returns the terminal text and the exit code. */
export async function finishCheck(input: FinishInput): Promise<{ output: string; exitCode: number; report: string }> {
  const { scans, settings, outRoot, started } = input;
  const surveySeconds = scans.surveySeconds;
  const deepSeconds = scans.deepSeconds;
  const deepOk = scans.deep.filter((p) => p.status === "ok" && p.page !== undefined);
  const deepFailed = scans.deep.filter((p) => p.status === "failed").length;
  const stop = scans.stop;

  const reportStart = performance.now();
  const report = buildCheckReport({
    title: input.title,
    site: input.site,
    date: started.toISOString().slice(0, 10),
    version: IMGTUNE_VERSION,
    survey: scans.survey,
    deep: scans.deep,
    routes: input.routes,
    selection: scans.selection,
    retries: scans.retries,
    urls: { listed: input.listed, surveyed: scans.survey.length },
    timings: { survey: surveySeconds, deep: deepSeconds },
    options: {
      surveyViewports: scans.surveyViewports,
      deepViewports: DEFAULT_VIEWPORTS.map((v) => v.name),
      qualities: settings.qualities,
      thirdParty: settings.thirdParty.block ? "blocked" : "allowed",
      allowHosts: settings.thirdParty.allowHosts.length > 0 ? [...settings.thirdParty.allowHosts] : undefined,
      gpu: settings.gpu?.device,
      quality: true,
      samplePerPattern: input.sample,
    },
    qualitiesNote: input.qualitiesNote,
    routeFiles: input.routeFiles,
    ...(stop.stop ? { stop: { reason: stop.reason ?? "", fix: stop.fix ?? "" } } : {}),
  });
  await writeFileAtomic(join(outRoot, "report.md"), report, { root: outRoot });
  const reportSeconds = secondsSince(reportStart);

  const exitCode = stop.stop ? (scans.survey.some((p) => p.status === "broken") ? BROKEN_EXIT : 1) : deepOk.length === 0 ? 1 : 0;
  const warnings: string[] = [...(input.warnings ?? [])];
  if (!stop.stop && deepOk.length === 0) warnings.push("no deep page was measured: see the deep/ JSON files for the status of each page");
  const manifest: RunManifest = {
    tool: "imgtune",
    version: IMGTUNE_VERSION,
    mode: input.mode,
    site: input.site,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    out: outRoot,
    urls: { count: scans.survey.length, types: input.routes.types.length, file: "urls.txt" },
    options: {
      deep: settings.deep,
      qualities: settings.qualities,
      gpu: settings.gpu?.device,
      pageConcurrency: settings.pageConcurrency,
      idleTimeoutMs: settings.idleTimeoutMs,
      noCache: settings.noCache,
      ignoreRobots: settings.ignoreRobots,
      storageState: input.storageState,
      thirdParty: settings.thirdParty.block ? "blocked" : "allowed",
      ...(settings.thirdParty.block && settings.thirdParty.allowHosts.length > 0 ? { allowHosts: [...settings.thirdParty.allowHosts] } : {}),
      ...(settings.routeMap !== undefined ? { routeMap: settings.routeMap } : {}),
      ...(input.dev !== undefined ? { dev: input.dev } : {}),
    },
    deep: scans.selection.picks.map((pick) => pick.url),
    deepLeftOut: scans.selection.leftOut,
    ...(scans.retries.length > 0 ? { deepRetries: scans.retries } : {}),
    phases: [
      { name: "survey", seconds: surveySeconds, pages: scans.survey.length, ok: scans.survey.filter((p) => p.status === "ok").length, broken: scans.survey.filter((p) => p.status === "broken").length, failed: scans.survey.filter((p) => p.status === "failed").length },
      ...(stop.stop ? [] : [{ name: "deep" as const, seconds: deepSeconds, pages: scans.deep.length, ok: deepOk.length, broken: scans.deep.filter((p) => p.status === "broken").length, failed: deepFailed }]),
      ...(input.extraPhases ?? []),
    ],
    commands: [...scans.commands, ...(input.extraCommands ?? [])],
    files: [],
    broken: scans.broken,
    stop: stop.stop ? { phase: "survey", reason: stop.reason ?? "", fix: stop.fix ?? "" } : null,
    warnings,
    exitCode,
    report: "report.md",
  };
  manifest.files = await filesOf(outRoot);
  await writeFileAtomic(join(outRoot, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`, { root: outRoot });

  const lines = [
    `${input.title}: ${safeText(input.site, 200)}: ${scans.survey.length} URL(s) surveyed, ${input.routes.types.length} route type(s), ${scans.selection.picks.length} deep page(s), ${deepOk.length} measured, ${deepFailed} failed, exit ${exitCode}`,
    `time: survey ${surveySeconds.toFixed(1)} s, deep ${deepSeconds.toFixed(1)} s, report ${reportSeconds.toFixed(1)} s`,
    `report: ${safeText(join(outRoot, "report.md"), 500)}`,
    `run:    ${safeText(join(outRoot, "run.json"), 500)}`,
  ];
  if (stop.stop) lines.push(`stopped before the deep phase: ${safeText(stop.reason ?? "", 300)}`);
  return { output: `${lines.join("\n")}\n`, exitCode, report };
}

/** `imgtune check`: the arguments after `check`. Writes the run directory and returns the terminal text and the exit code. */
export async function checkCommand(argv: string[], cwd: string, log: (message: string) => void): Promise<{ output: string; exitCode: number }> {
  const args = parseCheckArgs(argv);
  const started = new Date();
  const outRoot = resolve(cwd, args.out ?? join(DEFAULT_CHECK_DIR, stamp(started)));
  await mkdir(outRoot, { recursive: true });

  const routeMap = await routeMapOf(args.routeMap, cwd);
  const source = await resolveCheckUrls(args, cwd, log);
  const listed = source.urls.length;
  const urls = [...new Set(source.urls)];
  if (urls.length === 0) throw new Error("no URL to check");
  const fullRoutes = groupRoutes(urls, { routeMap });
  const sample = args.samplePerPattern ?? DEFAULT_CHECK_SAMPLE;
  const picked = sampleUrls(urls, fullRoutes, sample, log);
  const storageState: StorageState | undefined = args.storageState !== undefined ? await readStorageState(resolve(cwd, args.storageState)) : undefined;

  const scans = await scanCheckPages({ cwd, log, outRoot, urls: picked.urls, routes: picked.routes, settings: args, storageState });
  const finished = await finishCheck({
    mode: "check",
    title: "imgtune check",
    cwd,
    outRoot,
    started,
    site: source.site,
    listed,
    routes: picked.routes,
    settings: args,
    sample,
    scans,
    storageState: args.storageState !== undefined,
  });
  return { output: finished.output, exitCode: finished.exitCode };
}
