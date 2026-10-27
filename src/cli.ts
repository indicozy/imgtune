#!/usr/bin/env node
import { type Command, loadConfig } from "./config.js";
import type { ImgtuneConfig } from "./types.js";

type Handler = (config: ImgtuneConfig) => Promise<void>;

// Placeholders, replaced by the real command implementations in Task 13.
const notImplemented = (command: Command): Handler => async () => {
  throw new Error(`${command} is not implemented yet`);
};

const handlers: Record<Command, Handler> = {
  audit: notImplemented("audit"),
  apply: notImplemented("apply"),
  verify: notImplemented("verify"),
  restore: notImplemented("restore"),
};

async function main(): Promise<void> {
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(process.argv.slice(2), process.cwd());
  } catch (err) {
    console.error(`imgtune: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  await handlers[loaded.command](loaded.config);
}

main().catch((err: unknown) => {
  console.error(`imgtune: ${(err as Error).message}`);
  process.exitCode = 1;
});
