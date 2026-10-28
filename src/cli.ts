#!/usr/bin/env node
import { applyCommand, audit, progress, restoreCommand } from "./audit.js";
import { type Command, loadConfig } from "./config.js";
import { verify } from "./verify.js";
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

const USAGE = `Usage: imgtune <command> [options]

Commands:
  audit     measure the images of a running app and propose sizes and quality (writes .imgtune/report.json)
  apply     write the proposals of the last audit into the source files
  verify    re-check applied changes against the served images (report only)
  restore   undo the instrumentation an interrupted run left in the source files

Options:
  --project <dir>     project directory (default: current directory)
  --path <path>       limit the scan to a file or directory (repeatable; default: .)
  --metric <name>     ssimulacra2 (default) or ssim
  --quality <level>   relaxed (default) or strict; ssimulacra2 >= 88 / >= 90, ssim >= 0.975 / >= 0.99
  --threshold <n>     pass mark on the metric's scale (0-100 ssimulacra2, 0-1 ssim); overrides --quality
  --port <n>          port for a dev server the tool starts (default: 3999)
  --url <baseUrl>     measure a server that is already running; the tool never starts or stops it
  --all               also re-measure usages that were already applied
  --allow-growth      apply: write the full sizes correction, including media branches that grow bytes
  -h, --help          show this help
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
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
  console.error(`imgtune: ${(err as Error).message}`);
  if (process.env.IMGTUNE_DEBUG === "1" && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
