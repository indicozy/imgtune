import { afterAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  detectDevCommand,
  detectRunningDevServer,
  runningServerMessage,
  startNext,
} from "../src/server.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/fake-dev");
const created: string[] = [];
const children: { kill(signal: NodeJS.Signals): boolean }[] = [];

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "imgtune-server-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

describe("detectDevCommand", () => {
  it("uses pnpm for pnpm-lock.yaml", () => {
    const dir = makeProject({ "pnpm-lock.yaml": "" });
    expect(detectDevCommand(dir)).toEqual(["pnpm", "exec", "next", "dev"]);
  });

  it("uses yarn for yarn.lock", () => {
    const dir = makeProject({ "yarn.lock": "" });
    expect(detectDevCommand(dir)).toEqual(["yarn", "next", "dev"]);
  });

  it("uses bun for bun.lockb and bun.lock", () => {
    expect(detectDevCommand(makeProject({ "bun.lockb": "" }))).toEqual([
      "bun",
      "x",
      "next",
      "dev",
    ]);
    expect(detectDevCommand(makeProject({ "bun.lock": "" }))).toEqual([
      "bun",
      "x",
      "next",
      "dev",
    ]);
  });

  it("uses npx for package-lock.json and when no lockfile exists", () => {
    expect(detectDevCommand(makeProject({ "package-lock.json": "" }))).toEqual([
      "npx",
      "next",
      "dev",
    ]);
    expect(detectDevCommand(makeProject())).toEqual(["npx", "next", "dev"]);
  });

  it("prefers pnpm over yarn, bun and npm when several lockfiles exist", () => {
    const dir = makeProject({
      "package-lock.json": "",
      "bun.lock": "",
      "yarn.lock": "",
      "pnpm-lock.yaml": "",
    });
    expect(detectDevCommand(dir)).toEqual(["pnpm", "exec", "next", "dev"]);
  });

  it("an explicit override wins over the lockfile", () => {
    const dir = makeProject({ "pnpm-lock.yaml": "" });
    expect(detectDevCommand(dir, ["node", "custom-dev.js"])).toEqual(["node", "custom-dev.js"]);
  });
});

describe("detectRunningDevServer", () => {
  it("reports a server whose lock file names a live pid", () => {
    const dir = makeProject({
      ".next/dev/lock": JSON.stringify({
        pid: process.pid,
        port: 3000,
        hostname: "localhost",
        appUrl: "http://localhost:3000",
        startedAt: 0,
      }),
    });
    expect(detectRunningDevServer(dir)).toEqual({
      running: true,
      pid: process.pid,
      appUrl: "http://localhost:3000",
    });
  });

  it("ignores a lock file whose pid is dead", () => {
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const dir = makeProject({
      ".next/dev/lock": JSON.stringify({ pid: exited.pid, port: 3000 }),
    });
    expect(detectRunningDevServer(dir)).toEqual({ running: false });
  });

  it("reports a next dev process whose cwd is the project", async () => {
    if (process.platform !== "linux") return;
    const dir = makeProject();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "next", "dev"], {
      cwd: dir,
      stdio: "ignore",
    });
    children.push(child);
    try {
      let status = detectRunningDevServer(dir);
      for (let i = 0; i < 20 && !status.running; i++) {
        await new Promise((r) => setTimeout(r, 50));
        status = detectRunningDevServer(dir);
      }
      expect(status).toEqual({ running: true, pid: child.pid });
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("reports nothing for a project with no lock file and no next dev process", () => {
    expect(detectRunningDevServer(makeProject())).toEqual({ running: false });
  });
});

describe("runningServerMessage", () => {
  it("names the pid and app url", () => {
    expect(
      runningServerMessage({ running: true, pid: 4242, appUrl: "http://localhost:3000" }),
    ).toBe(
      "a dev server is running for this project (pid 4242, http://localhost:3000); stop it or pass --url <baseUrl>",
    );
  });

  it("omits the url when the lock file has none", () => {
    expect(runningServerMessage({ running: true, pid: 4242 })).toBe(
      "a dev server is running for this project (pid 4242); stop it or pass --url <baseUrl>",
    );
  });
});

describe("startNext", () => {
  it("waits for HTTP, returns the base url, and stops the process", async () => {
    const dir = makeProject();
    const port = await freePort();
    const server = await startNext(dir, port, [process.execPath, join(FIXTURES, "serve.mjs")]);
    expect(server.baseUrl).toBe(`http://localhost:${port}`);
    const res = await fetch(`${server.baseUrl}/`);
    expect(res.status).toBe(200);
    await server.stop();
    await expect(fetch(`${server.baseUrl}/`)).rejects.toThrow();
  });

  it("fails fast with the exit code and output when the command exits early", async () => {
    const dir = makeProject();
    const port = await freePort();
    const started = Date.now();
    await expect(
      startNext(dir, port, [process.execPath, join(FIXTURES, "exit-now.mjs")]),
    ).rejects.toThrow(/exit(ed)? .*code 3[\s\S]*fake dev failure/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("gives up after the timeout when the server never answers", async () => {
    const dir = makeProject();
    const port = await freePort();
    await expect(
      startNext(dir, port, [process.execPath, join(FIXTURES, "hang.mjs")], { timeoutMs: 1500 }),
    ).rejects.toThrow(/timed out/);
  });
});
