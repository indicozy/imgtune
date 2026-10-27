// Child process for test/server-kill.test.ts. Usage: node start-next-child.mjs <projectDir> <port> <devScript>
// Runs the real startNext under the real restore handlers, like the CLI does, so SIGINT takes the exit path.
import { register } from "node:module";

register("./ts-js-hook.mjs", import.meta.url);
const { startNext } = await import("../../src/server.ts");
const { installRestoreHandlers } = await import("../../src/instrument.ts");

const [projectDir, port, devScript] = process.argv.slice(2);
installRestoreHandlers(projectDir);
process.stdout.write("waiting\n");
await startNext(projectDir, Number(port), [process.execPath, devScript], { timeoutMs: 120_000 });
process.stdout.write("ready\n");
