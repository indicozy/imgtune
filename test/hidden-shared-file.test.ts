// Hidden layers that share one file: the page's loaded-but-not-shown bytes count that file once, so they never exceed the
// page's image bytes. (Eight background layers of one image counted the file eight times.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const STILL = readFileSync(fileURLToPath(new URL("./fixtures/media/still.png", import.meta.url)));
const LAYERS = 8;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>shared</title><style>
  body { margin: 0; }
  #shown { position: absolute; left: 20px; top: 20px; width: 200px; height: 120px; }
  .clip { width: 0; height: 0; overflow: hidden; }
  .layer { width: 200px; height: 120px; background-image: url("/bg.png"); background-size: cover; }
</style></head><body>
  <img id="shown" src="/still.png" alt="">
  ${Array.from({ length: LAYERS }, (_, i) => `<div class="clip"><div class="layer" id="layer${i}"></div></div>`).join("\n  ")}
</body></html>`;

describe("hidden bytes count a shared file once", () => {
  const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
  let server: Server | undefined;
  let base = "";

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (path === "/still.png" || path === "/bg.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": STILL.length });
        return res.end(STILL);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("the hidden total is at most the page's image bytes, and is one file's worth for the layers", async () => {
    const out = mkdtempSync(join(tmpdir(), "imgtune-shared-"));
    const [result] = await runScan([`${base}/`], {
      outDir: out,
      cwd: out,
      aggressive: false,
      quality: false,
      mediaBudget: 0,
      viewports: [desktop],
      log: () => {},
    });
    expect(result?.status).toBe("ok");
    const imageBytes = result?.page?.meanImageBytes ?? 0;
    expect(imageBytes).toBeGreaterThan(0);
    const hidden = result?.hidden;
    expect(hidden).toBeDefined();
    expect(hidden!.images).toBe(LAYERS);
    expect(hidden!.bytesPerView).toBeLessThanOrEqual(imageBytes);
    // One file, however many layers use it.
    expect(hidden!.bytesPerView).toBeLessThan(STILL.length * 2);
  }, 120_000);
});
