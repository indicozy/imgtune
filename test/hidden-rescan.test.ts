// The hidden-image fix, proven on a rescan: a page with a copy that is never shown on load is scanned; the hint's fix (remove
// the copy) is applied to a second page; the rescan of that page no longer loads the bytes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { hiddenLines } from "../src/hints.js";
import type { HiddenFix } from "../src/images.js";
import { runScan, type PageResult } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const VIEWS: Record<string, Viewport> = {
  desktop: { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false },
  mobile: { name: "mobile", width: 390, height: 844, dpr: 1, mobile: true },
};

const head = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>rescan</title>
<style>#menu { display: none; } main { width: 300px; height: 200px; }</style></head><body><main><img id="hero" src="/hero.png" alt="" width="300" height="200"></main>`;
const tail = `</body></html>`;
// The copy in the hidden menu is downloaded by the browser (no lazy attribute) and never shown on load.
const withGhost = `${head}<div id="menu"><img id="ghost" src="/ghost.png" alt="" width="600" height="400"></div>${tail}`;
const withoutGhost = `${head}${tail}`;

describe("applying the hint's fix removes the bytes on a rescan", () => {
  let base = "";
  let server: Server | undefined;
  let ghost = Buffer.alloc(0);

  beforeAll(async () => {
    const png = (w: number, h: number, color: string) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
    const hero = await png(600, 400, "#358");
    ghost = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#b53" } }).png({ compressionLevel: 0 }).toBuffer();
    const started = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? "";
        if (url === "/hero.png") {
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(hero);
        }
        if (url === "/ghost.png") {
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(ghost);
        }
        if (url === "/before") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(withGhost);
        }
        if (url === "/after") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(withoutGhost);
        }
        res.writeHead(404);
        res.end();
      });
      s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
    });
    base = started.base;
    server = started.server;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  const scan = async (path: string): Promise<PageResult> => {
    const out = mkdtempSync(join(tmpdir(), "imgtune-rescan-"));
    const [result] = await runScan([`${base}${path}`], {
      outDir: out,
      cwd: out,
      aggressive: false,
      quality: false,
      viewports: [VIEWS.desktop, VIEWS.mobile],
      log: () => {},
    });
    return result;
  };

  it("finds the never-shown copy, with its bytes and the remove fix", async () => {
    const result = await scan("/before");
    expect(result.status).toBe("ok");
    const copy = (result.images ?? []).find((r) => r.locator.selector.includes("#ghost"));
    expect(copy?.hidden?.action).toBe("never-shown-on-load");
    expect(copy?.hidden?.perViewBytes ?? 0).toBeGreaterThan(ghost.length / 2);
    expect(copy?.hidden).toBeDefined();
    expect(hiddenLines(copy?.hidden as HiddenFix).join("\n")).toMatch(/remove it, or load it on demand/);
  }, 180_000);

  it("loads no hidden bytes once the copy is removed, as the hint says", async () => {
    const result = await scan("/after");
    expect(result.status).toBe("ok");
    expect((result.images ?? []).some((r) => r.locator.selector.includes("#ghost"))).toBe(false);
    expect(result.hidden).toBeUndefined();
  }, 180_000);
});
