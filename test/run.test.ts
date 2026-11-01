// `imgtune run`: the argument parser, the flow on a local server (survey, deep, the manifest, the summary), the stop rule,
// and the broken checks wired into a scan. The server is on 127.0.0.1 with a closed port for a dead stylesheet host.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { devUrlOf, parseRunArgs, runCommand, type RunManifest } from "../src/run.js";
import { shellWord } from "../src/text.js";
import { runScan, scanCommand, type PageResult } from "../src/remote.js";
import { summaryCommand, MAX_SUMMARY_LINES } from "../src/summary.js";
import { BROKEN_EXIT } from "../src/broken.js";
import type { Viewport } from "../src/types.js";

describe("parseRunArgs", () => {
  it("takes URLs and the run's options, and keeps the dev server's origin only", () => {
    const args = parseRunArgs(["https://a.example/", "--deep", "3", "--dev", "http://localhost:3000/some/path?x=1", "--qualities", "75,85,100"]);
    expect(args.urls).toEqual(["https://a.example/"]);
    expect(args.deep).toBe(3);
    expect(args.dev).toBe("http://localhost:3000");
    expect(args.qualities).toEqual([75, 85, 100]);
    expect(args.noCache).toBe(false);
  });

  it("defaults to five deep pages, and reads --gpu-device, --urls-from and --sample-per-pattern", () => {
    const args = parseRunArgs(["--urls-from", "sitemap.xml", "--sample-per-pattern", "2", "--gpu-device", "1", "--page-concurrency", "3"]);
    expect(args.deep).toBe(5);
    expect(args.urlsFrom).toBe("sitemap.xml");
    expect(args.samplePerPattern).toBe(2);
    expect(args.gpu).toEqual({ device: 1 });
    expect(args.pageConcurrency).toBe(3);
  });

  it("refuses what cannot run: no URL, a sample without a list, a bad count, an unknown option, a non-http dev origin", () => {
    expect(() => parseRunArgs([])).toThrow(/usage: imgtune run/);
    expect(() => parseRunArgs(["https://a.example/", "--sample-per-pattern", "2"])).toThrow(/needs --urls-from/);
    expect(() => parseRunArgs(["https://a.example/", "--deep", "0"])).toThrow(/at least 1/);
    expect(() => parseRunArgs(["https://a.example/", "--survey"])).toThrow(/Unknown option --survey/);
    expect(() => parseRunArgs(["https://a.example/", "--dev", "ftp://dev.example"])).toThrow(/not an http or https URL/);
    expect(() => parseRunArgs(["not a url"])).toThrow(/is not a URL/);
  });
});

describe("helpers", () => {
  it("points a deep page at the same path and query on the dev origin", () => {
    expect(devUrlOf("http://localhost:3000", "https://shop.example/p/a-1?size=2")).toBe("http://localhost:3000/p/a-1?size=2");
  });

  it("quotes a shell word only when it needs it", () => {
    expect(shellWord("https://a.example/p/x")).toBe("https://a.example/p/x");
    expect(shellWord("https://a.example/p/x?a=1&b=2")).toBe("'https://a.example/p/x?a=1&b=2'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
  });
});

describe("imgtune run on a local site", () => {
  let base = "";
  let deadHost = "";
  let server: Server | undefined;
  let scratch = "";
  const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "imgtune-run-"));
    // A port with nothing listening: the stylesheet on it is refused, as a CDN host that cannot be reached would be.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    deadHost = `127.0.0.1:${closedPort}`;
    const wide = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#48a" } }).jpeg({ quality: 90 }).toBuffer();
    const html = (body: string, head = "") =>
      `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
    const imageBody = '<img src="/wide.jpg" width="320" height="200" alt="">';
    const pages: Record<string, { status: number; body: string; head?: string }> = {
      "/p/one": { status: 200, body: imageBody },
      "/p/two": { status: 200, body: imageBody },
      "/c/ok": { status: 200, body: imageBody },
      "/c/broken": { status: 200, body: imageBody, head: `<link rel="stylesheet" href="http://${deadHost}/dead.css">` },
      "/empty": { status: 200, body: "<p>nothing here</p>" },
    };
    server = createServer((req, res) => {
      const url = (req.url ?? "").split("?")[0];
      if (url === "/wide.jpg") {
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(wide);
      }
      if (url.startsWith("/gone")) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        return res.end(html("<p>not found</p>"));
      }
      const page = pages[url];
      if (page === undefined) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(page.status, { "content-type": "text/html; charset=utf-8" });
      res.end(html(page.body, page.head));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  });

  const exists = (path: string) => access(path).then(() => true, () => false);
  const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);

  it("runs survey, deep and hints; a broken page is left out of the deep set and named in the manifest", async () => {
    const out = join(scratch, "run-a");
    const urls = [`${base}/p/one`, `${base}/p/two`, `${base}/c/ok`, `${base}/c/broken`];
    const { output, exitCode } = await runCommand([...urls, "--deep", "2", "--out", out], scratch, log);
    expect(exitCode).toBe(0);

    // The manifest names every file and the commands that made them.
    const manifest = await readJson<RunManifest>(join(out, "run.json"));
    expect(manifest.tool).toBe("imgtune");
    expect(manifest.urls.count).toBe(4);
    expect(manifest.phases.map((p) => p.name)).toEqual(["survey", "deep", "hints"]);
    expect(manifest.commands.map((c) => c.phase)).toEqual(["survey", "deep", "hints"]);
    expect(manifest.commands[0].command).toMatch(/^imgtune scan --urls-from .+urls\.txt --survey --out /);
    expect(manifest.commands[1].command).toMatch(/^imgtune scan http:\/\/127\.0\.0\.1:\d+\/.* --out /);
    expect(manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining(["urls.txt", "hints.json", "run.json"]));
    expect(manifest.files.filter((f) => f.kind === "survey")).toHaveLength(4);
    expect(manifest.files.filter((f) => f.kind === "deep")).toHaveLength(2);
    for (const file of manifest.files) expect(await exists(join(out, file.path))).toBe(true);

    // The deep set: the worst page of each worst pattern (the broken /c/broken is not ranked).
    expect(manifest.deep).toHaveLength(2);
    expect(manifest.deep.some((u) => u.endsWith("/c/ok"))).toBe(true);
    expect(manifest.deep.some((u) => u.endsWith("/c/broken"))).toBe(false);

    // The broken page: its reason and fix, in the manifest and in its JSON; it has no page numbers.
    expect(manifest.broken).toEqual([
      expect.objectContaining({ url: `${base}/c/broken`, phase: "survey", kind: "stylesheet" }),
    ]);
    expect(manifest.broken[0].reason).toContain(deadHost);
    const broken = await readJson<PageResult>(join(out, "survey", (await readdirSafe(join(out, "survey"))).find((n) => n.includes("c-broken")) as string));
    expect(broken.status).toBe("broken");
    expect(broken.stylesheetHosts).toEqual([deadHost]);
    expect(broken).not.toHaveProperty("page");

    // The summary the run prints is the one `imgtune summary` prints, and it fits the line cap.
    const again = await summaryCommand([out], scratch);
    expect(output).toBe(again.output);
    expect(output.trimEnd().split("\n").length).toBeLessThanOrEqual(MAX_SUMMARY_LINES);
    expect(output).toMatch(/^imgtune run: 4 URL\(s\)/m);
    expect(output).toMatch(/survey: 4 page\(s\), 3 ok, 1 broken, 0 not measured/);
    expect(output).toMatch(/^warnings:$/m);
    expect(output).toMatch(/1 linked stylesheet\(s\) from "127\.0\.0\.1:\d+" did not load/);
    expect(output).not.toMatch(/after the fix/);
    expect(output).toMatch(/call sites by saving per view/);
    expect(output).toMatch(/next:\n {2}locate: imgtune scan <dev-url> --locate-only --from .+\n {2}imgtune hints .+\/deep\/\*\.json --limit 10/);
    expect(logs.some((m) => m.startsWith("survey:"))).toBe(true);
  }, 300_000);

  it("with --dev, locates each deep page at the same path on the dev origin, and hints read the located copies", async () => {
    const out = join(scratch, "run-dev");
    const urls = [`${base}/p/one`, `${base}/c/ok`];
    const { exitCode } = await runCommand([...urls, "--deep", "2", "--out", out, "--dev", base], scratch, () => undefined);
    expect(exitCode).toBe(0);
    const manifest = await readJson<RunManifest>(join(out, "run.json"));
    expect(manifest.phases.map((p) => p.name)).toEqual(["survey", "deep", "locate", "hints"]);
    const locate = manifest.commands.filter((c) => c.phase === "locate");
    expect(locate).toHaveLength(2);
    for (const command of locate) expect(command.command).toMatch(/^imgtune scan http:\/\/127\.0\.0\.1:\d+\/(p\/one|c\/ok) --locate-only --from .+ --locate-out .+located\.json$/);
    const located = manifest.files.filter((f) => f.kind === "located").map((f) => f.path);
    expect(located).toHaveLength(2);
    for (const path of located) expect(path.endsWith(".located.json")).toBe(true);
    // The hints command reads the located copies: the located file is what each page's hints came from.
    const hintsCommand = manifest.commands.find((c) => c.phase === "hints");
    expect(hintsCommand?.command).toMatch(/located\/.*\.located\.json/);
    expect(hintsCommand?.command).not.toMatch(/deep\/.*\.json .*deep\//);
  }, 300_000);

  it("refuses to write hints.json through a symlink, and writes nothing outside the run directory", async () => {
    const out = join(scratch, "run-symlink");
    await mkdir(out, { recursive: true });
    const outside = join(scratch, "outside-target.txt");
    await writeFile(outside, "untouched");
    await symlink(outside, join(out, "hints.json"));
    await expect(runCommand([`${base}/p/one`, "--deep", "1", "--out", out], scratch, () => undefined)).rejects.toThrow(
      /refusing to write through symlink/,
    );
    expect(await readFile(outside, "utf8")).toBe("untouched");
  }, 300_000);

  it("stops before the deep phase when more than half of the survey is broken, with exit 4 and the fix", async () => {
    const out = join(scratch, "run-stop");
    const urls = [`${base}/gone/a`, `${base}/gone/b`, `${base}/gone/c`, `${base}/p/one`];
    const { output, exitCode } = await runCommand([...urls, "--out", out], scratch, () => undefined);
    expect(exitCode).toBe(BROKEN_EXIT);
    expect(output).toMatch(/STOPPED before the deep phase: 3 of 4 survey pages are broken/);
    expect(output).toMatch(/fix: the URL does not serve this page/);
    expect(await exists(join(out, "deep"))).toBe(false);
    const manifest = await readJson<RunManifest>(join(out, "run.json"));
    expect(manifest.stop).toMatchObject({ phase: "survey" });
    expect(manifest.phases.map((p) => p.name)).toEqual(["survey"]);
  }, 300_000);

  it("a scan that finds no images where the survey found some marks the page broken, and --fail-on-broken exits 4", async () => {
    const out = join(scratch, "scan-broken");
    const common = { outDir: out, cwd: scratch, aggressive: false, quality: false, viewports: [desktop], log: () => undefined };
    const [page] = await runScan([`${base}/empty`], { ...common, expectImages: () => 2 });
    expect(page.status).toBe("broken");
    expect(page.broken?.kind).toBe("images");
    const [plain] = await runScan([`${base}/empty`], { ...common, outDir: join(scratch, "scan-plain") });
    expect(plain.status).toBe("ok");

    const failing = await scanCommand([`${base}/gone/x`, "--no-quality", "--viewports", "desktop", "--fail-on-broken", "--out", join(scratch, "scan-404")], scratch, () => undefined);
    expect(failing.exitCode).toBe(BROKEN_EXIT);
    expect(failing.output).toMatch(/1 of 1 page\(s\) broken \(--fail-on-broken\)/);
    expect(failing.output).toMatch(/fix: the URL does not serve this page/);
    const quiet = await scanCommand([`${base}/gone/x`, "--no-quality", "--viewports", "desktop", "--out", join(scratch, "scan-404-quiet")], scratch, () => undefined);
    expect(quiet.exitCode).toBe(0);
  }, 300_000);
});

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}
