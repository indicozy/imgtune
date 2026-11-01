// `imgtune scan --recheck <file> --sizes-only [--ids a,b,c] [--url <dev page>]`: the sizes check of an edit batch, on the dev
// page. Per image and viewport it reads what the browser chose: the `sizes` attribute, the rendered CSS width, the DPR, the
// srcset candidate it loaded and that file's bytes (the response's Content-Length: no body read, no decode, no score). It
// judges the choice against the hint's sizes and against the measured file of the scan. Seconds, not minutes.

import { DEFAULT_VIEWPORTS } from "./config.js";
import { hasFix, type ImageRecord, type ImagePerViewport } from "./images.js";
import { devImagesOf, httpUrl, joinLocate, joinKeyOfImage, joinKeyOfRecord, readMeasuredScan, type DevImage, type LocateJoin } from "./locate-join.js";
import { ID_PATTERN } from "./recheck.js";
import { isUndersized, neededWidth, observeLight, rightCandidate, type ViewportObservation } from "./remote.js";
import { parseSrcset } from "./srcset-parse.js";
import { sizesSlotAt } from "./sizes.js";
import { safeText } from "./text.js";
import { batchLine, rowLine, type RecheckRow } from "./recheck-rows.js";

export interface SizesArgs {
  file: string;
  ids?: string[];
  url?: string;
  ignoreRobots: boolean;
}

const USAGE = "usage: imgtune scan --recheck <scan.json> --sizes-only [--ids a,b,c] [--url <dev page>] [--ignore-robots]";

/** The arguments of `scan --recheck --sizes-only`. Throws with the message the CLI prints. */
export function parseSizesArgs(argv: string[]): SizesArgs {
  let file: string | undefined;
  let ids: string[] | undefined;
  let url: string | undefined;
  let ignoreRobots = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sizes-only" || arg === "--recheck") {
      if (arg === "--sizes-only") continue;
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--recheck needs a value (${USAGE})`);
      i++;
      file = value;
      continue;
    }
    if (arg === "--ignore-robots") {
      ignoreRobots = true;
      continue;
    }
    if (arg === "--ids" || arg === "--url") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value (${USAGE})`);
      i++;
      if (arg === "--url") {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          throw new Error(`--url is not a URL (${USAGE})`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("--url is not an http or https URL");
        url = parsed.href;
      } else {
        ids = value.split(",").map((id) => id.trim()).filter((id) => id !== "");
        if (ids.length === 0) throw new Error(`--ids needs at least one image id (${USAGE})`);
        const invalid = ids.filter((id) => !ID_PATTERN.test(id));
        if (invalid.length > 0) throw new Error(`not an image id: ${invalid.map((id) => safeText(id)).join(", ")}`);
      }
      continue;
    }
    throw new Error(`${safeText(arg)} is not an option of --sizes-only (${USAGE})`);
  }
  if (file === undefined) throw new Error(USAGE);
  return { file, ids, url, ignoreRobots };
}

/** What the browser chose at one viewport, and what the hint's sizes would choose there. */
export interface ChoiceInput {
  dpr: number;
  viewportWidth: number;
  /** The rendered CSS width of the element at this viewport. */
  rendered: number;
  /** The sizes attribute on the dev page now. */
  sizes?: string;
  srcset: string;
  pageUrl: string;
  /** The file the browser loaded (currentSrc). */
  chosenUrl: string;
  /** The bytes of that file (Content-Length); undefined when the response did not give them. */
  chosenBytes?: number;
  /** The measured scan's record of this element at this viewport. */
  before?: Pick<ImagePerViewport, "servedPx" | "servedBytes" | "undersized">;
  /** The sizes the hint proposes (the record's fix). */
  proposed?: string;
}

/** The verdict on one image at one viewport. `note` says why there is none (a plain image has no candidates to choose). */
export interface ChoiceVerdict {
  needed: number;
  chosenWidth?: number;
  undersized?: boolean;
  targetWidth?: number;
  fails: string[];
  note?: string;
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/**
 * The check of one choice. Fails when the chosen file is undersized (below the device pixels needed), when it is bigger than
 * the candidate the hint's sizes choose, and when its bytes rose on an image that was not undersized before (no sharpness
 * fix to pay for them). A choice that cannot be judged (no srcset, or the file is not one of its candidates) passes with a note.
 */
export function judgeChoice(input: ChoiceInput): ChoiceVerdict {
  const candidates = parseSrcset(input.srcset, input.pageUrl);
  const widths = candidates.map((c) => c.width);
  if (candidates.length === 0) {
    return { needed: Math.ceil(input.rendered * input.dpr), fails: [], note: "no srcset: sizes do not choose this file" };
  }
  const largest = Math.max(...widths);
  const needed = neededWidth(input.rendered, input.dpr, largest);
  const chosen = candidates.find((c) => c.url === input.chosenUrl);
  if (chosen === undefined) return { needed, fails: [], note: "the file loaded is not one of the srcset candidates" };
  const fails: string[] = [];
  const undersized = isUndersized(chosen.width, needed, largest);
  if (undersized) fails.push(`undersized: ${chosen.width}w is below the ${needed} px needed`);
  let targetWidth: number | undefined;
  if (input.proposed !== undefined) {
    const slot = sizesSlotAt(input.proposed, input.viewportWidth);
    if (slot !== undefined) targetWidth = rightCandidate(candidates, Math.ceil(slot * input.dpr)).width;
  }
  if (targetWidth !== undefined && chosen.width > targetWidth) {
    fails.push(`bigger than the hint needs: ${chosen.width}w, the hint's sizes choose ${targetWidth}w`);
  }
  const before = input.before;
  if (before && input.chosenBytes !== undefined && input.chosenBytes > before.servedBytes && !before.undersized) {
    fails.push(`bytes rose ${kb(before.servedBytes)} -> ${kb(input.chosenBytes)} without a sharpness fix`);
  }
  return { needed, chosenWidth: chosen.width, undersized, targetWidth, fails };
}

const yesNo = (value: boolean | undefined): string => (value === true ? "yes" : "no");

/** Where a record is, for its heading: its file and line, else its component, else its selector. */
function whereOf(record: ImageRecord): string {
  const { file, line, component, selector } = record.locator;
  if (file !== undefined) return `${safeText(file)}:${line ?? 0}`;
  return component.length > 0 ? safeText(component[0]) : safeText(selector);
}

/** The path of a page, for the heading (the host is the built server's, which the dev check does not use). */
const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return safeText(url);
  }
};

/** The sizes check, printed. Exit 1 when any image failed; a dev page that cannot be read fails the run. */
export async function sizesRecheck(argv: string[], cwd: string, log: (message: string) => void): Promise<{ output: string; exitCode: number }> {
  const args = parseSizesArgs(argv);
  const { page: measured, dropped, locateDropped } = await readMeasuredScan(args.file, cwd);
  if (dropped > 0) log(`warning: ${dropped} image record(s) of ${safeText(args.file)} are not usable and were left out`);
  if (locateDropped) log(`warning: the locate block of ${safeText(args.file)} is not usable (its dev URL, viewport or counts) and was ignored`);
  const given = args.url ?? measured.locate?.url;
  if (given === undefined) {
    throw new Error(`${safeText(args.file)} has no dev page: pass --url <dev page>, or run scan --locate-only on the dev page first`);
  }
  const target = httpUrl(given);
  if (target === undefined) throw new Error(`the dev page ${safeText(String(given))} is not an http or https URL`);
  const measuredPath = new URL(measured.url).pathname;
  if (new URL(target).pathname !== measuredPath) throw new Error(`the dev page path is not the measured page's ${safeText(measuredPath)}`);

  const byId = new Map(measured.images.map((record) => [record.id, record]));
  let selected: ImageRecord[];
  if (args.ids !== undefined) {
    const missing = args.ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`no image ${missing.map((id) => safeText(id)).join(", ")} in ${safeText(args.file)}`);
    selected = args.ids.map((id) => byId.get(id) as ImageRecord);
  } else {
    selected = measured.images.filter(hasFix);
  }
  if (selected.length === 0) return { output: "no images to recheck\n", exitCode: 0 };

  const selectedSet = new Set(selected);
  const viewports = DEFAULT_VIEWPORTS.filter((v) =>
    selected.some((r) => r.perViewport.some((p) => p.viewport === v.name && p.renderedCssPx > 0)),
  );
  if (viewports.length === 0) throw new Error("none of the images rendered in that scan");
  const flaggedPatterns = new Set(selected.map((r) => joinKeyOfRecord(r)));

  const started = Date.now();
  const light = await observeLight(target, {
    cwd,
    viewports: viewports.map((v) => ({ ...v })),
    log,
    ignoreRobots: args.ignoreRobots,
    wanted: (img, pageUrl) => flaggedPatterns.has(joinKeyOfImage(img, pageUrl)),
  });
  if (light.status !== "ok") {
    return { output: `recheck: the dev page is ${light.status}${light.error ? `: ${safeText(light.error)}` : ""}\n`, exitCode: 1 };
  }

  // Per viewport: the dev elements and the join, computed once for every image of the batch.
  const perView = new Map<string, { observation: ViewportObservation; devImages: DevImage[]; join: LocateJoin }>();
  for (const observation of light.observations) {
    const name = observation.viewport.name;
    const devImages = devImagesOf(observation, target, light.resolved);
    perView.set(name, { observation, devImages, join: joinLocate(measured.images, name, devImages, (r) => selectedSet.has(r)) });
  }

  const out: string[] = [];
  const failures: string[] = [];
  const rows: RecheckRow[] = [];
  const details: string[] = [];
  for (const record of selected) {
    const proposed = record.fix.sizes?.value;
    const now = JSON.stringify(safeText(record.current.sizes ?? "none"));
    const lines: string[] = [`${record.id}  ${whereOf(record)}  ${pathOf(record.page)}  sizes ${now} -> hint ${JSON.stringify(safeText(proposed ?? "-"))}`];
    const failed: string[] = [];
    let gone = false;
    const saved: number[] = [];
    for (const p of record.perViewport) {
      if (p.renderedCssPx <= 0) continue;
      const view = perView.get(p.viewport);
      if (view === undefined) continue;
      const pair = view.join.pairs.get(record);
      const name = safeText(p.viewport).padEnd(18);
      if (pair === undefined) {
        const reason = view.join.reasons.get(record)?.text ?? "no image of this URL at this viewport";
        lines.push(`  ${name}gone: ${safeText(reason)}`);
        failed.push(`${record.id}: ${p.viewport}: gone`);
        gone = true;
        continue;
      }
      const dev = pair.dev;
      const dpr = view.observation.viewport.dpr;
      const width = view.observation.viewport.width;
      const response = view.observation.responses.get(dev.currentSrc);
      const verdict = judgeChoice({
        dpr,
        viewportWidth: width,
        rendered: dev.renderedCssPx,
        sizes: dev.sizes,
        srcset: dev.srcset,
        pageUrl: target,
        chosenUrl: dev.currentSrc,
        chosenBytes: response?.bytesKnown === false ? undefined : response?.bytes,
        before: p,
        proposed,
      });
      if (response !== undefined && response.bytesKnown !== false) saved.push(p.servedBytes - response.bytes);
      const bytes = response === undefined || response.bytesKnown === false ? "bytes ?" : `bytes ${kb(response.bytes)}`;
      const chosen = verdict.chosenWidth !== undefined ? `chosen ${verdict.chosenWidth}w` : "chosen ?";
      const targetText = verdict.targetWidth !== undefined ? `target ${verdict.targetWidth}w` : "target -";
      const result =
        verdict.fails.length > 0
          ? `FAIL: ${verdict.fails.join("; ")}`
          : verdict.note !== undefined
            ? `n/a: ${verdict.note}`
            : "pass";
      lines.push(
        `  ${name}dpr ${dpr}  sizes ${JSON.stringify(safeText(dev.sizes ?? "none"))}  rendered ${dev.renderedCssPx} px  needed ${verdict.needed} px  ${chosen}  undersized ${yesNo(verdict.undersized)}  ${bytes} (was ${kb(p.servedBytes)})  ${targetText}  ${result}`,
      );
      for (const fail of verdict.fails) failed.push(`${record.id}: ${p.viewport}: ${fail}`);
    }
    const verdict = gone ? "GONE" : failed.length > 0 ? "FAIL" : "PASS";
    const predicted = record.fix.bytes.sizes ?? record.fix.bytes.saved;
    const measured = saved.length > 0 ? saved.reduce((sum, b) => sum + b, 0) / saved.length : undefined;
    rows.push({ id: record.id, where: whereOf(record), verdict, predicted, measured });
    failures.push(...failed);
    // One line per image; the viewport detail follows only for an image that did not pass.
    if (verdict === "PASS") continue;
    details.push(...lines, "");
  }
  const seconds = (Date.now() - started) / 1000;
  out.push(...rows.map(rowLine));
  if (details.length > 0) out.push("", "not passed:", ...details);
  out.push(batchLine(rows, seconds) + " (sizes only: no body decoded, nothing scored)");
  out.push(failures.length === 0 ? "ok: every chosen file is sharp and no bigger than the hint needs" : `FAILED: ${failures.length} check(s)`);
  for (const failure of failures) out.push(`  ${safeText(failure)}`);
  return { output: `${out.join("\n")}\n`, exitCode: failures.length === 0 ? 0 : 1 };
}
