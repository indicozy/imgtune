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

// A card that is display:none except while the window is scrolled into a band (1200-1650 px). The card's top is at 2000 px, so
// it is in the viewport from about 1200 px. The scanner's scroll-through steps every 800 px, and its step at 1600 px is inside
// the band, so the copy is visible there. The re-read jumps to the copy's centre (1690 px), outside the band, so a snapshot
// and the reads after it show the copy hidden.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>band</title><style>
  body { margin: 0; height: 6000px; }
  #card { position: absolute; left: 20px; top: 2000px; width: 320px; height: 180px; }
</style></head><body>
  <div id="card"><video id="bandVid" muted playsinline preload="auto" src="/hidden.mp4?c=band" width="320" height="180"></video></div>
  <script>
    const card = document.getElementById("card");
    const sync = () => { card.style.display = scrollY >= 1200 && scrollY < 1650 ? "block" : "none"; };
    addEventListener("scroll", sync);
    sync();
  </script>
</body></html>`;

describe("a copy shown only in a scroll band is shown (the scroll-through sees it)", () => {
  let server: Server | undefined;
  let base = "";
  let result: Awaited<ReturnType<typeof runScan>>[number] | undefined;

  beforeAll(async () => {
    const files: Record<string, Buffer> = { "/hidden.mp4": readFileSync(join(FIXTURES, "hidden.mp4")) };
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
          res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${file.length}`, "content-length": end - start + 1 });
          return res.end(file.subarray(start, end + 1));
        }
        res.writeHead(200, { "content-type": "video/mp4", "content-length": file.length });
        res.end(file);
      });
      s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
    });
    server = started.server;
    base = started.base;
    const out = mkdtempSync(join(tmpdir(), "imgtune-band-"));
    [result] = await runScan([`${base}/`], { outDir: out, cwd: out, aggressive: false, quality: false, mediaBudget: 0, viewports: [desktop], log: () => {} });
  }, 180_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("is not flagged: it was visible at a scroll position of the scan's own pass", () => {
    expect(result?.status).toBe("ok");
    const band = (result?.videos ?? []).find((v) => v.locator.selector.includes("#bandVid"));
    expect(band).toBeDefined();
    expect(band?.hidden).toBeUndefined();
  });
});
