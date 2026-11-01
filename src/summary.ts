// `imgtune summary`: the one-screen read of a run (or of scan files). The renderer is pure and never prints more than
// MAX_SUMMARY_LINES lines, so an agent decides the next step from it without opening the JSON.
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { hintsCommand } from "./hints.js";
import { safeText } from "./text.js";
import { pageFileName, type PageResult, siteNumbers, surveyLabelOf } from "./remote.js";
import { candidatesOf, patternRanking } from "./worst.js";
import type { RunManifest } from "./run.js";

/** The most lines the summary prints. */
export const MAX_SUMMARY_LINES = 40;
/** Rows shown in each table; the rest are counted on one line. */
const PATTERN_ROWS = 3;
const DEEP_ROWS = 5;
const CALL_SITE_ROWS = 10;
const WARNING_ROWS = 3;
const NEXT_ROWS = 2;
/** Longest label printed for a page or a call site, in characters. */
const LABEL_WIDTH = 34;

/** One call site of the hints: its saving per view, where it is, and why it is not located when it is not. */
export interface CallSite {
  saved: number;
  file?: string;
  line?: number;
  component?: string;
  count: number;
  pages: number;
  /** For a call site with no file:line: why it is not located. */
  reason?: string;
}

/** Everything the renderer prints. The loaders build it from a run directory or from scan files. */
export interface SummaryInput {
  heading: string;
  /** The run directory, as shown to the reader. */
  out?: string;
  timings: { name: string; seconds: number }[];
  surveyLabel?: string;
  /** The survey's pages (every status). Absent for a scan of files. */
  survey?: PageResult[];
  /** The full-scan pages (every status), in the order they were scanned. */
  deep: PageResult[];
  /** Call sites worst first; undefined when the hints were not read. */
  callSites?: CallSite[];
  stop?: { reason: string; fix: string };
  warnings: string[];
  next: string[];
}

const trim = (text: string, width: number): string => {
  const clean = safeText(text);
  return clean.length <= width ? clean : `${clean.slice(0, width - 3)}...`;
};

/** A path as the reader should type it: relative to the working directory when it is inside it, else absolute. */
export function showPath(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? absolute : rel;
}

/** The path and query of a page URL, the short label of a page in the tables. */
export function labelOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

const kbText = (kb: number): string => kb.toFixed(1);
const pctText = (value: number): string => `${value.toFixed(1)}%`;

/** The lines of the summary, capped at MAX_SUMMARY_LINES (the row limits keep it under the cap; the cap is the backstop). */
export function renderSummary(input: SummaryInput): string {
  const lines: string[] = [input.heading];
  if (input.out !== undefined) lines.push(`out: ${safeText(input.out)}`);
  if (input.timings.length > 0) {
    const total = input.timings.reduce((sum, t) => sum + t.seconds, 0);
    const parts = input.timings.map((t) => `${t.name} ${t.seconds.toFixed(0)} s`).join(", ");
    lines.push(`time: ${total.toFixed(0)} s total (${parts})`);
  }
  lines.push("");
  if (input.stop !== undefined) {
    lines.push(`STOPPED before the deep phase: ${safeText(input.stop.reason)}`, `  fix: ${safeText(input.stop.fix)}`, "");
  }
  if (input.survey !== undefined) lines.push(...surveyBlock(input.survey, input.surveyLabel), "");
  else if (input.surveyLabel !== undefined) lines.push(safeText(input.surveyLabel), "");
  if (input.deep.length > 0) lines.push(...deepBlock(input.deep), "");
  if (input.callSites !== undefined) lines.push(...callSiteBlock(input.callSites), "");
  if (input.warnings.length > 0) lines.push(...listBlock("warnings", input.warnings, WARNING_ROWS), "");
  if (input.next.length > 0) lines.push(...listBlock("next", input.next, NEXT_ROWS));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > MAX_SUMMARY_LINES) {
    const cut = lines.length - (MAX_SUMMARY_LINES - 1);
    return `${[...lines.slice(0, MAX_SUMMARY_LINES - 1), `... ${cut} line(s) cut: the JSON files have the rest`].join("\n")}\n`;
  }
  return `${lines.join("\n")}\n`;
}

/** The survey: its page counts, the label (exact only), the site totals, and the worst route patterns. */
function surveyBlock(survey: PageResult[], label: string | undefined): string[] {
  const ok = survey.filter((p) => p.status === "ok" && p.page !== undefined);
  const count = (status: string) => survey.filter((p) => p.status === status).length;
  const broken = count("broken");
  const other = survey.length - ok.length - broken;
  const lines: string[] = [`survey: ${survey.length} page(s), ${ok.length} ok, ${broken} broken, ${other} not measured`];
  if (label !== undefined) lines.push(`  ${safeText(label.replace(/^survey: /, ""))}`);
  const numbers = ok.map((p) => p.page as NonNullable<PageResult["page"]>);
  lines.push(
    numbers.length === 0
      ? "  site: no page measured"
      : `  site (${numbers.length} ok, mean): image KB/view ${kbText(siteNumbers(numbers).meanImageBytes / 1024)} · exact ${pctText(siteNumbers(numbers).exactPct)} · exact + est. ${pctText(siteNumbers(numbers).exactEstPct)}`,
  );
  const ranks = patternRanking(candidatesOf(survey));
  if (ranks.length > 0) {
    const shown = Math.min(PATTERN_ROWS, ranks.length);
    lines.push(`  worst patterns (mean exact KB/view per page, ${shown} of ${ranks.length} shown):`);
    for (const rank of ranks.slice(0, PATTERN_ROWS)) {
      lines.push(`    ${trim(rank.pattern, 22).padEnd(22)} ${String(rank.pages).padStart(3)} page(s)  ${kbText(rank.meanExactKB).padStart(6)} KB  worst ${trim(labelOf(rank.worst.url), 30)}`);
    }
  }
  return lines;
}

/** The full-scan pages, worst first by exact KB per view. */
function deepBlock(deep: PageResult[]): string[] {
  const ok = deep.filter((p) => p.status === "ok" && p.page !== undefined);
  const sorted = [...ok].sort((a, b) => exactOf(b) - exactOf(a) || a.url.localeCompare(b.url));
  const shown = Math.min(DEEP_ROWS, sorted.length);
  const lines = [`deep: ${deep.length} page(s) full-scanned, ${ok.length} ok (${shown} of ${ok.length} shown, worst first)`];
  if (sorted.length === 0) return lines;
  lines.push(
    `  ${"page".padEnd(LABEL_WIDTH)} ${"KB/view".padStart(8)} ${"exact".padStart(7)} ${"exact+est".padStart(10)} ${"sharp KB".padStart(9)}`,
  );
  for (const page of sorted.slice(0, DEEP_ROWS)) {
    const n = page.page as NonNullable<PageResult["page"]>;
    lines.push(
      `  ${trim(labelOf(page.url), LABEL_WIDTH).padEnd(LABEL_WIDTH)} ${kbText(n.meanImageBytes / 1024).padStart(8)} ${pctText(n.exactPct).padStart(7)} ${pctText(n.exactEstPct).padStart(10)} ${`+${n.sharpnessKB.toFixed(1)}`.padStart(9)}`,
    );
  }
  return lines;
}

const exactOf = (page: PageResult): number => {
  const n = page.page as NonNullable<PageResult["page"]>;
  return (n.meanImageBytes * n.exactPct) / 100;
};

function callSiteBlock(sites: CallSite[]): string[] {
  if (sites.length === 0) return ["call sites by saving per view: none (no deep page has a fix hint)"];
  const lines = [`call sites by saving per view (top ${Math.min(CALL_SITE_ROWS, sites.length)} of ${sites.length}):`];
  sites.slice(0, CALL_SITE_ROWS).forEach((site, index) => {
    const saved = `${(site.saved / 1024).toFixed(1)} KB`.padStart(9);
    const where =
      site.file !== undefined
        ? `${trim(`${site.file}:${site.line ?? 0}`, 52)}${site.component !== undefined ? ` (${trim(site.component, 20)})` : ""}`
        : `not located: ${trim(site.reason ?? "no source found", 60)}`;
    lines.push(`  ${String(index + 1).padStart(2)}. ${saved}  ${where}  ${site.count} img, ${site.pages} page(s)`);
  });
  return lines;
}

/** A titled list: the count in the title, and only the first `limit` rows. */
function listBlock(title: string, rows: string[], limit: number): string[] {
  const head = rows.length > limit ? `${title} (${rows.length}, first ${limit} shown):` : `${title}:`;
  return [head, ...rows.slice(0, limit).map((row) => `  ${trim(row, 150)}`)];
}

// ---------------------------------------------------------------------------------------------------------------------
// Loading: a run directory (run.json, survey/, deep/, located/, hints.json) or a list of scan files
// ---------------------------------------------------------------------------------------------------------------------

/** The page JSON files of a folder: the ones that hold a scan result (a url and an image list). */
export async function readPages(dir: string): Promise<PageResult[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json") && !name.endsWith(".located.json") && name !== "hints.json").sort();
  } catch {
    return [];
  }
  const pages: PageResult[] = [];
  for (const name of names) pages.push(await readPageFile(join(dir, name)));
  return pages;
}

async function readPageFile(file: string): Promise<PageResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${safeText(file)} as a scan file: ${(err as Error).message}`);
  }
  const page = parsed as Partial<PageResult> | null;
  if (page === null || typeof page !== "object" || typeof page.url !== "string" || !Array.isArray(page.images)) {
    throw new Error(`${safeText(file)} is not a scan file (no url and image list)`);
  }
  return page as PageResult;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads the call sites of the pages' scan files (the grouped hints, worst first). */
async function callSitesOf(files: string[], cwd: string, qualities?: string): Promise<CallSite[]> {
  const argv = [...files, "--format", "json"];
  if (qualities !== undefined) argv.push("--qualities", qualities);
  const { output } = await hintsCommand(argv, cwd);
  return callSitesFromJson(output);
}

/** The call sites of the hints JSON (the `callSites` of `hints --format json`). */
export function callSitesFromJson(text: string): CallSite[] {
  const body = JSON.parse(text) as { callSites?: { saved: number; file?: string | null; line?: number | null; component?: string[]; count: number; pages: string[]; hints?: { find?: { component: string; glob: string } }[] }[] };
  return (body.callSites ?? []).map((site) => {
    const out: CallSite = { saved: site.saved, count: site.count, pages: site.pages.length };
    if (typeof site.file === "string") {
      out.file = site.file;
      out.line = typeof site.line === "number" ? site.line : 0;
    } else {
      const find = site.hints?.[0]?.find;
      out.reason = find !== undefined ? `search ${find.component} in ${find.glob}` : "no source found";
    }
    if (site.component?.[0] !== undefined) out.component = site.component[0];
    return out;
  });
}

/** The warnings the pages themselves carry: broken pages by kind, and pages that were not measured, by status. */
function pageWarnings(label: string, pages: PageResult[]): string[] {
  const warnings: string[] = [];
  const broken = pages.filter((p) => p.status === "broken" && p.broken !== undefined);
  const byKind = new Map<string, { reason: string; fix: string; n: number }>();
  for (const page of broken) {
    const info = page.broken as NonNullable<PageResult["broken"]>;
    const entry = byKind.get(info.kind);
    if (entry) entry.n++;
    else byKind.set(info.kind, { reason: info.reason, fix: info.fix, n: 1 });
  }
  for (const entry of byKind.values()) warnings.push(`${label}: ${entry.n} page(s) broken: ${entry.reason}`);
  const notMeasured = new Map<string, number>();
  for (const page of pages) {
    if (page.status === "ok" || page.status === "broken") continue;
    notMeasured.set(page.status, (notMeasured.get(page.status) ?? 0) + 1);
  }
  if (notMeasured.size > 0) {
    const detail = [...notMeasured].map(([status, n]) => `${n} ${status}`).join(", ");
    warnings.push(`${label}: not measured: ${detail}`);
  }
  const robotsIgnored = pages.filter((p) => p.robotsIgnored === true).length;
  if (robotsIgnored > 0) warnings.push(`${label}: ${robotsIgnored} page(s) scanned past robots.txt (--ignore-robots)`);
  return warnings;
}

/** The located pages' gaps: flagged images with no file:line, by the page's locate summary. */
async function locateWarnings(dir: string): Promise<string[]> {
  const warnings: string[] = [];
  let names: string[];
  try {
    names = (await readdir(join(dir, "located"))).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return warnings;
  }
  for (const name of names) {
    const page = await readPageFile(join(dir, "located", name));
    const locate = page.locate;
    if (locate === undefined || locate.notJoined === 0) continue;
    const reasons = Object.entries(locate.reasons).map(([code, n]) => `${n} ${code}`).join(", ");
    warnings.push(`located ${labelOf(page.url)}: ${locate.notJoined} of ${locate.flagged} flagged image(s) not located (${reasons})`);
  }
  return warnings;
}

/** `imgtune summary <dir|scan files...> [--qualities list]`: the arguments after `summary`. */
export async function summaryCommand(argv: string[], cwd: string): Promise<{ output: string; exitCode: number }> {
  let qualities: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--qualities") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--qualities needs a list, e.g. 75,85,100");
      qualities = value;
      i++;
    } else if (argv[i].startsWith("--")) {
      throw new Error(`Unknown option ${safeText(argv[i])} (usage: imgtune summary <run dir | scan.json ...> [--qualities list])`);
    } else {
      paths.push(argv[i]);
    }
  }
  if (paths.length === 0) throw new Error("usage: imgtune summary <run dir | scan.json ...> [--qualities list]");
  const first = resolve(cwd, paths[0]);
  const isDir = paths.length === 1 && (await stat(first).then((s) => s.isDirectory(), () => false));
  if (isDir && (await exists(join(first, "run.json")))) {
    // The exit code is the run's own (its manifest), so a summary and the run that wrote it agree.
    const { input, exitCode } = await runDirInput(first, cwd);
    return { output: renderSummary(input), exitCode };
  }
  let files = paths.map((p) => resolve(cwd, p));
  if (isDir) {
    files = (await readdir(first)).filter((n) => n.endsWith(".json") && n !== "hints.json").sort().map((n) => join(first, n));
    if (files.length === 0) throw new Error(`${safeText(paths[0])} has no scan files and no run.json`);
  }
  return { output: renderSummary(await scanFilesInput(files, cwd, qualities)), exitCode: 0 };
}

async function runDirInput(dir: string, cwd: string): Promise<{ input: SummaryInput; exitCode: number }> {
  const manifest = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as RunManifest;
  const survey = (await exists(join(dir, "survey"))) ? await readPages(join(dir, "survey")) : undefined;
  const deep = (await exists(join(dir, "deep"))) ? await readPages(join(dir, "deep")) : [];
  const warnings: string[] = [];
  if (survey !== undefined) warnings.push(...pageWarnings("survey", survey));
  warnings.push(...pageWarnings("deep", deep));
  warnings.push(...(await locateWarnings(dir)));
  warnings.push(...(manifest.warnings ?? []));
  const qualities = manifest.options.qualities !== undefined ? ` --qualities ${manifest.options.qualities.join(",")}` : "";
  const next: string[] = [];
  if (manifest.stop != null) {
    next.push(`after the fix, run again: imgtune run --urls-from ${showPath(join(dir, manifest.urls.file), cwd)} --out <new dir>`);
  } else if (deep.some((p) => p.status === "ok")) {
    const located = (await exists(join(dir, "located"))) && (await readdir(join(dir, "located"))).some((n) => n.endsWith(".json"));
    if (located) {
      next.push(`imgtune hints ${showPath(join(dir, "located"), cwd)}/*.json --limit 10${qualities}`);
    } else {
      // The worst deep page, the one the table shows first (scan order is not the worst order).
      const worst = [...deep.filter((p) => p.status === "ok" && p.page !== undefined)].sort((a, b) => exactOf(b) - exactOf(a))[0];
      next.push(`locate: imgtune scan <dev-url> --locate-only --from ${showPath(join(dir, "deep", pageFileName(new URL(worst.url))), cwd)}`);
      next.push(`imgtune hints ${showPath(join(dir, "deep"), cwd)}/*.json --limit 10${qualities}`);
    }
  }
  const hintsFile = join(dir, "hints.json");
  const callSites = (await exists(hintsFile)) ? callSitesFromJson(await readFile(hintsFile, "utf8")) : undefined;
  const input: SummaryInput = {
    heading: `imgtune run: ${manifest.urls.count} URL(s), ${manifest.urls.patterns} pattern(s), exit ${manifest.exitCode}`,
    out: showPath(dir, cwd),
    timings: manifest.phases.map((p) => ({ name: p.name, seconds: p.seconds })),
    surveyLabel: survey !== undefined ? surveyLabelOf(survey) : undefined,
    survey,
    deep,
    callSites,
    stop: manifest.stop ?? undefined,
    warnings,
    next,
  };
  return { input, exitCode: manifest.exitCode };
}

async function scanFilesInput(files: string[], cwd: string, qualities?: string): Promise<SummaryInput> {
  const pages: PageResult[] = [];
  for (const file of files) pages.push(await readPageFile(resolve(cwd, file)));
  const callSites = await callSitesOf(files, cwd, qualities);
  const next = [`imgtune hints ${files.map((f) => showPath(f, cwd)).join(" ")} --limit 10${qualities ? ` --qualities ${qualities}` : ""}`];
  return {
    heading: `imgtune summary: ${pages.length} scan file(s)`,
    timings: [],
    surveyLabel: surveyLabelOf(pages),
    deep: pages,
    callSites,
    warnings: pageWarnings("scan", pages),
    next,
  };
}
