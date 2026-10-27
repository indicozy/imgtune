import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHILD = resolve(import.meta.dirname, "fixtures/start-next-child.mjs");
const HANG = resolve(import.meta.dirname, "fixtures/fake-dev/hang-record.mjs");

/** True while any process is still in the group (signal 0 probes it). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe("startNext under SIGINT", () => {
  it("SIGINT during the readiness wait exits and takes the dev server's process group down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgtune-kill-"));
    const pidFile = join(dir, "dev.pid");
    const port = await freePort();

    const child = spawn(process.execPath, [CHILD, dir, String(port), HANG], {
      env: { ...process.env, IMGTUNE_PIDFILE: pidFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));

    // Wait until the fake dev server has started and startNext is blocked on readiness.
    expect(await until(() => existsSync(pidFile) && stdout.includes("waiting"), 20_000)).toBe(true);
    const devPgid = Number(readFileSync(pidFile, "utf8"));
    expect(groupAlive(devPgid)).toBe(true);

    child.kill("SIGINT");

    expect(await exited).toBe(130);
    expect(await until(() => !groupAlive(devPgid), 10_000)).toBe(true);
    expect(stdout).not.toContain("ready");
  }, 60_000);
});
