import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { ComponentResult } from "../src/analyse.js";
import { detectRunningDevServer } from "../src/server.js";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(import.meta.dirname, "fixtures/next-app");
const CLI = join(ROOT, "dist/cli.js");
const MINUTE = 60_000;
/** Next telemetry off, so the run makes no calls out. NODE_ENV is inherited from vitest ("test") on purpose. */
const CHILD_ENV = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
const CARD_FILE = "components/Card.tsx";
const CONFIG_FILE = "next.config.ts";
/** Project files the run must not change (apart from the applied card and next.config). */
const WATCHED_FILES = ["next.config.ts", "next-env.d.ts", "tsconfig.json"];
const WATCHED_DIRS = ["app", "components"];

let dir: string;
/** Content hashes of every watched source file, taken right after the fixture was installed. */
let original: Map<string, string>;
/** Content hashes after `apply`. */
let applied: Map<string, string>;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function sha(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function walk(root: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const child = join(rel, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Hashes of the watched sources under `root`, keyed by project-relative path. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const files = [...WATCHED_FILES];
  for (const sub of WATCHED_DIRS) files.push(...(await walk(root, sub)));
  const map = new Map<string, string>();
  for (const file of files.sort()) map.set(file, sha(await readFile(join(root, file))));
  return map;
}

/** Keys whose hash differs between two snapshots, sorted. */
function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function httpStatus(url: string): Promise<number | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    await res.arrayBuffer().catch(() => undefined);
    return res.status;
  } catch {
    return undefined;
  }
}

/** Runs `imgtune <args>` against the fixture, capturing both streams. */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, "--project", dir], { cwd: dir, env: CHILD_ENV });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

/** A `next dev` the test owns, started the way a developer would start it. */
async function startDevServer(port: number): Promise<{ stop(): Promise<void> }> {
  const child = spawn("pnpm", ["exec", "next", "dev", "-p", String(port)], {
    cwd: dir,
    env: { ...CHILD_ENV, NODE_ENV: "development" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  const stop = async (): Promise<void> => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    await Promise.race([exited, sleep(10_000)]);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  await waitUntil(
    async () => (await httpStatus(`http://localhost:${port}/ae-en/eyeglasses`)) === 200,
    3 * MINUTE,
    `next dev on port ${port}`,
  );
  return { stop };
}

/** Pid and command line of every process whose working directory is the fixture. */
function leftoverProcesses(root: string): string[] {
  return processesIn(root).map((pid) => {
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    } catch {
      cmd = "(exited)";
    }
    return `${pid} ${cmd}`;
  });
}

/** Pids whose working directory is the fixture: any process left behind by a run. */
function processesIn(root: string): number[] {
  const want = realpathSync(root);
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (realpathSync(`/proc/${entry}/cwd`) === want) pids.push(Number(entry));
    } catch {
      // Exited, or not ours to inspect.
    }
  }
  return pids;
}

async function readReportResults(): Promise<ComponentResult[]> {
  const raw = await readFile(join(dir, ".imgtune/report.json"), "utf8");
  return (JSON.parse(raw) as { results: ComponentResult[] }).results;
}

/** Deterministic LCG in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A smooth synthetic "photo": a gradient, a hard-edged disc and a soft wave, plus light noise (sigma 2). Dense
 * noise would make WebP at quality 75 fail any SSIM threshold, which real product photos do not do.
 */
function syntheticPhoto(index: number): Buffer {
  const size = 1200;
  const next = lcg(index);
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next());
  const cx = 300 + index * 97;
  const cy = 420 + index * 53;
  const radius = 260 + index * 40;
  const data = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 3;
      const inDisc = Math.hypot(x - cx, y - cy) < radius;
      const wave = 0.5 + 0.5 * Math.sin((x + index * 30) / 37) * Math.cos((y - index * 20) / 53);
      const base = [(x / size) * 255, (y / size) * 255, 128 + 60 * wave];
      for (let c = 0; c < 3; c++) {
        const value = inDisc ? 255 - base[(c + 1) % 3] * 0.6 : base[c];
        data[p + c] = Math.min(255, Math.max(0, Math.round(value + 2 * gauss())));
      }
    }
  }
  return data;
}

async function writeImages(): Promise<void> {
  const imgDir = join(dir, "public/img");
  await mkdir(imgDir, { recursive: true });
  for (let i = 1; i <= 8; i++) {
    const jpeg = await sharp(syntheticPhoto(i), { raw: { width: 1200, height: 1200, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    await writeFile(join(imgDir, `p${i}.jpg`), jpeg);
  }
}

beforeAll(async () => {
  execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "pipe" });
  dir = await mkdtemp(join(tmpdir(), "imgtune-e2e-"));
  await cp(FIXTURE, dir, { recursive: true });
  execFileSync("pnpm", ["install", "--prefer-offline", "--frozen-lockfile"], {
    cwd: dir,
    stdio: "pipe",
    timeout: 10 * MINUTE,
  });
  await writeImages();
  original = await snapshot(dir);
}, 15 * MINUTE);

afterAll(async () => {
  if (!dir) return;
  // A failed step can leave a dev server behind; nothing in the fixture may outlive the run.
  for (const pid of processesIn(dir)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await rm(dir, { recursive: true, force: true });
});

describe("imgtune end to end on the Next.js fixture", () => {
  it(
    "refuses a running dev server without --url, and measures against it with --url",
    async () => {
      const port = await freePort();
      const dev = await startDevServer(port);
      try {
        const refused = await runCli(["audit", "--port", String(await freePort())]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("stop it or pass --url");
        expect(await snapshot(dir)).toEqual(original);

        const withUrl = await runCli(["audit", "--url", `http://localhost:${port}`]);
        expect(withUrl.code).toBe(0);
        expect(withUrl.stderr).toContain(`using server http://localhost:${port}`);
        expect(await snapshot(dir)).toEqual(original);
        const results = await readReportResults();
        expect(results[0]?.component).toBe("Card");

        // The user's server is never stopped by the tool.
        expect(detectRunningDevServer(dir).running).toBe(true);
        expect(await httpStatus(`http://localhost:${port}/ae-en/eyeglasses`)).toBe(200);
      } finally {
        await dev.stop();
      }
    },
    10 * MINUTE,
  );

  it(
    "audit with the tool-started server ranks the card first, confirmed, and leaves sources untouched",
    async () => {
      const result = await runCli(["audit", "--port", String(await freePort())]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("imgtune: starting server");
      expect(result.stderr).toContain("imgtune: measuring");
      expect(await snapshot(dir)).toEqual(original);

      const results = await readReportResults();
      const card = results[0];
      expect(card?.component).toBe("Card");
      expect(card?.relFile).toBe(CARD_FILE);
      expect(card?.proposed.sizes).toMatch(/^\(max-width: 768px\) calc\(50vw/);
      expect(card?.estimated).toBe(false);
      // Next's telemetry flush (detached-flush.js) can outlive `next dev` for a moment; the dev server must not.
      await waitUntil(async () => leftoverProcesses(dir).length === 0, 30_000, "no process left in the fixture");
      expect(leftoverProcesses(dir)).toEqual([]);
    },
    10 * MINUTE,
  );

  it(
    "apply changes only the card file and next.config",
    async () => {
      const result = await runCli(["apply"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`edited ${CARD_FILE}`);

      applied = await snapshot(dir);
      // The lower quality (75 -> 45) is not listed in next.config, so apply adds it there too.
      expect(changedBetween(original, applied)).toEqual([CARD_FILE, CONFIG_FILE].sort());
      const card = await readFile(join(dir, CARD_FILE), "utf8");
      expect(card).toMatch(/sizes="\(max-width: 768px\) calc\(50vw/);
    },
    10 * MINUTE,
  );

  it(
    "a second audit skips the applied card",
    async () => {
      const result = await runCli(["audit", "--port", String(await freePort())]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("nothing to measure");
      expect(result.stderr).not.toContain("starting server");
      expect(await snapshot(dir)).toEqual(applied);
    },
    10 * MINUTE,
  );

  it(
    "verify marks the applied card verified",
    async () => {
      const result = await runCli(["verify", "--port", String(await freePort())]);
      expect(result.code).toBe(0);
      const state = JSON.parse(await readFile(join(dir, "imgtune.state.json"), "utf8")) as {
        entries: { relFile: string; verification?: { status: string } }[];
      };
      const entry = state.entries.find((e) => e.relFile === CARD_FILE);
      expect(entry?.verification?.status).toBe("verified");
      expect(await snapshot(dir)).toEqual(applied);
    },
    10 * MINUTE,
  );

  it(
    "SIGINT during measurement restores the sources and leaves no dev server behind",
    async () => {
      const port = await freePort();
      const child = spawn(process.execPath, [CLI, "audit", "--all", "--port", String(port), "--project", dir], {
        cwd: dir,
        env: CHILD_ENV,
      });
      let stderr = "";
      const measuring = new Promise<void>((resolveMeasuring, rejectMeasuring) => {
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
          if (stderr.includes("imgtune: measuring")) resolveMeasuring();
        });
        child.once("exit", () => rejectMeasuring(new Error(`audit exited before measuring: ${stderr}`)));
      });
      await measuring;
      child.kill("SIGINT");
      const code = await new Promise<number | null>((resolveExit) => child.once("exit", (c) => resolveExit(c)));
      expect(code).toBe(130);

      expect(await snapshot(dir)).toEqual(applied);
      await waitUntil(async () => processesIn(dir).length === 0, 30_000, "dev server processes to exit");
      // The lock file Next leaves behind names a pid that may still be a zombie for a moment; wait it out.
      await waitUntil(async () => !detectRunningDevServer(dir).running, 30_000, "dev server lock to clear");
    },
    10 * MINUTE,
  );
});
