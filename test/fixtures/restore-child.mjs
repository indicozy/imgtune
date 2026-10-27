// Child process for test/instrument.test.ts. Usage: node restore-child.mjs <mode> <projectDir> <file>
import { register } from "node:module";

register("./ts-js-hook.mjs", import.meta.url);
const { instrument, installRestoreHandlers } = await import("../../src/instrument.ts");
const { scanFile } = await import("../../src/scan.ts");

const [mode, projectDir, file] = process.argv.slice(2);

installRestoreHandlers(projectDir);
installRestoreHandlers(projectDir);

if (mode === "count") {
  console.log(process.listenerCount("SIGINT"));
} else {
  await instrument(projectDir, scanFile(file, projectDir));
  if (mode === "sigint") {
    process.kill(process.pid, "SIGINT");
    setTimeout(() => {}, 10_000);
  } else if (mode === "uncaught") {
    setTimeout(() => {
      throw new Error("boom");
    }, 0);
  }
  // mode "exit": return normally, the exit handler restores.
}
