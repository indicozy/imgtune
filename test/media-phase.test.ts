// The media phase (media-phase.ts): the assets of a scan are ranked, encoded within the budget and the time limit, deduped
// and cached, and their results are attached to each page. Most cases inject the ffmpeg steps, so they run without an
// encoder; the real encode runs on a clip served by a local server through the egress proxy.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetFfmpegProbe, type FfmpegCaps, type MediaProbe } from "../src/ffmpeg.js";
import type { CandidateResult, SearchOutcome } from "../src/media-encode.js";
import {
  attachMediaResults,
  MEDIA_NOTE,
  mediaAssetsOf,
  mediaKeyOf,
  runMediaPhase,
  skippedMedia,
  type MediaAsset,
  type MediaOptions,
} from "../src/media-phase.js";
import { ResultCache } from "../src/result-cache.js";
import { parseScanArgs } from "../src/remote.js";
import { probeFfmpeg } from "../src/ffmpeg.js";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.js";
import { systemResolver } from "../src/address.js";
import { makeScorer } from "../src/metric.js";
import type { PageResult, ScanOptions } from "../src/remote.js";
import { runScan } from "../src/remote.js";
import type { VideoRecord } from "../src/video-analysis.js";
import type { Viewport } from "../src/types.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "media");
const scratch = mkdtempSync(join(tmpdir(), "imgtune-media-phase-"));
const closers: (() => Promise<void>)[] = [];
let egress: EgressProxy | undefined;

afterAll(async () => {
  await egress?.close();
  for (const close of closers) await close();
  rmSync(scratch, { recursive: true, force: true });
});

const caps: FfmpegCaps = { ffmpeg: true, ffprobe: true, vmaf: true, av1: "libsvtav1", x264: true, webpAnim: true, avifMuxer: true };
/** A VP9 source, so both AV1 and the H.264 fallback are encoded. */
const probe: MediaProbe = { durationS: 8, width: 1280, height: 720, fps: 30, videoCodec: "vp9" };

const video = (url: string, perView: number, widths = [640]): MediaAsset => ({
  key: mediaKeyOf("video", "video", url, widths),
  url,
  kind: "video",
  context: "video",
  widths,
  perView,
  perPlay: perView,
});

function candidate(codec: CandidateResult["codec"], width: number, bytes: number): CandidateResult {
  return { codec, width, quality: 40, sampleBytes: bytes / 4, sampleSeconds: 6, bytes, vmaf: 95, still: 80, estimate: true, audio: false };
}

/** Options for a phase run with a fresh work folder; the cache and the proxy are off unless a case sets them. */
function options(over: Partial<MediaOptions> = {}): MediaOptions {
  return {
    budget: 20,
    timeS: 600,
    vmafBar: 93,
    stillBar: 65,
    survey: false,
    workDir: join(scratch, `work-${Math.random().toString(36).slice(2)}`),
    log: () => undefined,
    ...over,
  };
}

/** Injected ffmpeg steps: every encode passes at a fixed size, and the calls are counted. */
function fakeSteps(): { deps: NonNullable<Parameters<typeof runMediaPhase>[2]>; searches: string[] } {
  const searches: string[] = [];
  return {
    searches,
    deps: {
      caps,
      hasRange: async () => ({ range: true, length: 500_000, etag: '"v1"' }),
      probe: async () => probe,
      cut: async () => ["/unused/sample-0.mkv"],
      search: async (_samples, _probe, codec, width): Promise<SearchOutcome> => {
        searches.push(`${codec}@${width}`);
        return { ok: true, best: candidate(codec, width, 1000), tried: 1 };
      },
    },
  };
}

describe("runMediaPhase without ffmpeg", () => {
  const saved = process.env.IMGTUNE_FFMPEG;
  beforeEach(() => {
    process.env.IMGTUNE_FFMPEG = "/nonexistent/ffmpeg";
    resetFfmpegProbe();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.IMGTUNE_FFMPEG;
    else process.env.IMGTUNE_FFMPEG = saved;
    resetFfmpegProbe();
  });

  it("gives every asset 'ffmpeg not found' and one note, without throwing", async () => {
    const logs: string[] = [];
    const results = await runMediaPhase(
      [video("http://127.0.0.1:1/a.mp4", 100), video("http://127.0.0.1:1/b.mp4", 50)],
      options({ log: (line) => logs.push(line) }),
    );
    const entries = [...results.byKey.values()];
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.notEncoded === "ffmpeg not found" && e.candidates.length === 0)).toBe(true);
    expect(results.note).toBe(MEDIA_NOTE);
    expect(logs.filter((line) => line.includes("install ffmpeg"))).toHaveLength(1);
  });
});

describe("runMediaPhase budget, limits and dedupe", () => {
  it("encodes the heaviest asset within the budget and marks the rest", async () => {
    const { deps } = fakeSteps();
    const results = await runMediaPhase(
      [video("http://127.0.0.1:1/light.mp4", 10), video("http://127.0.0.1:1/heavy.mp4", 1000)],
      options({ budget: 1 }),
      deps,
    );
    const heavy = results.byKey.get(mediaKeyOf("video", "video", "http://127.0.0.1:1/heavy.mp4", [640]));
    const light = results.byKey.get(mediaKeyOf("video", "video", "http://127.0.0.1:1/light.mp4", [640]));
    expect(heavy?.candidates.length).toBeGreaterThan(0);
    expect(light?.candidates).toEqual([]);
    expect(light?.notEncoded).toBe("over --media-budget");
  });

  it("encodes two assets with the same key once", async () => {
    const url = "http://127.0.0.1:1/shared.mp4";
    const one = fakeSteps();
    await runMediaPhase([video(url, 100)], options(), one.deps);
    const two = fakeSteps();
    const results = await runMediaPhase([video(url, 100), video(url, 100)], options(), two.deps);
    expect(two.searches).toHaveLength(one.searches.length);
    expect(two.searches.length).toBeGreaterThan(0);
    expect(results.byKey.size).toBe(1);
  });

  it("gives time-limit for every asset when the phase has no time (timeS 0), and encodes nothing", async () => {
    const steps = fakeSteps();
    const results = await runMediaPhase([video("http://127.0.0.1:1/t.mp4", 100)], options({ timeS: 0 }), steps.deps);
    const entry = [...results.byKey.values()][0];
    expect(entry.notEncoded).toBe("time-limit");
    expect(steps.searches).toEqual([]);
  });

  it("reuses a cached outcome on a second run instead of encoding again", async () => {
    const dir = await mkdtemp(join(scratch, "cache-"));
    const cache = new ResultCache(dir);
    const url = "http://127.0.0.1:1/cached.mp4";
    const first = fakeSteps();
    const a = await runMediaPhase([video(url, 100)], options({ cache }), first.deps);
    const second = fakeSteps();
    const b = await runMediaPhase([video(url, 100)], options({ cache }), second.deps);
    expect(first.searches.length).toBeGreaterThan(0);
    expect(second.searches).toEqual([]);
    const key = mediaKeyOf("video", "video", url, [640]);
    expect(b.byKey.get(key)?.candidates).toEqual(a.byKey.get(key)?.candidates);
  });

  it("marks survey assets 'survey' and encodes nothing", async () => {
    const steps = fakeSteps();
    const results = await runMediaPhase([video("http://127.0.0.1:1/s.mp4", 100)], options({ survey: true }), steps.deps);
    expect([...results.byKey.values()][0].notEncoded).toBe("survey");
    expect(steps.searches).toEqual([]);
  });
});

describe("runMediaPhase with a server that has no Range support", () => {
  it("reads a small video whole, once, and cuts its samples from the local copy", async () => {
    const url = "http://127.0.0.1:1/norange.mp4";
    const seen: { url: string; maxBytes?: number }[] = [];
    const cuts: string[] = [];
    const steps = fakeSteps();
    const deps = {
      ...steps.deps,
      hasRange: async () => ({ range: false, length: 300_000 }),
      fetch: async (u: string, maxBytes?: number) => {
        seen.push({ url: u, maxBytes });
        return Buffer.from("not really a video");
      },
      cut: async (input: string) => {
        cuts.push(input);
        return ["/unused/sample-0.mkv"];
      },
    };
    const work = join(scratch, `norange-${Math.random().toString(36).slice(2)}`);
    const results = await runMediaPhase([video(url, 100)], options({ workDir: work }), deps);
    expect(seen).toEqual([{ url, maxBytes: 50_000_000 }]);
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts.every((input) => input.startsWith(work))).toBe(true);
    expect(steps.searches.length).toBeGreaterThan(0);
    expect([...results.byKey.values()][0].notEncoded).toBeUndefined();
  });

  it("gives 'server has no Range support' for a video over 50 MB, and does not download it", async () => {
    const url = "http://127.0.0.1:1/huge.mp4";
    let fetched = 0;
    const steps = fakeSteps();
    const deps = { ...steps.deps, hasRange: async () => ({ range: false, length: 60_000_000 }), fetch: async () => { fetched++; return undefined; } };
    const results = await runMediaPhase([video(url, 100)], options(), deps);
    expect([...results.byKey.values()][0].notEncoded).toBe("server has no Range support");
    expect(fetched).toBe(0);
    expect(steps.searches).toEqual([]);
  });
});

describe("parseScanArgs: media flags", () => {
  it("reads the media flags and refuses values out of range", () => {
    expect(
      parseScanArgs(["https://a.example/", "--media-budget", "5", "--media-time", "120", "--video-bar", "90", "--video-still-bar", "60", "--max-video-widths", "1"]),
    ).toMatchObject({ mediaBudget: 5, mediaTime: 120, videoBar: 90, videoStillBar: 60, maxVideoWidths: 1 });
    expect(() => parseScanArgs(["https://a.example/", "--max-video-widths", "4"])).toThrow(/whole number from 1 to 3/);
    expect(() => parseScanArgs(["https://a.example/", "--media-time", "0"])).toThrow(/whole number from 1 to 3600/);
    expect(() => parseScanArgs(["https://a.example/", "--video-bar", "101"])).toThrow(/from 0 to 100/);
  });
});

describe("mediaAssetsOf and skippedMedia", () => {
  it("collects the videos and the animated images of a page, and marks skipped ones", () => {
    const record = {
      src: "http://127.0.0.1:1/clip.mp4",
      bytes: { perView: 500, perPlay: 500, perViewBasis: "full-file", browserDependent: false, fullBytesKnown: false },
      widths: { widths: [640], perViewport: [], sources: [], conditions: [], containerDriven: false },
      levers: { info: [] },
    } as unknown as VideoRecord;
    const page = { url: "http://127.0.0.1:1/", videos: [record], images: [] } as unknown as PageResult;
    const assets = mediaAssetsOf(page);
    expect(assets).toEqual([
      expect.objectContaining({ kind: "video", url: "http://127.0.0.1:1/clip.mp4", widths: [640], perView: 500 }),
    ]);
    const skipped = skippedMedia(assets, "quality off");
    expect(skipped.byKey.get(assets[0].key)?.notEncoded).toBe("quality off");
  });
});

describe("attachMediaResults", () => {
  it("sets the estimate, the audio lever and the chained levers, and leaves the rest as the cheap levers had them", () => {
    const url = "http://127.0.0.1:1/clip.mp4";
    const record = {
      src: url,
      bytes: { perView: 800_000, perPlay: 800_000, perViewBasis: "full-file", browserDependent: false, fullBytesKnown: false },
      widths: { widths: [640], perViewport: [], sources: [], conditions: [], containerDriven: false },
      attributes: { muted: true },
      levers: { info: [], codec: { missing: "av1" } },
    } as unknown as VideoRecord;
    const page = { url: "http://127.0.0.1:1/", videos: [record] } as unknown as PageResult;
    const av1 = candidate("av1-mp4", 640, 200_000);
    const results = {
      byKey: new Map([
        [mediaKeyOf("video", "video", url, [640]), { probe: { ...probe, width: 1280, durationS: 8, audio: { codec: "aac", bitrate: 128_000 } }, candidates: [av1], length: 800_000 }],
      ]),
    };
    const out = attachMediaResults(page, results, { quality: true, survey: false });
    const v = out.videos?.[0] as VideoRecord;
    expect(v.estimate).toEqual(av1);
    expect(v.levers.audio?.bytes).toBe(128_000 / 8 * 8);
    expect(v.bytes.fullBytesKnown).toBe(true);
    expect(v.bytes.perPlay).toBe(800_000);
    expect(v.levers.codec).toEqual({ missing: "av1" });
    expect(v.steps).toBeDefined();
    // The chain: no audio 672 000; resized (672 000 x (640/1280)^2 = 168 000) is the lowest stage, so the steps sum to
    // start - 168 000 (attributeLevers never lets a stage grow the file).
    const s = v.steps!;
    expect(s.audio).toBe(128_000);
    expect(s.audio + s.resolution + s.codec + s.quality).toBe(800_000 - 168_000);
  });

  it("leads with AV1 at the target width: the H.264 fallback is the estimate only when AV1 has none", () => {
    const url = "http://127.0.0.1:1/fallback.mp4";
    const record = {
      src: url,
      bytes: { perView: 1000, perPlay: 1000, perViewBasis: "full-file", browserDependent: false, fullBytesKnown: true },
      widths: { widths: [640], perViewport: [], sources: [], conditions: [], containerDriven: false },
      attributes: { muted: true },
      levers: { info: [] },
    } as unknown as VideoRecord;
    const page = { url: "http://127.0.0.1:1/", videos: [record] } as unknown as PageResult;
    const h264 = candidate("h264-mp4", 640, 100);
    const av1 = candidate("av1-mp4", 640, 300);
    const both = attachMediaResults(page, { byKey: new Map([[mediaKeyOf("video", "video", url, [640]), { candidates: [h264, av1] }]]) }, { quality: true, survey: false });
    expect((both.videos?.[0] as VideoRecord).estimate).toEqual(av1);
    const onlyH264 = attachMediaResults(page, { byKey: new Map([[mediaKeyOf("video", "video", url, [640]), { candidates: [h264] }]]) }, { quality: true, survey: false });
    expect((onlyH264.videos?.[0] as VideoRecord).estimate).toEqual(h264);
  });

  it("gives a reason when the phase has no entry for a video: survey, or quality off", () => {
    const record = {
      src: "http://127.0.0.1:1/clip.mp4",
      bytes: { perView: 1, perPlay: 1, perViewBasis: "full-file", browserDependent: false, fullBytesKnown: false },
      widths: { widths: [640], perViewport: [], sources: [], conditions: [], containerDriven: false },
      levers: { info: [] },
    } as unknown as VideoRecord;
    const page = { url: "http://127.0.0.1:1/", videos: [record] } as unknown as PageResult;
    const empty = { byKey: new Map() };
    expect((attachMediaResults(page, empty, { quality: true, survey: true }).videos?.[0] as VideoRecord).notEncoded).toBe("survey");
    expect((attachMediaResults(page, empty, { quality: false, survey: false }).videos?.[0] as VideoRecord).notEncoded).toBe("quality off");
  });
});

describe("runMediaPhase real encode", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const clip = readFileSync(join(FIXTURES, "clip.mp4"));
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== "/clip.mp4") {
        res.writeHead(404).end();
        return;
      }
      const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      if (!match) {
        res.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": clip.length, "Content-Type": "video/mp4", ETag: '"clip"' });
        res.end(req.method === "HEAD" ? undefined : clip);
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : clip.length - 1;
      res.writeHead(206, {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${clip.length}`,
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
        ETag: '"clip"',
      });
      res.end(clip.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    egress = await startEgressProxy({ resolver: systemResolver, allowPrivate: true });
  });

  it("encodes clip.mp4 at 640 px through the egress proxy, and the AV1 sample is smaller than the file", async () => {
    const fileSize = statSync(join(FIXTURES, "clip.mp4")).size;
    const url = `${base}/clip.mp4`;
    const work = await mkdtemp(join(scratch, "real-"));
    const results = await runMediaPhase(
      [video(url, 100_000)],
      options({ workDir: join(work, "w"), proxy: egress?.url, score: makeScorer("ssimulacra2") }),
    );
    const entry = results.byKey.get(mediaKeyOf("video", "video", url, [640]));
    expect(entry?.probe?.width).toBe(1280);
    const av1 = entry?.candidates.find((c) => c.codec === "av1-mp4");
    expect(av1, entry?.notEncoded).toBeDefined();
    expect(av1!.bytes).toBeLessThan(fileSize);
    // The work folder is removed at the end, and nothing else is.
    expect(readdirSync(join(work))).toEqual([]);
  }, 300_000);
});

describe("runScan media phase", () => {
  let server: Server;
  let base = "";
  let gif: Buffer;
  let clip: Buffer;
  let mp4: Buffer;
  let textGif: Buffer;
  beforeAll(async () => {
    textGif = readFileSync(join(FIXTURES, "text.gif"));
    gif = readFileSync(join(FIXTURES, "anim.gif"));
    clip = readFileSync(join(FIXTURES, "clip.webm"));
    mp4 = readFileSync(join(FIXTURES, "clip.mp4"));
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>media</title></head><body>
<video src="/clip.webm" width="320" autoplay muted loop playsinline></video>
<video src="/clip.mp4" width="640" autoplay muted loop playsinline></video>
<img src="/anim.gif" width="320" height="180" alt="">
<img src="/text.gif" width="320" height="180" alt="">
</body></html>`;
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page);
      }
      if (url === "/text.gif") {
        res.writeHead(200, { "content-type": "image/gif", "content-length": textGif.length });
        return res.end(textGif);
      }
      if (url === "/anim.gif") {
        res.writeHead(200, { "content-type": "image/gif", "content-length": gif.length });
        return res.end(gif);
      }
      if (url === "/clip.webm") {
        res.writeHead(200, { "content-type": "video/webm", "content-length": clip.length, "accept-ranges": "bytes" });
        return res.end(clip);
      }
      // No Range support: the media phase reads this one whole and cuts the samples locally.
      if (url === "/clip.mp4") {
        res.writeHead(200, { "content-type": "video/mp4", "content-length": mp4.length });
        return res.end(mp4);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  it("attaches the video estimate (or its reason) and the GIF's animated estimate to the written page", async () => {
    const out = await mkdtemp(join(scratch, "scan-"));
    const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
    const logs: string[] = [];
    const started = performance.now();
    const results = await runScan([`${base}/`], {
      outDir: out,
      cwd: out,
      aggressive: false,
      quality: true,
      viewports: [desktop],
      log: (line) => logs.push(line),
    } as ScanOptions);
    const wallS = (performance.now() - started) / 1000;
    process.stderr.write(`runScan media test wall time: ${wallS.toFixed(1)} s\n`);

    const page = results[0];
    expect(page.status).toBe("ok");
    // A machine with the encoders gets the estimates; one without gets the reason (and the cheap levers stay).
    const caps = await probeFfmpeg();
    const encoders = caps.ffmpeg && caps.vmaf && caps.av1 !== undefined;
    // clip.webm does not pass the bar at any width on this content (its search ends no-passing-quality), so its reason is
    // the answer; clip.mp4 passes, so it must carry the estimate and the audio lever of its muted track.
    const webm = page.videos?.find((v) => v.src.endsWith("/clip.webm"));
    expect(webm).toBeDefined();
    expect(webm!.estimate ?? webm!.notEncoded).toBeDefined();
    if (webm!.estimate === undefined) expect(webm!.notEncoded).toMatch(/^(no-passing-quality|no-encoder|no-vmaf|time-limit|score-failed|probe-failed|could not read the video)$/);
    const video = page.videos?.find((v) => v.src.endsWith("/clip.mp4"));
    expect(video).toBeDefined();
    if (encoders) expect(video!.estimate, video!.notEncoded).toBeDefined();
    else expect(video!.notEncoded).toBeTypeOf("string");
    expect(video!.estimate ?? video!.notEncoded).toBeDefined();
    if (video!.estimate !== undefined) {
      expect(video!.estimate.bytes).toBeLessThan(video!.bytes.perPlay);
      expect(video!.levers.audio?.bytes).toBeGreaterThan(0);
    }

    // text.gif passes the bar (the GIF encode tests use it), so it must carry the animated estimate. anim.gif may not pass
    // the bar on its content, and then its reason is the answer.
    const animated = page.images?.filter((image) => image.fix.animated !== undefined) ?? [];
    expect(animated).toHaveLength(2);
    const textRecord = animated.find((image) => image.current.src?.endsWith("/text.gif"));
    const animRecord = animated.find((image) => image.current.src?.endsWith("/anim.gif"));
    expect(textRecord, "text.gif record").toBeDefined();
    expect(animRecord, "anim.gif record").toBeDefined();
    if (encoders) expect(textRecord!.fix.animated!.estimate, textRecord!.fix.animated!.notEncoded).toBeDefined();
    expect(textRecord!.fix.animated!.estimate ?? textRecord!.fix.animated!.notEncoded).toBeDefined();
    expect(animRecord!.fix.animated!.estimate ?? animRecord!.fix.animated!.notEncoded).toBeDefined();
    const gifRecord = textRecord!;
    process.stderr.write(`runScan media: mp4 ${video!.estimate ? `est ${video!.estimate.bytes} B at ${video!.estimate.width}px` : `not encoded: ${video!.notEncoded}`}; webm ${webm!.estimate ? `est ${webm!.estimate.bytes} B` : `not encoded: ${webm!.notEncoded}`}; gif ${gifRecord!.fix.animated!.estimate ? `est ${gifRecord!.fix.animated!.estimate.length} candidates` : `not encoded: ${gifRecord!.fix.animated!.notEncoded}`}\n`);

    // The image bytes are the GIFs alone: the videos' bytes are not in the image totals.
    const imageBytes = page.perViewport.desktop.imageBytes;
    const gifs = gif.length + textGif.length;
    expect(imageBytes).toBeGreaterThanOrEqual(gifs);
    expect(imageBytes).toBeLessThan(gifs + Math.min(clip.length, mp4.length));
    const onDisk = JSON.parse(await readFile(join(out, readdirSync(out).find((name) => name.endsWith(".json"))!), "utf8")) as PageResult;
    expect(onDisk.complete).toBe(true);
    expect(logs.some((line) => line.startsWith("media: "))).toBe(true);
    expect(readdirSync(out)).not.toContain(".media-work");
  }, 600_000);
});
