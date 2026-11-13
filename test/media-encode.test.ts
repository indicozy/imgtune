import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeFfmpeg, probeMedia, type MediaProbe } from "../src/ffmpeg.js";
import { cfrIndices, cutSamples, guardOf, hasRange, searchQuality, stillestFrames, tenthPercentile } from "../src/media-encode.js";
import { makeScorer } from "../src/metric.js";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.js";
import { systemResolver } from "../src/address.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "media");
const fixture = (name: string): string => join(FIXTURES, name);

// Scratch for the encodes and the local servers, removed in afterAll.
const scratch = mkdtempSync(join(tmpdir(), "imgtune-encode-test-"));
const closers: (() => Promise<void>)[] = [];

/** The real egress proxy every URL in these tests goes through; local servers are allowed as targets. */
let egress: EgressProxy;
beforeAll(async () => {
  egress = await startEgressProxy({ resolver: systemResolver, allowPrivate: true });
});

afterAll(async () => {
  await egress?.close();
  for (const close of closers) await close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A local HTTP server answering every request with `handler`, closed in afterAll. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  closers.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A handler that serves a file with byte ranges, as a CDN would. */
function rangeFile(file: string): (req: IncomingMessage, res: ServerResponse) => void {
  const data = readFileSync(file);
  return (req, res) => {
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (!match) {
      res.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": data.length, ETag: '"clip"' });
      res.end(req.method === "HEAD" ? undefined : data);
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : data.length - 1;
    const body = data.subarray(start, end + 1);
    res.writeHead(206, {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${data.length}`,
      "Content-Length": body.length,
      ETag: '"clip"',
    });
    res.end(body);
  };
}

const score = makeScorer("ssimulacra2");

describe("cutSamples", () => {
  it("cuts three 2 s lossless clips from an 8 s video", async () => {
    const probe = (await probeMedia(fixture("clip.mp4"), 10_000))!;
    const dir = join(scratch, "cut-clip");
    const samples = await cutSamples(fixture("clip.mp4"), probe, dir, Date.now() + 120_000);
    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      const clip = (await probeMedia(sample, 10_000))!;
      expect(clip.durationS).toBeGreaterThan(1.9);
      expect(clip.durationS).toBeLessThan(2.1);
    }
  }, 120_000);

  it("seeks a served file with Range requests", async () => {
    const base = await serve(rangeFile(fixture("clip.mp4")));
    const probe = (await probeMedia(fixture("clip.mp4"), 10_000))!;
    const samples = await cutSamples(`${base}/clip.mp4`, probe, join(scratch, "cut-http"), Date.now() + 120_000, egress.url);
    expect(samples).toHaveLength(3);
  }, 120_000);

  it("rejects when the URL answers 404, so the caller can report probe-failed", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const probe: MediaProbe = { durationS: 8, width: 1280, height: 720, fps: 30, videoCodec: "h264" };
    await expect(
      cutSamples(`${base}/missing.mp4`, probe, join(scratch, "cut-404"), Date.now() + 30_000, egress.url),
    ).rejects.toThrow();
  }, 60_000);

  it("refuses a URL when no egress proxy is given", async () => {
    const probe: MediaProbe = { durationS: 8, width: 1280, height: 720, fps: 30, videoCodec: "h264" };
    await expect(cutSamples("https://cdn.example/clip.mp4", probe, join(scratch, "cut-noproxy"), Date.now() + 30_000))
      .rejects.toThrow("URL inputs require the egress proxy");
  });

  it("refuses an input that is neither an absolute path nor an http(s) URL", async () => {
    const probe: MediaProbe = { durationS: 8, width: 1280, height: 720, fps: 30, videoCodec: "h264" };
    await expect(cutSamples("clip.mp4", probe, join(scratch, "cut-rel"), Date.now() + 30_000)).rejects.toThrow();
  });
});

describe("searchQuality", () => {
  it("finds a passing AV1 quality for clip.mp4 that is smaller than the file", async () => {
    const caps = await probeFfmpeg();
    const probe = (await probeMedia(fixture("clip.mp4"), 10_000))!;
    const dir = join(scratch, "search-av1");
    const samples = await cutSamples(fixture("clip.mp4"), probe, dir, Date.now() + 120_000);
    const outcome = await searchQuality(samples, probe, "av1-mp4", 640, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now() + 120_000,
      caps,
      score,
      workDir: join(dir, "work"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.best.bytes).toBeLessThan(statSync(fixture("clip.mp4")).size);
    expect(outcome.best.vmaf).toBeGreaterThanOrEqual(93);
    expect(outcome.best.still).toBeGreaterThanOrEqual(65);
    expect(outcome.best.estimate).toBe(true);
    expect(outcome.best.audio).toBe(false);
  }, 120_000);

  it("finds a passing animated WebP quality for a GIF", async () => {
    const caps = await probeFfmpeg();
    const probe = (await probeMedia(fixture("text.gif"), 10_000))!;
    const dir = join(scratch, "search-webp");
    const samples = await cutSamples(fixture("text.gif"), probe, dir, Date.now() + 120_000);
    const outcome = await searchQuality(samples, probe, "animated-webp", probe.width, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now() + 120_000,
      caps,
      score,
      workDir: join(dir, "work"),
    });
    expect(outcome.ok).toBe(true);
  }, 120_000);

  it("returns time-limit when the deadline has already passed", async () => {
    const caps = await probeFfmpeg();
    const probe = (await probeMedia(fixture("clip.mp4"), 10_000))!;
    const outcome = await searchQuality([fixture("clip.mp4")], probe, "av1-mp4", 640, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now(),
      caps,
      score,
      workDir: join(scratch, "search-late"),
    });
    expect(outcome).toEqual({ ok: false, reason: "time-limit" });
  });
});

describe("hasRange", () => {
  it("refuses a URL when no egress proxy is given", async () => {
    await expect(hasRange("https://cdn.example/clip.mp4", 10_000)).rejects.toThrow("URL inputs require the egress proxy");
  });

  it("reports no range for a 200 answer without Accept-Ranges", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": 4 });
      res.end("data");
    });
    expect((await hasRange(`${base}/clip.mp4`, 10_000, egress.url)).range).toBe(false);
  });

  it("reports the range, length and validators of a server that serves ranges", async () => {
    const base = await serve(rangeFile(fixture("clip.mp4")));
    const info = await hasRange(`${base}/clip.mp4`, 10_000, egress.url);
    expect(info.range).toBe(true);
    expect(info.length).toBe(statSync(fixture("clip.mp4")).size);
    expect(info.etag).toBe('"clip"');
  });

  it("reports no range, and does not throw, for a 404", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    expect((await hasRange(`${base}/missing.mp4`, 10_000, egress.url)).range).toBe(false);
  });

  it("sends an http target through a proxy with the absolute URL, and opens a CONNECT tunnel for https", async () => {
    const origin = await serve(rangeFile(fixture("clip.mp4")));
    const seen: string[] = [];
    const proxy = createServer((req, res) => {
      seen.push(req.url ?? "");
      const headers = { ...req.headers };
      delete headers.host;
      const up = httpRequest(req.url!, { method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode!, r.headers);
        r.pipe(res);
      });
      up.on("error", () => res.destroy());
      up.end();
    });
    proxy.on("connect", (req, socket) => {
      seen.push(`CONNECT ${req.url}`);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    expect((await hasRange(`${origin}/clip.mp4`, 10_000, proxyUrl)).range).toBe(true);
    expect(seen).toContain(`${origin}/clip.mp4`);
    expect((await hasRange("https://example.test/clip.mp4", 10_000, proxyUrl)).range).toBe(false);
    expect(seen).toContain("CONNECT example.test:443");
  });
});

describe("still-frame guard", () => {
  it("scores a reference frame against itself at about 100", async () => {
    const probe = (await probeMedia(fixture("clip.mp4"), 10_000))!;
    const dir = join(scratch, "guard-self");
    const samples = await cutSamples(fixture("clip.mp4"), probe, dir, Date.now() + 120_000);
    const guard = await guardOf(samples[0], 640, join(dir, "ydif.txt"), join(dir, "ref"), Date.now() + 120_000);
    expect(guard.frames).toHaveLength(3);
    for (const frame of guard.frames) {
      expect(await score(frame, frame)).toBeGreaterThanOrEqual(99);
    }
  }, 120_000);
});

describe("pure helpers", () => {
  it("maps constant-frame-rate ticks to the frame on screen at each tick", () => {
    expect(cfrIndices([100, 100, 100], 10, 3)).toEqual([0, 1, 2]);
    // Frame 0 lasts 50 ms, frame 1 lasts 150 ms: the tick at 100 ms shows frame 1, and the last tick repeats it.
    expect(cfrIndices([50, 150], 10, 3)).toEqual([0, 1, 1]);
  });

  it("picks the lowest-difference frames, never frame 0, and returns them in order", () => {
    const text = [0, 1, 2, 3, 4, 5]
      .map((n) => `frame:${n}    pts:${n}\nlavfi.signalstats.YDIF=${[0, 9, 2, 0.5, 7, 1][n]}\n`)
      .join("");
    expect(stillestFrames(text, 3)).toEqual([2, 3, 5]);
  });

  it("takes the lower-nearest-rank 10th percentile", () => {
    expect(tenthPercentile([90, 70, 80, 60, 100, 75, 85, 65, 95])).toBe(60);
    expect(tenthPercentile([42])).toBe(42);
  });
});
