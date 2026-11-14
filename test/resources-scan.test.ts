// The resource capture in a real scan: a local page with an uncompressed stylesheet and a large favicon, scanned in a
// browser. The findings are on the result; --no-resources (resources: false) captures and analyses nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { runScan, type ScanOptions } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

/** A stylesheet of repeated rules: about 60 KB of text that brotli shrinks a lot. */
function bigCss(): string {
  let css = "";
  for (let i = 0; css.length < 60_000; i++) css += `.card-item-${i % 200}{display:flex;margin:0 auto;color:#334455;transition:all .2s ease}\n`;
  return css;
}

/** An ICO whose one PNG frame is 256 px of noise (a large favicon). */
async function bigIco(): Promise<Buffer> {
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#4a7", noise: { type: "gaussian", mean: 128, sigma: 60 } } })
    .png()
    .toBuffer();
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0;
  entry[1] = 0;
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

describe("resource capture in a scan", () => {
  let base = "";
  let server: Server | undefined;

  beforeAll(async () => {
    const css = bigCss();
    const ico = await bigIco();
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<link rel="stylesheet" href="/site.css"><link rel="icon" href="/favicon.ico"></head>
<body><h1>Resources fixture</h1><p>Some visible text for the page context.</p></body></html>`;
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/" || url === "/page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page);
      }
      if (url === "/site.css") {
        // Sent as is: no Content-Encoding, so the compression analyzer must find it.
        res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
        return res.end(css);
      }
      if (url === "/favicon.ico") {
        res.writeHead(200, { "content-type": "image/x-icon" });
        return res.end(ico);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const scanOptions = (outDir: string, over: Partial<ScanOptions> = {}): ScanOptions => ({
    outDir,
    cwd: outDir,
    aggressive: false,
    quality: false,
    viewports: [desktop],
    log: () => undefined,
    ...over,
  });

  it("finds the uncompressed stylesheet and the large favicon of a page", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const out = await mkdtemp(join(tmpdir(), "imgtune-resources-"));
    try {
      const [result] = await runScan([`${base}/page`], scanOptions(out));
      expect(result.status).toBe("ok");
      const findings = result.resources ?? [];
      const compression = findings.find((f) => f.kind === "compression" && f.details?.contentType === "text/css");
      expect(compression?.savedBytes ?? 0).toBeGreaterThan(30_000);
      expect(compression?.url).toBe(`${base}/site.css`);
      const favicon = findings.find((f) => f.kind === "favicon");
      expect(favicon?.url).toBe(`${base}/favicon.ico`);
      expect(favicon?.savedBytes ?? 0).toBeGreaterThan(0);
      // The image totals do not count the resources: the favicon is an image response, its saving is not in the headline.
      expect(result.page).toBeDefined();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("captures and analyses nothing with resources off", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const out = await mkdtemp(join(tmpdir(), "imgtune-resources-off-"));
    try {
      const [result] = await runScan([`${base}/page`], scanOptions(out, { resources: false }));
      expect(result.status).toBe("ok");
      expect(result.resources).toBeUndefined();
      expect(result.options?.resources).toBe(false);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
