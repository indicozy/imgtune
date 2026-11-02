// `imgtune run`: the whole agent flow in one command. Survey every URL, full-scan the worst pages, locate them on a dev
// server (optional), group the fix hints by call site, and write a run directory with a manifest that names every file and
// every command it ran. The summary it prints is the one `imgtune summary <run dir>` prints.
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { writeFileAtomic } from "./atomic.js";
import { parseGpuDevice } from "./gpu.js";
import { hintsCommand, parseQualities } from "./hints.js";
import { locateCommand } from "./locate-only.js";
import { surveyStop, withBroken, BROKEN_EXIT } from "./broken.js";
import { DEFAULT_THIRD_PARTY, parseAllowHosts, thirdPartyFromFlags, type ThirdPartyPolicy } from "./third-party.js";
import {
  MAX_IDLE_TIMEOUT_MS,
  MAX_PAGE_CONCURRENCY,
  pageFileName,
  parseLimit,
  parseRange,
  readStorageState,
  rootOf,
  runScan,
  scanPlan,
  type ScanArgs,
  type PageResult,
  type StorageState,
} from "./remote.js";
import { sampleByPattern, urlsFromSource } from "./urls.js";
import { groupRoutes, parseRouteMap, type RouteGrouping, type RouteMapRule } from "./routes.js";
import { selectDeepPages, type DeepPick, type LeftOutType } from "./deep.js";
import { showPath, summaryCommand } from "./summary.js";
import { safeText, shellWord } from "./text.js";
import { IMGTUNE_VERSION } from "./version.js";
import type { Viewport } from "./types.js";

/** Where a run's directory goes when --out is not given: a timestamped folder under this. */
export const DEFAULT_RUN_DIR = ".imgtune/run";
/** The deep pages when --deep is not given: one per route type, the heaviest types first. */
export const DEFAULT_DEEP = 20;

export interface RunArgs {
  urls: string[];
  urlsFrom?: string;
  samplePerPattern?: number;
  out?: string;
  deep: number;
  gpu?: { device: number };
  pageConcurrency?: number;
  idleTimeoutMs?: number;
  noCache: boolean;
  /** --dev: the origin of the dev server; the deep pages are located at the same paths on it. */
  dev?: string;
  /** --qualities: the framework's allowed qualities, passed to hints. */
  qualities?: number[];
  root?: string;
  storageState?: string;
  ignoreRobots: boolean;
  /** Third-party requests: allowed by default; --block-third-party turns blocking on, --allow-host keeps hosts. */
  thirdParty: ThirdPartyPolicy;
  /** --route-map: a file of route rules (see routes.ts), read when the run starts. */
  routeMap?: string;
}

const RUN_USAGE =
  "usage: imgtune run <url> [<url> ...] | --urls-from <file|sitemap> [--sample-per-pattern N] [--deep N] [--route-map file] [--out dir] [--dev origin] [--qualities list] [--gpu] [--gpu-device n] [--page-concurrency N] [--idle-timeout ms] [--no-cache] [--root dir] [--storage-state file] [--ignore-robots] [--block-third-party] [--allow-host h1,h2]";

function parseHttpUrl(text: string, what: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${what} ${safeText(text)} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${what} ${safeText(text)} is not an http or https URL`);
  return url.href;
}

/** The arguments after `run`. Throws with the message the CLI prints. */
export function parseRunArgs(argv: string[]): RunArgs {
  const args: RunArgs = { urls: [], deep: DEFAULT_DEEP, noCache: false, ignoreRobots: false, thirdParty: DEFAULT_THIRD_PARTY };
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
      const value = argValue(argv, i, arg);
      i++;
      args.gpu = { device: parseGpuDevice(value) };
    } else if (
      arg === "--out" ||
      arg === "--urls-from" ||
      arg === "--sample-per-pattern" ||
      arg === "--deep" ||
      arg === "--page-concurrency" ||
      arg === "--idle-timeout" ||
      arg === "--dev" ||
      arg === "--qualities" ||
      arg === "--root" ||
      arg === "--storage-state" ||
      arg === "--allow-host" ||
      arg === "--route-map"
    ) {
      const value = argValue(argv, i, arg);
      i++;
      if (arg === "--out") args.out = value;
      else if (arg === "--urls-from") args.urlsFrom = value;
      else if (arg === "--sample-per-pattern") args.samplePerPattern = parseLimit(arg, value);
      else if (arg === "--deep") args.deep = parseLimit(arg, value);
      else if (arg === "--page-concurrency") args.pageConcurrency = parseRange(arg, value, 1, MAX_PAGE_CONCURRENCY);
      else if (arg === "--idle-timeout") args.idleTimeoutMs = parseRange(arg, value, 0, MAX_IDLE_TIMEOUT_MS);
      else if (arg === "--dev") args.dev = new URL(parseHttpUrl(value, "--dev")).origin;
      else if (arg === "--qualities") args.qualities = parseQualities(value);
      else if (arg === "--root") args.root = value;
      else if (arg === "--allow-host") allowHosts = parseAllowHosts(value);
      else if (arg === "--route-map") args.routeMap = value;
      else args.storageState = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${safeText(arg)} (${RUN_USAGE})`);
    } else {
      args.urls.push(parseHttpUrl(arg, "URL"));
    }
  }
  if (args.urls.length === 0 && args.urlsFrom === undefined) throw new Error(RUN_USAGE);
  if (args.samplePerPattern !== undefined && args.urlsFrom === undefined) throw new Error("--sample-per-pattern needs --urls-from");
  args.thirdParty = thirdPartyFromFlags(blockThirdParty, allowHosts);
  return args;
}

function argValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

/** The dev URL of a deep page: the same path and query on the dev origin. */
export function devUrlOf(devOrigin: string, pageUrl: string): string {
  const page = new URL(pageUrl);
  return `${devOrigin}${page.pathname}${page.search}`;
}

/** The URL list of a run: the named URLs, then --urls-from (deduplicated), then the per-type sample. */
export async function resolveUrls(
  args: RunArgs,
  cwd: string,
  log: (message: string) => void,
  routeMap: RouteMapRule[] = [],
): Promise<{ urls: string[]; routes: RouteGrouping }> {
  let urls = args.urls;
  if (args.urlsFrom !== undefined) {
    const source = await urlsFromSource(args.urlsFrom, cwd);
    const named = source.source === "list" ? "URL list" : source.source === "local-sitemap" ? "local sitemap" : "remote sitemap";
    const dropped = source.dropped > 0 ? `, ${source.dropped} on another domain dropped` : "";
    log(`--urls-from: ${source.urls.length} URL(s) from the ${named}${dropped}`);
    urls = [...new Set([...urls, ...source.urls])];
    if (args.samplePerPattern !== undefined) {
      const sample = sampleByPattern(urls, args.samplePerPattern, groupRoutes(urls, { routeMap }));
      log(`--sample-per-pattern ${args.samplePerPattern}: ${sample.urls.length} of ${urls.length} URL(s), ${sample.patterns} route type(s)`);
      urls = sample.urls;
    }
  }
  return { urls, routes: groupRoutes(urls, { routeMap }) };
}

/** The route-map rules of a --route-map file (read relative to cwd). Empty when there is none. */
export async function routeMapOf(args: RunArgs, cwd: string): Promise<RouteMapRule[]> {
  if (args.routeMap === undefined) return [];
  return parseRouteMap(await readFile(resolve(cwd, args.routeMap), "utf8"));
}

/** One step of the run, as the manifest records it. */
interface PhaseRecord {
  name: "survey" | "deep" | "locate" | "hints";
  seconds: number;
  pages?: number;
  ok?: number;
  broken?: number;
  /** Pages whose browser load failed (status "failed"): counted, so a phase's pages add up. */
  failed?: number;
  exitCode?: number;
}

/** A run directory's manifest (run.json). Paths are relative to the run directory; commands are relative to the cwd. */
export interface RunManifest {
  tool: "imgtune";
  version: string;
  startedAt: string;
  finishedAt: string;
  out: string;
  urls: { count: number; types: number; file: string };
  options: {
    deep: number;
    dev?: string;
    qualities?: number[];
    gpu?: number;
    pageConcurrency?: number;
    idleTimeoutMs?: number;
    noCache: boolean;
    root?: string;
    ignoreRobots: boolean;
    storageState: boolean;
    /** The third-party setting: "allowed" (the default) or "blocked" (--block-third-party). */
    thirdParty: "allowed" | "blocked";
    allowHosts?: string[];
    /** The --route-map file as it was given (relative to the cwd). Absent when there is none. */
    routeMap?: string;
  };
  deep: string[];
  /** The route types that were not deep-scanned, heaviest first, and why (the cap, or no images). */
  deepLeftOut: LeftOutType[];
  phases: PhaseRecord[];
  /** The commands the run executed, equivalent to the CLI calls: an agent can re-run one step from here. */
  commands: { phase: string; command: string }[];
  files: { path: string; kind: "urls" | "survey" | "deep" | "located" | "hints" | "manifest" | "report" }[];
  /** `check` and `audit` runs only: the mode, the site as the reader named it, and the Markdown report's file name. */
  mode?: "run" | "check" | "audit";
  site?: string;
  report?: string;
  broken: { url: string; phase: string; kind: string; reason: string; fix: string }[];
  /** `check` runs only: the deep pages that failed, and the page scanned in place of each (one retry). */
  deepRetries?: { type: string; failed: string; replacement: string }[];
  stop: { phase: "survey"; reason: string; fix: string } | null;
  warnings: string[];
  exitCode: number;
}

const stamp = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");

/** The run: the phases in order, the run directory, and the summary. */
export async function runCommand(
  argv: string[],
  cwd: string,
  log: (message: string) => void,
): Promise<{ output: string; exitCode: number }> {
  const args = parseRunArgs(argv);
  const started = new Date();
  const outRoot = resolve(cwd, args.out ?? join(DEFAULT_RUN_DIR, stamp(started)));
  const show = (path: string) => showPath(path, cwd);
  const routeMap = await routeMapOf(args, cwd);
  const { urls, routes } = await resolveUrls(args, cwd, log, routeMap);
  if (urls.length === 0) throw new Error("no URL to scan");
  await mkdir(outRoot, { recursive: true });
  const urlsFile = join(outRoot, "urls.txt");
  await writeFileAtomic(urlsFile, `${urls.join("\n")}\n`, { root: outRoot });

  const storageState: StorageState | undefined = args.storageState !== undefined ? await readStorageState(resolve(cwd, args.storageState)) : undefined;
  const root = await rootOf(args.root, cwd);
  const common = {
    cwd,
    root,
    log,
    storageState,
    cache: !args.noCache,
    ignoreRobots: args.ignoreRobots,
    aggressive: false,
    thirdParty: args.thirdParty,
  };
  const base: ScanArgs = { urls: [], out: outRoot, aggressive: false, quality: true, thirdParty: DEFAULT_THIRD_PARTY };
  const surveyPlan = scanPlan({ ...base, survey: true, pageConcurrency: args.pageConcurrency, idleTimeoutMs: args.idleTimeoutMs });
  const fullPlan = scanPlan({ ...base, pageConcurrency: args.pageConcurrency, idleTimeoutMs: args.idleTimeoutMs });
  const phases: PhaseRecord[] = [];
  const commands: RunManifest["commands"] = [];
  const warnings: string[] = [];
  const broken: RunManifest["broken"] = [];
  const flagWords = runFlags(args);
  const types = routes.types.length;

  // 1. Survey: every URL, fast and exact only.
  const surveyDir = join(outRoot, "survey");
  commands.push({
    phase: "survey",
    command: ["imgtune scan", "--urls-from", shellWord(show(urlsFile)), "--survey", "--out", shellWord(show(surveyDir)), ...flagWords.survey].join(" "),
  });
  log(`survey: ${urls.length} URL(s)`);
  const surveyStart = performance.now();
  const survey = await runScan(urls, {
    ...common,
    outDir: surveyDir,
    viewports: viewportsOf(surveyPlan.viewports),
    quality: surveyPlan.quality,
    survey: true,
    pageConcurrency: surveyPlan.pageConcurrency,
    idleTimeoutMs: surveyPlan.idleTimeoutMs,
  });
  phases.push(phaseOf("survey", surveyStart, survey));
  for (const page of survey) recordBroken(broken, "survey", page);

  // Fail fast: a survey that is mostly broken (or measured nothing) is not worth a deep phase.
  const stop = surveyStop(survey);
  if (stop.stop) {
    const exitCode = survey.some((p) => p.status === "broken") ? BROKEN_EXIT : 1;
    const manifest = await writeManifest(outRoot, cwd, {
      started,
      args,
      urls,
      types,
      deep: [],
      deepLeftOut: [],
      phases,
      commands,
      broken,
      stop: { phase: "survey", reason: stop.reason ?? "", fix: stop.fix ?? "" },
      warnings,
      exitCode,
    });
    log(`stopped before the deep phase: ${stop.reason}`);
    return { output: (await summaryCommand([outRoot], cwd)).output, exitCode: manifest.exitCode };
  }

  // 2. Deep: the worst pages (by exact KB per view, at least one per worst route pattern), full scan.
  const selection = selectDeepPages(survey, routes, args.deep);
  const deepUrls = selection.picks.map((pick) => pick.url);
  log(deepSelectionNote(selection.picks, selection.leftOut));
  const expected = new Map<string, number>();
  for (const page of survey) if (page.status === "ok") expected.set(page.url, page.counts.images);
  const deepDir = join(outRoot, "deep");
  commands.push({
    phase: "deep",
    command: ["imgtune scan", ...deepUrls.map(shellWord), "--out", shellWord(show(deepDir)), ...flagWords.deep].join(" "),
  });
  log(`deep: ${deepUrls.length} page(s), full scan`);
  const deepStart = performance.now();
  const deep = await runScan(deepUrls, {
    ...common,
    outDir: deepDir,
    viewports: viewportsOf(fullPlan.viewports),
    quality: fullPlan.quality,
    pageConcurrency: fullPlan.pageConcurrency,
    idleTimeoutMs: fullPlan.idleTimeoutMs,
    gpu: args.gpu,
    expectImages: (url) => expected.get(url),
  });
  phases.push(phaseOf("deep", deepStart, deep));
  for (const page of deep) recordBroken(broken, "deep", page);

  // 3. Locate: the deep pages at the same paths on the dev server (only with --dev).
  const deepOk = deep.filter((p) => p.status === "ok" && p.page !== undefined);
  const locatedDir = join(outRoot, "located");
  const hintFiles: string[] = [];
  if (args.dev !== undefined) {
    const locateStart = performance.now();
    for (const page of deepOk) {
      const from = join(deepDir, pageFileName(new URL(page.url)));
      const out = join(locatedDir, pageFileName(new URL(page.url)).replace(/\.json$/, ".located.json"));
      const dev = devUrlOf(args.dev, page.url);
      const locateArgs = [dev, "--locate-only", "--from", from, "--locate-out", out];
      if (args.root !== undefined) locateArgs.push("--root", args.root);
      if (args.ignoreRobots) locateArgs.push("--ignore-robots");
      commands.push({ phase: "locate", command: ["imgtune scan", shellWord(dev), "--locate-only", "--from", shellWord(show(from)), "--locate-out", shellWord(show(out))].join(" ") });
      try {
        const outcome = await locateCommand(locateArgs, cwd, log);
        if (!(await exists(out))) warnings.push(`located ${page.url}: no located file (${firstLine(outcome.output)})`);
      } catch (err) {
        warnings.push(`located ${page.url}: ${(err as Error).message}`);
      }
      hintFiles.push((await exists(out)) ? out : from);
    }
    phases.push({ name: "locate", seconds: secondsSince(locateStart), pages: deepOk.length, ok: deepOk.length });
  } else {
    for (const page of deepOk) hintFiles.push(join(deepDir, pageFileName(new URL(page.url))));
  }

  // 4. Hints: the fix hints of the deep pages, grouped by call site, as JSON (the summary reads it).
  const hintsFile = join(outRoot, "hints.json");
  if (hintFiles.length > 0) {
    const hintsStart = performance.now();
    const hintArgv = [...hintFiles, "--format", "json", ...(args.qualities !== undefined ? ["--qualities", args.qualities.join(",")] : [])];
    commands.push({
      phase: "hints",
      command: ["imgtune hints", ...hintFiles.map((f) => shellWord(show(f))), "--format json", ...(args.qualities !== undefined ? ["--qualities", args.qualities.join(",")] : []), `> ${shellWord(show(hintsFile))}`].join(" "),
    });
    const hints = await hintsCommand(hintArgv, cwd);
    await writeFileAtomic(hintsFile, hints.output, { root: outRoot });
    phases.push({ name: "hints", seconds: secondsSince(hintsStart), pages: hintFiles.length, exitCode: hints.exitCode });
  }

  const exitCode = deepOk.length === 0 ? 1 : 0;
  if (deepOk.length === 0) warnings.push("no deep page was measured: see the deep/ JSON files for the status of each page");
  await writeManifest(outRoot, cwd, {
    started,
    args,
    urls,
    types,
    deep: deepUrls,
    deepLeftOut: selection.leftOut,
    phases,
    commands,
    broken,
    stop: null,
    warnings,
    exitCode,
  });
  return { output: (await summaryCommand([outRoot], cwd)).output, exitCode };
}

/** The log line of the deep selection: the pages picked, and the route types left out (the cap, or no images). */
export function deepSelectionNote(picks: DeepPick[], leftOut: LeftOutType[]): string {
  const capped = leftOut.filter((t) => t.reason === "cap");
  const noImages = leftOut.filter((t) => t.reason === "no-images");
  const parts = [`deep: ${picks.length} route type(s), one page each (heaviest first)`];
  if (capped.length > 0) parts.push(`${capped.length} left out by --deep: ${capped.map((t) => safeText(t.type, 100)).join(", ")}`);
  if (noImages.length > 0) parts.push(`${noImages.length} without images: ${noImages.map((t) => safeText(t.type, 100)).join(", ")}`);
  return parts.join("; ");
}

/** The viewports a phase measures: the named ones, or all six. */
function viewportsOf(names: string[] | undefined): Viewport[] {
  return DEFAULT_VIEWPORTS.filter((v) => names === undefined || names.includes(v.name)).map((v) => ({ ...v }));
}

/** The passthrough flags of each phase, as the commands spell them. */
function runFlags(args: RunArgs): { survey: string[]; deep: string[] } {
  const common: string[] = [];
  if (args.root !== undefined) common.push("--root", shellWord(args.root));
  if (args.storageState !== undefined) common.push("--storage-state", shellWord(args.storageState));
  if (args.ignoreRobots) common.push("--ignore-robots");
  if (args.noCache) common.push("--no-cache");
  if (args.pageConcurrency !== undefined) common.push("--page-concurrency", String(args.pageConcurrency));
  if (args.idleTimeoutMs !== undefined) common.push("--idle-timeout", String(args.idleTimeoutMs));
  if (args.thirdParty.block) common.push("--block-third-party");
  if (args.thirdParty.allowHosts.length > 0) common.push("--allow-host", shellWord(args.thirdParty.allowHosts.join(",")));
  const deep = [...common];
  if (args.gpu !== undefined) deep.push("--gpu-device", String(args.gpu.device));
  return { survey: common, deep };
}

function recordBroken(broken: RunManifest["broken"], phase: string, page: PageResult): void {
  if (page.status !== "broken" || page.broken === undefined) return;
  broken.push({ url: page.url, phase, kind: page.broken.kind, reason: page.broken.reason, fix: page.broken.fix });
}

function phaseOf(name: "survey" | "deep", startedAt: number, pages: PageResult[]): PhaseRecord {
  return {
    name,
    seconds: secondsSince(startedAt),
    pages: pages.length,
    ok: pages.filter((p) => p.status === "ok").length,
    broken: pages.filter((p) => p.status === "broken").length,
    failed: pages.filter((p) => p.status === "failed").length,
  };
}

function secondsSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) / 100) / 10;
}

const firstLine = (text: string): string => safeText(text.split("\n")[0] ?? "");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file of the run directory, relative to it, by the folder it is in. */
export async function filesOf(outRoot: string): Promise<RunManifest["files"]> {
  const files: RunManifest["files"] = [{ path: "urls.txt", kind: "urls" }];
  const folders: [string, RunManifest["files"][number]["kind"]][] = [
    ["survey", "survey"],
    ["deep", "deep"],
    ["located", "located"],
  ];
  for (const [folder, kind] of folders) {
    if (!(await exists(join(outRoot, folder)))) continue;
    for (const name of (await readdir(join(outRoot, folder))).sort()) files.push({ path: `${folder}/${name}`, kind });
  }
  if (await exists(join(outRoot, "hints.json"))) files.push({ path: "hints.json", kind: "hints" });
  if (await exists(join(outRoot, "report.md"))) files.push({ path: "report.md", kind: "report" });
  files.push({ path: "run.json", kind: "manifest" });
  return files;
}

/** Writes run.json: the manifest, with the file list read from the run directory as it is now. */
export async function writeManifest(
  outRoot: string,
  cwd: string,
  run: {
    started: Date;
    args: RunArgs;
    urls: string[];
    types: number;
    deep: string[];
    deepLeftOut: LeftOutType[];
    phases: PhaseRecord[];
    commands: RunManifest["commands"];
    broken: RunManifest["broken"];
    stop: RunManifest["stop"];
    warnings: string[];
    exitCode: number;
  },
): Promise<RunManifest> {
  const { args } = run;
  const manifest: RunManifest = {
    tool: "imgtune",
    version: IMGTUNE_VERSION,
    startedAt: run.started.toISOString(),
    finishedAt: new Date().toISOString(),
    out: showPath(outRoot, cwd),
    urls: { count: run.urls.length, types: run.types, file: "urls.txt" },
    options: {
      deep: args.deep,
      dev: args.dev,
      qualities: args.qualities,
      gpu: args.gpu?.device,
      pageConcurrency: args.pageConcurrency,
      idleTimeoutMs: args.idleTimeoutMs,
      noCache: args.noCache,
      root: args.root,
      ignoreRobots: args.ignoreRobots,
      storageState: args.storageState !== undefined,
      thirdParty: args.thirdParty.block ? "blocked" : "allowed",
      ...(args.thirdParty.block && args.thirdParty.allowHosts.length > 0 ? { allowHosts: [...args.thirdParty.allowHosts] } : {}),
      ...(args.routeMap !== undefined ? { routeMap: args.routeMap } : {}),
    },
    deep: run.deep,
    deepLeftOut: run.deepLeftOut,
    phases: run.phases,
    commands: run.commands,
    files: [],
    broken: run.broken,
    stop: run.stop,
    warnings: run.warnings,
    exitCode: run.exitCode,
  };
  manifest.files = await filesOf(outRoot);
  await writeFileAtomic(join(outRoot, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`, { root: outRoot });
  return manifest;
}
