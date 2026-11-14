import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScan } from "../src/remote.js";
import type { VideoRecord } from "../src/video-analysis.js";
import type { Viewport } from "../src/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/media/", import.meta.url));
const VIEWS = {
  desktop: { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false },
  mobile: { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true },
} as const satisfies Record<string, Viewport>;

// Each case has its own URL (a query string makes a separate file for the browser and the media map), so one case's bytes
// never stand for another's. The server ignores the query and answers Range requests, as a CDN does.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>hidden video</title><style>
  .desktop-only { width: 320px; height: 180px; }
  .mobile-only { width: 180px; height: 320px; }
  @media (max-width: 600px) { .desktop-only { display: none; } }
  @media (min-width: 601px) { .mobile-only { display: none; } }
  #vcarousel { width: 320px; height: 180px; overflow: hidden; }
  #vtrack { display: flex; width: 640px; }
  #vtrack video { width: 320px; height: 180px; flex: none; }
  #vopa { opacity: 0; width: 320px; height: 180px; }
  #vzero { width: 0; height: 0; }
  #vmodal { display: none; }
  #vclip { width: 40px; height: 40px; overflow: hidden; }
  #vclip video { width: 320px; height: 180px; margin-top: 100px; }
</style></head><body>
  <video id="heroDesk" class="desktop-only" autoplay muted playsinline src="/hidden.mp4?c=heroDesk"></video>
  <video id="heroMob" class="mobile-only" autoplay muted playsinline src="/hidden-mob.mp4?c=heroMob"></video>
  <div id="vcarousel"><div id="vtrack">
    <video id="slide1" autoplay muted playsinline preload="auto" src="/hidden.mp4?c=slide1"></video>
    <video id="slide2" autoplay muted playsinline preload="auto" src="/hidden.mp4?c=slide2"></video>
  </div></div>
  <div id="vmodal"><video id="modalVid" preload="auto" src="/hidden.mp4?c=modal"></video></div>
  <video id="vopa" autoplay muted playsinline src="/hidden.mp4?c=opacity"></video>
  <video id="vzero" autoplay muted playsinline src="/hidden.mp4?c=zero"></video>
  <div role="tabpanel" hidden><video id="tabVid" autoplay muted playsinline src="/hidden.mp4?c=tab"></video></div>
  <details><summary>More</summary><video id="detVid" autoplay muted playsinline src="/hidden.mp4?c=details"></video></details>
  <video id="idleVid" preload="none" poster="/still.png" style="display: none" src="/hidden.mp4?c=idle"></video>
  <div id="vclip"><video id="clipVid" autoplay muted playsinline src="/hidden.mp4?c=clip"></video></div>
  <video id="shownVid" autoplay muted playsinline width="320" height="180" src="/hidden.mp4?c=shown"></video>
</body></html>`;

describe("hidden video scan", () => {
  const posterBytes = readFileSync(join(FIXTURES, "still.png")).length;
  let base = "";
  let server: Server | undefined;
  let result: Awaited<ReturnType<typeof runScan>>[number] | undefined;

  beforeAll(async () => {
    const files: Record<string, Buffer> = {
      "/hidden.mp4": readFileSync(join(FIXTURES, "hidden.mp4")),
      "/hidden-mob.mp4": readFileSync(join(FIXTURES, "hidden-mob.mp4")),
      "/still.png": readFileSync(join(FIXTURES, "still.png")),
    };
    const started = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        const path = (req.url ?? "").split("?")[0];
        if (path === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(PAGE);
        }
        const file = files[path];
        if (!file) {
          res.writeHead(404);
          return res.end();
        }
        const type = path.endsWith(".mp4") ? "video/mp4" : "image/png";
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = range[2] === "" ? file.length - 1 : Math.min(Number(range[2]), file.length - 1);
          res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${file.length}`, "content-length": end - start + 1 });
          return res.end(file.subarray(start, end + 1));
        }
        res.writeHead(200, { "content-type": type, "content-length": file.length, "accept-ranges": "bytes" });
        res.end(file);
      });
      s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
    });
    server = started.server;
    base = started.base;
    const out = mkdtempSync(join(tmpdir(), "imgtune-hidden-video-"));
    [result] = await runScan([`${base}/`], {
      outDir: out,
      cwd: out,
      aggressive: false,
      quality: false,
      mediaBudget: 0,
      viewports: [VIEWS.desktop, VIEWS.mobile],
      log: () => {},
    });
  }, 180_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const named = (id: string): VideoRecord | undefined => (result?.videos ?? []).find((v) => v.locator.selector.includes(`#${id}`));

  it("reports the scan as ok with one record per video that the browser fetched", () => {
    expect(result?.status).toBe("ok");
    expect(named("heroDesk")).toBeDefined();
    expect(named("heroMob")).toBeDefined();
  });

  it("finds a responsive twin: shown at one viewport, hidden at the other, one fix per the twin", () => {
    const desk = named("heroDesk");
    expect(desk?.hidden?.action).toBe("responsive");
    expect(desk?.hidden?.viewports).toEqual(["mobile"]);
    expect(desk?.hidden?.shownIn).toEqual(["desktop"]);
    expect(desk?.hidden?.reasons).toEqual(["display"]);
    expect(desk?.perViewport.find((p) => p.viewport === "mobile")?.hidden).toBe("display");
    expect(desk?.perViewport.find((p) => p.viewport === "desktop")?.hidden).toBeUndefined();
    expect(named("heroMob")?.hidden?.viewports).toEqual(["desktop"]);
  });

  it("finds a carousel slide clipped by its overflow box as lazy", () => {
    expect(named("slide1")?.hidden).toBeUndefined();
    expect(named("slide2")?.hidden?.reasons).toEqual(["clipped"]);
    expect(named("slide2")?.hidden?.action).toBe("lazy");
  });

  it("finds a modal video that is never shown on load and is fetched by the browser", () => {
    const modal = named("modalVid");
    expect(modal?.hidden?.reasons).toEqual(["display"]);
    expect(modal?.hidden?.action).toBe("never-shown-on-load");
    expect(modal?.hidden?.shownIn).toEqual([]);
    expect(modal?.hidden?.perViewBytes).toBeGreaterThan(0);
  });

  it("finds opacity 0 and zero-size videos, and the tab and closed-details copies as lazy", () => {
    expect(named("vopa")?.hidden?.reasons).toEqual(["opacity"]);
    expect(named("vopa")?.hidden?.action).toBe("never-shown-on-load");
    expect(named("vzero")?.hidden?.reasons).toEqual(["zero-size"]);
    expect(named("tabVid")?.hidden?.inPanel).toBe(true);
    expect(named("tabVid")?.hidden?.action).toBe("lazy");
    expect(named("detVid")?.hidden?.inPanel).toBe(true);
    expect(named("detVid")?.hidden?.action).toBe("lazy");
  });

  it("finds a video clipped inside an overflow hidden box as lazy", () => {
    expect(named("clipVid")?.hidden?.reasons).toEqual(["clipped"]);
    expect(named("clipVid")?.hidden?.action).toBe("lazy");
  });

  it("never calls a shown video hidden; a preload none copy counts its poster download only, not its file", () => {
    expect(named("shownVid")?.hidden).toBeUndefined();
    const idle = named("idleVid");
    expect(idle?.bytes.perView).toBe(0);
    expect(idle?.hidden?.action).toBe("never-shown-on-load");
    // Each viewport is its own page load by default, and each one downloads the poster; the video's file is not fetched.
    expect(idle?.hidden?.perViewBytes).toBe(posterBytes);
  });

  it("gives no encode and no width claim in the viewport that hides a video", () => {
    const desk = named("heroDesk");
    expect(desk?.widths?.perViewport.map((p) => p.viewport)).toEqual(["desktop"]);
    expect(named("modalVid")?.widths?.perViewport ?? []).toEqual([]);
  });
});
