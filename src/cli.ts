#!/usr/bin/env node
import { scanCommand } from "./remote.js";
import { hintsCommand } from "./hints.js";
import { recheckScan } from "./recheck.js";
import { locateCommand } from "./locate-only.js";
import { sizesRecheck } from "./sizes-recheck.js";
import { imageCommand } from "./image-file.js";
import { compareCommand } from "./compare.js";
import { reportCommand } from "./report.js";
import { runCommand, DEFAULT_RUN_DIR, DEFAULT_DEEP } from "./run.js";
import { summaryCommand } from "./summary.js";
import { ChromiumMissingError } from "./browser.js";
import { IMGTUNE_VERSION } from "./version.js";

const progress = (message: string) => {
  process.stderr.write(`imgtune: ${message}\n`);
};

/** Option lines, keyed by flag. The scan help lists the flags the scan reads. */
const OPTION_HELP = {
  out: ["--out <dir>", "directory for the JSON files (default: .imgtune/scan)"],
  noCache: ["--no-cache", "do not read or write the result cache in .imgtune/cache (the numbers are computed again)"],
  root: [
    "--root <dir>",
    "folder project source files are read from (default: the nearest folder above the cwd that holds the file, else the nearest with a package.json or .git)",
  ],
  aggressive: ["--aggressive", "also report a delta 4 column (never used for the claim)"],
  viewports: ["--viewports <names>", "comma-separated viewport names to measure (default: all six)"],
  survey: [
    "--survey",
    "fast site-wide pass: viewports iphone-15 and desktop, no quality estimate, 4 pages at once, 3 s network-idle cap. Exact savings only, labelled as such; an explicit flag here overrides its part",
  ],
  pageConcurrency: ["--page-concurrency <N>", "scan up to N pages at once on one browser, 1 to 6 (default 1; --survey sets 4)"],
  idleTimeout: [
    "--idle-timeout <ms>",
    "cap on the wait for network idle after scroll, 0 to 600000 (default 10000; 0 skips the wait; --survey sets 3000)",
  ],
  noQuality: ["--no-quality", "skip the SSIMULACRA2 quality measurement"],
  markdown: ["--markdown <file>", "write a PR-comment Markdown summary: per page, its top groups and the method"],
  failOver: [
    "--fail-over <pct>",
    "exit 3 when a page's exact + est. share is above this percentage (default: never fail)",
  ],
  summaryJson: ["--summary-json <file>", "write one JSON file with every page's status and numbers"],
  harness: [
    "--harness",
    "the pages are harness routes (a temporary /__imgtune/<component> route, or Storybook): measured in isolation, rung measured-harness",
  ],
  ignoreRobots: [
    "--ignore-robots",
    "scan a page even when robots.txt disallows it (a warning is printed; the verdict is recorded in the JSON)",
  ],
  resume: ["--resume", "reuse the complete pages already in --out that were scanned with the same options"],
  maxPages: ["--max-pages <N>", "stop after N pages (scanned or resumed); run again with --resume to continue"],
  maxImages: ["--max-images <N>", "stop after the page that brings the images counted to N (checked between pages)"],
  urlsFrom: [
    "--urls-from <file|sitemap-url>",
    "scan the URLs of a text file (one per line, # comments), a local sitemap.xml, or a remote sitemap (same domain only)",
  ],
  samplePerPattern: [
    "--sample-per-pattern <N>",
    "with --urls-from: at most N URLs per route pattern (/p/*, /c/*), spread over the pattern",
  ],
  allowThirdParty: [
    "--allow-third-party",
    "keep the requests to other sites that the scan blocks by default (scripts, fetch and xhr, iframes, media, websockets, beacons). Use it when a third-party script renders images: without it the scan shows fewer images than the page has",
  ],
  allowHost: [
    "--allow-host <h1,h2>",
    "keep the requests to these hosts while blocking stays on (exact host names, e.g. an image carousel's script)",
  ],
  storageState: [
    "--storage-state <file>",
    "a Playwright storage state (logged-in session) for every context. It holds session cookies: never commit it",
  ],
  recheck: [
    "--recheck <scan.json>",
    "rescan only the images of an earlier scan that have a fix hint, at the viewports where they rendered, and print before and after",
  ],
  ids: ["--ids <a,b,c>", "with --recheck: only these image ids (from the scan JSON's images[].id)"],
  gpu: [
    "--gpu",
    "score with the GPU scorer (imgtune-ssimu2-gpu, see the docs); opt-in. Falls back to the CPU with a warning",
  ],
  gpuDevice: ["--gpu-device <n>", "the GPU to score on, by CUDA index (implies --gpu; default 0; see the GPU notes)"],
  locateOnly: [
    "--locate-only",
    "read the source of the flagged images from a dev page (React owner data) or a built page with source maps (prod-sourcemap); not a measurement (needs --from)",
  ],
  from: ["--from <scan.json>", "with --locate-only: the measured scan of the same page (its flagged images are located)"],
  locateOut: [
    "--locate-out <file>",
    "with --locate-only: where the joined copy is written (default: the measured file's name with .located.json)",
  ],
  sizesOnly: [
    "--sizes-only",
    "with --recheck: judge the sizes choice only (no bytes decoded, nothing scored), on the dev page",
  ],
  failOnBroken: [
    "--fail-on-broken",
    "exit 4 when a page is broken (a document error, a failed stylesheet, or no images where the survey had some); each broken page gives the reason and the fix",
  ],
  url: ["--url <dev page>", "with --recheck --sizes-only: the dev page to check (default: the page the scan file was located on)"],
} as const;

type OptionKey = keyof typeof OPTION_HELP;

const HELP_FLAG: [string, string] = ["-h, --help", "show this help"];

/** Usage text for one command: the synopsis, a description, and the options it reads. */
function commandHelp(synopsis: string, description: string[], options: OptionKey[]): string {
  const rows = [...options.map((key) => OPTION_HELP[key]), HELP_FLAG];
  const width = Math.max(...rows.map(([flag]) => flag.length)) + 2;
  const lines = rows.map(([flag, text]) => `  ${flag.padEnd(width)}${text}`);
  return `Usage: ${synopsis}\n\n${description.join("\n")}\n\nOptions:\n${lines.join("\n")}\n`;
}

const SCAN_HELP = commandHelp(
  "imgtune scan <url> [<url> ...] [options]",
  [
    "Measure live pages by URL, with no source, config or dev server. Writes one JSON file per page to --out.",
    "With --recheck <scan.json> [--ids a,b,c]: rescans only the named images of an earlier scan, at the viewports where they",
    "rendered, and prints before and after. Exits 1 when an image became undersized or bytes rose without a sharpness fix.",
    "The split flow: measure on a built server (scan), locate the flagged images on dev (scan <dev-url> --locate-only --from",
    "<scan.json>), check each edit batch's sizes on dev (scan --recheck <located.json> --sizes-only --ids a,b), measure again.",
    "Needs Chromium for Playwright: npx playwright install chromium.",
  ],
  [
    "out",
    "root",
    "noCache",
    "aggressive",
    "viewports",
    "survey",
    "noQuality",
    "markdown",
    "failOver",
    "summaryJson",
    "ignoreRobots",
    "harness",
    "resume",
    "maxPages",
    "maxImages",
    "pageConcurrency",
    "idleTimeout",
    "urlsFrom",
    "samplePerPattern",
    "storageState",
    "allowThirdParty",
    "allowHost",
    "recheck",
    "ids",
    "gpu",
    "gpuDevice",
    "locateOnly",
    "from",
    "locateOut",
    "sizesOnly",
    "url",
    "failOnBroken",
  ],
);

const RUN_HELP = `Usage: imgtune run <url> [<url> ...] | --urls-from <file|sitemap-url> [options]

The whole agent flow in one command. Survey every URL (two viewports, exact savings only), rank the pages by exact KB per
view and by route pattern, full-scan the worst ones (at least one per worst pattern), optionally locate them on a dev server
(--dev), group the fix hints by call site, and write the run directory. Then it prints the one-screen summary.

The run directory (default ${DEFAULT_RUN_DIR}/<timestamp>) holds survey/ (one JSON per page), deep/, located/ (with --dev),
hints.json and run.json: the manifest, with every file and every command the run executed, so one step can be re-run.
The run stops before the deep phase when more than half of the survey pages are broken (exit 4) or none was measured (exit 1).

Options:
  --urls-from <file|sitemap-url>  a URL list, a local sitemap.xml, or a remote sitemap (same domain)
  --sample-per-pattern <N>        with --urls-from: at most N URLs per route pattern in the survey
  --deep <N>                      deep pages to full-scan (default ${DEFAULT_DEEP}): the worst page of each worst pattern first
  --out <dir>                     the run directory (default ${DEFAULT_RUN_DIR}/<timestamp>)
  --dev <origin>                  locate the deep pages at the same paths on this dev server (a running dev server)
  --qualities <list>              the framework's allowed qualities, e.g. 75,85,100 (passed to hints)
  --gpu, --gpu-device <n>         score the deep pages with the GPU scorer (see the GPU notes; not the survey)
  --page-concurrency <N>          pages at once in the survey (default 4) and in the deep phase (default 1)
  --idle-timeout <ms>             cap on the network-idle wait (default 3000 in the survey, 10000 in the deep phase)
  --no-cache                      do not read or write the result cache
  --root <dir>                    the source folder for --dev (a monorepo sub-folder)
  --storage-state <file>          a logged-in session (holds cookies: never commit it)
  --ignore-robots                 scan pages robots.txt disallows (owned or authorised sites only)
  -h, --help                      show this help
`;

const SUMMARY_HELP = `Usage: imgtune summary <run dir | scan.json ...> [options]

Prints the one-screen summary of a run directory (its run.json, survey/, deep/, located/ and hints.json), or of scan files
(a folder of scan files works too). At most 40 lines: the site totals, the worst patterns, the deep pages, the top call
sites by saving per view (file:line, or not located and why), the warnings and the next commands.

Options:
  --qualities <list>  with scan files: the framework's allowed qualities (passed to hints)
  -h, --help          show this help
`;

const HINTS_HELP = `Usage: imgtune hints <scan.json> [<scan.json> ...] [options]

Prints a compact batch of the per-image fix hints of one or more scanned pages, sorted by the bytes a fix saves. Each hint
names the image, its component and file:line when they resolved, the sizes and quality to use, and the two byte numbers.
Hints of the same call site are grouped across pages; --flat lists each image instead.

Options:
  --page <text>       only pages whose URL contains the text
  --component <name>  only images whose component or file contains the text
  --limit <N>         hints to print (default 10)
  --offset <N>        skip the first N hints (for the next batch)
  --min-kb <N>        only hints that save at least N KB per view
  --top <N>           the N call sites that save the most per view, one line each (no batch, no offset)
  --flat              one hint per image, not grouped by call site
  --qualities <list>  the quality values the framework allows, e.g. 75,85,100 (targets are snapped up to one of them)
  --format <text|json>  text (default) or JSON
  -h, --help          show this help
`;

const IMAGE_HELP = `Usage: imgtune image <file|url|glob> [<file|url|glob> ...] [options]

Measures image files without a page: the bytes now, the lowest quality per format (avif, webp, jpeg) that keeps the file's
SSIMULACRA2 bar, and, with --width, the bytes at the width the image is needed at (width x dpr). The bar is measured
against the file itself: 90 (visually lossless) unless --min-score sets another. Files are read, never written, unless
--write names a folder for optimised copies (existing names are never overwritten).
Evidence is "file-mode". Globs: ** walks folders (node_modules and dot folders are skipped).

Options:
  --width <css px>      the CSS width the image is shown at (the width is then the user's, not the file's)
  --dpr <list>          device pixel ratios for --width (default 1,2)
  --formats <list>      avif, webp, jpeg (default all three)
  --min-score <n>       the SSIMULACRA2 bar, above 0 and at most 100 (default 90)
  --write <dir>         write optimised copies (best format, at the largest needed width) into this folder
  --format <text|json>  text (default) or JSON
  --gpu                 score with the GPU scorer (opt-in; falls back to the CPU with a warning)
  --gpu-device <n>      the GPU to score on, by CUDA index (implies --gpu; default 0). CUDA numbers the GPUs fastest first
                        unless CUDA_DEVICE_ORDER=PCI_BUS_ID; with CUDA_VISIBLE_DEVICES set, n indexes the devices it lists.
                        The scorer prints the name of the GPU it opened: check it.
  --no-cache            do not read or write the result cache in .imgtune/cache
  -h, --help            show this help
`;

const COMPARE_HELP = `Usage: imgtune compare <before.json> <after.json> [options]

Compares two scans of the same page, image by image: images are paired by their srcset URL pattern and alt (in document
order), so the numbers are built against built and drift does not move bytes onto the wrong image. Prints, per view, the
bytes of the paired images before and after, the bytes saved and the bytes added for sharpness (two numbers, never netted),
then the page total (which includes data drift) and the images in one scan only (listed, not counted).

Options:
  --format <text|json>  text (default) or JSON (every paired change and unpaired image)
  --limit <N>           largest changes and unpaired images to print in text (default 10)
  -h, --help            show this help
`;

const REPORT_HELP = `Usage: imgtune report [options]

Builds a Markdown run report from the agent's ledger (.imgtune/ledger.jsonl, one JSON line per usage: id, file, rung, fix,
status, verified, and reason for a reverted, failed, skipped or unmatched usage). With --compare, the bytes come from the JSON
of imgtune compare --format json. Ledger values are data: they are printed as code spans, never as Markdown.

Options:
  --ledger <file>       the ledger (default .imgtune/ledger.jsonl)
  --compare <file>      the JSON of imgtune compare --format json (the bytes section)
  --out <file>          write the Markdown to this file instead of printing it
  -h, --help            show this help
`;

const USAGE = `Usage: imgtune <command> [options]

Commands:
  scan      measure live pages by URL, with no source, config or dev server (writes JSON to --out)
  hints     print a batch of the per-image fix hints of a scan file
  image     measure image files or URLs without a page (--width, --dpr, --formats, --write)
  compare   the per-image before and after of two scans of one page (saved and sharpness bytes)
  report    a Markdown run report from the ledger (and the compare JSON)
  run       the whole flow: survey, worst pages, deep scan, locate (--dev), hints, one run directory and summary
  summary   the one-screen summary of a run directory or of scan files

Run "imgtune run --help", "imgtune summary --help", "imgtune scan --help", "imgtune hints --help", "imgtune image --help", "imgtune compare --help" or "imgtune report --help" for the options of each command.

Options:
  --version           print the version
  -h, --help          show this help
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    process.stdout.write(`${IMGTUNE_VERSION}\n`);
    return;
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    if (argv[0] === "hints") process.stdout.write(HINTS_HELP);
    else if (argv[0] === "image") process.stdout.write(IMAGE_HELP);
    else if (argv[0] === "compare") process.stdout.write(COMPARE_HELP);
    else if (argv[0] === "report") process.stdout.write(REPORT_HELP);
    else if (argv[0] === "run") process.stdout.write(RUN_HELP);
    else if (argv[0] === "summary") process.stdout.write(SUMMARY_HELP);
    else process.stdout.write(argv.includes("scan") ? SCAN_HELP : USAGE);
    return;
  }

  if (argv[0] === "scan" && argv.includes("--locate-only")) {
    const outcome = await locateCommand(argv.slice(1), process.cwd(), progress);
    process.stdout.write(outcome.output);
    process.exitCode = outcome.exitCode;
    return;
  }

  if (argv[0] === "scan" && argv.includes("--recheck") && argv.includes("--sizes-only")) {
    const outcome = await sizesRecheck(argv.slice(1), process.cwd(), progress);
    process.stdout.write(outcome.output);
    process.exitCode = outcome.exitCode;
    return;
  }

  if (argv[0] === "scan" && argv.includes("--recheck")) {
    const outcome = await recheckScan(argv.slice(1), process.cwd(), progress);
    process.stdout.write(outcome.output);
    process.exitCode = outcome.exitCode;
    return;
  }

  if (argv[0] === "image") {
    const outcome = await imageCommand(argv.slice(1), process.cwd());
    process.stdout.write(outcome.output);
    process.exitCode = outcome.exitCode;
    return;
  }

  if (argv[0] === "hints") {
    const hints = await hintsCommand(argv.slice(1), process.cwd());
    process.stdout.write(hints.output);
    process.exitCode = hints.exitCode;
    return;
  }

  if (argv[0] === "run") {
    const outcome = await runCommand(argv.slice(1), process.cwd(), progress);
    process.stdout.write(outcome.output);
    process.exitCode = outcome.exitCode;
    return;
  }

  if (argv[0] === "summary") {
    const outcome = await summaryCommand(argv.slice(1), process.cwd());
    process.stdout.write(outcome.output);
    process.exitCode = outcome.exitCode;
    return;
  }

  if (argv[0] === "report") {
    const outcome = await reportCommand(argv.slice(1), process.cwd());
    process.stdout.write(outcome.output);
    process.exitCode = outcome.exitCode;
    return;
  }

  if (argv[0] === "compare") {
    const outcome = await compareCommand(argv.slice(1), process.cwd());
    process.stdout.write(outcome.output);
    process.exitCode = outcome.exitCode;
    return;
  }

  if (argv[0] !== "scan") {
    console.error(`imgtune: Unknown command "${argv[0]}": expected scan, run, summary, hints, image, compare or report`);
    process.exitCode = 2;
    return;
  }
  const outcome = await scanCommand(argv.slice(1), process.cwd(), progress);
  process.stdout.write(outcome.output);
  process.exitCode = outcome.exitCode;
}

main().catch((err: unknown) => {
  if (err instanceof ChromiumMissingError) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  console.error(`imgtune: ${(err as Error).message}`);
  if (process.env.IMGTUNE_DEBUG === "1" && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
