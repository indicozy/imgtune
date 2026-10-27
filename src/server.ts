import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

const LOG_LINES = 40;
const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 5_000;

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

  const child = spawn(bin, [...args, "-p", String(port)], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port) },
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
  const stop = async (): Promise<void> => {
    if (pid === undefined) return;
    signalGroup(pid, "SIGTERM");
    if (await waitFor(() => exit.done && !groupAlive(pid), KILL_GRACE_MS)) return;
    signalGroup(pid, "SIGKILL");
    await waitFor(() => exit.done && !groupAlive(pid), KILL_GRACE_MS);
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
    if (await respondsOverHttp(`${baseUrl}/`)) return { baseUrl, stop };
    if (Date.now() >= deadline) {
      return fail(`timed out after ${timeoutMs} ms waiting for ${baseUrl}/`);
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
  if (!isAlive(pid)) return undefined;
  const appUrl = typeof lock?.appUrl === "string" ? lock.appUrl : undefined;
  return appUrl === undefined ? { running: true, pid } : { running: true, pid, appUrl };
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

function isNextDevCmdline(cmdline: string): boolean {
  if (cmdline.includes("next-server")) return true;
  return /\bnext\b/.test(cmdline) && /\bdev\b/.test(cmdline);
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

async function respondsOverHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  constructor(private readonly max: number) {}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
