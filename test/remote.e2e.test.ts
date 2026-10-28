import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { gradientNoise } from "./image-fixtures.js";
import type { PageResult } from "../src/remote.js";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(import.meta.dirname, "fixtures/next-app");
const CLI = join(ROOT, "dist/cli.js");
const MINUTE = 60_000;
const CHILD_ENV = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
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
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    await res.arrayBuffer().catch(() => undefined);
    return res.status;
  } catch {
    return undefined;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

/** Runs `imgtune scan <args>` in `cwd`, capturing both streams. */
function runScan(cwd: string, args: string[]): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [CLI, "scan", ...args], { cwd, env: CHILD_ENV });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

/** Pids whose working directory is `root`: any process left behind by a run. */
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

function sha(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Hashes of every file under `root` except the build output and dependencies. */
async function snapshot(root: string, rel = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".imgtune") continue;
    const child = join(rel, entry.name);
    if (entry.isDirectory()) for (const [k, v] of await snapshot(root, child)) out.set(k, v);
    else out.set(child, sha(await readFile(join(root, child))));
  }
  return out;
}

async function jpeg(width: number, height: number, seed: number): Promise<Buffer> {
  const pixels = gradientNoise(width, height, 4, seed);
  return sharp(Buffer.from(pixels.data.buffer), { raw: { width, height, channels: 4 } }).jpeg({ quality: 90 }).toBuffer();
}

let staticDir: string;
let staticServer: Server | undefined;
let staticBase = "";
let nextDir: string;
let nextPort = 0;
let nextChild: ReturnType<typeof spawn> | undefined;
let work: string;
let fixtureBefore: Map<string, string>;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "imgtune-scan-e2e-"));

  // A plain static page, served by a tiny node:http server on localhost. No Next.js anywhere.
  staticDir = join(work, "static");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "big.jpg"), await jpeg(1200, 800, 11));
  await writeFile(join(staticDir, "small.jpg"), await jpeg(400, 267, 12));
  // A separate file for the plain <img>: two elements on one URL are one download, measured once.
  await writeFile(join(staticDir, "huge.jpg"), await jpeg(1200, 800, 13));
  // A local route shaped like a Contentful URL (?w= and ?q=). Its host is not Contentful's, so it is the generic loader.
  await mkdir(join(staticDir, "ctf"), { recursive: true });
  await writeFile(join(staticDir, "ctf/hero.jpg"), await jpeg(400, 267, 14));
  await writeFile(
    join(staticDir, "index.html"),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>static</title></head><body>
<img src="/huge.jpg" width="200" height="133" alt="">
<img srcset="/small.jpg 400w, /big.jpg 1200w" sizes="1200px" width="200" height="133" alt="">
<img src="/ctf/hero.jpg?w=400&q=70" width="200" height="133" alt="">
</body></html>`,
  );
  staticServer = createHttpServer(async (req, res) => {
    const name = (req.url ?? "/").split("?")[0];
    const file = name === "/" ? "index.html" : name.slice(1);
    try {
      const body = await readFile(join(staticDir, file));
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "image/jpeg" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolveListen) => staticServer!.listen(0, "127.0.0.1", () => resolveListen()));
  staticBase = `http://127.0.0.1:${(staticServer.address() as AddressInfo).port}`;

  // The Next.js fixture, in a temp copy: installed, given one deliberately oversized image, built and started.
  nextDir = join(work, "next-app");
  await cp(FIXTURE, nextDir, { recursive: true });
  execFileSync("pnpm", ["install", "--prefer-offline", "--frozen-lockfile", "--network-concurrency=4"], {
    cwd: nextDir,
    stdio: "pipe",
    timeout: 10 * MINUTE,
  });
  await mkdir(join(nextDir, "public/img"), { recursive: true });
  for (let i = 1; i <= 8; i++) await writeFile(join(nextDir, `public/img/p${i}.jpg`), await jpeg(800, 800, 20 + i));
  // A 160 px card asks for the full width: the browser fetches the 1200 px file, the card needs 640.
  const pagePath = join(nextDir, "app/[store]/[...slug]/page.tsx");
  const page = await readFile(pagePath, "utf8");
  await writeFile(
    pagePath,
    `import Image from "next/image";\n${page.replace("<main>", '<main>\n      <Image src="/img/p2.jpg" width={160} height={160} sizes="100vw" alt="" />')}`,
  );
  execFileSync("pnpm", ["exec", "next", "build"], { cwd: nextDir, stdio: "pipe", env: CHILD_ENV, timeout: 15 * MINUTE });

  nextPort = await freePort();
  nextChild = spawn("pnpm", ["exec", "next", "start", "-p", String(nextPort)], {
    cwd: nextDir,
    env: { ...CHILD_ENV, NODE_ENV: "production" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  nextChild.stdout?.resume();
  nextChild.stderr?.resume();
  await waitUntil(async () => (await httpStatus(`http://localhost:${nextPort}/ae-en/eyeglasses`)) === 200, 3 * MINUTE, "next start");
  // Taken after next build and next start, which rewrite some generated files; the scan must change none of them.
  fixtureBefore = await snapshot(nextDir);
}, 30 * MINUTE);

afterAll(async () => {
  if (nextChild?.pid !== undefined) {
    try {
      process.kill(-nextChild.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (nextDir) for (const pid of processesIn(nextDir)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await new Promise<void>((resolveClose) => (staticServer ? staticServer.close(() => resolveClose()) : resolveClose()));
  if (work) await rm(work, { recursive: true, force: true });
});

describe("imgtune scan end to end", () => {
  it("scans a plain static page with hints and no Next.js pointer", async () => {
    const out = join(work, "out-static");
    const result = await runScan(work, [`${staticBase}/`, "--out", out, "--viewports", "iphone-15,desktop"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Next.js detected");
    expect(result.stdout).not.toContain("imgtune audit");

    const page = JSON.parse(await readFile(join(out, `127.0.0.1-${new URL(staticBase).port}-index.json`), "utf8")) as PageResult;
    expect(page.status).toBe("ok");
    expect(page.nextjs).toBe(false);
    const images = page.perViewport["iphone-15"].images;
    const plain = images.find((img) => img.kind === "plain");
    expect(plain?.estSaved ?? 0).toBeGreaterThan(0);
    // At desktop (dpr 2) the 200 px image needs 400 px, so the 400w candidate is the right one; at iphone-15 (dpr 3) it needs 600.
    const desktopSrcset = page.perViewport.desktop.images.find((img) => img.kind === "srcset");
    expect(desktopSrcset?.right?.url).toContain("/small.jpg");
    expect(desktopSrcset?.exactSaved ?? 0).toBeGreaterThan(0);
    expect(page.page?.exactPct ?? 0).toBeGreaterThan(0);
    // The loader of each image and the page's count per loader are recorded (no adapter claims this host).
    const ctf = images.find((img) => img.url.includes("/ctf/hero.jpg"));
    expect(ctf?.loader).toBe("generic");
    expect(page.counts.byLoader.generic).toBeGreaterThan(0);
  }, 10 * MINUTE);

  it("measures the Next.js fixture: resolution, quality with a reference, and a second run that agrees", async () => {
    const url = `http://localhost:${nextPort}/ae-en/eyeglasses`;
    const out = join(work, "out-next");
    const first = await runScan(work, [url, "--out", out, "--viewports", "iphone-15,desktop"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Next.js detected: run "npx imgtune audit"');

    const name = `localhost-${nextPort}-ae-en-eyeglasses.json`;
    const page = JSON.parse(await readFile(join(out, name), "utf8")) as PageResult;
    expect(page.status).toBe("ok");
    expect(page.nextjs).toBe(true);
    const oversized = page.perViewport["iphone-15"].images.find((img) => img.sizes === "100vw");
    expect(oversized?.kind).toBe("srcset");
    expect(oversized?.exactSaved ?? 0).toBeGreaterThan(0);
    const judged = Object.values(page.perViewport).flatMap((v) => v.images).find((img) => img.quality?.sampled);
    expect(judged).toBeDefined();
    expect(judged?.quality?.qualityAssumed).toBe(false);

    const second = await runScan(work, [url, "--out", join(work, "out-next-2"), "--viewports", "iphone-15,desktop"]);
    expect(second.code).toBe(0);
    const again = JSON.parse(await readFile(join(work, "out-next-2", name), "utf8")) as PageResult;
    expect(Math.abs((again.page?.exactPct ?? 0) - (page.page?.exactPct ?? 0))).toBeLessThanOrEqual(2);

    // Nothing in the project changes: the scan only reads, and writes its JSON under --out.
    expect(await snapshot(nextDir)).toEqual(fixtureBefore);
  }, 20 * MINUTE);

  it("stops the fixture server and leaves no process of the fixture running", async () => {
    if (nextChild?.pid !== undefined) process.kill(-nextChild.pid, "SIGTERM");
    await waitUntil(async () => processesIn(nextDir).length === 0, 60_000, "next start to exit");
    expect(processesIn(nextDir)).toEqual([]);
  }, 2 * MINUTE);
});
