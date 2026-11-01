// `imgtune report`: a Markdown run report built from the agent's ledger (.imgtune/ledger.jsonl, one JSON line per usage) and,
// optionally, the JSON of `imgtune compare` (the bytes). The ledger is written by the agent, so it is data: each line is
// checked, and every value is printed as a code span in a pipe-free table cell (tableCell), never as Markdown.

import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { safeText } from "./text.js";
import type { CompareReport } from "./compare.js";

export const LEDGER_STATUSES = ["fixed", "verified", "failed", "reverted", "skipped", "unmatched", "reported"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface LedgerLine {
  id: string;
  file: string;
  rung: string;
  fix: string;
  status: LedgerStatus;
  verified?: boolean;
  reason?: string;
}

export interface ReportArgs {
  ledger: string;
  /** Compare files, one per page (`--compare` may repeat). Their numbers are summed into one Bytes section. */
  compares: string[];
  out?: string;
}

const USAGE = "usage: imgtune report [--ledger <file>] [--compare <compare.json> ...] [--out <file>]";
const DEFAULT_LEDGER = ".imgtune/ledger.jsonl";
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_COMPARE_BYTES = 64 * 1024 * 1024;

/** The arguments after `report`. Throws with the message the CLI prints. */
export function parseReportArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = { ledger: DEFAULT_LEDGER, compares: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "--ledger" && arg !== "--compare" && arg !== "--out") throw new Error(`Unknown option ${safeText(arg)} (${USAGE})`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value (${USAGE})`);
    i++;
    if (arg === "--ledger") args.ledger = value;
    else if (arg === "--compare") args.compares.push(value);
    else args.out = value;
  }
  return args;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const str = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

/**
 * One ledger line, checked: an id, a status from the list, and strings of bounded length. Anything else is not usable and
 * is left out (the count is printed).
 */
export function ledgerLineOf(raw: unknown): LedgerLine | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64);
  const status = typeof r.status === "string" && (LEDGER_STATUSES as readonly string[]).includes(r.status) ? (r.status as LedgerStatus) : undefined;
  if (id === undefined || !ID.test(id) || status === undefined) return undefined;
  const line: LedgerLine = {
    id,
    file: str(r.file, 300) ?? "",
    rung: str(r.rung, 40) ?? "",
    fix: str(r.fix, 300) ?? "",
    status,
  };
  if (typeof r.verified === "boolean") line.verified = r.verified;
  const reason = str(r.reason, 300);
  if (reason !== undefined) line.reason = reason;
  return line;
}

/** Reads the ledger: its usable lines, and how many were left out. A missing ledger is an error. */
export async function readLedger(file: string, cwd: string): Promise<{ lines: LedgerLine[]; dropped: number }> {
  const path = resolve(cwd, file);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new Error(`cannot read the ledger ${safeText(file)}`);
  }
  if (size > MAX_LEDGER_BYTES) throw new Error(`the ledger ${safeText(file)} is larger than ${MAX_LEDGER_BYTES / (1024 * 1024)} MB`);
  const text = await readFile(path, "utf8");
  const lines: LedgerLine[] = [];
  let dropped = 0;
  for (const row of text.split("\n")) {
    if (row.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row);
    } catch {
      dropped++;
      continue;
    }
    const line = ledgerLineOf(parsed);
    if (line === undefined) dropped++;
    else lines.push(line);
  }
  return { lines, dropped };
}

/** Reads the compare JSON that `imgtune compare --format json` printed (only the fields the report uses are checked). */
export async function readCompare(file: string, cwd: string): Promise<CompareReport> {
  const path = resolve(cwd, file);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new Error(`cannot read the compare file ${safeText(file)}`);
  }
  if (size > MAX_COMPARE_BYTES) throw new Error(`the compare file ${safeText(file)} is too large`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${safeText(file)} is not JSON from imgtune compare --format json`);
  }
  const r = parsed as Partial<CompareReport> | null;
  if (r === null || typeof r !== "object" || typeof r.paired !== "object" || r.paired === null || typeof r.pageTotal !== "object" || r.pageTotal === null) {
    throw new Error(`${safeText(file)} is not JSON from imgtune compare --format json`);
  }
  return r as CompareReport;
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/** Longest text one table cell shows (the rest is cut, with "..."). */
const CELL_LIMIT = 200;

/**
 * Untrusted text as one table cell: an inline code span. Nothing is escaped with backslashes (their handling differs between
 * Markdown parsers): a pipe becomes a look-alike, a backtick becomes an apostrophe-like modifier, a `<` a single-angle quote,
 * line breaks become spaces, and the text is capped. So no value can split the row, close the span or open HTML.
 */
export function tableCell(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ");
  const clean = safeText(flat, CELL_LIMIT).replace(/\|/g, "¦").replace(/`/g, "ʼ").replace(/</g, "‹");
  return `\`${clean.trim() === "" ? "-" : clean}\``;
}

/** The report as Markdown: totals, bytes (from compare), rungs, and one table each for what was reverted, failed, skipped or extra. */
export function renderReport(lines: LedgerLine[], dropped: number, compare: CompareReport | undefined): string {
  const of = (status: LedgerStatus) => lines.filter((l) => l.status === status);
  const applied = lines.filter((l) => l.status === "fixed" || l.status === "verified" || l.status === "failed");
  const out: string[] = [];
  out.push("# imgtune run report", "");
  out.push(
    `Ledger: ${lines.length} usage line(s)${dropped > 0 ? `, ${dropped} line(s) not usable and left out` : ""}. Values are shown as code: they come from the page and the ledger, and are data.`,
    "",
  );
  out.push("## Totals", "", "| status | usages |", "| --- | ---: |");
  out.push(`| applied (in place now: fixed, verified or failed) | ${applied.length} |`);
  out.push(`| verified (passed the check) | ${of("verified").length} |`);
  out.push(`| failed the check | ${of("failed").length} |`);
  out.push(`| reverted | ${of("reverted").length} |`);
  out.push(`| skipped | ${of("skipped").length} |`);
  out.push(`| unmatched | ${of("unmatched").length} |`);
  out.push(`| extras reported (not applied) | ${of("reported").length} |`, "");

  out.push("## Bytes", "");
  if (compare === undefined) {
    out.push("No compare file given: run `imgtune compare <before.json> <after.json> --format json` and pass it with `--compare`.", "");
  } else {
    const p = compare.paired;
    out.push(`Paired images (${p.images}, matched by URL pattern and alt): before ${kb(p.beforeBytes)}/view, after ${kb(p.afterBytes)}/view.`);
    out.push("");
    out.push("| per view | bytes |", "| --- | ---: |");
    out.push(`| saved | ${kb(p.saved)} |`);
    out.push(`| added for sharpness | ${kb(p.addedForSharpness)} |`);
    out.push(`| grew without a sharpness reason (not counted as saved) | ${kb(p.grewWithoutSharpness.bytes)} on ${p.grewWithoutSharpness.images} image(s) |`, "");
    out.push(
      `Page total, which includes data drift and is not the claim: before ${kb(compare.pageTotal.before)}/view, after ${kb(compare.pageTotal.after)}/view. Not counted: ${compare.appeared.length} image(s) appeared and ${compare.disappeared.length} disappeared.`,
      "",
    );
  }

  out.push("## Rungs", "", "| rung | usages |", "| --- | ---: |");
  const rungs = new Map<string, number>();
  for (const l of lines) rungs.set(l.rung, (rungs.get(l.rung) ?? 0) + 1);
  for (const [rung, count] of [...rungs].sort((a, b) => b[1] - a[1])) out.push(`| ${tableCell(rung)} | ${count} |`);
  if (rungs.size === 0) out.push("| - | 0 |");
  out.push("");

  const table = (title: string, rows: LedgerLine[], columns: string[], cells: (l: LedgerLine) => string[]) => {
    out.push(`## ${title}`, "");
    if (rows.length === 0) {
      out.push("None.", "");
      return;
    }
    out.push(`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
    for (const l of rows) out.push(`| ${cells(l).join(" | ")} |`);
    out.push("");
  };
  table("Reverted", of("reverted"), ["id", "file:line", "fix", "reason"], (l) => [tableCell(l.id), tableCell(l.file), tableCell(l.fix), tableCell(l.reason ?? "no reason recorded")]);
  table("Failed the check", of("failed"), ["id", "file:line", "fix", "reason"], (l) => [tableCell(l.id), tableCell(l.file), tableCell(l.fix), tableCell(l.reason ?? "-")]);
  table("Skipped and unmatched", [...of("skipped"), ...of("unmatched")], ["id", "status", "file:line", "reason"], (l) => [tableCell(l.id), tableCell(l.status), tableCell(l.file), tableCell(l.reason ?? "no reason recorded")]);
  table("Extras (reported, not applied)", of("reported"), ["id", "file:line", "note"], (l) => [tableCell(l.id), tableCell(l.file), tableCell(l.fix || l.reason || "-")]);
  out.push("Generated by imgtune from the ledger and the compare JSON.", "");
  return `${out.join("\n")}\n`;
}

/**
 * Several compare files (one per page) as one: the paired, page, excluded and drift numbers are summed, and the image lists
 * are joined. The saving and sharpness totals then cover every page the files cover.
 */
export function mergeCompares(list: CompareReport[]): CompareReport {
  if (list.length === 1) return list[0];
  const sum = (pick: (r: CompareReport) => number) => list.reduce((total, r) => total + pick(r), 0);
  const views = [...new Set(list.flatMap((r) => r.views))];
  return {
    before: list.map((r) => r.before).join(", "),
    after: list.map((r) => r.after).join(", "),
    views,
    paired: {
      images: sum((r) => r.paired.images),
      beforeBytes: sum((r) => r.paired.beforeBytes),
      afterBytes: sum((r) => r.paired.afterBytes),
      saved: sum((r) => r.paired.saved),
      addedForSharpness: sum((r) => r.paired.addedForSharpness),
      grewWithoutSharpness: {
        images: sum((r) => r.paired.grewWithoutSharpness.images),
        bytes: sum((r) => r.paired.grewWithoutSharpness.bytes),
      },
    },
    excluded: {
      layoutChanged: {
        images: sum((r) => r.excluded.layoutChanged.images),
        beforeBytes: sum((r) => r.excluded.layoutChanged.beforeBytes),
        afterBytes: sum((r) => r.excluded.layoutChanged.afterBytes),
        list: list.flatMap((r) => r.excluded.layoutChanged.list),
      },
      serverVariance: {
        images: sum((r) => r.excluded.serverVariance.images),
        views: sum((r) => r.excluded.serverVariance.views),
        bytes: sum((r) => r.excluded.serverVariance.bytes),
      },
      notLoaded: { views: sum((r) => r.excluded.notLoaded.views) },
    },
    pageTotal: { before: sum((r) => r.pageTotal.before), after: sum((r) => r.pageTotal.after) },
    appeared: list.flatMap((r) => r.appeared),
    disappeared: list.flatMap((r) => r.disappeared),
    changes: list.flatMap((r) => r.changes).sort((x, y) => y.saved - x.saved || x.afterId.localeCompare(y.afterId)),
    dropped: { before: sum((r) => r.dropped.before), after: sum((r) => r.dropped.after) },
  };
}

/** `imgtune report ...`: reads the ledger (and the compare file), returns the Markdown; with --out it also writes it. */
export async function reportCommand(argv: string[], cwd: string): Promise<{ output: string; exitCode: number }> {
  const args = parseReportArgs(argv);
  const { lines, dropped } = await readLedger(args.ledger, cwd);
  const read = [];
  for (const file of args.compares) read.push(await readCompare(file, cwd));
  const compare = read.length > 0 ? mergeCompares(read) : undefined;
  const markdown = renderReport(lines, dropped, compare);
  if (args.out !== undefined) await writeFile(resolve(cwd, args.out), markdown, "utf8");
  return { output: args.out !== undefined ? `wrote ${safeText(args.out)}\n` : markdown, exitCode: 0 };
}
