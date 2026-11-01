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
