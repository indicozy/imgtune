// `scan --page-concurrency`: pages in flight at once on one browser. The results keep the input order, each page is written
// once its estimates are in, the limits stop new pages but keep the ones in flight, and --resume reads the pages back.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { parseScanArgs, runScan, type ScanOptions, type ScanReport } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
/** How long the /slow page takes to answer: long enough that every fast page finishes first. */
const SLOW_MS = 4000;

describe("parseScanArgs for --page-concurrency", () => {
  it("is unset by default and reads a whole number from 1 to 6", () => {
    expect(parseScanArgs(["https://a.example/"]).pageConcurrency).toBeUndefined();
    expect(parseScanArgs(["https://a.example/", "--page-concurrency", "4"]).pageConcurrency).toBe(4);
    expect(parseScanArgs(["https://a.example/", "--page-concurrency", "6"]).pageConcurrency).toBe(6);
  });

  it("rejects a value outside 1 to 6, a fraction, a non-number and a missing value", () => {
    for (const bad of ["0", "7", "2.5", "x", "-1", "1e1"]) {
      expect(() => parseScanArgs(["https://a.example/", "--page-concurrency", bad])).toThrow(/--page-concurrency needs a whole number from 1 to 6/);
    }
    expect(() => parseScanArgs(["https://a.example/", "--page-concurrency"])).toThrow(/--page-concurrency needs a value/);
  });
});

describe("runScan with pageConcurrency", () => {
  let base = "";
  let server: Server | undefined;

  const page = (body: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`;

  beforeAll(async () => {
    const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#6a8" } }).png().toBuffer();
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/pic.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png);
      }
      const send = () => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page('<img src="/pic.png" width="320" height="200" alt="">'));
      };
      if (url === "/slow") return setTimeout(send, SLOW_MS);
      if (url.startsWith("/p/")) return send();
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

  const jsonFilesIn = (dir: string): number => readdirSync(dir).filter((name) => name.endsWith(".json")).length;

  it("keeps the input order, and writes each page once its estimates are in", async () => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-conc-order-"));
    try {
      const urls = [`${base}/slow`, `${base}/p/a`, `${base}/p/b`];
      const progress: string[] = [];
      // The file count at each progress line. A page's file is on disk before the line that reports it, but the count may
      // be ahead of the lines: two pages that finish together can both be on disk before the first line runs.
      const filesAtProgress: number[] = [];
      const results = await runScan(
        urls,
        scanOptions(out, {
          pageConcurrency: 3,
          log: (message) => {
            if (message.includes(" done")) {
              progress.push(message);
              filesAtProgress.push(jsonFilesIn(out));
            }
          },
        }),
      );
      expect(results.map((r) => r.url)).toEqual(urls);
      expect(results.every((r) => r.status === "ok" && r.complete === true)).toBe(true);
      expect(progress).toHaveLength(3);
      expect(progress[0]).toMatch(/^page 1\/3 done/);
      expect(progress[2]).toMatch(/^page 3\/3 done/);
      // The reported page is on disk at each line (the lines count pages, the disk may hold more), and the slow page is not
      // among the first line's files: it takes SLOW_MS, so the first line comes before it can be written.
      filesAtProgress.forEach((files, line) => expect(files).toBeGreaterThanOrEqual(line + 1));
      expect(filesAtProgress[0]).toBeLessThan(3);
      expect(filesAtProgress[filesAtProgress.length - 1]).toBe(3);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("stops starting pages at --max-pages, and keeps the pages already in flight", async () => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-conc-maxpages-"));
    try {
      const urls = [`${base}/slow`, `${base}/p/a`, `${base}/p/b`, `${base}/p/c`];
      const report: ScanReport = {};
      const results = await runScan(urls, scanOptions(out, { pageConcurrency: 2, maxPages: 3, report }));
      // The first three pages start in input order, so these are the three kept whatever order they finish in.
      expect(results.map((r) => r.url)).toEqual(urls.slice(0, 3));
      expect(report.stopped).toMatchObject({ reason: "max-pages", limit: 3, pages: 3, total: 4 });
      expect(jsonFilesIn(out)).toBe(3);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("stops starting pages once --max-images is reached, and keeps the pages in flight", async () => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-conc-maximages-"));
    try {
      const urls = [`${base}/p/a`, `${base}/p/b`, `${base}/p/c`, `${base}/p/d`];
      const report: ScanReport = {};
      const results = await runScan(urls, scanOptions(out, { pageConcurrency: 2, maxImages: 1, report }));
      // Both of the first two pages start before either finishes, so both are kept; no third page starts.
      expect(results.map((r) => r.url)).toEqual(urls.slice(0, 2));
      expect(report.stopped).toMatchObject({ reason: "max-images", limit: 1, pages: 2, total: 4, images: 2 });
      expect(jsonFilesIn(out)).toBe(2);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("resumes the pages of an earlier run in input order, at another page concurrency", async () => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-conc-resume-"));
    try {
      const urls = [`${base}/p/a`, `${base}/p/b`, `${base}/p/c`];
      await runScan(urls, scanOptions(out, { pageConcurrency: 1 }));
      const log: string[] = [];
      const results = await runScan(urls, scanOptions(out, { pageConcurrency: 3, resume: true, log: (m) => log.push(m) }));
      expect(results.map((r) => r.url)).toEqual(urls);
      expect(log.filter((m) => m.startsWith("resumed "))).toHaveLength(3);
      expect(log.filter((m) => m.startsWith("scanning "))).toHaveLength(0);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);
});
