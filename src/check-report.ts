// The Markdown report of `imgtune check`: a pure builder over the survey results, the deep results, the route grouping and
// the deep selection. No browser, no files. The audit mode extends it with source-aware sections; the sections below keep
// their order so the two stay comparable. Page-derived text goes through mdText and mdCode (see text.ts).
import { hintsOf, type Hint } from "./hints.js";
import { hasFix, type ImageRecord } from "./images.js";
import { APPROX_MARK, siteNumbers, type PageResult } from "./remote.js";
import type { RouteGrouping } from "./routes.js";
import type { DeepSelection, LeftOutType } from "./deep.js";
import { mdCode, mdText } from "./text.js";

/** How many fixes, heavy pages, sharpness images and survey route types the report lists in full. */
export const REPORT_FIXES = 15;
export const REPORT_SHARPNESS = 15;
export const REPORT_PAGES = 10;

export interface CheckReportInput {
  /** The report's first line: "imgtune check" or "imgtune audit". */
  title?: string;
  /** The site or list the check was made of, as the reader named it. */
  site: string;
  /** The date of the run (YYYY-MM-DD). */
  date: string;
  /** The imgtune version. */
  version: string;
  /** The survey's results (every status) and the deep results (every status). */
  survey: PageResult[];
  deep: PageResult[];
  routes: RouteGrouping;
  selection: DeepSelection;
  /** The list's URL count, before sampling, and the URLs surveyed. */
  urls: { listed: number; surveyed: number };
  /** Seconds per phase: survey and deep (0 when not run). The report's own time is printed by the command, not here. */
  timings: { survey: number; deep: number };
  options: {
    surveyViewports: string[];
    deepViewports: string[];
    /** The framework's allowed qualities (--qualities), when given: targets are snapped up to them. */
    qualities?: number[];
    thirdParty: "allowed" | "blocked";
    allowHosts?: string[];
    /** The GPU device the deep scan scored on, when --gpu was given. */
    gpu?: number;
    quality: boolean;
    samplePerPattern?: number;
  };
  /** Why the deep phase did not run (the survey was mostly broken or measured nothing). */
  stop?: { reason: string; fix: string };
  /** Where the allowed qualities came from, when they were not given (audit: next.config.js, or the Next default). */
  qualitiesNote?: string;
  /** The route files each route type renders from (audit only): a route-file column in the route type table. */
  routeFiles?: Map<string, string[]>;
}

interface PageTotals {
  kb: number;
  exactKB: number;
  exactEstKB: number;
  exactPct: number;
  exactEstPct: number;
  sharpnessKB: number;
}

const kb = (value: number): string => value.toFixed(1);
const pct = (value: number): string => `${value.toFixed(1)}%`;
const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length);

/** The page numbers of a measured page as KB and percentages (the same arithmetic as siteNumbers, per page). */
function totalsOf(page: NonNullable<PageResult["page"]>): PageTotals {
  const bytesKB = page.meanImageBytes / 1024;
  return {
    kb: bytesKB,
    exactKB: (bytesKB * page.exactPct) / 100,
    exactEstKB: (bytesKB * page.exactEstPct) / 100,
    exactPct: page.exactPct,
    exactEstPct: page.exactEstPct,
    sharpnessKB: page.sharpnessKB,
  };
}

const measured = (pages: PageResult[]): PageResult[] => pages.filter((p) => p.status === "ok" && p.page !== undefined);

/** The percentile of a list, linearly interpolated between the two values around its rank (0 for an empty list). */
function percentile(values: number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = share * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/** One merged fix: the same change across deep pages (one file:line, or one image pattern with the same proposed sizes). */
export interface FixGroup {
  key: string;
  /** Where the image is: file:line when located, else its component, else its selector. */
  where: string;
  located: boolean;
  loader: string;
  /** The image's URL pattern (the loader's URL with w, q and the CDN transform taken out), when it has one. */
  pattern?: string;
  current: string;
  proposed: string;
  basis?: string;
  format?: string;
  quality?: { current: number; target?: number; snapFrom?: number; allowed?: number[]; void: boolean };
  /** Images the fix covers, summed over the pages. */
  images: number;
  pages: string[];
  /** Bytes saved per view, summed over the pages (the ranking key). */
  savedKBSum: number;
  /** Per page the fix applies to: the mean saving per view, and its sizes and quality parts. */
  savedKBPerPage: number;
  sizesKBPerPage: number;
  qualityKBPerPage: number;
  /** Sharpness bytes the fix adds per view (separate: never netted). */
  sharpnessKBPerPage: number;
}

/**
 * The fixes of the deep pages, merged. Each image with a fix (hints.ts) joins the group of its file:line when it is
 * located, else the group of its image pattern and proposed sizes. Qualities are snapped as the hints snap them.
 */
export function fixGroupsOf(deep: PageResult[], qualities?: number[]): FixGroup[] {
  const groups = new Map<string, { hints: Hint[]; loaders: string[]; patterns: (string | undefined)[]; located: boolean; key: string }>();
  for (const result of measured(deep)) {
    const records = new Map<string, ImageRecord>((result.images ?? []).map((r) => [r.id, r]));
    for (const hint of hintsOf(result, qualities)) {
      const record = records.get(hint.id);
      if (record === undefined || !hasFix(record)) continue;
      const located = hint.file !== undefined;
      const key = located ? `file:${hint.file}:${hint.line ?? 0}` : `src:${record.locator.urlPattern ?? hint.selector}|sizes:${hint.sizes.proposed ?? "-"}`;
      const group = groups.get(key) ?? { hints: [], loaders: [], patterns: [], located, key };
      group.hints.push(hint);
      group.loaders.push(record.locator.loader);
      group.patterns.push(record.locator.urlPattern);
      groups.set(key, group);
    }
  }
  const out: FixGroup[] = [];
  for (const group of groups.values()) {
    const first = group.hints[0];
    const pages = [...new Set(group.hints.map((h) => h.page))];
    const saved = group.hints.reduce((sum, h) => sum + h.bytes.saved, 0) / 1024;
    const sizes = group.hints.reduce((sum, h) => sum + (h.bytes.sizes ?? 0), 0) / 1024;
    const sharp = group.hints.reduce((sum, h) => sum + h.bytes.addedForSharpness, 0) / 1024;
    const targets = group.hints.map((h) => h.quality?.target).filter((t): t is number => t !== undefined);
    const quality = group.hints.find((h) => h.quality !== undefined)?.quality;
    const best = group.hints.map((h) => h.format?.best).find((f) => f !== undefined);
    const current = group.hints.map((h) => h.sizes.current).find((s) => s !== undefined) ?? "none";
    const proposed = group.hints.map((h) => h.sizes.proposed).find((s) => s !== undefined) ?? "-";
    const perPage = (value: number) => value / pages.length;
    out.push({
      key: group.key,
      where: group.located && first.file !== undefined ? `${first.file}:${first.line ?? 0}` : first.component[0] ?? first.selector,
      located: group.located,
      loader: [...new Set(group.loaders)].join(", "),
      pattern: group.patterns.find((p) => p !== undefined),
      current,
      proposed,
      basis: first.sizes.basis,
      format: best !== undefined && best !== first.format?.current ? best : undefined,
      ...(quality !== undefined
        ? {
            quality: {
              current: quality.current,
              target: targets.length > 0 ? Math.max(...targets) : undefined,
              snapFrom: quality.snapFrom,
              allowed: quality.allowed,
              void: group.hints.some((h) => h.quality?.void === true),
            },
          }
        : {}),
      images: group.hints.length,
      pages,
      savedKBSum: saved,
      savedKBPerPage: perPage(saved),
      sizesKBPerPage: perPage(sizes),
      qualityKBPerPage: perPage(saved - sizes),
      sharpnessKBPerPage: perPage(sharp),
    });
  }
  return out.sort((a, b) => b.savedKBSum - a.savedKBSum || a.key.localeCompare(b.key));
}

/** The line of one fix: where, the sizes and quality change, the saving per view and its pages. */
function fixLines(fix: FixGroup, rank: number): string[] {
  const where = fix.located ? mdCode(fix.where) : `${mdCode(fix.where)} (not located)`;
  const sizes = fix.current === fix.proposed ? "sizes unchanged" : `sizes ${mdCode(fix.current)} -> ${mdCode(fix.proposed)}${fix.basis ? ` (${mdText(fix.basis)})` : ""}`;
  const quality =
    fix.quality === undefined
      ? "quality -"
      : fix.quality.target === undefined
        ? `quality ${fix.quality.current}`
        : fix.quality.void
          ? `quality ${fix.quality.current} -> ${fix.quality.target} (snapped: void, counted as 0)`
          : `quality ${fix.quality.current} -> ${fix.quality.target}${fix.quality.snapFrom !== undefined ? ` (snapped from ${fix.quality.snapFrom}${fix.quality.allowed ? `, allowed ${fix.quality.allowed.join(",")}` : ""})` : ""}`;
  const saving = `saves ${kb(fix.savedKBPerPage)} KB/view per page (sizes ${kb(fix.sizesKBPerPage)} + quality ${kb(fix.qualityKBPerPage)})`;
  const source = fix.pattern !== undefined ? `, src ${mdCode(fix.pattern)}` : "";
  const where2 = `${fix.pages.length} page(s), ${fix.images} image(s), loader ${mdText(fix.loader)}${source}`;
  return [
    `${rank}. ${where}`,
    `   ${sizes}; ${quality}${fix.format ? `; format -> ${mdText(fix.format)}` : ""}`,
    `   ${saving}; sharpness +${kb(fix.sharpnessKBPerPage)} KB (separate)`,
    `   ${where2}: ${fix.pages.slice(0, 3).map((u) => mdCode(pathOf(u))).join(", ")}${fix.pages.length > 3 ? ` and ${fix.pages.length - 3} more` : ""}`,
  ];
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** The report of a check run, as Markdown. */
export function buildCheckReport(input: CheckReportInput): string {
  const survey = measured(input.survey);
  const deepOk = measured(input.deep);
  const surveyTotals = survey.map((p) => totalsOf(p.page as NonNullable<PageResult["page"]>));
  const deepTotals = deepOk.map((p) => totalsOf(p.page as NonNullable<PageResult["page"]>));
  const approx = deepOk.some((p) => p.page?.estApprox === true);
  const count = (pages: PageResult[], status: string) => pages.filter((p) => p.status === status).length;
  const total = (values: number[]) => values.reduce((sum, v) => sum + v, 0);
  const lines: string[] = [];
  const out = (...text: string[]) => lines.push(...text);

  // 1. Header.
  out(`# ${mdText(input.title ?? "imgtune check")}: ${mdCode(input.site)}`, "");
  out(`${input.date} · imgtune ${mdText(input.version)} · ${input.urls.listed} URL(s) listed, ${input.urls.surveyed} surveyed, ${input.routes.types.length} route type(s), ${input.selection.picks.length} deep page(s)`);
  out(
    `survey ${input.urls.surveyed} page(s): ${survey.length} ok, ${count(input.survey, "broken")} broken, ${input.survey.length - survey.length - count(input.survey, "broken")} not measured · deep ${input.deep.length} page(s): ${deepOk.length} ok`,
  );
  out(`time: survey ${input.timings.survey.toFixed(1)} s, deep ${input.timings.deep.toFixed(1)} s, total ${(input.timings.survey + input.timings.deep).toFixed(1)} s`, "");

  if (input.stop !== undefined) {
    out("## Stopped before the deep phase", "", `${mdText(input.stop.reason)}`, `Fix: ${mdText(input.stop.fix)}`, "");
  }

  // 2. Summary numbers.
  out("## Summary", "");
  if (survey.length > 0) {
    const numbers = siteNumbers(survey.map((p) => p.page as NonNullable<PageResult["page"]>));
    out(
      `- Survey (${survey.length} page(s), viewports ${input.options.surveyViewports.map(mdText).join(", ")}, exact savings only): mean image ${kb(numbers.meanImageBytes / 1024)} KB/view, exact ${pct(numbers.exactPct)} of image bytes.`,
    );
  } else {
    out("- Survey: no page measured.");
  }
  if (deepOk.length > 0) {
    const exact = mean(deepTotals.map((t) => t.exactKB));
    const exactEst = mean(deepTotals.map((t) => t.exactEstKB));
    const numbers = siteNumbers(deepOk.map((p) => p.page as NonNullable<PageResult["page"]>));
    out(
      `- Deep (${deepOk.length} page(s), viewports ${input.options.deepViewports.map(mdText).join(", ")}): mean image ${kb(numbers.meanImageBytes / 1024)} KB/view.`,
      `  - exact: ${kb(exact)} KB/view (${pct(numbers.exactPct)})`,
      `  - exact + est.: ${APPROX_MARK.trim()} ${kb(exactEst)} KB/view (${pct(numbers.exactEstPct)})${approx ? " (some estimates are approximate)" : ""}`,
      `  - sharpness: +${kb(mean(deepTotals.map((t) => t.sharpnessKB)))} KB/view, a separate number: it is never netted against the saving`,
    );
  } else {
    out("- Deep: no deep page measured.");
  }
  out("");

  // 3. Ranked fixes.
  out("## Ranked fixes", "");
  const fixes = fixGroupsOf(input.deep, input.options.qualities);
  if (fixes.length === 0) out("No deep image has a fix.", "");
  else {
    out(`Merged across the deep pages: one file:line when located, else one image pattern with the same proposed sizes. Ranked by the total saving over the pages. Top ${Math.min(REPORT_FIXES, fixes.length)} of ${fixes.length}.`, "");
    fixes.slice(0, REPORT_FIXES).forEach((fix, i) => out(...fixLines(fix, i + 1), ""));
  }

  // 4. Heavy but not wasteful.
  out("## Heavy but not wasteful", "");
  const heavyCut = percentile(deepTotals.map((t) => t.kb), 0.75);
  const heavy = deepOk.filter((p, i) => deepTotals[i].kb > heavyCut && deepTotals[i].exactEstPct < 2);
  if (heavy.length === 0) out("No deep page is above the 75th percentile of image KB per view with under 2% saving.", "");
  else {
    out(`Deep pages above the 75th percentile (${kb(heavyCut)} KB/view) with under 2% exact + est. saving: a fix to their sizes or quality saves little here, so the weight is in the images themselves.`, "");
    for (const page of heavy.sort((a, b) => (b.page?.meanImageBytes ?? 0) - (a.page?.meanImageBytes ?? 0))) {
      out(`- ${mdCode(pathOf(page.url))}: ${kb((page.page?.meanImageBytes ?? 0) / 1024)} KB/view, ${page.counts.images} image(s), exact + est. ${pct(page.page?.exactEstPct ?? 0)}`);
    }
    out("");
  }

  // 5. Too small (adds bytes).
  out("## Too small (adds bytes)", "");
  const sharp: { page: string; where: string; current: string; proposed: string; kb: number }[] = [];
  for (const result of deepOk) {
    for (const record of result.images ?? []) {
      if (record.fix.bytes.addedForSharpness <= 0) continue;
      sharp.push({
        page: pathOf(result.url),
        where: record.locator.file !== undefined ? `${record.locator.file}:${record.locator.line ?? 0}` : record.locator.component[0] ?? record.locator.selector,
        current: record.current.sizes ?? "none",
        proposed: record.fix.sizes?.value ?? "-",
        kb: record.fix.bytes.addedForSharpness / 1024,
      });
    }
  }
  if (sharp.length === 0) out("No image would get bigger for sharpness.", "");
  else {
    sharp.sort((a, b) => b.kb - a.kb || a.page.localeCompare(b.page));
    out(`${sharp.length} image(s) are shown smaller than their pixels need: a larger file adds bytes to keep the sharpness. Shown in full, largest first (top ${Math.min(REPORT_SHARPNESS, sharp.length)}).`, "");
    for (const row of sharp.slice(0, REPORT_SHARPNESS)) {
      out(`- ${mdCode(row.where)} on ${mdCode(row.page)}: sizes ${mdCode(row.current)} -> ${mdCode(row.proposed)}, +${kb(row.kb)} KB/view (separate)`);
    }
    out("");
  }

  // 6. Per-route-type table (the survey).
  out("## Route types (survey)", "");
  if (survey.length === 0) out("No survey page measured.", "");
  else {
    const deepPicks = new Map(input.selection.picks.map((p) => [p.type, p.url]));
    const leftOut = new Map(input.selection.leftOut.map((t: LeftOutType) => [t.type, t.reason]));
    const rows = new Map<string, { pages: PageResult[] }>();
    for (const result of survey) {
      const type = input.routes.typeOf(result.url);
      const row = rows.get(type) ?? { pages: [] };
      row.pages.push(result);
      rows.set(type, row);
    }
    const ordered = [...rows.entries()].sort(
      (a, b) => total(b[1].pages.map((p) => (p.page?.meanImageBytes ?? 0) / 1024)) - total(a[1].pages.map((p) => (p.page?.meanImageBytes ?? 0) / 1024)) || a[0].localeCompare(b[0]),
    );
    const files = input.routeFiles;
    out(
      files ? "| Route type | Route file | Pages | Mean KB/view | Exact % | Heaviest page | Deep |" : "| Route type | Pages | Mean KB/view | Exact % | Heaviest page | Deep |",
      files ? "|---|---|---:|---:|---:|---|---|" : "|---|---:|---:|---:|---|---|",
    );
    for (const [type, row] of ordered) {
      const numbered = row.pages.filter((p) => p.page !== undefined);
      const heaviest = [...numbered].sort((a, b) => (b.page?.meanImageBytes ?? 0) - (a.page?.meanImageBytes ?? 0) || a.url.localeCompare(b.url))[0];
      const deepCell = deepPicks.has(type) ? "yes" : leftOut.get(type) === "no-images" ? "no images" : leftOut.has(type) ? "left out (--deep)" : "-";
      out(
        `| ${mdCode(type)} | ${files ? `${(files.get(type) ?? []).map((f) => mdCode(f)).join(", ") || "-"} | ` : ""}${row.pages.length} | ${numbered.length > 0 ? kb(mean(numbered.map((p) => (p.page?.meanImageBytes ?? 0) / 1024))) : "-"} | ${numbered.length > 0 ? pct(mean(numbered.map((p) => p.page?.exactPct ?? 0))) : "-"} | ${heaviest?.page ? `${mdCode(pathOf(heaviest.url))} ${kb(heaviest.page.meanImageBytes / 1024)}` : "-"} | ${deepCell} |`,
      );
    }
    out("");
  }

  // 7. Broken, not measured, and images still loading.
  out("## Broken, not measured, and images still loading", "");
  const problems = (label: string, pages: PageResult[]): string[] => {
    const bad = pages.filter((p) => p.status !== "ok");
    const loading = pages.filter((p) => (p.notLoaded ?? 0) > 0);
    const rows = [`${label}: ${bad.length} of ${pages.length} page(s) not measured; ${loading.length} page(s) with images still loading at settle (${total(loading.map((p) => p.notLoaded ?? 0))} image(s))`];
    for (const page of bad.slice(0, REPORT_PAGES)) {
      const reason = page.status === "broken" ? page.broken?.reason ?? "broken" : page.error ?? page.status;
      rows.push(`  - ${mdCode(pathOf(page.url))}: ${page.status}, ${mdText(reason, 200)}`);
    }
    if (bad.length > REPORT_PAGES) rows.push(`  - and ${bad.length - REPORT_PAGES} more`);
    return rows;
  };
  out(...problems("Survey", input.survey), ...problems("Deep", input.deep), "");

  // 8. How to read.
  out("## How to read", "");
  out(
    `- The survey measures ${input.options.surveyViewports.map(mdText).join(", ")} with exact savings only (no quality estimate); its KB/view is a site-wide screen, not a page's full figure.`,
    `- The deep pages measure ${input.options.deepViewports.map(mdText).join(", ")} with the quality estimate. ${APPROX_MARK.trim()} marks an approximate estimate (a file above the matching size limit).`,
    `- Savings are per page view and never netted: the sharpness bytes of undersized images are a separate number.`,
    input.title === "imgtune audit"
      ? `- Route types group URLs by template (locale and device variant stripped), as check does; the route file column names the file(s) each type renders from. Only the heaviest page of each type is deep-scanned; ${input.selection.leftOut.length} type(s) were not (see the table).`
      : `- Route types group URLs by template (locale and device variant stripped). Only the heaviest page of each type is deep-scanned; ${input.selection.leftOut.length} type(s) were not (see the table).`,
    input.options.qualities !== undefined
      ? `- Quality targets are snapped up to the allowed qualities ${input.options.qualities.join(", ")}; a snapped target's quality saving is void and counts as 0.${input.qualitiesNote !== undefined ? ` (${mdText(input.qualitiesNote)})` : ""}`
      : "- Quality targets are not snapped (no --qualities given): a target the framework cannot serve is not the saving it looks like.",
    `- Third-party requests: ${input.options.thirdParty}${input.options.allowHosts ? ` (hosts kept: ${input.options.allowHosts.map(mdText).join(", ")})` : ""}. Blocking can drop images a page loads through its own API on another host.`,
    `- Pages with images still loading at settle show the images that loaded; the rest are not measured.`,
    input.options.gpu !== undefined ? `- Quality was scored on the GPU ${input.options.gpu} (with the CPU fallback noted in the page JSON).` : "- Quality was scored on the CPU.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
