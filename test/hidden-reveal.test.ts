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
const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

// Fade-ins: an IntersectionObserver sets .in only when the element is in the middle band of the viewport (rootMargin keeps
// the top and bottom 45% out), and the CSS fades it from opacity 0. The scanner scrolls one viewport height at a time, so
// an element placed at 0.2 of a viewport below a multiple of its height is never in that band during the scan: its snapshot
// reads opacity 0. Only the scroll re-read (centring it) brings it into the band. A static opacity-0 copy never fades in.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>reveal</title><style>
  body { margin: 0; height: 4000px; }
  .fade { position: absolute; left: 20px; opacity: 0; transition: opacity 0.2s; width: 320px; height: 180px; }
  #ioImg { top: 1760px; }
  #ioVid { top: 3360px; }
  .fade.in { opacity: 1; }
  #staticOpa { opacity: 0; width: 320px; height: 180px; }
  #staticVid { opacity: 0; width: 320px; height: 180px; }
</style></head><body>
  <img id="ioImg" class="fade" src="/still.png?c=io">
  <video id="ioVid" class="fade" autoplay muted playsinline src="/hidden.mp4?c=iovid"></video>
  <img id="staticOpa" src="/still.png?c=opa">
  <video id="staticVid" autoplay muted playsinline src="/hidden.mp4?c=opavid"></video>
  <script>
    const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) e.target.classList.add("in"); }, { rootMargin: "-45% 0px -45% 0px" });
    document.querySelectorAll(".fade").forEach((el) => io.observe(el));
  </script>
</body></html>`;

describe("a scroll reveal is shown, a static opacity copy is still hidden", () => {
  let server: Server | undefined;
  let base = "";
  let result: Awaited<ReturnType<typeof runScan>>[number] | undefined;

  beforeAll(async () => {
    const files: Record<string, Buffer> = {
      "/still.png": readFileSync(join(FIXTURES, "still.png")),
      "/hidden.mp4": readFileSync(join(FIXTURES, "hidden.mp4")),
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
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = range[2] === "" ? file.length - 1 : Math.min(Number(range[2]), file.length - 1);
          res.writeHead(206, { "content-type": path.endsWith(".mp4") ? "video/mp4" : "image/png", "content-range": `bytes ${start}-${end}/${file.length}`, "content-length": end - start + 1 });
          return res.end(file.subarray(start, end + 1));
        }
        res.writeHead(200, { "content-type": path.endsWith(".mp4") ? "video/mp4" : "image/png", "content-length": file.length });
        res.end(file);
      });
      s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
    });
    server = started.server;
    base = started.base;
    const out = mkdtempSync(join(tmpdir(), "imgtune-reveal-"));
    [result] = await runScan([`${base}/`], { outDir: out, cwd: out, aggressive: false, quality: false, mediaBudget: 0, viewports: [desktop], log: () => {} });
  }, 180_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const image = (id: string) => (result?.images ?? []).find((r) => r.locator.selector.includes(`#${id}`));
  const video = (id: string) => (result?.videos ?? []).find((v) => v.locator.selector.includes(`#${id}`));

  it("does not call an intersection fade-in image or video hidden after the scroll re-read", () => {
    expect(result?.status).toBe("ok");
    expect(image("ioImg")?.hidden).toBeUndefined();
    expect(video("ioVid")?.hidden).toBeUndefined();
  });

  it("still calls a static opacity-0 image and video hidden", () => {
    expect(image("staticOpa")?.hidden?.reasons).toEqual(["opacity"]);
    expect(video("staticVid")?.hidden?.reasons).toEqual(["opacity"]);
    expect(video("staticVid")?.hidden?.action).toBe("never-shown-on-load");
  });
});
