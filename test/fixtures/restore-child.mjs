// Child process for test/instrument.test.ts. Usage: node restore-child.mjs <mode> <projectDir> <file>
// Node 24 strips the types of the .ts sources directly; no loader is needed.
import { instrument, installRestoreHandlers } from "../../src/instrument.ts";
import { scanFile } from "../../src/scan.ts";

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
