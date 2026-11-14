// HAR replay (src/replay.ts, scripts/record-sites.mjs): a page recorded to HAR is scanned again with the server gone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { harKey, replayHarPath } from "../src/replay.js";
import { runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const DESKTOP: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

describe("HAR replay", () => {
  let server: Server | undefined;
  let base = "";
  let dir = "";
  let png = Buffer.alloc(0);

  beforeAll(async () => {
    png = await sharp({ create: { width: 640, height: 400, channels: 3, background: "#4a8" } }).png().toBuffer();
    server = createServer((req, res) => {
      if (req.url === "/x.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png);
      }
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end('<!doctype html><html><head><title>replay</title></head><body><img id="x" src="/x.png" width="640" height="400"></body></html>');
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    dir = mkdtempSync(join(tmpdir(), "imgtune-har-"));
    const list = join(dir, "urls.txt");
    writeFileSync(list, `${base}\n`);
    // Async: the recorder fetches from this process's server, so the event loop must stay free while it runs.
    await promisify(execFile)(process.execPath, [join(__dirname, "..", "scripts", "record-sites.mjs"), list, join(dir, "har"), "desktop"], { timeout: 170_000 });
  }, 180_000);

  afterAll(async () => {
    delete process.env.IMGTUNE_REPLAY_HAR;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it("names each HAR by the URL and the viewport, and is off without the variable", () => {
    expect(harKey(base)).toMatch(/^[0-9a-f]{12}$/);
    expect(replayHarPath(base, "desktop", {})).toBeUndefined();
    expect(() => replayHarPath(base, "desktop", { IMGTUNE_REPLAY_HAR: join(dir, "har") } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => replayHarPath(`${base}missing`, "desktop", { IMGTUNE_REPLAY_HAR: join(dir, "har") } as NodeJS.ProcessEnv)).toThrow(/no recorded HAR/);
  });

  it("scans a recorded page with the server stopped, and finds the same image", async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    process.env.IMGTUNE_REPLAY_HAR = join(dir, "har");
    const out = mkdtempSync(join(tmpdir(), "imgtune-har-out-"));
    const [result] = await runScan([base], { outDir: out, cwd: out, aggressive: false, quality: false, viewports: [DESKTOP], log: () => {} });
    expect(result.status).toBe("ok");
    expect((result.images ?? []).some((r) => r.locator.selector.includes("#x"))).toBe(true);
  }, 180_000);
});
