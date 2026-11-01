// `imgtune scan --recheck <scan.json> [--ids a,b,c]`: rescans the page of a previous scan, only at the viewports where the
// named images rendered, and compares each image with its earlier record. An image whose src did not change keeps its
// earlier quality and format estimate (the search is skipped); a changed src gets the full search. Nothing is written.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { hasFix, type ImagePerViewport, type ImageRecord } from "./images.js";
import { parseGpuDevice } from "./gpu.js";
import { safeText, scanOnce, scorerNote, type PageResult } from "./remote.js";
import { cleanRecord } from "./locate-join.js";

export interface RecheckArgs {
  file: string;
  /** The image ids to recheck; undefined: every image of the scan that has a fix hint. */
  ids?: string[];
  /** Recheck a page that robots.txt disallows (needed when the scan file says the page was scanned that way). */
  ignoreRobots: boolean;
  /** Score the recheck with the GPU scorer on this GPU index (--gpu, --gpu-device). Undefined: the CPU. */
  gpu?: { device: number };
}

/** An image id as imgtune writes it (12 hex digits); anything else in a scan file is refused. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const USAGE = "usage: imgtune scan --recheck <scan.json> [--ids a,b,c] [--gpu] [--gpu-device n]";

/** The arguments after `scan --recheck`. Throws with the message the CLI prints. */
export function parseRecheckArgs(argv: string[]): RecheckArgs {
  let file: string | undefined;
  let ids: string[] | undefined;
  let ignoreRobots = false;
  let gpu: { device: number } | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ignore-robots") {
      ignoreRobots = true;
      continue;
    }
    if (arg === "--gpu") {
      gpu ??= { device: 0 };
      continue;
    }
    if (arg === "--recheck" || arg === "--ids" || arg === "--gpu-device") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value (${USAGE})`);
      i++;
      if (arg === "--recheck") file = value;
      else if (arg === "--gpu-device") gpu = { device: parseGpuDevice(value) };
      else {
        ids = value.split(",").map((id) => id.trim()).filter((id) => id !== "");
        if (ids.length === 0) throw new Error(`--ids needs at least one image id (${USAGE})`);
      }
    } else {
      throw new Error(`${safeText(arg)} is not an option of --recheck (${USAGE})`);
    }
  }
  if (file === undefined) throw new Error(USAGE);
  return { file, ids, ignoreRobots, gpu };
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
    const cleaned = cleanRecord(record);
    if (cleaned === undefined) {
      log(`warning: skipped image ${safeText(record.id)}: its record is malformed`);
      continue;
    }
    out.push(cleaned);
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

/** The source a record belongs to: its file, else its component (the same key a rescan gives it). */
function sourceOf(record: ImageRecord): string | undefined {
  const { file, component } = record.locator;
  if (file !== undefined) return `file:${file}`;
  return component.length > 0 ? `component:${component[0]}` : undefined;
}

/** How an earlier record was found again: by its id, by its source and URL pattern, or not at all. */
export interface Pairing {
  after?: ImageRecord;
  /** "id": the same id. "source": the id changed (an edit moved the element or shifted its order), but its source file and URL match. */
  by?: "id" | "source";
  /** Records that matched the source and URL pattern, when there was more than one and none could be picked. */
  ambiguous: number;
}

/**
 * Finds an earlier image in a rescan. The id comes first. When it changed, the element is still the same one if its source
 * file and its URL pattern (the loader URL without w and q, so a sizes or quality change does not move it) match one
 * rescanned image; when several match, the one on the same line is taken, and only if that is unique too.
 */
export function pairRecord(before: ImageRecord, now: Map<string, ImageRecord>, fresh: ImageRecord[]): Pairing {
  const same = now.get(before.id);
  if (same !== undefined) return { after: same, by: "id", ambiguous: 0 };
  const source = sourceOf(before);
  const pattern = before.locator.urlPattern;
  if (source === undefined) return { ambiguous: 0 };
  let candidates = fresh.filter((r) => sourceOf(r) === source && (pattern === undefined || r.locator.urlPattern === pattern));
  if (candidates.length > 1 && before.locator.line !== undefined) {
    const line = candidates.filter((r) => r.locator.line === before.locator.line);
    if (line.length === 1) candidates = line;
  }
  if (candidates.length === 1) return { after: candidates[0], by: "source", ambiguous: 0 };
  return { ambiguous: candidates.length };
}

/** A signed kilobyte count: "saves 12 KB" or "grew 12 KB". */
const saving = (bytes: number): string => (bytes >= 0 ? `saves ${kb(bytes)}` : `grew ${kb(-bytes)}`);

/**
 * One image before and after: a row per viewport, the predicted saving next to the measured one (served bytes), the hint
 * delta, and the failures (undersized, bytes up without a fix). `how` says how the image was found again.
 */
export function compareImage(
  before: ImageRecord,
  after: ImageRecord | undefined,
  unchangedSrc: boolean,
  how: Pairing = { ambiguous: 0 },
): Check {
  const lines = [`${safeText(before.id)}  ${whereOf(before)}  ${safeText(before.page)}`];
  if (after === undefined) {
    const source = sourceOf(before);
    const looked = [
      source !== undefined ? `source ${safeText(source.replace(/^(file|component):/, ""))}` : "no source",
      before.locator.urlPattern !== undefined ? `URL ${safeText(before.locator.urlPattern)}` : "no URL pattern",
    ].join(", ");
    const why = how.ambiguous > 1 ? `${how.ambiguous} images match that source and URL, so none is picked` : "no image matches";
    return {
      lines: [
        ...lines,
        `  gone: the id is not on the page now (looked for ${looked}; ${why})`,
        "  before concluding it is gone, rescan the page unchanged (pristine) and recheck it again: a moved or re-keyed element is not gone",
      ],
      failures: ["gone"],
    };
  }
  const failures: string[] = [];
  if (how.by === "source") {
    const was = before.locator.line;
    const now = after.locator.line;
    const moved = was !== undefined && now !== undefined && was !== now ? ` (line ${was} -> ${now})` : "";
    lines.push(`  matched by source file and URL, not by id: the element moved or its order changed${moved}`);
  }
  const measured: number[] = [];
  for (const p of before.perViewport.filter((v) => v.renderedCssPx > 0 && KNOWN_VIEWPORTS.includes(v.viewport))) {
    const q: ImagePerViewport | undefined = after.perViewport.find((v) => v.viewport === p.viewport);
    if (q === undefined) continue;
    const name = safeText(p.viewport);
    measured.push(p.servedBytes - q.servedBytes);
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
  // Predicted (the hint, per view, averaged over viewports) next to measured (served bytes at the same viewports).
  const split = before.fix.bytes.sizes !== undefined ? ` (sizes ${kb(before.fix.bytes.sizes)}, quality ${kb(before.fix.bytes.quality ?? 0)})` : "";
  const predicted = `predicted ${saving(savedBefore)}/view${split}`;
  if (measured.length > 0) {
    const mean = measured.reduce((sum, b) => sum + b, 0) / measured.length;
    lines.push(`  ${predicted}; measured ${saving(mean)}/view (served bytes, mean of ${measured.length} viewport(s))`);
  } else lines.push(`  ${predicted}; measured: no viewport in both scans`);
  return { lines, failures };
}

/**
 * The warning when the recheck's scorer is not the scan's: the numbers may then differ for that reason alone. A scan from
 * before --gpu has no scorer and was scored on the CPU.
 */
export function scorerMismatch(previous: PageResult, fresh: PageResult): string | undefined {
  const before = previous.scorer?.name ?? "cpu";
  const after = fresh.scorer?.name ?? "cpu";
  if (before === after) return undefined;
  const name = (scorer: string) => (scorer === "gpu" ? "GPU" : "CPU");
  return `the scan was scored on the ${name(before)} and this recheck on the ${name(after)}; the numbers may differ slightly, so compare them with care`;
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
    gpu: args.gpu,
  });
  const seconds = (Date.now() - started) / 1000;
  if (fresh.status !== "ok") {
    return { output: `recheck: the page is ${safeText(fresh.status)} now${fresh.error ? `: ${safeText(fresh.error)}` : ""}\n`, exitCode: 1 };
  }

  const now = new Map((fresh.images ?? []).map((record) => [record.id, record]));
  const out: string[] = [];
  const note = scorerNote([fresh]);
  const mismatch = scorerMismatch(previous, fresh);
  if (note !== undefined) out.push(note);
  if (mismatch !== undefined) {
    log(`warning: ${mismatch}`);
    out.push(`warning: ${mismatch}`);
  }
  if (note !== undefined || mismatch !== undefined) out.push("");
  const failures: string[] = [];
  for (const before of selected) {
    const how = pairRecord(before, now, fresh.images ?? []);
    const after = how.after;
    const unchangedSrc = before.current.src !== undefined && after !== undefined && earlierSrcs.has(after.current.src ?? "");
    const check = compareImage(before, after, unchangedSrc, how);
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
