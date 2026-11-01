// `imgtune hints <scan.json>`: a compact batch of the per-image fix records of one scanned page, for an AI agent to work
// through. Sorted by the bytes a fix saves; each hint is a few short lines so ten of them fit in a small context.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hasFix } from "./images.js";
import { safeText } from "./text.js";
import type { PageResult } from "./remote.js";

export const DEFAULT_HINT_LIMIT = 10;

export interface HintsArgs {
  file: string;
  page?: string;
  component?: string;
  limit: number;
  offset: number;
  minKb?: number;
  format: "text" | "json";
  /** One hint per image instead of one entry per file:line (the default groups them). */
  flat: boolean;
  /** The framework's allowed quality values (Next: images.qualities). Targets are snapped up to one of them. */
  qualities?: number[];
}

/** One hint: an image record reduced to what an agent needs to make the fix. */
export interface Hint {
  id: string;
  page: string;
  /** Component names, nearest first, and the source file and line when they resolved. */
  component: string[];
  file?: string;
  line?: number;
  /** The source check (see LocatorKind): `owner` means the file:line is the call site of the component that renders the image. */
  kind?: string;
  /** False unless the source line was read from a local project and renders an image: printed as unverified. */
  verified?: boolean;
  testid?: string;
  alt?: string;
  classes?: string;
  /** Where to look for the element in the project when no file resolved (see SearchHints). */
  find?: { component: string; glob: string };
  /** The rendered width range over the viewports the image was measured at, in CSS px. */
  rendered?: { min: number; max: number };
  selector: string;
  sizes: { current?: string; proposed?: string; basis?: string };
  width?: number;
  quality?: {
    current: number;
    target?: number;
    samples: number;
    group: string;
    /** The target before it was snapped up to an allowed quality (--qualities). */
    snapFrom?: number;
    /** The allowed qualities the target was snapped to. */
    allowed?: number[];
    /** The snap left the quality saving unknown: it was estimated at the unsnapped target, so it is not counted. */
    void?: boolean;
  };
  format?: { current?: string; best?: string };
  bytes: { saved: number; addedForSharpness: number; sizes?: number; quality?: number };
  rung: string;
  notes: string[];
}

const usage =
  "usage: imgtune hints <scan.json> [--page <text>] [--component <name>] [--limit N] [--offset N] [--min-kb N] [--format text|json] [--flat] [--qualities 75,85,100]";

function nonNegativeInteger(name: string, text: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`${name} needs a whole number, not ${safeText(text)}`);
  return Number(text);
}

const OPTIONS: readonly string[] = ["--page", "--component", "--limit", "--offset", "--min-kb", "--format", "--qualities"];

/** A list of allowed quality values: whole numbers 1 to 100, separated by commas. Sorted, without repeats. */
export function parseQualities(text: string): number[] {
  const values = text.split(",").map((v) => v.trim());
  if (values.some((v) => !/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > 100)) {
    throw new Error(`--qualities needs a list of qualities from 1 to 100, like 75,85,100, not ${safeText(text)}`);
  }
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}

/**
 * The allowed quality a target is raised to: the smallest allowed value that is not below it. A target above every
 * allowed value gets the largest (the framework cannot go higher).
 */
export function snapUp(target: number, allowed: number[]): number {
  const sorted = [...allowed].sort((a, b) => a - b);
  return sorted.find((q) => q >= target) ?? sorted[sorted.length - 1];
}

/** The arguments after `hints`: one scan JSON file and the filters. Throws with the message the CLI prints. */
export function parseHintsArgs(argv: string[]): HintsArgs {
  const args: HintsArgs = { file: "", limit: DEFAULT_HINT_LIMIT, offset: 0, format: "text", flat: false };
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (file !== undefined) throw new Error(`only one scan file is read at a time (${usage})`);
      file = arg;
      continue;
    }
    if (arg === "--flat") {
      args.flat = true;
      continue;
    }
    if (!OPTIONS.includes(arg)) throw new Error(`Unknown option ${safeText(arg)} (${usage})`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    i++;
    if (arg === "--page") args.page = value;
    else if (arg === "--component") args.component = value;
    else if (arg === "--limit") {
      args.limit = nonNegativeInteger(arg, value);
      if (args.limit === 0) throw new Error("--limit needs a number of at least 1");
    } else if (arg === "--offset") args.offset = nonNegativeInteger(arg, value);
    else if (arg === "--min-kb") {
      if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`--min-kb needs a number, not ${safeText(value)}`);
      args.minKb = Number(value);
    } else if (arg === "--qualities") {
      args.qualities = parseQualities(value);
    } else if (arg === "--format") {
      if (value !== "text" && value !== "json") throw new Error(`--format is text or json, not ${safeText(value)}`);
      args.format = value;
    }
  }
  if (file === undefined) throw new Error(usage);
  args.file = file;
  return args;
}

/** The hints of one page: its image records that have a fix, as hints. */
export function hintsOf(result: PageResult, qualities?: number[]): Hint[] {
  return (result.images ?? []).filter(hasFix).map((record) => {
    const served = record.current.format;
    const rawTarget = served !== undefined ? record.fix.quality?.perFormat[served] : undefined;
    // With the framework's allowed qualities, the target goes up to one of them. The quality saving was estimated at the
    // raw target, so after a snap it is not counted, and the hint says so.
    const snapped = rawTarget !== undefined && qualities !== undefined ? snapUp(rawTarget, qualities) : undefined;
    const snapFrom = snapped !== undefined && snapped !== rawTarget ? rawTarget : undefined;
    const target = snapped ?? rawTarget;
    const hint: Hint = {
      id: record.id,
      page: record.page,
      component: record.locator.component,
      selector: record.locator.selector,
      sizes: { current: record.current.sizes, proposed: record.fix.sizes?.value, basis: record.fix.sizes?.basis },
      bytes: { ...record.fix.bytes },
      rung: record.evidence.rung,
      notes: record.evidence.notes,
    };
    if (record.locator.file !== undefined) {
      hint.file = record.locator.file;
      hint.line = record.locator.line;
      hint.verified = record.locator.verified;
    }
    if (record.locator.kind !== undefined) hint.kind = record.locator.kind;
    if (record.locator.testid !== undefined) hint.testid = record.locator.testid;
    if (record.locator.alt !== undefined) hint.alt = record.locator.alt;
    if (record.locator.classes) hint.classes = record.locator.classes;
    const search = record.locator.searchHints;
    if (record.locator.file === undefined && search?.component !== undefined && search.glob !== undefined) {
      hint.find = { component: search.component, glob: search.glob };
    }
    const widths = record.perViewport.map((p) => p.renderedCssPx).filter((w) => w > 0);
    if (widths.length > 0) hint.rendered = { min: Math.min(...widths), max: Math.max(...widths) };
    if (record.fix.width !== undefined) hint.width = record.fix.width;
    if (record.fix.quality !== undefined && record.current.quality !== undefined) {
      hint.quality = {
        current: record.current.quality,
        target,
        samples: record.fix.quality.samples,
        group: record.fix.quality.group,
      };
      if (qualities !== undefined) hint.quality.allowed = [...new Set(qualities)].sort((a, b) => a - b);
      if (snapFrom !== undefined) {
        hint.quality.snapFrom = snapFrom;
        hint.quality.void = true;
        if (hint.bytes.sizes !== undefined) hint.bytes = { ...hint.bytes, saved: hint.bytes.sizes, quality: 0 };
      }
    }
    if (record.fix.format !== undefined || served !== undefined) hint.format = { current: served, best: record.fix.format };
    return hint;
  });
}

/** The hints an argument set asks for: filtered, sorted by bytes saved (largest first), then offset and limited. */
export function selectHints(hints: Hint[], args: Pick<HintsArgs, "page" | "component" | "minKb" | "limit" | "offset">): Hint[] {
  const page = args.page?.toLowerCase();
  const component = args.component?.toLowerCase();
  return hints
    .filter((h) => page === undefined || h.page.toLowerCase().includes(page))
    .filter((h) => {
      if (component === undefined) return true;
      return h.component.some((c) => c.toLowerCase().includes(component)) || (h.file ?? "").toLowerCase().includes(component);
    })
    .filter((h) => args.minKb === undefined || h.bytes.saved >= args.minKb * 1024)
    .sort((a, b) => b.bytes.saved - a.bytes.saved || a.id.localeCompare(b.id))
    .slice(args.offset, args.offset + args.limit);
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/** The mark after a hint's file:line: an owner call site, or an unverified source. */
export function locationNote(hint: Hint): string {
  if (hint.kind === "owner") return " (owner call site)";
  return hint.verified === false ? " (unverified)" : "";
}

/** The quality target as printed: "-> 85", or "q82 -> 85 (allowed: 75,85,100)" when the target was snapped to an allowed value. */
export function qualityTarget(quality: NonNullable<Hint["quality"]>): string {
  if (quality.target === undefined) return "";
  const allowed = quality.allowed !== undefined ? ` (allowed: ${quality.allowed.join(",")})` : "";
  return quality.snapFrom !== undefined ? ` q${quality.snapFrom} -> ${quality.target}${allowed}` : ` -> ${quality.target}${allowed}`;
}

/**
 * The saving of one image or one call site, per view, split into its parts when the scan gave them: "saves 15 KB/view =
 * sizes 12 KB + quality 3 KB". A quality part that a snap voided is printed as void, not as a number.
 */
export function savesText(hint: Hint): string {
  const { saved, sizes, quality } = hint.bytes;
  if (sizes === undefined) return `saves ${kb(saved)}/view`;
  const qualityPart = hint.quality?.void === true ? "quality void after snap" : `quality ${kb(quality ?? 0)}`;
  return `saves ${kb(saved)}/view = sizes ${kb(sizes)} + ${qualityPart}`;
}

/** One hint as four short lines: where, sizes, quality and format, bytes and rung. */
export function renderHint(hint: Hint, rank: number): string[] {
  // Page-derived names and attributes are printed as JSON strings, so a newline or an instruction inside them stays data.
  const where =
    hint.file !== undefined
      ? `${JSON.stringify(`${hint.file}:${hint.line ?? 0}`)}${locationNote(hint)}`
      : JSON.stringify(hint.component[0] ?? hint.selector);
  const component = hint.component.length > 0 && hint.file !== undefined ? ` (${JSON.stringify(hint.component[0])})` : "";
  const lines = [`${rank}. ${hint.id}  ${where}${component}  ${safeText(hint.page)}`];
  const attributes = [
    hint.alt !== undefined ? `alt ${JSON.stringify(hint.alt)}` : undefined,
    hint.testid !== undefined ? `testid ${JSON.stringify(hint.testid)}` : undefined,
    hint.classes !== undefined ? `class ${JSON.stringify(hint.classes)}` : undefined,
  ].filter((a): a is string => a !== undefined);
  if (attributes.length > 0) lines.push(`   ${attributes.join("  ")}`);
  // The name is an identifier (COMPONENT_NAME), so it prints bare; the glob is built from the same name.
  if (hint.kind === "owner") {
    const name = hint.component[0];
    lines.push(
      name !== undefined
        ? `   owner call site: the image is rendered inside <${name}>; search that component for the <img>`
        : "   owner call site: the image is rendered inside an unnamed component; search the file's imports",
    );
  }
  if (hint.find) lines.push(`   find: ${hint.find.component} in ${hint.find.glob}`);
  if (hint.width !== undefined) lines.push(`   width ${hint.width}px (device pixels needed)`);
  else lines.push(`   sizes ${safeText(hint.sizes.current ?? "none")} -> ${safeText(hint.sizes.proposed ?? "-")} (${hint.sizes.basis ?? "-"})`);
  if (hint.file === undefined && hint.find === undefined && hint.kind !== "owner") lines.push("   owner unknown");
  const parts: string[] = [];
  if (hint.quality) parts.push(`quality ${hint.quality.current}${qualityTarget(hint.quality)} (max of ${hint.quality.samples}, ${safeText(hint.quality.group)})`);
  if (hint.format) parts.push(`format ${hint.format.current ?? "?"}${hint.format.best && hint.format.best !== hint.format.current ? ` -> ${hint.format.best}` : ""}`);
  if (parts.length > 0) lines.push(`   ${parts.join("  ")}`);
  lines.push(
    `   ${savesText(hint)}, +${kb(hint.bytes.addedForSharpness)} sharpness (separate)  rung ${hint.rung}`,
  );
  return lines;
}

/** The hints of one file:line across pages: the grouped view, one entry per call site. */
export interface HintGroup {
  key: string;
  hints: Hint[];
  /** The pages the group's images are on, in the order they were scanned. */
  pages: string[];
  /** Bytes the group saves per page view, summed over its images (each image's own per-view saving). */
  saved: number;
}

/** The group a hint belongs to: its file:line, else its nearest component, else its selector. */
export function groupKeyOf(hint: Hint): string {
  if (hint.file !== undefined) return `file:${hint.file}:${hint.line ?? 0}`;
  return `${hint.component[0] !== undefined ? "component" : "selector"}:${hint.component[0] ?? hint.selector}`;
}

/** Groups hints by call site across pages, largest saving first. The hints keep the order they came in. */
export function groupHints(hints: Hint[]): HintGroup[] {
  const groups = new Map<string, HintGroup>();
  for (const hint of hints) {
    const key = groupKeyOf(hint);
    const group = groups.get(key) ?? { key, hints: [], pages: [], saved: 0 };
    group.hints.push(hint);
    if (!group.pages.includes(hint.page)) group.pages.push(hint.page);
    group.saved += hint.bytes.saved;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.saved - a.saved || a.key.localeCompare(b.key));
}

/**
 * One sizes value for a group, or the reason there is none. Callers are the pages: when the pages propose different
 * values, the component is shared and each caller passes its own sizes. On one page with differing values, the widest
 * measured width is the safe floor (no image on the page is rendered wider).
 */
export function combinedSizes(group: HintGroup): string {
  const proposals = [...new Set(group.hints.map((h) => h.sizes.proposed).filter((v): v is string => v !== undefined))];
  if (proposals.length === 0) return "no sizes change";
  if (proposals.length === 1) return `${proposals[0]} (the same on ${group.hints.length} image(s))`;
  if (group.pages.length > 1) return "shared component: pass sizes from each caller (listed below)";
  const widest = Math.max(...group.hints.map((h) => h.rendered?.max ?? 0));
  return `max-safe: ${widest}px, the widest measured width (the images on this page differ; one value covers them all)`;
}

/** The text of a group: its call site, the combined sizes, each page's sizes and rendered widths, the ids, and the quality. */
export function renderGroup(group: HintGroup, rank: number): string[] {
  const first = group.hints[0];
  const where =
    first.file !== undefined
      ? `${JSON.stringify(`${first.file}:${first.line ?? 0}`)}${locationNote(first)}`
      : JSON.stringify(first.component[0] ?? first.selector);
  const name = first.file !== undefined && first.component[0] !== undefined ? ` (${JSON.stringify(first.component[0])})` : "";
  const sizes = group.hints.every((h) => h.bytes.sizes !== undefined) ? group.hints.reduce((sum, h) => sum + (h.bytes.sizes ?? 0), 0) : undefined;
  const split = sizes !== undefined ? ` = sizes ${kb(sizes)} + quality ${kb(group.saved - sizes)}` : "";
  const lines = [`${rank}. ${where}${name}  ${group.hints.length} image(s), ${group.pages.length} page(s)  saves ${kb(group.saved)}/view${split}`];
  if (first.kind === "owner") lines.push(`   owner call site: the image is rendered inside <${first.component[0] ?? "an unnamed component"}>; search that component`);
  lines.push(`   sizes: ${safeText(combinedSizes(group))}`);
  for (const page of group.pages) {
    const mine = group.hints.filter((h) => h.page === page);
    const current = [...new Set(mine.map((h) => h.sizes.current ?? "none"))].map((v) => JSON.stringify(safeText(v))).join(", ");
    const proposed = [...new Set(mine.map((h) => h.sizes.proposed ?? "-"))].map((v) => JSON.stringify(safeText(v))).join(", ");
    const widths = mine.flatMap((h) => (h.rendered ? [h.rendered.min, h.rendered.max] : []));
    const rendered = widths.length > 0 ? `${Math.min(...widths)}-${Math.max(...widths)} px` : "not rendered";
    lines.push(`   ${JSON.stringify(pathOf(page))}  ${mine.length} image(s)  current ${current}  proposed ${proposed}  rendered ${rendered}`);
  }
  const targets = group.hints.flatMap((h) => (h.quality ? [h.quality] : []));
  if (targets.length > 0) {
    const current = Math.max(...targets.map((q) => q.current));
    const withTarget = targets.filter((q) => q.target !== undefined).map((q) => q.target as number);
    const target = withTarget.length > 0 ? ` -> ${Math.max(...withTarget)}` : "";
    lines.push(`   quality ${current}${target} (max of ${targets[0].samples}, ${safeText(targets[0].group)})`);
  }
  const ids = group.hints.map((h) => h.id);
  const shown = ids.slice(0, 8).join(" ");
  lines.push(`   ids ${shown}${ids.length > 8 ? ` (+${ids.length - 8} more; --flat lists each image)` : ""}`);
  return lines;
}

/** The text of a grouped selection: a count line, then each group. */
export function renderGroups(groups: HintGroup[], totalGroups: number, totalImages: number, offset: number, page?: string): string {
  if (groups.length === 0) return `no images with fix hints${totalGroups > 0 ? " match the filters" : ""}\n`;
  const head = `${totalGroups} call site(s), ${totalImages} image(s) with fix hints${page ? ` (page ${safeText(page)})` : ""}; showing ${offset + 1}-${offset + groups.length}\n`;
  const body = groups.flatMap((group, i) => renderGroup(group, offset + i + 1));
  return `${head}${body.join("\n")}\n`;
}

/** The text of a selection: a count line, then each hint. */
export function renderHints(hints: Hint[], total: number, offset: number, page?: string): string {
  if (hints.length === 0) return `no images with fix hints${total > 0 ? " match the filters" : ""}\n`;
  const head = `${total} image(s) with fix hints${page ? ` (page ${safeText(page)})` : ""}; showing ${offset + 1}-${offset + hints.length}\n`;
  const body = hints.flatMap((hint, i) => renderHint(hint, offset + i + 1));
  return `${head}${body.join("\n")}\n`;
}

/** `imgtune hints <scan.json> ...`: reads one page's scan file and returns the text or JSON to print. */
export async function hintsCommand(argv: string[], cwd: string): Promise<{ output: string; exitCode: number }> {
  const args = parseHintsArgs(argv);
  const path = resolve(cwd, args.file);
  let result: PageResult;
  try {
    result = JSON.parse(await readFile(path, "utf8")) as PageResult;
  } catch (err) {
    throw new Error(`cannot read ${safeText(args.file)} as a scan file: ${(err as Error).message}`);
  }
  if (!Array.isArray(result.images)) {
    throw new Error(`${safeText(args.file)} has no image records: scan it with this version of imgtune`);
  }
  const all = hintsOf(result, args.qualities);
  const filtered = selectHints(all, { ...args, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
  if (!args.flat) {
    // Grouped (the default): --limit and --offset count call sites, so a batch is whole call sites.
    const groups = groupHints(filtered);
    const selectedGroups = groups.slice(args.offset, args.offset + args.limit);
    if (args.format === "json") {
      const body = {
        page: result.url,
        groups: groups.length,
        images: filtered.length,
        offset: args.offset,
        limit: args.limit,
        callSites: selectedGroups.map((group) => ({
          key: group.key,
          file: group.hints[0].file,
          line: group.hints[0].line,
          component: group.hints[0].component,
          count: group.hints.length,
          pages: group.pages.map((p) => pathOf(p)),
          saved: group.saved,
          sizes: combinedSizes(group),
          ids: group.hints.map((h) => h.id),
          hints: group.hints,
        })),
      };
      return { output: `${JSON.stringify(body, null, 2)}\n`, exitCode: 0 };
    }
    return { output: renderGroups(selectedGroups, groups.length, filtered.length, args.offset, args.page), exitCode: 0 };
  }
  const selected = selectHints(all, args);
  if (args.format === "json") {
    const body = {
      page: result.url,
      total: filtered.length,
      offset: args.offset,
      limit: args.limit,
      hints: selected,
    };
    return { output: `${JSON.stringify(body, null, 2)}\n`, exitCode: 0 };
  }
  return { output: renderHints(selected, filtered.length, args.offset, args.page), exitCode: 0 };
}

/** How many hints the PR comment lists. */
export const COMMENT_HINTS = 10;
/** Longest value shown in the comment, before JSON quoting and escaping. */
const COMMENT_FIELD = 80;
/** Longest text one field may take after quoting (a capped value, JSON-quoted, is far shorter). */
const COMMENT_QUOTED_LIMIT = 1000;

/** The hints of a PR comment: the top `limit` across the pages, one line each, and the number of hints in all. */
export function commentHints(results: PageResult[], limit = COMMENT_HINTS): { total: number; lines: string[] } {
  const all = results.filter((r) => r.status === "ok").flatMap((r) => hintsOf(r));
  const top = selectHints(all, { limit, offset: 0 });
  return { total: all.length, lines: top.map((hint, i) => `${i + 1}. ${commentLine(hint)}`) };
}

/**
 * A page-derived value in the comment: capped at COMMENT_FIELD characters, then JSON-quoted the way the CLI text prints it
 * (so an instruction inside a name stays a quoted string). The block is fenced, and GitHub does not decode entities inside
 * a fence, so there is no entity escaping here. Instead every backtick becomes an apostrophe: no value can close the fence.
 */
function quoted(value: string): string {
  const capped = value.length > COMMENT_FIELD ? `${value.slice(0, COMMENT_FIELD - 3)}...` : value;
  return safeText(JSON.stringify(capped), COMMENT_QUOTED_LIMIT).replace(/`/g, "'");
}

/** One hint as a line of the comment's fenced block. Every page-derived value goes through `quoted`. */
function commentLine(hint: Hint): string {
  const location =
    hint.file !== undefined
      ? `${quoted(`${hint.file}:${hint.line ?? 0}`)}${locationNote(hint)}`
      : quoted(hint.component[0] ?? hint.selector);
  const component = hint.file !== undefined && hint.component[0] !== undefined ? ` (${quoted(hint.component[0])})` : "";
  const sizes =
    hint.width !== undefined
      ? `width ${hint.width}px`
      : `sizes ${quoted(hint.sizes.current ?? "none")} -> ${quoted(hint.sizes.proposed ?? "-")}`;
  const parts: (string | undefined)[] = [
    `${savesText(hint)}, +${kb(hint.bytes.addedForSharpness)} sharpness`,
    `${location}${component}`,
    hint.alt !== undefined ? `alt ${quoted(hint.alt)}` : undefined,
    `page ${quoted(pathOf(hint.page))}`,
    sizes,
    hint.quality ? `quality ${hint.quality.current}${hint.quality.target !== undefined ? ` -> ${hint.quality.target}` : ""}` : undefined,
    hint.format ? `format ${quoted(hint.format.current ?? "?")}${hint.format.best && hint.format.best !== hint.format.current ? ` -> ${quoted(hint.format.best)}` : ""}` : undefined,
    `rung ${hint.rung}`,
    `id ${quoted(hint.id)}`,
  ];
  return parts.filter((part): part is string => part !== undefined).join("; ");
}

/** The host and path of a page URL (no query): what a comment shows of a page. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}
