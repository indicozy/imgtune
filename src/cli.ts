#!/usr/bin/env node
import { applyCommand, audit, progress, restoreCommand } from "./audit.js";
import { type Command, loadConfig } from "./config.js";
import { verify } from "./verify.js";
import { scanCommand } from "./remote.js";
import { ChromiumMissingError } from "./browser.js";
import { IMGTUNE_VERSION } from "./version.js";
import type { ImgtuneConfig } from "./types.js";

type Handler = (config: ImgtuneConfig, allowGrowth: boolean) => Promise<void>;

const handlers: Record<Command, Handler> = {
  audit: async (config) => {
    await audit(config);
  },
  apply: async (config, allowGrowth) => {
    await applyCommand(config.projectDir, progress, { allowGrowth });
  },
  verify: async (config) => {
    await verify(config);
  },
  restore: async (config) => {
    await restoreCommand(config.projectDir);
  },
};

/** Option lines, keyed by flag. The per-command help lists the flags each command reads. */
const OPTION_HELP = {
  project: ["--project <dir>", "project directory (default: current directory)"],
  path: ["--path <path>", "limit the scan to a file or directory (repeatable; default: .)"],
  metric: ["--metric <name>", "ssimulacra2 (default, built in), ssimulacra2-native (the ssimulacra2_rs binary) or ssim"],
  quality: [
    "--quality <level>",
    "relaxed (default) or strict. ssimulacra2: relative, a sample may drop 2 (relaxed) or 1 (strict) points from its current score, never below 70 / 80. ssim: absolute 0.975 / 0.99",
  ],
  maxDrop: [
    "--max-drop <points>",
    "relative rule (ssimulacra2): a sample may drop this many points from its current score (default: 2 relaxed, 1 strict). Positive; not with --threshold or ssim",
  ],
  threshold: [
    "--threshold <n>",
    "absolute pass mark on the metric's scale (0-100 ssimulacra2, 0-1 ssim). Overrides --quality and switches the relative rule off",
  ],
  port: ["--port <n>", "port for a dev server the tool starts (default: 3999)"],
  url: ["--url <baseUrl>", "measure a server that is already running; the tool never starts or stops it"],
  all: ["--all", "also re-measure usages that were already applied"],
  allowGrowth: ["--allow-growth", "write the full sizes correction, including media branches that grow bytes"],
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

const COMMAND_HELP: Record<Command | "scan", string> = {
  audit: commandHelp(
    "imgtune audit [options]",
    [
      "Measure the images of a running app and propose sizes and quality. Writes .imgtune/report.json.",
      "Starts the app's dev server unless --url names one that is already running.",
    ],
    ["project", "path", "metric", "quality", "maxDrop", "threshold", "port", "url", "all"],
  ),
  apply: commandHelp(
    "imgtune apply [options]",
    ["Write the proposals of the last audit into the source files. Nothing is committed."],
    ["project", "allowGrowth"],
  ),
  verify: commandHelp(
    "imgtune verify [options]",
    ["Re-check applied changes against the served images. Report only: the source files are not changed."],
    ["project", "path", "metric", "quality", "maxDrop", "threshold", "port", "url"],
  ),
  restore: commandHelp(
    "imgtune restore [options]",
    ["Undo the instrumentation an interrupted run left in the source files."],
    ["project"],
  ),
  scan: commandHelp(
    "imgtune scan <url> [<url> ...] [options]",
    [
      "Measure live pages by URL, with no source, config or dev server. Writes one JSON file per page to --out.",
      "Needs Chromium for Playwright: npx playwright install chromium.",
    ],
    ["out", "aggressive", "viewports", "noQuality", "markdown", "failOver", "summaryJson"],
  ),
};

const COMMAND_NAMES = Object.keys(COMMAND_HELP) as (Command | "scan")[];

const USAGE = `Usage: imgtune <command> [options]

Commands:
  audit     measure the images of a running app and propose sizes and quality (writes .imgtune/report.json)
  apply     write the proposals of the last audit into the source files
  verify    re-check applied changes against the served images (report only)
  restore   undo the instrumentation an interrupted run left in the source files
  scan      measure live pages by URL, with no source, config or dev server (writes JSON to --out)

Run "imgtune <command> --help" for the options of one command.

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
    const named = argv.find((arg) => (COMMAND_NAMES as string[]).includes(arg));
    process.stdout.write(named === undefined ? USAGE : COMMAND_HELP[named as Command | "scan"]);
    return;
  }

  if (argv[0] === "scan") {
    const outcome = await scanCommand(argv.slice(1), process.cwd(), progress);
    process.stdout.write(outcome.output);
    process.exitCode = outcome.exitCode;
    return;
  }

  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(argv, process.cwd());
  } catch (err) {
    console.error(`imgtune: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  await handlers[loaded.command](loaded.config, loaded.allowGrowth);
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
