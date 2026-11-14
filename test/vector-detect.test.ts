// The cheap vector check in a scan: a flat still raster (an <img> or a CSS background) gets fix.vector with its flatness;
// a photo, a small flat file and an animated file get none. Only numbers are kept.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { scanOnce, type ScanOptions } from "../src/remote.js";
import type { Viewport } from "../src/types.js";
import { gradientNoise, rawToPng } from "./image-fixtures.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">
<rect width="600" height="200" fill="#ffffff"/><circle cx="100" cy="100" r="70" fill="#e4572e"/>
<rect x="200" y="60" width="330" height="80" rx="14" fill="#29335c"/></svg>`;

describe("the vector check in a scan", () => {
  let base = "";
  let server: Server | undefined;
  let dir = "";

  beforeAll(async () => {
    const logo = await sharp(Buffer.from(LOGO_SVG)).png().toBuffer();
    const photo = await sharp(await rawToPng(gradientNoise(400, 300, 12, 5))).jpeg({ quality: 90 }).toBuffer();
    const tinyLogo = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#e4572e"/></svg>')).png().toBuffer();
    const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>vector</title><style>
      .hero { width: 600px; height: 200px; background: url(/logo-bg.png) no-repeat; background-size: 600px 200px; }
    </style></head><body>${body}</body></html>`;
    server = createServer((req, res) => {
      const url = req.url ?? "";
      const send = (type: string, body: Buffer) => {
        res.writeHead(200, { "content-type": type });
        res.end(body);
      };
      if (url === "/") return send("text/html; charset=utf-8", Buffer.from(page(
        '<img src="/logo.png" width="600" height="200" alt="logo"><img src="/photo.jpg" width="400" height="300" alt=""><img src="/tiny.png" width="40" height="40" alt=""><div class="hero"></div>',
      )));
      if (url === "/logo.png" || url === "/logo-bg.png") return send("image/png", logo);
      if (url === "/photo.jpg") return send("image/jpeg", photo);
      if (url === "/tiny.png") return send("image/png", tinyLogo);
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), "imgtune-vector-detect-"));
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const options = (over: Partial<ScanOptions> = {}): ScanOptions => ({
    outDir: dir,
    cwd: dir,
    aggressive: false,
    quality: false,
    viewports: [desktop],
    log: () => undefined,
    ...over,
  });

  it("marks the flat logo (img and background) and leaves the photo and the tiny file alone", async () => {
    const result = await scanOnce(`${base}/`, options());
    const images = result.images ?? [];
    const logo = images.find((r) => r.current.src?.endsWith("/logo.png"));
    const photo = images.find((r) => r.current.src?.endsWith("/photo.jpg"));
    const tiny = images.find((r) => r.current.src?.endsWith("/tiny.png"));
    const background = images.find((r) => r.kind === "css-background");
    expect(logo?.fix.vector?.flatness.flat).toBe(true);
    expect(background?.fix.vector?.flatness.flat).toBe(true);
    expect(photo?.fix.vector).toBeUndefined();
    expect(tiny?.fix.vector).toBeUndefined();
  });

  it("keeps only the numbers of the flatness, and no SVG or trace fields before the proof runs", async () => {
    const result = await scanOnce(`${base}/`, options());
    const logo = (result.images ?? []).find((r) => r.current.src?.endsWith("/logo.png"));
    expect(Object.keys(logo?.fix.vector ?? {})).toEqual(["flatness"]);
    expect(Object.keys(logo?.fix.vector?.flatness ?? {}).sort()).toEqual(["alphaBinaryShare", "flat", "megapixels", "smoothShare", "top16Share", "uniqueColors"]);
  });
});
