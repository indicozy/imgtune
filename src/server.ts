import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";

const LOG_LINES = 40;
const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 5_000;
const MAX_PARTIAL_LINE = 4096;

const LOCKFILE_COMMANDS: { files: string[]; command: string[] }[] = [
  { files: ["pnpm-lock.yaml"], command: ["pnpm", "exec", "next", "dev"] },
  { files: ["yarn.lock"], command: ["yarn", "next", "dev"] },
  { files: ["bun.lockb", "bun.lock"], command: ["bun", "x", "next", "dev"] },
];
const NPX_COMMAND = ["npx", "next", "dev"];

export interface RunningDevServer {
  running: true;
  pid: number;
  appUrl?: string;
}

export type DevServerStatus = RunningDevServer | { running: false };

export interface StartedNext {
  baseUrl: string;
  /** Process id of the dev command, which leads its own process group. */
  pid: number;
  stop(): Promise<void>;
}

/** Picks the dev command from the lockfile; `override` (config.devCommand) wins. */
export function detectDevCommand(projectDir: string, override?: string[]): string[] {
  if (override && override.length > 0) return [...override];
  for (const { files, command } of LOCKFILE_COMMANDS) {
    if (files.some((file) => existsSync(join(projectDir, file)))) return [...command];
  }
  return [...NPX_COMMAND];
}

/**
 * Finds a `next dev` server already running for `projectDir`: first via the
 * lock file Next holds in `.next/dev/lock`, then (Linux) via /proc.
 */
export function detectRunningDevServer(projectDir: string): DevServerStatus {
  const fromLock = detectFromLockFile(projectDir);
  if (fromLock) return fromLock;
  if (process.platform === "linux") {
    const fromProc = detectFromProc(projectDir);
    if (fromProc) return fromProc;
  }
  return { running: false };
}

export function runningServerMessage(info: RunningDevServer): string {
  const where = info.appUrl ? `, ${info.appUrl}` : "";
  return `a dev server is running for this project (pid ${info.pid}${where}); stop it or pass --url <baseUrl>`;
}

/**
 * Starts `command -p <port>` in `projectDir` in its own process group and waits
 * until it answers HTTP. `stop` terminates the whole group.
 */
export async function startNext(
  projectDir: string,
  port: number,
  command: string[],
  opts: { timeoutMs?: number } = {},
): Promise<StartedNext> {
  const [bin, ...args] = command;
  if (!bin) throw new Error("dev command is empty");
  await assertPortFree(port);

  const child = spawn(bin, [...args, "-p", String(port)], {
    cwd: projectDir,
    // `next dev` rewrites tsconfig.json when NODE_ENV is something else (e.g. "test" under vitest); the tool must not
    // edit the project, so the server it starts always runs in development.
    env: { ...process.env, NODE_ENV: "development", PORT: String(port) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = new LineTail(LOG_LINES);
  tailStream(child.stdout, tail);
  tailStream(child.stderr, tail);

  const exit: { done: boolean; description: string } = { done: false, description: "" };
  child.once("exit", (code, signal) => {
    exit.done = true;
    exit.description = signal ? `signal ${signal}` : `exit code ${code}`;
  });
  child.once("error", (err) => {
    exit.done = true;
    exit.description = err.message;
  });

  const pid = child.pid;
  if (pid === undefined) throw new Error(`could not start ${bin}`);

  // Registered before any await: a process exit (SIGINT and uncaught errors go through process.exit) during the
  // readiness wait still takes the group down. Removed once the group is stopped.
  const killGroupOnExit = (): void => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // The group is already gone.
    }
  };
  process.on("exit", killGroupOnExit);

  const stop = async (): Promise<void> => {
    try {
      signalGroup(pid, "SIGTERM");
      if (await waitFor(() => exit.done && !groupAlive(pid), KILL_GRACE_MS)) return;
      signalGroup(pid, "SIGKILL");
      await waitFor(() => exit.done && !groupAlive(pid), KILL_GRACE_MS);
    } finally {
      process.off("exit", killGroupOnExit);
    }
  };
  const fail = async (reason: string): Promise<never> => {
    await stop();
    const lines = tail.lines();
    const output = lines.length > 0 ? lines.join("\n") : "(no output)";
    throw new Error(`${reason}; last ${lines.length} lines of dev server output:\n${output}`);
  };

  const baseUrl = `http://localhost:${port}`;
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exit.done) {
      return fail(`dev command exited before the server was ready (${exit.description})`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return fail(`timed out after ${timeoutMs} ms waiting for ${baseUrl}/`);
    }
    if (await respondsOverHttp(`${baseUrl}/`, Math.min(REQUEST_TIMEOUT_MS, remaining))) {
      // A response only means ours if the child is still running.
      if (exit.done) {
        return fail(`dev command exited before the server was ready (${exit.description})`);
      }
      return { baseUrl, pid, stop };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function detectFromLockFile(projectDir: string): RunningDevServer | undefined {
  let lock: { pid?: unknown; appUrl?: unknown } | null;
  try {
    lock = JSON.parse(readFileSync(join(projectDir, ".next", "dev", "lock"), "utf8"));
  } catch {
    return undefined;
  }
  const pid = lock?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (!isAlive(pid) || !isLiveNextDev(pid, projectDir)) return undefined;
  const appUrl = typeof lock?.appUrl === "string" ? lock.appUrl : undefined;
  return appUrl === undefined ? { running: true, pid } : { running: true, pid, appUrl };
}

/**
 * A lock file outlives a killed `next dev`, and its pid can be a zombie or a reused pid. On Linux the pid counts
 * only when it is not a zombie and is either in the project or running a `next dev` command line. Elsewhere
 * (no /proc) a live pid is taken as the server.
 */
function isLiveNextDev(pid: number, projectDir: string): boolean {
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    if (state === "Z") return false;
    if (realpathSync(`/proc/${pid}/cwd`) === realpathSync(projectDir)) return true;
    return isNextDevCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "));
  } catch {
    // The process is gone or not inspectable: it is not a server we can name.
    return false;
  }
}

function detectFromProc(projectDir: string): RunningDevServer | undefined {
  let wantedCwd: string;
  let entries: string[];
  try {
    wantedCwd = realpathSync(projectDir);
    entries = readdirSync("/proc");
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ");
      if (!isNextDevCmdline(cmdline)) continue;
      if (realpathSync(`/proc/${entry}/cwd`) !== wantedCwd) continue;
      return { running: true, pid: Number(entry) };
    } catch {
      // Process exited or belongs to another user: skip it.
    }
  }
  return undefined;
}

/**
 * True for a `next dev` command: an argument that is `next` (or a path ending in `/next`, the package's bin) directly
 * followed by `dev`. Next's own helpers (e.g. `telemetry/detached-flush.js dev <dir>`) do not match.
 */
function isNextDevCmdline(cmdline: string): boolean {
  const args = cmdline.split(" ");
  return args.some((arg, i) => /(^|\/)next$/.test(arg) && args[i + 1] === "dev");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}

async function respondsOverHttp(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    void res.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Keeps the last `max` complete lines of a process's output. */
class LineTail {
  private readonly buffer: string[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > this.max) this.buffer.shift();
  }

  lines(): string[] {
    return [...this.buffer];
  }
}

function tailStream(stream: Readable | null, tail: LineTail): void {
  if (!stream) return;
  let partial = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const parts = (partial + chunk).split(/\r?\n/);
    partial = parts.pop() ?? "";
    for (const line of parts) tail.push(line);
    if (partial.length > MAX_PARTIAL_LINE) {
      tail.push(partial);
      partial = "";
    }
  });
  stream.on("end", () => {
    if (partial) tail.push(partial);
    partial = "";
  });
}

async function waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

/** Rejects when another process already listens on `port` on any common address. */
async function assertPortFree(port: number): Promise<void> {
  for (const host of [undefined, "127.0.0.1", "0.0.0.0", "::"]) {
    const inUse = await isPortInUse(port, host);
    if (inUse) {
      throw new Error(`port ${port} is already in use; pass --port <free port>`);
    }
  }
}

function isPortInUse(port: number, host: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const probe: Server = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve(false));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
