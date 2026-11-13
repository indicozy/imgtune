import { readFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeFfmpeg, probeMedia, runFfmpeg, type MediaProbe } from "../src/ffmpeg.js";
import {
  STILL_GUARD_FLOOR,
  blurFrame,
  compareToReference,
  effectiveStillBar,
  cfrIndices,
  cutSamples,
  guardOf,
  guardScores,
  hasRange,
  searchQuality,
  stillestFrames,
  tenthPercentile,
  yuv4mpegFrames,
  yuvToRgba,
} from "../src/media-encode.js";
import { prepareMedia } from "../src/media-prepare.js";
import { makeScorer, type Scorer } from "../src/metric.js";
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
    expect(outcome.best.still).toBeGreaterThanOrEqual(outcome.best.stillBar);
    expect(outcome.best.stillBar).toBeLessThanOrEqual(65);
    expect(outcome.best.estimate).toBe(true);
    expect(outcome.best.audio).toBe(false);
    // Regression: at 640 px the bisection passes CRF 37, 46, 51, 53 and 54 (VMAF 95.3, guard 68.6), so the search picks
    // 54. A search that stopped at the first passing probe, or read the wrong width, would pick a lower CRF.
    expect(outcome.best.quality).toBeGreaterThanOrEqual(50);
    expect(outcome.best.vmafBar).toBe(93);
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
    if (!outcome.ok) return;
    expect(outcome.best.bytes).toBeGreaterThan(0);
    expect(outcome.best.vmaf).toBeGreaterThanOrEqual(93);
    expect(outcome.best.still).toBeGreaterThanOrEqual(outcome.best.stillBar);
    // text.gif's own WebP ceiling is high, so the requested bar applies unchanged (not lowered).
    expect(outcome.best.stillBar).toBe(65);
  }, 120_000);

  it("reports score-failed, not a failing quality, when the scorer throws", async () => {
    const caps = await probeFfmpeg();
    const probe = (await probeMedia(fixture("text.gif"), 10_000))!;
    const dir = join(scratch, "search-broken-scorer");
    const samples = await cutSamples(fixture("text.gif"), probe, dir, Date.now() + 120_000);
    const broken: Scorer = () => {
      throw new Error("scorer is broken");
    };
    const outcome = await searchQuality(samples, probe, "animated-webp", probe.width, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now() + 120_000,
      caps,
      score: broken,
      workDir: join(dir, "work"),
    });
    expect(outcome).toEqual({ ok: false, reason: "score-failed" });
  }, 120_000);

  it("passes the dithered anim.gif at its own width with the real bars, through the GIF guard prefilter", async () => {
    const caps = await probeFfmpeg();
    const probe = (await probeMedia(fixture("anim.gif"), 10_000))!;
    const dir = join(scratch, "search-anim-gif");
    const samples = await cutSamples(fixture("anim.gif"), probe, dir, Date.now() + 120_000);
    const outcome = await searchQuality(samples, probe, "av1-mp4", probe.width, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now() + 120_000,
      caps,
      score,
      workDir: join(dir, "work"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.best.vmaf).toBeGreaterThanOrEqual(93);
    expect(outcome.best.still).toBeGreaterThanOrEqual(outcome.best.stillBar);
    expect(outcome.best.stillBar).toBeLessThan(65);
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
    // Two stillest frames per sample: the guard takes 2 (see GUARD_FRAMES, performance round).
    expect(guard.frames).toHaveLength(2);
    for (const frame of guard.frames) {
      expect(await score(frame, frame)).toBeGreaterThanOrEqual(99);
    }
  }, 120_000);
});

describe("still-frame guard on a degraded candidate", () => {
  it("rejects a heavily blurred text.gif candidate: the guard is below the bar", async () => {
    const probe = (await probeMedia(fixture("text.gif"), 10_000))!;
    const dir = join(scratch, "guard-degraded");
    const samples = await cutSamples(fixture("text.gif"), probe, dir, Date.now() + 120_000);
    // The reference frames as the search reads them: raw stillest frames, then the GIF prefilter (sigma 1).
    const raw = await guardOf(samples[0], probe.width, join(dir, "ydif.txt"), join(dir, "ref"), Date.now() + 120_000);
    // The candidate: the same frames blurred hard (sigma 3) before the same prefilter, so only the candidate is degraded.
    const scores: number[] = [];
    for (const frame of raw.frames) {
      const ref = await blurFrame(frame, 1);
      const cand = await blurFrame(await blurFrame(frame, 3), 1);
      scores.push(await score(ref, cand));
    }
    expect(Math.min(...scores)).toBeLessThan(65);
  }, 120_000);
});

describe("effective still bar", () => {
  it("is the requested bar when the ceiling is high, the ceiling minus 10 when that is lower, and the floor below that", () => {
    expect(effectiveStillBar(65, 85)).toBe(65);
    expect(effectiveStillBar(65, 40)).toBe(30);
    expect(effectiveStillBar(65, 5)).toBe(STILL_GUARD_FLOOR);
    expect(effectiveStillBar(65, 5)).toBe(20);
  });
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

describe("the guard's frame conversion (yuvToRgba, yuv4mpegFrames)", () => {
  it("converts limited-range BT.601 planes: white, black and mid grey come out exact", () => {
    // A 2 x 2 frame: luma 235 (white), 16 (black), 126 (grey) and 235 (white), with neutral chroma (128).
    const frame = { width: 2, height: 2, y: Uint8Array.from([235, 16, 126, 235]), u: Uint8Array.from([128]), v: Uint8Array.from([128]) };
    const rgba = yuvToRgba(frame).data;
    expect(Array.from(rgba.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(rgba.subarray(4, 8))).toEqual([0, 0, 0, 255]);
    expect(Array.from(rgba.subarray(8, 12))).toEqual([128, 128, 128, 255]);
  });

  it("reads the planes of a YUV4MPEG2 stream by its header size, and every frame of it", () => {
    // 4 x 2 luma and 2 x 1 chroma per plane, two frames.
    const header = Buffer.from("YUV4MPEG2 W4 H2 F30:1 Ip A1:1 C420jpeg\n", "latin1");
    const frame = (fill: number): Buffer => Buffer.concat([Buffer.from("FRAME\n", "latin1"), Buffer.alloc(8, fill), Buffer.alloc(2, 100), Buffer.alloc(2, 150)]);
    const frames = yuv4mpegFrames(Buffer.concat([header, frame(10), frame(200)]));
    expect(frames).toHaveLength(2);
    expect(frames[0].width).toBe(4);
    expect(frames[0].height).toBe(2);
    expect(frames[0].y[0]).toBe(10);
    expect(frames[1].y[7]).toBe(200);
    expect(frames[1].v).toHaveLength(2);
  });

  it("refuses a truncated frame rather than reading past the end", () => {
    const header = Buffer.from("YUV4MPEG2 W4 H2 F30:1\n", "latin1");
    expect(() => yuv4mpegFrames(Buffer.concat([header, Buffer.from("FRAME\n", "latin1"), Buffer.alloc(5)]))).toThrow(/truncated/);
  });
});

describe("the still guard on an animated WebP source (the colour path)", () => {
  it("scores an AV1 CRF 20 encode of a 720x1280 WebP source at guard p10 of at least 60", async () => {
    const caps = await probeFfmpeg();
    const dir = join(scratch, "webp-guard");
    mkdirSync(dir, { recursive: true });
    // A synthetic animated WebP, made here: 3 s of testsrc2 (colour, text and motion) at 720 x 1280.
    const webp = join(dir, "source.webp");
    const made = await runFfmpeg(
      ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=10:duration=3", "-c:v", "libwebp_anim", "-q:v", "75", "-loop", "0", "-y", webp],
      { timeoutMs: 240_000 },
    );
    expect(made.code).toBe(0);
    const buffer = readFileSync(webp);
    const prepared = await prepareMedia(webp, buffer, join(dir, "prepared"));
    const source = prepared.source;
    if (typeof source === "string") throw new Error("expected an animated WebP source, not a file");
    // The candidate: the whole animation as AV1 at CRF 20, from its own frames (the same planes the sample cut gives).
    const candidate = join(dir, "candidate-av1-crf20.mp4");
    const encoded = await runFfmpeg(
      [
        "-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", `${source.width}x${source.height}`, "-framerate", String(source.fps), "-i", "pipe:0",
        "-an", "-c:v", "libsvtav1", "-preset", "10", "-crf", "20", "-svtav1-params", "lp=2", "-pix_fmt", "yuv420p", "-y", candidate,
      ],
      { timeoutMs: 240_000, stdin: () => source.ticks(0, source.tickPages.length) },
    );
    expect(encoded.code).toBe(0);
    const result = await compareToReference(
      candidate,
      source,
      prepared.probe,
      source.width,
      { vmafBar: 0, stillBar: 0, deadline: Date.now() + 240_000, caps, score, workDir: join(dir, "compare") },
      "av1-mp4",
    );
    // The guard reads the same colour for both sides, so a faithful encode scores high. The old path scored 21 here.
    expect(result.still).toBeGreaterThanOrEqual(60);
    expect(result.vmaf).toBeGreaterThanOrEqual(93);
  }, 300_000);
});

describe("the ceiling fails closed on an unreadable frame (guardScores)", () => {
  // A context with one sample whose two guard frames are known. The candidate's frames cannot be read.
  const frame = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 };
  const ctx = {
    samples: ["/unused/sample-0.mkv"],
    probe: { durationS: 2, width: 4, height: 4, fps: 30, videoCodec: "vp9" },
    codec: "av1-mp4",
    width: 4,
    fps: 30,
    seconds: [2],
    opts: { score: async () => 90 },
    guards: [{ indices: [0, 1], frames: [frame, frame] }],
    cache: new Map(),
  } as unknown as Parameters<typeof guardScores>[0];
  const unreadable = { input: [], frames: async () => Promise.reject(new Error("no frame")) };

  it("scores an unreadable candidate frame as 0 for a candidate (it fails closed)", async () => {
    expect(await guardScores(ctx, 0, unreadable)).toEqual([0, 0]);
  });

  it("is score-failed for a ceiling, never a 0 that would lower the still bar to its floor", async () => {
    await expect(guardScores(ctx, 0, unreadable, true)).rejects.toMatchObject({ reason: "score-failed" });
  });
});

describe("hasRange and the third-party policy on each redirect hop", () => {
  let server: Server;
  let port = 0;
  const seen: string[] = [];
  let proxy: EgressProxy;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.headers.host ?? ""}${req.url ?? ""}`);
      if (req.url === "/start.mp4") {
        // A redirect from the page's own host to another host (127.0.0.2 is the same machine under another name).
        res.writeHead(302, { location: `http://127.0.0.2:${port}/clip.mp4` });
        return res.end();
      }
      if (req.url === "/clip.mp4") {
        res.writeHead(200, { "content-type": "video/mp4", "content-length": 5000, "accept-ranges": "bytes" });
        return res.end(Buffer.alloc(5000));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", () => resolve()));
    port = (server.address() as AddressInfo).port;
    proxy = await startEgressProxy({ resolver: systemResolver, allowPrivate: true });
  });

  afterAll(async () => {
    await proxy?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("reads the final URL of an allowed redirect, which is the URL ffmpeg is given", async () => {
    seen.length = 0;
    const info = await hasRange(`http://127.0.0.1:${port}/start.mp4`, 10_000, proxy.url);
    expect(info.blocked).toBeUndefined();
    expect(info.url).toBe(`http://127.0.0.2:${port}/clip.mp4`);
    expect(info.length).toBe(5000);
  });

  it("refuses a redirect hop the policy blocks: the hop is never requested, and the file is blocked", async () => {
    seen.length = 0;
    const allowHop = (hop: string): boolean => !hop.startsWith("http://127.0.0.2:");
    const info = await hasRange(`http://127.0.0.1:${port}/start.mp4`, 10_000, proxy.url, allowHop);
    expect(info).toEqual({ range: false, blocked: true });
    expect(seen.some((line) => line.startsWith("127.0.0.2:"))).toBe(false);
  });
});
