// `imgtune scan --recheck <scan.json> [--ids a,b,c]`: rescans the page of a previous scan, only at the viewports where the
// named images rendered, and compares each image with its earlier record. An image whose src did not change keeps its
// earlier quality and format estimate (the search is skipped); a changed src gets the full search. Nothing is written.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { hasFix, type ImagePerViewport, type ImageRecord } from "./images.js";
import { safeText, scanOnce, type PageResult } from "./remote.js";

export interface RecheckArgs {
  file: string;
  /** The image ids to recheck; undefined: every image of the scan that has a fix hint. */
  ids?: string[];
  /** Recheck a page that robots.txt disallows (needed when the scan file says the page was scanned that way). */
  ignoreRobots: boolean;
}

/** An image id as imgtune writes it (12 hex digits); anything else in a scan file is refused. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const USAGE = "usage: imgtune scan --recheck <scan.json> [--ids a,b,c]";

/** The arguments after `scan --recheck`. Throws with the message the CLI prints. */
export function parseRecheckArgs(argv: string[]): RecheckArgs {
  let file: string | undefined;
  let ids: string[] | undefined;
  let ignoreRobots = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ignore-robots") {
      ignoreRobots = true;
      continue;
    }
    if (arg === "--recheck" || arg === "--ids") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value (${USAGE})`);
      i++;
      if (arg === "--recheck") file = value;
      else {
        ids = value.split(",").map((id) => id.trim()).filter((id) => id !== "");
        if (ids.length === 0) throw new Error(`--ids needs at least one image id (${USAGE})`);
      }
    } else {
      throw new Error(`${safeText(arg)} is not an option of --recheck (${USAGE})`);
    }
  }
  if (file === undefined) throw new Error(USAGE);
  return { file, ids, ignoreRobots };
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;
const quoted = (text: string): string => JSON.stringify(safeText(text));
const KNOWN_VIEWPORTS: readonly string[] = DEFAULT_VIEWPORTS.map((v) => v.name);

/**
 * The records of a scan file that may be used: an id of the expected form, and an object with its page. The scan file is
 * untrusted (it can be edited or planted), so anything else is skipped with a warning.
 */
export function usableRecords(images: unknown[], log: (message: string) => void): ImageRecord[] {
  const out: ImageRecord[] = [];
  for (const raw of images) {
    const record = raw as ImageRecord | null;
    if (record === null || typeof record !== "object" || typeof record.id !== "string" || !ID_PATTERN.test(record.id)) {
      log(`warning: skipped an image record with no valid id`);
      continue;
    }
    if (typeof record.page !== "string" || !Array.isArray(record.perViewport)) {
      log(`warning: skipped image ${safeText(record.id)}: its record is malformed`);
      continue;
    }
    out.push(record);
  }
  return out;
}
const yesNo = (value: boolean): string => (value ? "yes" : "no");

/** A record's place on the page, for its heading: its file and line, else its component, else its selector. */
function whereOf(record: ImageRecord): string {
  const { file, line, component, selector } = record.locator;
  if (file !== undefined) return `${safeText(file)}:${line ?? 0}`;
  return component.length > 0 ? safeText(component[0]) : safeText(selector);
}

/** The viewports where an image rendered in the earlier scan: the ones an image's rendered width is measured at. */
function viewportsOf(records: ImageRecord[]): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const p of record.perViewport) if (p.renderedCssPx > 0 && p.loaded) names.add(p.viewport);
  }
  return DEFAULT_VIEWPORTS.filter((v) => names.has(v.name)).map((v) => v.name);
}

interface Check {
  lines: string[];
  failures: string[];
}

/** One image before and after: a row per viewport, the hint delta, and the failures (undersized, bytes up without a fix). */
export function compareImage(before: ImageRecord, after: ImageRecord | undefined, unchangedSrc: boolean): Check {
  const lines = [`${safeText(before.id)}  ${whereOf(before)}  ${safeText(before.page)}`];
  if (after === undefined) return { lines: [...lines, "  gone: the image is not on the page any more"], failures: ["gone"] };
  const failures: string[] = [];
  for (const p of before.perViewport.filter((v) => v.renderedCssPx > 0 && KNOWN_VIEWPORTS.includes(v.viewport))) {
    const q: ImagePerViewport | undefined = after.perViewport.find((v) => v.viewport === p.viewport);
    if (q === undefined) continue;
    const name = safeText(p.viewport);
    lines.push(
      `  ${name.padEnd(18)} rendered ${p.renderedCssPx} -> ${q.renderedCssPx} px  served ${kb(p.servedBytes)} -> ${kb(q.servedBytes)}  undersized ${yesNo(p.undersized)} -> ${yesNo(q.undersized)}`,
    );
    if (!p.undersized && q.undersized) failures.push(`${name}: became undersized`);
    const sharpnessFix = p.undersized && !q.undersized;
    if (q.servedBytes > p.servedBytes && !sharpnessFix) {
      failures.push(`${name}: bytes rose ${kb(p.servedBytes)} -> ${kb(q.servedBytes)} without a sharpness fix`);
    }
  }
  const sizesBefore = quoted(before.fix.sizes?.value ?? "-");
  const sizesAfter = quoted(after.fix.sizes?.value ?? "-");
  const savedBefore = before.fix.bytes.saved;
  const savedAfter = unchangedSrc ? savedBefore : after.fix.bytes.saved;
  const reused = unchangedSrc ? " (src unchanged: estimate reused)" : "";
  lines.push(
    `  hint   sizes ${sizesBefore} -> ${sizesAfter}  saves ${kb(savedBefore)} -> ${kb(savedAfter)}${reused}`,
  );
  return { lines, failures };
}

/** `imgtune scan --recheck`: the text to print and the exit code (1 when an image failed the check). */
export async function recheckScan(argv: string[], cwd: string, log: (message: string) => void): Promise<{ output: string; exitCode: number }> {
  const args = parseRecheckArgs(argv);
  let previous: PageResult;
  try {
    previous = JSON.parse(await readFile(resolve(cwd, args.file), "utf8")) as PageResult;
  } catch {
    throw new Error(`cannot read ${safeText(args.file)} as a scan file`);
  }
  if (!previous || typeof previous.url !== "string" || !Array.isArray(previous.images)) {
    throw new Error(`${safeText(args.file)} has no image records: scan it with this version of imgtune`);
  }
  // The page is the file's claim, so it is checked like a scan's URL: http or https, and a robots.txt refusal is only
  // overridden by the flag on this command line, never by the file.
  let target: URL;
  try {
    target = new URL(previous.url);
  } catch {
    throw new Error(`${safeText(args.file)} names a page that is not a URL`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`${safeText(args.file)} names a page that is not http or https`);
  if (previous.robotsIgnored === true && !args.ignoreRobots) {
    throw new Error(`${safeText(args.file)} was scanned with --ignore-robots; pass --ignore-robots to recheck it too`);
  }
  const images = usableRecords(previous.images, log);
  const byId = new Map(images.map((record) => [record.id, record]));
  let selected: ImageRecord[];
  if (args.ids !== undefined) {
    const invalid = args.ids.filter((id) => !ID_PATTERN.test(id));
    if (invalid.length > 0) throw new Error(`not an image id: ${invalid.map((id) => safeText(id)).join(", ")}`);
    const missing = args.ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`no image ${missing.map((id) => safeText(id)).join(", ")} in ${safeText(args.file)}`);
    selected = args.ids.map((id) => byId.get(id) as ImageRecord);
  } else {
    selected = images.filter(hasFix);
  }
  if (selected.length === 0) return { output: "no images to recheck\n", exitCode: 0 };

  const viewports = viewportsOf(selected);
  if (viewports.length === 0) throw new Error("none of the images rendered in that scan");
  // The srcs the earlier scan loaded: an image that still loads one of them keeps its estimate.
  const earlierSrcs = new Set(selected.map((r) => r.current.src).filter((src): src is string => src !== undefined));

  log(`recheck target: ${safeText(target.href)}${args.ignoreRobots ? " (robots.txt ignored: --ignore-robots)" : ""}`);
  const started = Date.now();
  const fresh = await scanOnce(target.href, {
    outDir: resolve(cwd),
    cwd,
    aggressive: false,
    quality: true,
    viewports: DEFAULT_VIEWPORTS.filter((v) => viewports.includes(v.name)).map((v) => ({ ...v })),
    log,
    ignoreRobots: args.ignoreRobots,
    qualityFor: (inst) => inst.url === "" || !earlierSrcs.has(inst.url),
  });
  const seconds = (Date.now() - started) / 1000;
  if (fresh.status !== "ok") {
    return { output: `recheck: the page is ${safeText(fresh.status)} now${fresh.error ? `: ${safeText(fresh.error)}` : ""}\n`, exitCode: 1 };
  }

  const now = new Map((fresh.images ?? []).map((record) => [record.id, record]));
  const out: string[] = [];
  const failures: string[] = [];
  for (const before of selected) {
    const after = now.get(before.id);
    const unchangedSrc = before.current.src !== undefined && after !== undefined && earlierSrcs.has(after.current.src ?? "");
    const check = compareImage(before, after, unchangedSrc);
    out.push(...check.lines, "");
    for (const failure of check.failures) failures.push(`${before.id}: ${failure}`);
  }
  out.push(
    `rechecked ${selected.length} image(s) at ${viewports.length} viewport(s) on ${safeText(target.href)} in ${seconds.toFixed(1)} s`,
  );
  out.push(failures.length === 0 ? "ok: no image became undersized, and no bytes rose without a sharpness fix" : `FAILED: ${failures.length} check(s)`);
  for (const failure of failures) out.push(`  ${safeText(failure)}`);
  return { output: `${out.join("\n")}\n`, exitCode: failures.length === 0 ? 0 : 1 };
}
