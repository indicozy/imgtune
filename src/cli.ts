#!/usr/bin/env node
import { scanCommand } from "./remote.js";
import { hintsCommand } from "./hints.js";
import { recheckScan } from "./recheck.js";
import { imageCommand } from "./image-file.js";
import { ChromiumMissingError } from "./browser.js";
import { IMGTUNE_VERSION } from "./version.js";

const progress = (message: string) => {
  process.stderr.write(`imgtune: ${message}\n`);
};

/** Option lines, keyed by flag. The scan help lists the flags the scan reads. */
const OPTION_HELP = {
  out: ["--out <dir>", "directory for the JSON files (default: .imgtune/scan)"],
  aggressive: ["--aggressive", "also report a delta 4 column (never used for the claim)"],
  viewports: ["--viewports <names>", "comma-separated viewport names to measure (default: all six)"],
  noQuality: ["--no-quality", "skip the SSIMULACRA2 quality measurement"],
  markdown: ["--markdown <file>", "write a PR-comment Markdown summary: per page, its top groups and the method"],
  failOver: [
    "--fail-over <pct>",
    "exit 3 when a page's exact + est. share is above this percentage (default: never fail)",
  ],
  summaryJson: ["--summary-json <file>", "write one JSON file with every page's status and numbers"],
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
  gpuDevice: ["--gpu-device <n>", "the GPU to score on, by nvidia-smi index (implies --gpu; default 0)"],
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
    "Needs Chromium for Playwright: npx playwright install chromium.",
  ],
  [
    "out",
    "aggressive",
    "viewports",
    "noQuality",
    "markdown",
    "failOver",
    "summaryJson",
    "ignoreRobots",
    "resume",
    "maxPages",
    "maxImages",
    "urlsFrom",
    "samplePerPattern",
    "storageState",
    "recheck",
    "ids",
    "gpu",
    "gpuDevice",
  ],
);

const HINTS_HELP = `Usage: imgtune hints <scan.json> [options]

Prints a compact batch of the per-image fix hints of one scanned page, sorted by the bytes a fix saves. Each hint names
the image, its component and file:line when they resolved, the sizes and quality to use, and the two byte numbers.

Options:
  --page <text>       only pages whose URL contains the text
  --component <name>  only images whose component or file contains the text
  --limit <N>         hints to print (default 10)
  --offset <N>        skip the first N hints (for the next batch)
  --min-kb <N>        only hints that save at least N KB per view
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
  --gpu-device <n>      the GPU to score on, by nvidia-smi index (implies --gpu; default 0)
  -h, --help            show this help
`;

const USAGE = `Usage: imgtune <command> [options]

Commands:
  scan      measure live pages by URL, with no source, config or dev server (writes JSON to --out)
  hints     print a batch of the per-image fix hints of a scan file
  image     measure image files or URLs without a page (--width, --dpr, --formats, --write)

Run "imgtune scan --help", "imgtune hints --help" or "imgtune image --help" for the options of each command.

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
    else process.stdout.write(argv.includes("scan") ? SCAN_HELP : USAGE);
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

  if (argv[0] !== "scan") {
    console.error(`imgtune: Unknown command "${argv[0]}": expected scan or hints`);
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
