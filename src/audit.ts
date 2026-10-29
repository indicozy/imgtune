import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { analyse, type ComponentResult } from "./analyse.js";
import { applyResults, raiseQuality, renderApplyChanges, type ApplyResult, type RaiseResult } from "./apply.js";
import { sha1, writeFileAtomic } from "./atomic.js";
import { confirmNextDefault, withQuality, type ConfirmSample } from "./calibrate.js";
import { backupFiles, installRestoreHandlers, instrument, restore } from "./instrument.js";
import { measurePages, type ImageObservation } from "./measure.js";
import { readImageConfig, type ImageConfig } from "./nextconfig.js";
import { readReport, rank, renderTable, writeReport } from "./report.js";
import { buildRouteIndex, type RouteIndex } from "./routes.js";
import {
  detectDevCommand,
  detectRunningDevServer,
  runningServerMessage,
  startNext,
} from "./server.js";
import { listSourceFiles, scanFile } from "./scan.js";
import { isDone, loadState, type StateEntry } from "./state.js";
import { assertMetricAvailable, makeScorer } from "./metric.js";
import type { ImageUsage, ImgtuneConfig, QualityRaise } from "./types.js";
import { fetchSitemapUrls, resolveUrls, sitemapCandidates, type ResolvedUrls } from "./urls.js";
import type { RawImage } from "./ssim.js";

export type Log = (message: string) => void;

type Format = "avif" | "webp";
type ConfirmResult = { confirmed: boolean; ssim: { avif?: number; webp?: number }; bytes: { avif?: number; webp?: number } };

/** Directory the tool owns inside the project. */
export const TOOL_DIR = ".imgtune";
const NEXT_DEFAULT_QUALITY = 75;
const ORIGINAL_TIMEOUT_MS = 30_000;
const CONFIRM_READY_TIMEOUT_MS = 60_000;
const CONFIRM_POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 10_000;

export const progress: Log = (message) => {
  process.stderr.write(`imgtune: ${message}\n`);
};

/** Distinct items in first-seen order. */
export const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];

/** A route pattern with a dynamic segment (`[x]`, `[...x]`, `[[...x]]`). */
const isDynamicPattern = (pattern: string): boolean => pattern.includes("[");

const isNotFound = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/** Profile the analysis uses: a custom loader means the `cdn` profile, else Next's own optimizer. */
export const profileOf = (imageConfig: ImageConfig): "cdn" | "next-default" =>
  imageConfig.loaderFile ? "cdn" : "next-default";

/**
 * Usages to measure: every in-scope usage whose state entry does not match the current file content, unless
 * `includeDone`. `hashOf` returns the sha1 of a file as it is now.
 */
export function pendingUsages(
  usages: ImageUsage[],
  state: StateEntry[],
  hashOf: (file: string) => string,
  includeDone: boolean,
): ImageUsage[] {
  if (includeDone) return usages;
  const byId = new Map(state.map((entry) => [entry.usageId, entry]));
  return usages.filter((usage) => !isDone(byId.get(usage.id), hashOf(usage.file)));
}

/** Usages the audit leaves out because their state entry already matches the file: the already applied ones. */
export function alreadyAppliedUsages(usages: ImageUsage[], pending: ImageUsage[]): ImageUsage[] {
  const pendingIds = new Set(pending.map((usage) => usage.id));
  return usages.filter((usage) => !pendingIds.has(usage.id));
}

/** The already applied usages as a listing, one per line, under a heading. Empty when there are none. */
export function renderAlreadyApplied(done: ImageUsage[]): string {
  if (done.length === 0) return "";
  const lines = done.map((usage) => `  ${usage.component}  ${usage.relFile}:${usage.line}`);
  return ["already applied (use --all to re-measure):", ...lines].join("\n") + "\n";
}

/** Unique resolved paths of the given route patterns, in first-seen order. */
export function pagesFor(patterns: Iterable<string>, resolved: Map<string, ResolvedUrls>): string[] {
  return unique([...patterns].flatMap((pattern) => resolved.get(pattern)?.paths ?? []));
}

/** One message per in-scope dynamic route pattern that resolution left without a URL. */
export function unresolvedPatterns(
  scopePatterns: string[],
  resolved: Map<string, ResolvedUrls>,
  sitemapSource: string,
): string[] {
  return scopePatterns
    .filter((pattern) => isDynamicPattern(pattern) && (resolved.get(pattern)?.paths.length ?? 0) === 0)
    .map((pattern) => `no URL for ${pattern} (sitemap: ${sitemapSource}); add one under "urls" in imgtune.config.json`);
}

/** Nothing measured at all is an error, not an empty report. */
export function assertPagesResolved(pages: string[]): void {
  if (pages.length === 0) throw new Error("nothing to measure: no page URLs resolved");
}

/**
 * Sitemap candidates are tried in order; the first whose paths resolve at least one in-scope dynamic pattern wins.
 * Static-only scopes never read a sitemap. Returns the chosen resolution and the sitemap URL ("none" if none).
 */
export async function resolveScopeUrls(
  config: Pick<ImgtuneConfig, "projectDir" | "sitemapUrl" | "urls" | "market" | "maxPagesPerPattern">,
  allPatterns: string[],
  scopePatterns: string[],
  baseUrl: string,
  log: Log,
  fetchSitemap: (url: string) => Promise<string[]> = fetchSitemapUrls,
): Promise<{ resolved: Map<string, ResolvedUrls>; sitemapSource: string }> {
  const scopeDynamic = scopePatterns.filter(isDynamicPattern);
  if (scopeDynamic.length > 0) {
    for (const candidate of sitemapCandidates(config.projectDir, config, baseUrl)) {
      let paths: string[];
      try {
        paths = await fetchSitemap(candidate);
      } catch (err) {
        log(`sitemap ${candidate} unusable: ${(err as Error).message}`);
        continue;
      }
      const resolved = resolveUrls(allPatterns, paths, config);
      if (scopeDynamic.some((pattern) => resolved.get(pattern)?.source === "sitemap")) {
        return { resolved, sitemapSource: candidate };
      }
    }
  }
  return { resolved: resolveUrls(allPatterns, [], config), sitemapSource: "none" };
}

export type ConfirmPlan = "direct" | "edit-config" | "skip";

/**
 * How a next-default quality is confirmed. A quality next.config already lists (or 75 when no list is set) is
 * confirmed against the running app as is. Any other quality needs next.config to list it, which is only done
 * temporarily for a server the tool started.
 */
export function confirmPlan(
  q: number,
  imageConfig: Pick<ImageConfig, "qualities">,
  serverOwned: boolean,
): ConfirmPlan {
  const listed = imageConfig.qualities ? imageConfig.qualities.includes(q) : q === NEXT_DEFAULT_QUALITY;
  if (listed) return "direct";
  return serverOwned ? "edit-config" : "skip";
}

export interface ConfirmDeps {
  confirmNextDefault: (
    baseUrl: string,
    samples: ConfirmSample[],
    q: number,
    threshold: number,
    opts: { formats: Format[] },
  ) => Promise<ConfirmResult>;
  /**
   * Runs `body` while next.config lists `q`, then restores next.config. Resolves undefined when next.config cannot
   * take `q`, or the dev server does not serve it within the timeout (body is not run then).
   */
  withConfigQuality<T>(
    q: number,
    probe: { src: string; width: number },
    body: () => Promise<T>,
  ): Promise<T | undefined>;
}

export interface ConfirmContext {
  baseUrl: string;
  threshold: number;
  imageConfig: Pick<ImageConfig, "qualities" | "file">;
  serverOwned: boolean;
}

/** The `confirm` callback handed to analyse. Undefined means "not confirmed" (the result stays estimated). */
export function makeConfirm(ctx: ConfirmContext, deps: ConfirmDeps) {
  return async (
    samples: ConfirmSample[],
    q: number,
    formats: Format[],
  ): Promise<ConfirmResult | undefined> => {
    if (samples.length === 0) return undefined;
    const plan = confirmPlan(q, ctx.imageConfig, ctx.serverOwned);
    if (plan === "skip") return undefined;
    if (plan === "edit-config" && ctx.imageConfig.file === "") return undefined;

    const run = () => deps.confirmNextDefault(ctx.baseUrl, samples, q, ctx.threshold, { formats });
    const outcome =
      plan === "direct"
        ? await run()
        : await deps.withConfigQuality(q, { src: samples[0].src, width: samples[0].width }, run);
    if (!outcome) return undefined;
    return { confirmed: outcome.confirmed, ssim: outcome.ssim, bytes: outcome.bytes };
  };
}

/**
 * Downloads an original image once and keeps it under `.imgtune/cache/originals/<sha1(url)>`. A non-2xx response
 * throws and nothing is cached.
 */
export function makeFetchOriginal(
  projectDir: string,
  fetchImpl: typeof fetch = fetch,
): (url: string) => Promise<Buffer> {
  const dir = join(projectDir, TOOL_DIR, "cache", "originals");
  return async (url) => {
    const file = join(dir, sha1(url));
    try {
      return await readFile(file);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ORIGINAL_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET ${url} returned HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    await ensureToolDir(projectDir);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(file, bytes, { root: projectDir });
    return bytes;
  };
}

/** Creates `.imgtune` with a `.gitignore` that ignores everything in it, so the project's own ignore files stay untouched. */
export async function ensureToolDir(projectDir: string): Promise<void> {
  const dir = join(projectDir, TOOL_DIR);
  await mkdir(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) await writeFileAtomic(ignore, "*\n", { root: projectDir });
}

/** Project-relative paths of the report's files whose content no longer matches the audit-time hash. */
export async function changedSince(projectDir: string, fileHashes: Record<string, string>): Promise<string[]> {
  const changed: string[] = [];
  for (const [relFile, expected] of Object.entries(fileHashes)) {
    let current: string | undefined;
    try {
      current = sha1(await readFile(join(projectDir, relFile)));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    if (current !== expected) changed.push(relFile);
  }
  return changed;
}

async function scanAll(projectDir: string, paths: string[]): Promise<ImageUsage[]> {
  const files = await listSourceFiles(projectDir, paths);
  return files.flatMap((file) => scanFile(file, projectDir));
}

/** Runs `restore` and reports what an interrupted earlier run left behind. */
export async function restoreAndReport(projectDir: string, log: Log): Promise<void> {
  const { restored } = await restore(projectDir);
  if (restored.length > 0) {
    const names = restored.map((path) => relative(projectDir, path)).join(", ");
    log(`restored ${restored.length} file(s) left instrumented by an earlier run: ${names}`);
  }
}

export interface Measured {
  observations: ImageObservation[];
  baseUrl: string;
  /** Sitemap URL that supplied the dynamic paths, or "none". */
  sitemapSource: string;
  /** Stops the dev server when the tool started it; a no-op for `--url`. Safe to call twice. */
  stop(): Promise<void>;
}

interface ServerHandle {
  baseUrl: string;
  stop(): Promise<void>;
}

async function startServer(config: ImgtuneConfig, log: Log): Promise<ServerHandle> {
  if (config.url) {
    log(`using server ${config.url}`);
    return { baseUrl: config.url, stop: async () => {} };
  }
  const running = detectRunningDevServer(config.projectDir);
  if (running.running) throw new Error(runningServerMessage(running));

  log("starting server");
  const started = await startNext(config.projectDir, config.port, detectDevCommand(config.projectDir, config.devCommand));
  return { baseUrl: started.baseUrl, stop: started.stop };
}

/**
 * The measurement pipeline shared by audit and verify: route patterns for the given usages, a server, sitemap and
 * URL resolution, instrumentation, page loads, then restore. Instrumentation is always restored before this returns
 * or throws. The server stays up until the caller calls `stop`, because confirmation needs it.
 */
export async function measureUsages(
  config: ImgtuneConfig,
  usages: ImageUsage[],
  imageConfig: ImageConfig,
  log: Log,
): Promise<Measured> {
  const projectDir = config.projectDir;
  log("mapping routes");
  const index: RouteIndex = await buildRouteIndex(projectDir);
  const allPatterns = unique([...index.routesByFile.values()].flat().map((route) => route.pattern));
  const patternsOf = new Map(usages.map((usage) => [usage.id, index.routesFor(usage.file).map((r) => r.pattern)]));
  const scopePatterns = unique([...patternsOf.values()].flat());

  const server = await startServer(config, log);
  try {
    const { resolved, sitemapSource } = await resolveScopeUrls(
      config,
      allPatterns,
      scopePatterns,
      server.baseUrl,
      log,
    );
    log(`resolving urls (sitemap: ${sitemapSource})`);
    for (const message of unresolvedPatterns(scopePatterns, resolved, sitemapSource)) log(message);

    const pages = pagesFor(scopePatterns, resolved);
    assertPagesResolved(pages);
    const measured: Measured = { observations: [], baseUrl: server.baseUrl, sitemapSource, stop: server.stop };

    const instrumented = usages.filter((usage) => pagesFor(patternsOf.get(usage.id) ?? [], resolved).length > 0);
    try {
      log(`instrumenting ${instrumented.length} usages`);
      await instrument(projectDir, instrumented);
      log(`measuring ${pages.length} pages × ${config.viewports.length} viewports`);
      measured.observations = await measurePages(server.baseUrl, pages, config.viewports, {
        webpPass: profileOf(imageConfig) === "cdn",
      });
    } finally {
      log("restoring sources");
      await restore(projectDir);
    }
    return measured;
  } catch (err) {
    await server.stop();
    throw err;
  }
}

/** Production dependencies for the confirmation callback. Confirmation scores with the configured metric. */
function confirmDepsFor(config: ImgtuneConfig, baseUrl: string, imageConfigFile: string): ConfirmDeps {
  const { projectDir } = config;
  const score = makeScorer(config.metric, { projectDir, binary: config.ssimulacra2Path });
  return {
    confirmNextDefault: (url, samples, q, threshold, opts) => confirmNextDefault(url, samples, q, threshold, { ...opts, score }),
    withConfigQuality: async (q, probe, body) => {
      const text = await readFile(imageConfigFile, "utf8");
      const edited = withQuality(text, q);
      if (edited === undefined) return undefined;

      await backupFiles(projectDir, [imageConfigFile]);
      try {
        await writeFileAtomic(imageConfigFile, edited, { root: projectDir, followSymlink: true });
        if (!(await waitForQuality(baseUrl, probe, q))) return undefined;
        return await body();
      } finally {
        await restore(projectDir);
      }
    },
  };
}

/** Polls the optimizer until it stops answering 400 for the quality, i.e. the dev server has reloaded next.config. */
async function waitForQuality(baseUrl: string, probe: { src: string; width: number }, q: number): Promise<boolean> {
  const url = `${baseUrl}/_next/image?url=${encodeURIComponent(probe.src)}&w=${probe.width}&q=${q}`;
  const deadline = Date.now() + CONFIRM_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) return true;
    } catch {
      // The server may still be restarting; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
  }
  return false;
}

export async function audit(config: ImgtuneConfig, opts: { log?: Log } = {}): Promise<ComponentResult[]> {
  const log = opts.log ?? progress;
  const projectDir = config.projectDir;

  await assertMetricAvailable(config.metric, config.ssimulacra2Path);
  await restoreAndReport(projectDir, log);
  installRestoreHandlers(projectDir);
  await ensureToolDir(projectDir);

  log("scanning");
  const usages = await scanAll(projectDir, config.paths);
  const state = await loadState(projectDir);
  const hashes = new Map<string, string>();
  for (const file of unique(usages.map((usage) => usage.file))) {
    hashes.set(file, sha1(await readFile(file)));
  }
  const pending = pendingUsages(usages, state, (file) => hashes.get(file) ?? "", config.includeDone);
  const done = alreadyAppliedUsages(usages, pending);
  if (pending.length === 0) {
    process.stdout.write(renderAlreadyApplied(done));
    log("nothing to measure: every usage is already done (use --all to re-measure)");
    return [];
  }

  const imageConfig = readImageConfig(projectDir);
  const measured = await measureUsages(config, pending, imageConfig, log);
  let ranked: ComponentResult[];
  try {
    log(`analysing ${pending.length} components`);
    const serverOwned = config.url === undefined;
    const confirm =
      profileOf(imageConfig) === "next-default"
        ? makeConfirm(
            {
              baseUrl: measured.baseUrl,
              threshold: config.threshold,
              imageConfig,
              serverOwned,
            },
            confirmDepsFor(config, measured.baseUrl, imageConfig.file),
          )
        : undefined;
    const results = await analyse(
      pending,
      measured.observations,
      imageConfig,
      config,
      measured.baseUrl,
      makeFetchOriginal(projectDir),
      { confirm, log },
    );
    ranked = rank(results);
  } finally {
    await measured.stop();
  }

  process.stdout.write(`${renderTable(ranked, config.metric)}\n`);
  process.stdout.write(renderAlreadyApplied(done));
  await writeReport(projectDir, ranked, { config, imageConfig, sitemapSource: measured.sitemapSource });
  log("done");
  return ranked;
}

/** `imgtune apply`: writes the last audit's proposals, refusing when any audited file changed since. */
export async function applyCommand(
  projectDir: string,
  log: Log = progress,
  opts: { allowGrowth?: boolean } = {},
): Promise<ApplyResult> {
  await restoreAndReport(projectDir, log);
  const report = await readReport(projectDir);
  const changed = await changedSince(projectDir, report.fileHashes);
  if (changed.length > 0) {
    throw new Error(`files changed since the audit: ${changed.join(", ")}; re-run imgtune audit`);
  }

  const usages = await scanAll(projectDir, report.config.paths);
  const result = await applyResults(projectDir, report.results, usages, {
    expectedHashes: report.fileHashes,
    allowGrowth: opts.allowGrowth,
  });
  for (const file of result.edited) process.stdout.write(`edited ${file}\n`);
  process.stdout.write(renderApplyChanges(result.changes));
  for (const skip of result.skipped) process.stdout.write(`skipped ${skip.usageId}: ${skip.reason}\n`);
  process.stdout.write(`review with: git diff\n`);
  return result;
}

/** `apply --raise`: raises the applied quality of the named usages and says what changed. Nothing else is applied. */
export async function raiseCommand(projectDir: string, raises: QualityRaise[], log: Log = progress): Promise<RaiseResult> {
  await restoreAndReport(projectDir, log);
  const result = await raiseQuality(projectDir, raises);
  for (const file of result.edited) process.stdout.write(`edited ${file}\n`);
  for (const r of result.raised) process.stdout.write(`raised ${r.component} quality ${r.from} -> ${r.to}\n`);
  process.stdout.write(`run imgtune verify to measure it\n`);
  return result;
}

/** `imgtune restore`: undoes an interrupted run's instrumentation. */
export async function restoreCommand(projectDir: string): Promise<void> {
  const { restored } = await restore(projectDir);
  if (restored.length === 0) {
    process.stdout.write("nothing to restore\n");
    return;
  }
  process.stdout.write(`restored ${restored.length} file(s):\n`);
  for (const path of restored) process.stdout.write(`  ${relative(projectDir, path)}\n`);
}
