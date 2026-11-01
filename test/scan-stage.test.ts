// The stage of a scan (src/stage.ts): a measured page is written to the out dir before the run's analysis, so an
// interrupted run is resumed without measuring its pages again, and the resumed numbers are those of a page analysed alone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runScan, scanOnce, type ScanOptions } from "../src/remote.js";
import { STAGE_DIR_NAME } from "../src/stage.js";
import type { Viewport } from "../src/types.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

describe("runScan stages each measured page", () => {
  let base = "";
  let server: Server | undefined;
  /** Page document requests by path: a page measured again is counted again. */
  const hits: Record<string, number> = {};

  beforeAll(async () => {
    // A 320-px image: the /p pages draw it at 320 px, the /wide page at 80 px (so it gets a resize estimate).
    const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#6a8" } }).png().toBuffer();
    // A noisy JPEG for the /wide page: a photo-like file, so its quality-matched resize estimate is a real saving.
    const jpg = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#777", noise: { type: "gaussian", mean: 128, sigma: 40 } } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const page = (body: string) =>
      `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`;
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/pic.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png);
      }
      if (url === "/pic.jpg") {
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(jpg);
      }
      if (url.startsWith("/p/")) {
        hits[url] = (hits[url] ?? 0) + 1;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page('<img src="/pic.png" width="320" height="200" alt="">'));
      }
      if (url === "/wide") {
        hits[url] = (hits[url] ?? 0) + 1;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page('<img src="/pic.jpg" width="80" height="50" alt="">'));
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

  const jsonFilesIn = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".json"));

  it("does not measure a staged page again when an interrupted run is resumed, and matches a page analysed alone", async () => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-stage-phase2-"));
    try {
      const urls = [`${base}/p/a`, `${base}/wide`];
      // Interrupted after both pages are measured and staged: at the start of the analysis.
      await expect(
        runScan(
          urls,
          scanOptions(out, {
            log: (message) => {
              if (message.startsWith("estimates:")) throw new Error("interrupted");
            },
          }),
        ),
      ).rejects.toThrow("interrupted");
      expect(jsonFilesIn(out)).toHaveLength(0);
      expect(readdirSync(join(out, STAGE_DIR_NAME, "blobs")).length).toBeGreaterThan(0);
      const measured = { ...hits };
      expect(measured["/p/a"]).toBe(1);

      const results = await runScan(urls, scanOptions(out, { resume: true }));
      expect(hits).toEqual(measured);
      expect(results.every((r) => r.status === "ok" && r.complete === true)).toBe(true);
      expect(jsonFilesIn(out)).toHaveLength(2);
      expect(existsSync(join(out, STAGE_DIR_NAME))).toBe(false);

      // The numbers of the resumed pages are those of each page analysed alone (no stage, all in memory).
      for (const url of urls) {
        const alone = await scanOnce(url, scanOptions(out));
        const resumed = results.find((r) => r.url === url);
        expect(resumed?.page).toEqual(alone.page);
        expect(resumed?.groups).toEqual(alone.groups);
      }
      expect(results.find((r) => r.url === `${base}/wide`)?.page?.exactEstPct).toBeGreaterThan(0);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("measures only the pages the interrupted run did not reach", async () => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-stage-phase1-"));
    try {
      const before = { ...hits };
      const urls = [`${base}/p/b`, `${base}/p/c`];
      // Interrupted in phase 1, as the second page starts: the first is staged, the second is not yet.
      await expect(
        runScan(
          urls,
          scanOptions(out, {
            log: (message) => {
              if (message.startsWith("scanning") && message.includes("/p/c")) throw new Error("interrupted");
            },
          }),
        ),
      ).rejects.toThrow("interrupted");
      expect(hits["/p/b"]).toBe((before["/p/b"] ?? 0) + 1);
      expect(hits["/p/c"] ?? 0).toBe(before["/p/c"] ?? 0);

      const results = await runScan(urls, scanOptions(out, { resume: true }));
      expect(hits["/p/b"]).toBe((before["/p/b"] ?? 0) + 1);
      expect(hits["/p/c"]).toBe((before["/p/c"] ?? 0) + 1);
      expect(results.map((r) => r.url)).toEqual(urls);
      expect(results.every((r) => r.status === "ok" && r.complete === true)).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
