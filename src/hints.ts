// `imgtune hints <scan.json>`: a compact batch of the per-image fix records of one scanned page, for an AI agent to work
// through. Sorted by the bytes a fix saves; each hint is a few short lines so ten of them fit in a small context.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hasFix } from "./images.js";
import { mdText, safeText } from "./text.js";
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
}

/** One hint: an image record reduced to what an agent needs to make the fix. */
export interface Hint {
  id: string;
  page: string;
  /** Component names, nearest first, and the source file and line when they resolved. */
  component: string[];
  file?: string;
  line?: number;
  /** False when the source came from a non-local origin: printed as unverified. */
  verified?: boolean;
  testid?: string;
  alt?: string;
  classes?: string;
  /** Where to look for the element in the project when no file resolved (see SearchHints). */
  find?: { component: string; glob: string };
  selector: string;
  sizes: { current?: string; proposed?: string; basis?: string };
  width?: number;
  quality?: { current: number; target?: number; samples: number; group: string };
  format?: { current?: string; best?: string };
  bytes: { saved: number; addedForSharpness: number };
  rung: string;
  notes: string[];
}

const usage = "usage: imgtune hints <scan.json> [--page <text>] [--component <name>] [--limit N] [--offset N] [--min-kb N] [--format text|json]";

function nonNegativeInteger(name: string, text: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`${name} needs a whole number, not ${safeText(text)}`);
  return Number(text);
}

const OPTIONS: readonly string[] = ["--page", "--component", "--limit", "--offset", "--min-kb", "--format"];

/** The arguments after `hints`: one scan JSON file and the filters. Throws with the message the CLI prints. */
export function parseHintsArgs(argv: string[]): HintsArgs {
  const args: HintsArgs = { file: "", limit: DEFAULT_HINT_LIMIT, offset: 0, format: "text" };
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (file !== undefined) throw new Error(`only one scan file is read at a time (${usage})`);
      file = arg;
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
export function hintsOf(result: PageResult): Hint[] {
  return (result.images ?? []).filter(hasFix).map((record) => {
    const served = record.current.format;
    const target = served !== undefined ? record.fix.quality?.perFormat[served] : undefined;
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
    if (record.locator.testid !== undefined) hint.testid = record.locator.testid;
    if (record.locator.alt !== undefined) hint.alt = record.locator.alt;
    if (record.locator.classes) hint.classes = record.locator.classes;
    const search = record.locator.searchHints;
    if (record.locator.file === undefined && search?.component !== undefined && search.glob !== undefined) {
      hint.find = { component: search.component, glob: search.glob };
    }
    if (record.fix.width !== undefined) hint.width = record.fix.width;
    if (record.fix.quality !== undefined && record.current.quality !== undefined) {
      hint.quality = {
        current: record.current.quality,
        target,
        samples: record.fix.quality.samples,
        group: record.fix.quality.group,
      };
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

/** One hint as four short lines: where, sizes, quality and format, bytes and rung. */
export function renderHint(hint: Hint, rank: number): string[] {
  // Page-derived names and attributes are printed as JSON strings, so a newline or an instruction inside them stays data.
  const where =
    hint.file !== undefined
      ? `${JSON.stringify(`${hint.file}:${hint.line ?? 0}`)}${hint.verified === false ? " (unverified)" : ""}`
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
  if (hint.find) lines.push(`   find: ${hint.find.component} in ${hint.find.glob}`);
  if (hint.width !== undefined) lines.push(`   width ${hint.width}px (device pixels needed)`);
  else lines.push(`   sizes ${safeText(hint.sizes.current ?? "none")} -> ${safeText(hint.sizes.proposed ?? "-")} (${hint.sizes.basis ?? "-"})`);
  const parts: string[] = [];
  if (hint.quality) {
    const target = hint.quality.target !== undefined ? ` -> ${hint.quality.target}` : "";
    parts.push(`quality ${hint.quality.current}${target} (max of ${hint.quality.samples}, ${safeText(hint.quality.group)})`);
  }
  if (hint.format) parts.push(`format ${hint.format.current ?? "?"}${hint.format.best && hint.format.best !== hint.format.current ? ` -> ${hint.format.best}` : ""}`);
  if (parts.length > 0) lines.push(`   ${parts.join("  ")}`);
  lines.push(
    `   saves ${kb(hint.bytes.saved)}/view, +${kb(hint.bytes.addedForSharpness)} sharpness (separate)  rung ${hint.rung}`,
  );
  return lines;
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
  const all = hintsOf(result);
  const selected = selectHints(all, args);
  const filtered = selectHints(all, { ...args, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
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

/** The hints of a PR comment: the top `limit` across the pages, one line each, and the number of hints in all. */
export function commentHints(results: PageResult[], limit = COMMENT_HINTS): { total: number; lines: string[] } {
  const all = results.filter((r) => r.status === "ok").flatMap((r) => hintsOf(r));
  const top = selectHints(all, { limit, offset: 0 });
  return { total: all.length, lines: top.map((hint, i) => `${i + 1}. ${commentLine(hint)}`) };
}

/**
 * One hint as a Markdown line. Every value is page-derived, so each goes through mdText: no HTML, link, mention, heading or
 * emphasis survives. The text is plain, not a code span, because a code span would show the escapes as written.
 */
function commentLine(hint: Hint): string {
  const source = hint.file !== undefined ? `${hint.file}:${hint.line ?? 0}${hint.verified === false ? " (unverified)" : ""}` : hint.component[0] ?? hint.selector;
  const component = hint.file !== undefined && hint.component[0] !== undefined ? ` (${hint.component[0]})` : "";
  const sizes =
    hint.width !== undefined
      ? `width ${hint.width}px`
      : `sizes ${mdText(hint.sizes.current ?? "none")} -> ${mdText(hint.sizes.proposed ?? "-")}`;
  const parts = [
    `saves ${kb(hint.bytes.saved)}/view, +${kb(hint.bytes.addedForSharpness)} sharpness`,
    `${mdText(source)}${mdText(component)}`,
    `page ${mdText(pathOf(hint.page))}`,
    sizes,
  ];
  if (hint.quality) parts.push(`quality ${hint.quality.current}${hint.quality.target !== undefined ? ` -> ${hint.quality.target}` : ""}`);
  if (hint.format) parts.push(`format ${mdText(hint.format.current ?? "?")}${hint.format.best && hint.format.best !== hint.format.current ? ` -> ${mdText(hint.format.best)}` : ""}`);
  parts.push(`rung ${hint.rung}`, `id ${mdText(hint.id)}`);
  return parts.join("; ");
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
