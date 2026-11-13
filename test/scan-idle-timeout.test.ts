// `scan --idle-timeout`: the cap on the wait for network idle after scroll. A page whose network never goes idle (a script
// request that never answers, as some tracker or ad requests do) pays the cap on every settle. The images-complete wait is
// not changed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { parseScanArgs, recordOptionsOf, runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

describe("parseScanArgs for --idle-timeout", () => {
  it("is unset by default, and takes a whole number of milliseconds from 0 to 600000", () => {
    expect(parseScanArgs(["https://a.example/"]).idleTimeoutMs).toBeUndefined();
    expect(parseScanArgs(["https://a.example/", "--idle-timeout", "0"]).idleTimeoutMs).toBe(0);
    expect(parseScanArgs(["https://a.example/", "--idle-timeout", "3000"]).idleTimeoutMs).toBe(3000);
    expect(parseScanArgs(["https://a.example/", "--idle-timeout", "600000"]).idleTimeoutMs).toBe(600000);
  });

  it("rejects a negative, a fraction, a value over ten minutes, a non-number and a missing value", () => {
    for (const bad of ["-1", "1.5", "600001", "soon"]) {
      expect(() => parseScanArgs(["https://a.example/", "--idle-timeout", bad])).toThrow(/--idle-timeout needs a whole number from 0 to 600000/);
    }
    expect(() => parseScanArgs(["https://a.example/", "--idle-timeout"])).toThrow(/--idle-timeout needs a value/);
  });
});

describe("the recorded options and --idle-timeout", () => {
  const base = { aggressive: false, quality: true, viewports: [desktop], ignoreRobots: false, storageState: undefined, gpu: undefined };

  it("records nothing for the default cap, so older scans still match", () => {
    expect(recordOptionsOf(base)).not.toHaveProperty("idleTimeoutMs");
    expect(recordOptionsOf({ ...base, idleTimeoutMs: 10_000 })).not.toHaveProperty("idleTimeoutMs");
  });

  it("records another cap, so --resume never reuses a page scanned with another one", () => {
    expect(recordOptionsOf({ ...base, idleTimeoutMs: 3000 }).idleTimeoutMs).toBe(3000);
    expect(recordOptionsOf({ ...base, idleTimeoutMs: 0 }).idleTimeoutMs).toBe(0);
  });
});

describe("scan of a page whose network never goes idle", () => {
  let base = "";
  let server: Server | undefined;
  const hung: ServerResponse[] = [];

  beforeAll(async () => {
    const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#6a8" } }).png().toBuffer();
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/pic.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png);
      }
      if (url === "/never.js") {
        hung.push(res);
        return;
      }
      if (url === "/busy") {
        // An async script that never answers keeps the load event from firing and the network from going idle.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(
          '<!doctype html><html><head><meta charset="utf-8"></head><body><img src="/pic.png" width="320" height="200" alt="">' +
            '<script async src="/never.js"></script></body></html>',
        );
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const res of hung) res.destroy();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const scanBusy = async (idleTimeoutMs: number | undefined) => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-idle-"));
    try {
      const started = Date.now();
      const [result] = await runScan([`${base}/busy`], {
        outDir: out,
        cwd: out,
        aggressive: false,
        quality: false,
        viewports: [desktop],
        log: () => undefined,
        loadCapMs: 500,
        idleTimeoutMs,
      });
      return { result, seconds: (Date.now() - started) / 1000 };
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  };

  it("caps the network-idle wait at the given time, and still measures the images", async () => {
    const { result, seconds } = await scanBusy(300);
    expect(result.status).toBe("ok");
    expect(result.counts?.images).toBe(1);
    // The default cap is 10 s per settle; with 300 ms the whole scan is a few seconds.
    expect(seconds).toBeLessThan(6);
  }, 60_000);

  it("skips the network-idle wait at 0", async () => {
    const { result, seconds } = await scanBusy(0);
    expect(result.status).toBe("ok");
    expect(result.counts?.images).toBe(1);
    expect(seconds).toBeLessThan(6);
  }, 60_000);
});

describe("scan of a page with an endless-streaming video (autoplay)", () => {
  // The video never ends its response, so its request is in flight for the whole scan. A media request is not network
  // traffic the page waits for: with two viewports the resize must not hold the network-idle wait to its cap.
  let base = "";
  let server: Server | undefined;
  const streams: { res: ServerResponse; timer: NodeJS.Timeout }[] = [];
  const wide: Viewport = { name: "wide", width: 1440, height: 900, dpr: 1, mobile: false };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/stream.mp4" && req.method === "HEAD") {
        // A HEAD is answered at once, as a real server does (the length probe reads it).
        res.writeHead(200, { "content-type": "video/mp4" });
        return res.end();
      }
      if (url === "/stream.mp4") {
        res.writeHead(200, { "content-type": "video/mp4" });
        const chunk = Buffer.alloc(1024, 7);
        const timer = setInterval(() => res.write(chunk), 50);
        streams.push({ res, timer });
        res.on("close", () => clearInterval(timer));
        return;
      }
      if (url === "/video") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(
          '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
            '<video autoplay muted loop playsinline width="320" height="200" src="/stream.mp4"></video></body></html>',
        );
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const { res, timer } of streams) {
      clearInterval(timer);
      res.destroy();
    }
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("does not hold the resize's network-idle wait to the cap while the video streams", async () => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-stream-"));
    try {
      const started = Date.now();
      const [result] = await runScan([`${base}/video`], {
        outDir: out,
        cwd: out,
        aggressive: false,
        quality: false,
        viewports: [desktop, wide],
        sharedLoads: true,
        log: () => undefined,
        loadCapMs: 500,
        idleTimeoutMs: 8000,
      });
      const seconds = (Date.now() - started) / 1000;
      expect(result.status).toBe("ok");
      // The first load's network-idle settle (8 s) and the media reads of the stream (one shared 5 s deadline, BODY_READ_TIMEOUT_MS)
      // take about 13 s. A resize that waited out its cap would add 8 s more: the bound sits between the two (about 20 s fixed, 28 s without).
      expect(seconds).toBeLessThan(24);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("waits for the stream once per page, not once per viewport, and counts the bytes that arrived before the settle", async () => {
    const out = await mkdtemp(join(tmpdir(), "imgtune-stream-"));
    const narrow: Viewport = { name: "narrow", width: 390, height: 844, dpr: 1, mobile: true };
    try {
      const started = Date.now();
      const [result] = await runScan([`${base}/video`], {
        outDir: out,
        cwd: out,
        aggressive: false,
        quality: false,
        viewports: [desktop, wide, narrow],
        sharedLoads: true,
        log: () => undefined,
        loadCapMs: 500,
        idleTimeoutMs: 8000,
      });
      const seconds = (Date.now() - started) / 1000;
      expect(result.status).toBe("ok");
      // Three viewports, one stream: its media read waits 5 s once for the page (the steps share the deadline). Waiting per
      // viewport would add 5 s for each further step: the bound sits below that (about 13 s shared, 23 s per step).
      expect(seconds).toBeLessThan(19);
      // A chunked stream has no Content-Length, and is still streaming at the settle: its bytes are the ones that arrived.
      const video = result.videos?.[0];
      expect(video, "the streaming video is recorded").toBeDefined();
      expect(video!.bytes.perView).toBeGreaterThan(0);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 90_000);
});
