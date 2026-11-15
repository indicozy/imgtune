import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

// A page that reloads itself: the way a site with a timer-driven reload behaves. The first RELOADS loads reload RELOAD_MS
// after their load event; then the page stays. A full read holds the page for about 1.8 s of stability waits, so each full
// read is cut by a reload. The scan must still finish from a quick read between two reloads, and say that its hidden copies
// are unverified.
const RELOADS = 4;
const RELOAD_MS = 2000;
const DESKTOP: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

const PAGE = (reload: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>self reload</title><style>
  body { margin: 0; height: 1600px; }
  #vis { position: absolute; left: 20px; top: 300px; width: 200px; height: 120px; }
  #hid { position: absolute; left: 260px; top: 300px; width: 200px; height: 120px; display: none; }
</style></head><body>
  <img id="vis" src="/still.png?c=vis" alt="">
  <img id="hid" src="/still.png?c=hid" alt="">
  <script>
    ${reload ? 'window.addEventListener("load", () => setTimeout(() => location.reload(), ' + RELOAD_MS + '));' : ""}
  </script>
</body></html>`;

// A page whose URL and hash change on a timer for the whole scan: same-document changes, which are not navigations.
const REWRITING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>rewrite</title></head><body>
  <img id="vis" src="/still.png?c=vis" style="position:absolute;left:20px;top:300px;width:200px;height:120px" alt="">
  <script>
    let n = 0;
    setInterval(() => { n++; history.replaceState({}, "", "/?step=" + n); location.hash = "#s" + n; }, 150);
  </script>
</body></html>`;

// Serves each path's page. "/reloading" reloads itself for its first RELOADS loads, then serves the plain page.
async function serve(): Promise<{ server: Server; base: string; still: Buffer }> {
  const still = readFileSync(new URL("./fixtures/media/still.png", import.meta.url));
  let loads = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/still.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": still.length });
      return res.end(still);
    }
    if (path === "/reloading") {
      loads++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE(loads <= RELOADS));
    }
    if (path === "/rewriting") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(REWRITING_PAGE);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, still };
}

const OPTIONS = () => ({
  outDir: mkdtempSync(join(tmpdir(), "imgtune-reload-")),
  cwd: mkdtempSync(join(tmpdir(), "imgtune-reload-cwd-")),
  aggressive: false,
  quality: false,
  mediaBudget: 0,
  viewports: [DESKTOP],
  log: () => {},
});

describe("a page that reloads itself on a timer", () => {
  let server: Server | undefined;
  let base = "";

  beforeAll(async () => {
    ({ server, base } = await serve());
  }, 30_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("is scanned from a quick read between reloads, and its hidden copy is unverified", async () => {
    const [result] = await runScan([`${base}/reloading`], OPTIONS());
    expect(result?.status).toBe("ok");
    const visible = (result?.images ?? []).find((r) => r.locator.selector.includes("#vis"));
    expect(visible).toBeDefined();
    const hidden = (result?.images ?? []).find((r) => r.locator.selector.includes("#hid"));
    expect(hidden?.hidden).toBeDefined();
    expect(hidden?.hidden?.unstable).toBe("unknown");
  }, 120_000);

  it("is scanned normally when the URL and hash change on a timer (same-document changes)", async () => {
    const [result] = await runScan([`${base}/rewriting`], OPTIONS());
    expect(result?.status).toBe("ok");
    const visible = (result?.images ?? []).find((r) => r.locator.selector.includes("#vis"));
    expect(visible).toBeDefined();
  }, 120_000);
});
