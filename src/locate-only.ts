// `imgtune scan <dev-url> --locate-only --from <measured.json>`: reads the React owner source of the images a measured
// scan flagged (a saving or sharpness growth), from a dev page at one viewport. No image body is read, nothing is decoded,
// encoded or scored. Writes a copy of the measured scan with the sources joined in (locate-join.ts says how).

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { applyLocate, devImagesOf, isFlagged, joinLocate, joinKeyOfImage, joinKeyOfRecord, readMeasuredScan, reasonCounts, type LocateSummary, type MeasuredPage } from "./locate-join.js";
import { observeLight, rootOf } from "./remote.js";
import { parseAllowHosts, thirdPartyFromFlags, type ThirdPartyPolicy } from "./third-party.js";
import type { PageResult } from "./remote.js";
import { unreadSourceNote } from "./source-root.js";
import { safeText } from "./text.js";
import { IMGTUNE_VERSION } from "./version.js";

/** The viewport a locate reads when --viewports does not name one: the scan's reference viewport. */
export const DEFAULT_LOCATE_VIEWPORT = "iphone-15";

export interface LocateArgs {
  url: string;
  from: string;
  viewport?: string;
  out?: string;
  ignoreRobots: boolean;
  /** --root: the folder the project sources are read from. */
  root?: string;
  /** Third-party requests: blocked by default, as in a scan (--allow-third-party, --allow-host). */
  thirdParty: ThirdPartyPolicy;
}

const USAGE = "usage: imgtune scan <dev-url> --locate-only --from <measured-scan.json> [--viewports <name>] [--locate-out <file>]";

const KNOWN_VIEWPORTS: readonly string[] = DEFAULT_VIEWPORTS.map((v) => v.name);

/** The arguments after `scan` for --locate-only. Throws with the message the CLI prints. */
export function parseLocateArgs(argv: string[]): LocateArgs {
  let url: string | undefined;
  let from: string | undefined;
  let viewport: string | undefined;
  let out: string | undefined;
  let root: string | undefined;
  let ignoreRobots = false;
  let allowThirdParty = false;
  let allowHosts: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--locate-only") continue;
    if (arg === "--ignore-robots") {
      ignoreRobots = true;
      continue;
    }
    if (arg === "--allow-third-party") {
      allowThirdParty = true;
      continue;
    }
    if (arg === "--from" || arg === "--viewports" || arg === "--locate-out" || arg === "--root" || arg === "--allow-host") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value (${USAGE})`);
      i++;
      if (arg === "--from") from = value;
      else if (arg === "--locate-out") out = value;
      else if (arg === "--root") root = value;
      else if (arg === "--allow-host") allowHosts = parseAllowHosts(value);
      else {
        if (!KNOWN_VIEWPORTS.includes(value)) throw new Error(`--viewports takes one viewport name for --locate-only, one of ${KNOWN_VIEWPORTS.join(", ")}`);
        viewport = value;
      }
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`${safeText(arg)} is not an option of --locate-only (${USAGE})`);
    if (url !== undefined) throw new Error(`--locate-only reads one dev page (${USAGE})`);
    let parsed: URL;
    try {
      parsed = new URL(arg);
    } catch {
      throw new Error(`${safeText(arg)} is not a URL (${USAGE})`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${safeText(arg)} is not an http or https URL`);
    url = parsed.href;
  }
  if (url === undefined) throw new Error(USAGE);
  if (from === undefined) throw new Error(`--locate-only needs --from <measured-scan.json> (${USAGE})`);
  return { url, from, viewport, out, ignoreRobots, root, thirdParty: thirdPartyFromFlags(allowThirdParty, allowHosts) };
}

/** The default output: the measured file's name with `.located.json` in its place. */
export function defaultLocateOut(from: string): string {
  return `${from.replace(/\.json$/i, "")}.located.json`;
}

const REASON_TEXT: Record<string, string> = {
  "not-measured": "not measured at this viewport",
  "no-dev-image": "no image with this URL on the dev page",
  "count-differs": "the dev page has a different number of this URL and alt",
  "alt-differs": "alt text differs and the URL is not unique",
};

/** `imgtune scan <dev-url> --locate-only`: the text to print and the exit code (1 when nothing joined). */
export async function locateCommand(argv: string[], cwd: string, log: (message: string) => void): Promise<{ output: string; exitCode: number }> {
  const args = parseLocateArgs(argv);
  const { page: measured, dropped } = await readMeasuredScan(args.from, cwd);
  if (dropped > 0) log(`warning: ${dropped} image record(s) of ${safeText(args.from)} are not usable and were left out`);
  const viewport = args.viewport ?? (measured.viewports.includes(DEFAULT_LOCATE_VIEWPORT) ? DEFAULT_LOCATE_VIEWPORT : measured.viewports[0]);
  if (viewport === undefined || !measured.viewports.includes(viewport)) {
    throw new Error(`${safeText(args.from)} has no measured viewport to locate at (measured: ${measured.viewports.map((v) => safeText(v)).join(", ")})`);
  }
  const measuredPath = new URL(measured.url).pathname;
  const devPath = new URL(args.url).pathname;
  if (devPath !== measuredPath) throw new Error(`the dev page path ${safeText(devPath)} is not the measured page's ${safeText(measuredPath)}`);

  const flagged = measured.images.filter(isFlagged);
  const flaggedSet = new Set(flagged);
  const flaggedPatterns = new Set(flagged.map((r) => joinKeyOfRecord(r)));
  const started = Date.now();
  const root = await rootOf(args.root, cwd);
  const light = await observeLight(args.url, {
    cwd,
    root,
    viewports: DEFAULT_VIEWPORTS.filter((v) => v.name === viewport).map((v) => ({ ...v })),
    log,
    ignoreRobots: args.ignoreRobots,
    wanted: (img, pageUrl) => flaggedPatterns.has(joinKeyOfImage(img, pageUrl)),
    thirdParty: args.thirdParty,
  });
  if (light.status !== "ok") {
    return { output: `locate: the dev page is ${light.status}${light.error ? `: ${safeText(light.error)}` : ""}\n`, exitCode: 1 };
  }
  const observation = light.observations[0];
  const devImages = devImagesOf(observation, args.url, light.resolved);
  const unread = await unreadSourceNote(
    devImages.flatMap((d) => (d.kind === "unread" && d.file !== undefined ? [d.file] : [])),
    cwd,
    root,
  );
  const join = joinLocate(measured.images, viewport, devImages, (record) => flaggedSet.has(record));
  const seconds = (Date.now() - started) / 1000;

  const summary: LocateSummary = {
    url: args.url,
    viewport,
    scannedAt: new Date().toISOString(),
    imgtuneVersion: IMGTUNE_VERSION,
    seconds: Math.round(seconds * 10) / 10,
    flagged: flagged.length,
    joined: join.pairs.size,
    notJoined: flagged.length - join.pairs.size,
    devLeft: join.devLeft.length,
    noOrder: join.noOrder,
    reasons: reasonCounts(join),
  };
  const located: PageResult = { ...measured, locate: summary, images: applyLocate(measured.images, join, viewport) };
  const outPath = resolve(cwd, args.out ?? defaultLocateOut(args.from));
  if (outPath === resolve(cwd, args.from)) throw new Error("--locate-out must not be the measured scan itself");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFileAtomic(outPath, `${JSON.stringify(located, null, 2)}\n`, { root: dirname(outPath) });

  const lines = [
    `locate: ${safeText(args.url)} at ${viewport} in ${summary.seconds} s (no image bytes read, nothing decoded or scored)`,
    `flagged images: ${summary.flagged}; located: ${summary.joined}; not located: ${summary.notJoined}`,
  ];
  for (const [code, count] of Object.entries(summary.reasons)) lines.push(`  not located, ${count}: ${REASON_TEXT[code] ?? code}`);
  if (summary.devLeft > 0) lines.push(`dev images of a flagged URL with no measured partner: ${summary.devLeft}`);
  if (summary.noOrder > 0) lines.push(`measured elements without an element order: ${summary.noOrder} (the scan is older: scan again)`);
  lines.push(`wrote ${safeText(outPath)}`);
  const exitCode = flagged.length > 0 && summary.joined === 0 ? 1 : 0;
  if (exitCode !== 0) lines.push("nothing located: is this the dev page of the measured scan, with the same images?");
  else lines.push(`next: imgtune hints ${safeText(outPath)}`);
  return { output: `${lines.join("\n")}\n${unread ?? ""}`, exitCode };
}
