// Ctrl-C and SIGTERM stop a scan. The CLI runs as a child process (dist/cli.js, so `npm run build` first) against a page whose
// body never finishes: the scan is still waiting on it when the signal arrives. The process must exit within a few seconds,
// with the signal's shell exit code (130 for SIGINT, 143 for SIGTERM).
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
const EXIT: Record<"SIGINT" | "SIGTERM", number> = { SIGINT: 130, SIGTERM: 143 };

let server: Server;
let base = "";
let scratch = "";

beforeAll(async () => {
  if (!BUILT) return;
  scratch = await mkdtemp(join(tmpdir(), "imgtune-signal-"));
  server = createServer((req, res) => {
    if (req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    // The head and a first part of the body, then nothing for a minute: the page never finishes loading.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.write('<!doctype html><html><head><meta charset="utf-8"></head><body><p>slow page</p>');
    const timer = setTimeout(() => res.end("</body></html>"), 60_000);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

// Skipped (not failed) without a build: `npm test` runs before `npm run build` on publish and on a fresh checkout.
const BUILT = existsSync(CLI);

describe.skipIf(!BUILT)("a signal ends a scan (needs npm run build)", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`exits within a few seconds on ${signal}, with its exit code`, async () => {
      const child = spawn(process.execPath, [CLI, "scan", `${base}/`, "--out", join(scratch, signal)], {
        cwd: scratch,
        stdio: "ignore",
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
        child.once("exit", (code, sig) => resolveExit({ code, signal: sig })),
      );
      // Let the scan start and reach the slow page before the signal.
      await new Promise((resolveWait) => setTimeout(resolveWait, 4000));
      const started = Date.now();
      child.kill(signal);
      const result = await exited;
      const seconds = (Date.now() - started) / 1000;
      expect(seconds, "seconds until exit").toBeLessThan(5);
      expect(result.code).toBe(EXIT[signal]);
    }, 60_000);
  }
});
