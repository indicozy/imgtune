import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/media/", import.meta.url));
const VIEWS = {
  desktop: { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false },
  mobile: { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true },
} as const satisfies Record<string, Viewport>;

// Three cases the stability rule must tell apart:
// - an auto-advancing carousel: each slide's display toggles every 800 ms, so every read of it is one of two states;
// - a crossfade slider: two images swap opacity every 1000 ms;
// - a truly hidden mobile twin: a desktop video that display:none hides at every read, at the desktop width.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>stability</title><style>
  body { margin: 0; height: 2400px; }
  .slide { position: absolute; left: 20px; top: 300px; width: 320px; height: 180px; }
  .x { position: absolute; left: 400px; top: 300px; width: 200px; height: 120px; transition: opacity 0.3s; }
  .x.off { opacity: 0; }
  #mobTwin { position: absolute; left: 20px; top: 700px; width: 320px; height: 180px; }
  @media (min-width: 601px) { #mobTwin { display: none; } }
</style></head><body>
  <video id="slideA" class="slide" muted playsinline preload="auto" src="/hidden.mp4?c=slideA"></video>
  <video id="slideB" class="slide" muted playsinline preload="auto" src="/hidden.mp4?c=slideB" style="left: 360px; display: none"></video>
  <img id="xA" class="x" src="/still.png?c=xA">
  <img id="xB" class="x off" src="/still.png?c=xB">
  <video id="mobTwin" muted playsinline preload="auto" src="/hidden-mob.mp4?c=mobTwin"></video>
  <script>
    // The carousel: exactly one slide shows, and the shown one changes every 800 ms.
    const slides = [document.getElementById("slideA"), document.getElementById("slideB")];
    let phase = 0;
    setInterval(() => { phase = 1 - phase; slides[0].style.display = phase === 0 ? "block" : "none"; slides[1].style.display = phase === 1 ? "block" : "none"; }, 800);
    // The crossfade: the two images swap opacity every 1000 ms.
    const xs = [document.getElementById("xA"), document.getElementById("xB")];
    let on = 0;
    setInterval(() => { on = 1 - on; xs[0].classList.toggle("off", on !== 0); xs[1].classList.toggle("off", on !== 1); }, 1000);
  </script>
</body></html>`;

describe("a copy is hidden only when it stays hidden across reads", () => {
  let server: Server | undefined;
  let base = "";
  let result: Awaited<ReturnType<typeof runScan>>[number] | undefined;

  beforeAll(async () => {
    const files: Record<string, Buffer> = {
      "/still.png": readFileSync(join(FIXTURES, "still.png")),
      "/hidden.mp4": readFileSync(join(FIXTURES, "hidden.mp4")),
      "/hidden-mob.mp4": readFileSync(join(FIXTURES, "hidden-mob.mp4")),
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
        res.writeHead(200, { "content-type": type, "content-length": file.length });
        res.end(file);
      });
      s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
    });
    server = started.server;
    base = started.base;
    const out = mkdtempSync(join(tmpdir(), "imgtune-stability-"));
    [result] = await runScan([`${base}/`], {
      outDir: out,
      cwd: out,
      aggressive: false,
      quality: false,
      mediaBudget: 0,
      viewports: [VIEWS.desktop, VIEWS.mobile],
      log: () => {},
    });
  }, 240_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const video = (id: string) => (result?.videos ?? []).find((v) => v.locator.selector.includes(`#${id}`));
  const image = (id: string) => (result?.images ?? []).find((r) => r.locator.selector.includes(`#${id}`));

  it("does not flag an auto-advancing carousel whose slides toggle display", () => {
    expect(result?.status).toBe("ok");
    expect(video("slideA")?.hidden).toBeUndefined();
    expect(video("slideB")?.hidden).toBeUndefined();
  });

  it("does not flag a crossfade whose images swap opacity", () => {
    expect(image("xA")?.hidden).toBeUndefined();
    expect(image("xB")?.hidden).toBeUndefined();
  });

  it("flags a truly hidden mobile twin: display:none at the desktop width on every read", () => {
    const twin = video("mobTwin");
    expect(twin?.hidden?.reasons).toEqual(["display"]);
    expect(twin?.hidden?.viewports).toEqual(["desktop"]);
    expect(twin?.hidden?.shownIn).toEqual(["mobile"]);
    expect(twin?.hidden?.unstable).toBeUndefined();
  });
});

describe("the candidate cap does not leave a video unverified", () => {
  it("re-reads a hidden video before the images when more than the cap are hidden (videos are the heavy copies)", async () => {
    const images = Array.from({ length: 62 }, (_, i) => `<img id="hi${i}" src="/still.png?c=hi${i}" style="display:none">`).join("");
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>
      .opa { opacity: 0; width: 320px; height: 180px; }
    </style></head><body>${images}<video id="capVid" class="opa" muted playsinline src="/hidden.mp4?c=cap"></video></body></html>`;
    const files: Record<string, Buffer> = { "/still.png": readFileSync(join(FIXTURES, "still.png")), "/hidden.mp4": readFileSync(join(FIXTURES, "hidden.mp4")) };
    const cap = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page);
      }
      const file = files[path];
      if (!file) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": path.endsWith(".mp4") ? "video/mp4" : "image/png", "content-length": file.length });
      res.end(file);
    });
    await new Promise<void>((resolve) => cap.listen(0, "127.0.0.1", () => resolve()));
    const capBase = `http://127.0.0.1:${(cap.address() as AddressInfo).port}`;
    try {
      const out = mkdtempSync(join(tmpdir(), "imgtune-cap-"));
      const [r] = await runScan([`${capBase}/`], { outDir: out, cwd: out, aggressive: false, quality: false, mediaBudget: 0, viewports: [VIEWS.desktop], log: () => {} });
      const vid = (r?.videos ?? []).find((v) => v.locator.selector.includes("#capVid"));
      expect(vid?.hidden?.reasons).toEqual(["opacity"]);
      expect(vid?.hidden?.unstable).toBeUndefined();
    } finally {
      cap.closeAllConnections();
      await new Promise<void>((resolve) => cap.close(() => resolve()));
    }
  }, 180_000);
});
