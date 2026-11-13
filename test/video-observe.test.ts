// The browser reads the <video> elements of a page (readView), and the response listener records the media responses
// without their bodies. Video bytes come from the headers: a video is never buffered.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/browser.js";
import { systemResolver } from "../src/address.js";
import {
  addMediaResponse,
  isOutOfScopeVideo,
  mediaBytesOf,
  observeLoads,
  type MediaRecord,
  type RequestGuard,
  type ViewportObservation,
} from "../src/remote.js";
import { DEFAULT_THIRD_PARTY } from "../src/third-party.js";
import type { Viewport } from "../src/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/media/", import.meta.url));

// Two in-scope videos share clip.webm: the first autoplays, the one below the fold does not load (preload none).
// broken.webm is not media: the browser reports MEDIA_ERR_SRC_NOT_SUPPORTED (errorCode 4).
// `unsupported`: its only <source> is refused before any fetch (an unsupported type), so currentSrc is "". `filtered` plays
// copy.webm, and its HLS <source> child is left out of `sources`.
const UNSUPPORTED_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<video id="unsupported" autoplay muted width="320" height="180"><source src="/clip.webm" type="video/x-unsupported"></video>
<video id="filtered" autoplay muted width="320" height="180"><source src="/copy.webm" type="video/webm"><source src="/stream.m3u8" type="video/webm"></video>
<img alt="still" src="/still.png" width="40" height="40">
</body></html>`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>videos</title></head><body>
<video id="webm" autoplay muted loop playsinline width="320" height="180" src="/clip.webm"></video>
<video id="mp4" autoplay muted loop playsinline width="320" height="180"><source src="/clip.mp4" type="video/mp4"></video>
<div style="height:1000px"></div>
<video id="lazy" preload="none" poster="/still.png" controls width="320" height="180"><source src="/clip.webm" type="video/webm"></video>
<video id="hidden" preload="none" style="display:none" width="320" height="180" src="/clip.webm"></video>
<video id="broken" width="320" height="180" src="/broken.webm"></video>
<video id="blob" autoplay muted width="320" height="180"></video>
<video id="hls" autoplay muted width="320" height="180" src="/stream.m3u8"></video>
<img alt="still" src="/still.png" width="40" height="40">
<script>document.getElementById("blob").src = URL.createObjectURL(new Blob([new Uint8Array(64)], { type: "video/webm" }));</script>
</body></html>`;

/** Serves a file with Range support, as Chromium requests video: 206 with Content-Range for a range request. */
function serveRanged(req: IncomingMessage, res: ServerResponse, body: Buffer, type: string): void {
  res.setHeader("content-type", type);
  res.setHeader("accept-ranges", "bytes");
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (!range || (range[1] === "" && range[2] === "")) {
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
    return;
  }
  // A suffix range ("bytes=-N") is the last N bytes.
  const start = range[1] === "" ? Math.max(0, body.length - Number(range[2])) : Number(range[1]);
  const end = range[2] === "" || range[1] === "" ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
  if (start > end) {
    res.writeHead(416, { "content-range": `bytes */${body.length}` });
    res.end();
    return;
  }
  res.writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
  res.end(body.subarray(start, end + 1));
}

describe("isOutOfScopeVideo", () => {
  it("drops blob, mediastream, HLS and DASH sources and an empty src, with or without a query string", () => {
    for (const src of [
      "blob:http://127.0.0.1:1/7f3a",
      "mediastream:4c1d",
      "http://127.0.0.1:1/stream.m3u8",
      "http://127.0.0.1:1/stream.M3U8?token=1",
      "https://cdn.example/manifest.mpd",
      "https://cdn.example/manifest.mpd?x=1",
      "",
    ]) {
      expect(isOutOfScopeVideo(src), src).toBe(true);
    }
  });

  it("keeps plain file sources, including a name that only contains m3u8 or mpd", () => {
    for (const src of [
      "http://127.0.0.1:1/clip.mp4",
      "https://cdn.example/clip.webm?v=2",
      "https://cdn.example/clip.m3u8.mp4",
      "https://cdn.example/video.mpd/clip.mp4",
    ]) {
      expect(isOutOfScopeVideo(src), src).toBe(false);
    }
  });
});

describe("mediaBytesOf", () => {
  it("takes the Content-Length header", () => {
    expect(mediaBytesOf({ "content-length": "1024" })).toBe(1024);
  });

  it("takes the span of Content-Range when there is no Content-Length", () => {
    expect(mediaBytesOf({ "content-range": "bytes 0-1023/5000" })).toBe(1024);
    expect(mediaBytesOf({ "content-range": "bytes 100-199/*" })).toBe(100);
  });

  it("falls back to Content-Range when Content-Length is not a number", () => {
    expect(mediaBytesOf({ "content-length": "", "content-range": "bytes 0-9/10" })).toBe(10);
  });

  it("is undefined when neither header gives a length", () => {
    expect(mediaBytesOf({})).toBeUndefined();
    expect(mediaBytesOf({ "content-range": "garbage" })).toBeUndefined();
  });
});

describe("addMediaResponse", () => {
  it("sums the bytes of the range responses of one URL and keeps the last status", () => {
    const media = new Map<string, MediaRecord>();
    const url = "http://127.0.0.1:1/clip.webm";
    addMediaResponse(media, { url, status: 206, contentType: "video/webm", headers: { "content-range": "bytes 0-99/1000" } });
    addMediaResponse(media, { url, status: 206, headers: { "content-range": "bytes 100-299/1000" } });
    expect(media.get(url)).toEqual({ url, contentType: "video/webm", bytes: 300, status: 206 });
  });

  it("counts a 200 as well as a 206, and keeps URLs apart", () => {
    const media = new Map<string, MediaRecord>();
    addMediaResponse(media, { url: "http://h/a.mp4", status: 206, headers: { "content-range": "bytes 0-9/100" } });
    addMediaResponse(media, { url: "http://h/a.mp4", status: 200, contentType: "video/mp4", headers: { "content-length": "50" } });
    addMediaResponse(media, { url: "http://h/b.mp4", status: 200, headers: {} });
    expect(media.get("http://h/a.mp4")).toEqual({ url: "http://h/a.mp4", contentType: "video/mp4", bytes: 60, status: 200 });
    expect(media.get("http://h/b.mp4")).toEqual({ url: "http://h/b.mp4", contentType: undefined, bytes: 0, status: 200 });
  });
});

describe("videos and media responses of a page", () => {
  const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
  const guard: RequestGuard = {
    isBlocked: async () => false,
    policy: { resolver: systemResolver, allowPrivate: true },
    thirdParty: DEFAULT_THIRD_PARTY,
  };
  let server: Server | undefined;
  let base = "";
  let browser: Browser | undefined;

  beforeAll(async () => {
    const webm = readFileSync(join(FIXTURES, "clip.webm"));
    const mp4 = readFileSync(join(FIXTURES, "clip.mp4"));
    const still = readFileSync(join(FIXTURES, "still.png"));
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      if (path === "/page.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
      } else if (path === "/copy.webm") {
        serveRanged(req, res, webm, "video/webm");
      } else if (path === "/unsupported.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(UNSUPPORTED_PAGE);
      } else if (path === "/clip.webm") {
        serveRanged(req, res, webm, "video/webm");
      } else if (path === "/clip.mp4") {
        serveRanged(req, res, mp4, "video/mp4");
      } else if (path === "/broken.webm") {
        serveRanged(req, res, Buffer.from("this is not a media file, so the browser cannot decode it"), "video/webm");
      } else if (path === "/still.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": still.length });
        res.end(still);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launchChromium();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const observe = async (light = false): Promise<ViewportObservation> => {
    const [outcome] = await observeLoads(browser as Browser, `${base}/page.html`, [desktop], guard, undefined, undefined, light);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };

  it("observes the in-scope videos in document order, and drops blob and HLS sources", async () => {
    const obs = await observe();
    expect(obs.blocked).toBe(false);
    // Indices are positions among all <video> elements: the blob (4) and HLS (5) videos are dropped, not renumbered.
    expect((obs.videos ?? []).map((v) => v.index)).toEqual([0, 1, 2, 3, 4]);
  }, 90_000);

  it("reads the attributes, the rendered box and the error state of an autoplaying video", async () => {
    const videos = (await observe()).videos ?? [];
    const first = videos.find((v) => v.index === 0);
    const mp4 = videos.find((v) => v.index === 1);
    const broken = videos.find((v) => v.index === 4);
    if (first === undefined || mp4 === undefined || broken === undefined) throw new Error("videos 0, 1 and 4 expected");
    expect(first.currentSrc.endsWith("/clip.webm")).toBe(true);
    expect(first.autoplay && first.muted).toBe(true);
    expect(first.loop).toBe(true);
    expect(first.playsinline).toBe(true);
    expect(first.controls).toBe(false);
    expect(first.renderedWidth).toBe(320);
    expect(first.renderedHeight).toBe(180);
    expect(first.inFirstViewport).toBe(true);
    expect(first.hidden).toBe(false);
    expect(first.locator.selector).toContain("video");
    // The mp4 is read as the page's own file: its source is kept whether or not this browser decodes H.264.
    expect(mp4.currentSrc.endsWith("/clip.mp4")).toBe(true);
    expect(mp4.autoplay && mp4.muted).toBe(true);
    // A source the browser cannot decode reports MEDIA_ERR_SRC_NOT_SUPPORTED.
    expect(broken.currentSrc.endsWith("/broken.webm")).toBe(true);
    expect(broken.errorCode).toBe(4);
  }, 90_000);

  it("reads a preload=none video with its poster, its sources and no bytes, and it is below the first viewport", async () => {
    const lazy = (await observe()).videos?.find((v) => v.index === 2);
    expect(lazy).toBeDefined();
    expect(lazy?.preload).toBe("none");
    expect(lazy?.autoplay).toBe(false);
    expect(lazy?.controls).toBe(true);
    expect(lazy?.poster?.endsWith("/still.png")).toBe(true);
    expect(lazy?.sources).toEqual([{ src: `${base}/clip.webm`, type: "video/webm" }]);
    expect(lazy?.inFirstViewport).toBe(false);
  }, 90_000);

  it("marks a display:none video as hidden", async () => {
    const hidden = (await observe()).videos?.find((v) => v.index === 3);
    expect(hidden?.hidden).toBe(true);
    expect(hidden?.preload).toBe("none");
  }, 90_000);

  it("keeps a video whose sources were all refused, with the first in-scope source as its current source and no bytes", async () => {
    const [outcome] = await observeLoads(browser as Browser, `${base}/unsupported.html`, [desktop], guard);
    if (!outcome.ok) throw outcome.error;
    const obs = outcome.value;
    expect((obs.videos ?? []).map((v) => v.index)).toEqual([0, 1]);
    const video = obs.videos?.[0];
    expect(video?.currentSrc).toBe(`${base}/clip.webm`);
    expect(video?.sources).toEqual([{ src: `${base}/clip.webm`, type: "video/x-unsupported" }]);
    // Nothing was fetched for it: no media response for its file.
    expect(obs.media?.has(`${base}/clip.webm`)).toBe(false);
    // The playing video's HLS <source> child is out of scope, so it is left out of `sources`.
    expect(obs.videos?.[1]?.currentSrc).toBe(`${base}/copy.webm`);
    expect(obs.videos?.[1]?.sources).toEqual([{ src: `${base}/copy.webm`, type: "video/webm" }]);
  }, 90_000);

  it("records the media responses by URL with the bytes from the headers", async () => {
    const obs = await observe();
    const webm = obs.media?.get(`${base}/clip.webm`);
    expect(webm?.bytes).toBeGreaterThan(0);
    expect([200, 206]).toContain(webm?.status);
    expect(webm?.contentType).toBe("video/webm");
    const mp4 = obs.media?.get(`${base}/clip.mp4`);
    expect(mp4?.bytes).toBeGreaterThan(0);
    // The poster is an image: it is not a media response.
    expect(obs.media?.has(`${base}/still.png`)).toBe(false);
  }, 90_000);

  it("collects no videos on a light read", async () => {
    const obs = await observe(true);
    expect(obs.videos).toEqual([]);
  }, 90_000);
});
