// End to end: the media fixture page (animated GIFs in an img and a CSS background, four self-hosted videos, an adaptive
// stream and a YouTube iframe) served from a local Range-capable server and scanned with the CLI. Covers the video section,
// the animated hints and the third-party block. Needs ffmpeg on PATH and a built dist/ (npm run build).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { hintsOf, renderHint, renderVideoHints } from "../src/hints.js";
import type { PageResult } from "../src/remote.js";
import type { VideoRecord } from "../src/video-analysis.js";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/media");
const CLI = join(ROOT, "dist/cli.js");
const CHILD_ENV = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
const TYPES: Record<string, string> = { ".html": "text/html", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm" };

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
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

/** A static server over the fixture folder that answers Range requests (the videos are sought by ffmpeg through it). */
function serveFixtures(): Server {
  return createHttpServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = join(FIXTURE_DIR, name === "/" ? "page.html" : name.slice(1));
    if (!file.startsWith(FIXTURE_DIR)) {
      res.writeHead(403).end();
      return;
    }
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const type = TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range !== null && (range[1] !== "" || range[2] !== "")) {
      const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
      res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}` });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
    createReadStream(file).pipe(res);
  });
}

/** The video record whose source ends with `name`. */
function videoNamed(videos: VideoRecord[], name: string): VideoRecord {
  const found = videos.find((v) => v.src.endsWith(`/${name}`));
  if (found === undefined) throw new Error(`no video record for ${name}`);
  return found;
}

const fixtureSize = (name: string): number => statSync(join(FIXTURE_DIR, name)).size;

let server: Server | undefined;
let work = "";
let base = "";
let result: CliResult;
let page: PageResult;
let wallSeconds = 0;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "imgtune-media-e2e-"));
  server = serveFixtures();
  await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", () => resolveListen()));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  // The scan: quality on (the default), two viewports (a phone and a desktop), the third-party block on for the YouTube iframe.
  const started = performance.now();
  result = await runScan(work, [`${base}/page.html`, "--out", join(work, "out"), "--viewports", "iphone-15,desktop", "--block-third-party"]);
  wallSeconds = (performance.now() - started) / 1000;
  console.log(`media e2e: scan wall time ${wallSeconds.toFixed(1)} s`);
  if (result.code === 0) {
    page = JSON.parse(await readFile(join(work, "out", `127.0.0.1-${port}-page.html.json`), "utf8")) as PageResult;
  }
}, 20 * 60_000);

afterAll(async () => {
  await new Promise<void>((resolveClose) => (server ? server.close(() => resolveClose()) : resolveClose()));
  if (work) await rm(work, { recursive: true, force: true });
});

describe("imgtune scan of the media fixture page", () => {
  it("exits 0, logs the media phase, and writes one ok page", () => {
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("media: done in");
    expect(page.status).toBe("ok");
    expect(page.nextjs).toBe(false);
    expect(page.viewports).toEqual(["iphone-15", "desktop"]);
    // The YouTube iframe's requests were stopped by the third-party block.
    expect(page.thirdPartyBlocked ?? 0).toBeGreaterThan(0);
  });

  it("reports the four file-sourced videos, and not the adaptive stream", () => {
    const videos = page.videos ?? [];
    expect(videos.map((v) => v.src.split("/").pop()).sort()).toEqual(["clip-noaudio.mp4", "clip.mp4", "clip.webm", "clip60.mp4"]);
    expect(videos.some((v) => v.src.includes("m3u8"))).toBe(false);
  });

  it("keeps an autoplay video's bytes at the full file, with an audio lever and an AV1 codec lever", () => {
    const clip = videoNamed(page.videos ?? [], "clip.mp4");
    expect(clip.attributes).toMatchObject({ autoplay: true, muted: true, loop: true });
    expect(clip.bytes.perView).toBe(fixtureSize("clip.mp4"));
    expect(clip.bytes.perPlay).toBe(fixtureSize("clip.mp4"));
    expect(clip.levers.audio?.bytes ?? 0).toBeGreaterThan(0);
    expect(clip.levers.codec).toEqual({ missing: "av1" });
    // The AV1 encode at the target width is the expected outcome. Under four parallel encodes on this machine the 1280 px
    // search can run past the per-asset cap, so the reason is then "time-limit" (see the report).
    if (clip.estimate !== undefined) {
      expect(clip.estimate.codec).toBe("av1-mp4");
      expect(clip.estimate.bytes).toBeGreaterThan(0);
    } else {
      expect(["time-limit", "no-passing-quality"]).toContain(clip.notEncoded);
    }
  });

  it("gives a preload=none video no per-view bytes and the full file per play", () => {
    const lazy = videoNamed(page.videos ?? [], "clip-noaudio.mp4");
    expect(lazy.attributes.preload).toBe("none");
    expect(lazy.bytes.perView).toBe(0);
    expect(lazy.bytes.perPlay).toBe(fixtureSize("clip-noaudio.mp4"));
  });

  it("counts a preload=auto video by the bytes the scan saw, and gives it an estimate or a reason", () => {
    const eager = videoNamed(page.videos ?? [], "clip.webm");
    expect(eager.attributes.preload).toBe("auto");
    expect(eager.bytes.browserDependent).toBe(true);
    expect(eager.bytes.perView).toBeGreaterThan(0);
    expect(eager.bytes.perView).toBeLessThanOrEqual(fixtureSize("clip.webm"));
    if (eager.estimate !== undefined) expect(eager.estimate.bytes).toBeGreaterThan(0);
    else expect(["no-passing-quality", "time-limit"]).toContain(eager.notEncoded);
  });

  it("puts the 60 fps note in the info of the 60 fps loop", () => {
    const loop = videoNamed(page.videos ?? [], "clip60.mp4");
    expect(loop.probe?.fps).toBe(60);
    expect(loop.levers.info.some((note) => note.startsWith("60 fps:"))).toBe(true);
  });

  it("gives the GIFs (in an img and as a CSS background) animated records with estimates", () => {
    const animated = (page.images ?? []).filter((img) => img.fix.animated !== undefined);
    expect(animated).toHaveLength(3);
    expect(animated.map((img) => img.fix.animated?.context).sort()).toEqual(["css-background", "img", "img"]);
    for (const img of animated) {
      const fix = img.fix.animated!;
      expect(fix.info.format).toBe("gif");
      if (fix.estimate !== undefined) expect(fix.estimate.some((c) => c.bytes > 0)).toBe(true);
      else expect(fix.notEncoded).toBeDefined();
    }
  });

  it("keeps the video bytes out of the image totals", () => {
    const expected = fixtureSize("anim.gif") + fixtureSize("text.gif");
    for (const name of ["iphone-15", "desktop"]) {
      expect(page.perViewport[name].imageBytes).toBe(expected);
    }
  });

  it("renders the animated hints and the Video section, with the 60 fps note and the no-preload bytes", () => {
    const hints = hintsOf(page);
    const animatedHints = hints.filter((h) => h.animated !== undefined);
    expect(animatedHints.length).toBeGreaterThanOrEqual(2);
    const rendered = animatedHints.flatMap((h, i) => renderHint(h, i + 1)).join("\n");
    expect(rendered).toContain("animated GIF");
    expect(rendered).toContain("(estimate from 2 s samples)");

    const video = renderVideoHints(page.videos ?? []);
    expect(video).toContain("60 fps");
    expect(video).toContain("0 KB/view (not loaded before play)");
    expect(video).not.toContain("m3u8");
    console.log(`media e2e: rendered hints\n${rendered}\n${video}`);
  });
});
