// The two-phase scan (see runScan): a file two pages share is estimated once for the run, every page gets the same estimate
// it gets when it is scanned alone, and the progress line names the unique jobs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runScan, scanOnce, type PageResult, type ScanOptions } from "../src/remote.js";
import type { Viewport } from "../src/types.js";
import { gradientNoise, rawToPng } from "./image-fixtures.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

describe("runScan estimates each shared file once", () => {
  let base = "";
  let server: Server | undefined;

  const page = (body: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`;

  beforeAll(async () => {
    // A noisy photo: its JPEG is far larger than the threshold, and drawn at 200 px it is an estimated resize.
    const photo = await sharp(await rawToPng(gradientNoise(1600, 1000, 12, 3))).jpeg({ quality: 92 }).toBuffer();
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/photo.jpg") {
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(photo);
      }
      if (url === "/a" || url === "/b") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        const own = url === "/a" ? "first" : "second";
        return res.end(page(`<p>${own}</p><img src="/photo.jpg" width="200" height="125" alt="">`));
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

  /** The numbers that the estimate decides, per image, for comparison. */
  const estimates = (result: PageResult) =>
    (result.perViewport.desktop.images ?? []).map((image) => ({ url: image.url, estSaved: image.estSaved, exactSaved: image.exactSaved }));

  it("runs the shared photo's resize once, and gives both pages the numbers each gets alone", async () => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-est-jobs-"));
    try {
      const logs: string[] = [];
      const results = await runScan(
        [`${base}/a`, `${base}/b`],
        scanOptions(out, { log: (message) => logs.push(message) }),
      );
      expect(results.every((r) => r.status === "ok" && r.complete === true)).toBe(true);
      // Two pages name the photo at the same width: one job, two requests, nothing skipped.
      expect(logs).toContain("estimates: 1 unique of 2, 0 skipped");
      const [first, second] = results;
      expect(estimates(first)).toEqual(estimates(second));
      expect(first.perViewport.desktop.estSaved).toBeGreaterThan(0);

      // Each page scanned alone has the same numbers as in the run.
      const alone = await scanOnce(`${base}/a`, scanOptions(out));
      expect(estimates(alone)).toEqual(estimates(first));
      expect(alone.perViewport.desktop.estSaved).toBe(first.perViewport.desktop.estSaved);

      // The pages were written after their estimates: every file on disk is complete and carries them.
      const files = readdirSync(out).filter((name) => name.endsWith(".json"));
      expect(files).toHaveLength(2);
      for (const name of files) {
        const written = JSON.parse(await readFile(join(out, name), "utf8")) as PageResult;
        expect(written.complete).toBe(true);
        expect(written.perViewport.desktop.estSaved).toBe(first.perViewport.desktop.estSaved);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
