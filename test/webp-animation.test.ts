// An animated WebP read frame by frame (src/webp-animation.ts), and the sample cut and the search that use it. Each frame is
// composed as the WebP spec says (rectangle, blend, dispose), so the frames are checked against sharp's own decoder, which
// composes with libwebp. The per-frame pixel limit is what refuses a frame, never the animation's total.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { probeFfmpeg, probeMedia, runFfmpeg } from "../src/ffmpeg.js";
import { cutSamples, isAbortError, PixelsTooLarge, WindowTooLarge, type CandidateResult } from "../src/media-encode.js";
import { mediaKeyOf, runMediaPhase, type MediaAsset, type MediaOptions } from "../src/media-phase.js";
import { prepareMedia } from "../src/media-prepare.js";
import { cfrIndices, WebpAnimation } from "../src/webp-animation.js";

let scratch = "";
let animated300: Buffer = Buffer.alloc(0);
let animated60: Buffer = Buffer.alloc(0);
let webpOk = false;

/** An animated WebP of `frames` frames of 320x568 test pattern, made by ffmpeg's libwebp_anim (sub-rectangle frames, ALPH). */
async function makeAnimatedWebp(frames: number, name: string): Promise<Buffer> {
  const out = join(scratch, name);
  const result = await runFfmpeg(
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=30", "-frames:v", String(frames), "-c:v", "libwebp_anim", "-loop", "0", "-y", out],
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0) throw new Error(`ffmpeg could not make the test animation: ${result.stderr}`);
  return Buffer.from(await readFile(out));
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "imgtune-webp-anim-"));
  const caps = await probeFfmpeg();
  webpOk = caps.ffmpeg && caps.webpAnim && caps.vmaf;
  if (webpOk) {
    animated60 = await makeAnimatedWebp(60, "a60.webp");
    animated300 = await makeAnimatedWebp(300, "a300.webp");
  }
}, 180_000);
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("animated WebP read frame by frame", () => {
  it("composes each frame as sharp's own decoder does, on a file of sub-rectangle and alpha frames", async () => {
    if (!webpOk) return;
    const anim = new WebpAnimation(animated60, 30);
    expect(anim.pages).toBe(60);
    expect(anim.tickPages.length).toBe(60);
    // Frames read in order, and then one back (a restart): each equals libwebp's composition of that frame.
    for (const page of [0, 1, 2, 17, 40, 59, 3]) {
      const ours = await anim.page(page);
      const { data, info } = await sharp(animated60, { page, pages: 1, animated: true, limitInputPixels: 40_000_000 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(320);
      expect(info.height).toBe(568);
      let worst = 0;
      for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(data[i] - ours.data[i]));
      // Alpha-blended colour is rounded per frame, so a difference of 1 is the rounding, not a wrong composition.
      expect(worst, `frame ${page}`).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it("applies the per-frame pixel limit, not one for the whole animation", async () => {
    if (!webpOk) return;
    // Each frame is 181 760 px; the 60 frames together are 10.9 Mpx. A limit of 500 000 px sits between the two.
    expect(() => new WebpAnimation(animated60, 30, 500_000)).not.toThrow();
    expect(() => new WebpAnimation(animated60, 30, 100_000)).toThrow(PixelsTooLarge);
  });

  it("gives the timeline its ticks at the rate, and a frame on screen at each", () => {
    if (!webpOk) return;
    const anim = new WebpAnimation(animated60, 30);
    expect(anim.tickPages[0]).toBe(0);
    expect(anim.tickPages[anim.tickPages.length - 1]).toBe(anim.pages - 1);
    expect(anim.tickPages.every((p, k) => k === 0 || p >= anim.tickPages[k - 1])).toBe(true);
  });
});

describe("the tick phase of an encoded candidate", () => {
  it("maps tick k to frame k at the tick's middle, even when the frame starts are rounded to whole milliseconds", () => {
    // 30 frames at 30 fps, as ffmpeg writes them in a millisecond timebase: frame i starts at round(i × 1000 / 30).
    const starts = Array.from({ length: 31 }, (_, i) => Math.round((i * 1000) / 30));
    const delays = starts.slice(1).map((s, i) => s - starts[i]);
    // At its start a tick can fall in the frame before (tick 2 is at 66.7 ms, but frame 2 starts at 67 ms).
    expect(cfrIndices(delays, 30, 30, 0).slice(0, 3)).toEqual([0, 1, 1]);
    // At its middle every tick shows its own frame.
    expect(cfrIndices(delays, 30, 30, 0.5)).toEqual(Array.from({ length: 30 }, (_, k) => k));
  });
});

describe("a still WebP (what an encoder writes when its frames are all alike)", () => {
  it("is one frame held for the sample's length, so its candidate has the sample's ticks", async () => {
    if (!webpOk) return;
    const still = join(scratch, "still.webp");
    const made = await runFfmpeg(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=green:size=320x568:rate=30", "-frames:v", "1", "-c:v", "libwebp", "-y", still], { timeoutMs: 60_000 });
    expect(made.code).toBe(0);
    const anim = new WebpAnimation(Buffer.from(await readFile(still)), 30, undefined, 2000);
    expect(anim.pages).toBe(1);
    expect(anim.width).toBe(320);
    expect(anim.height).toBe(568);
    expect(anim.tickPages).toHaveLength(60);
    expect(anim.tickPages.every((p) => p === 0)).toBe(true);
    const frame = await anim.page(0);
    expect(frame.width).toBe(320);
  });
});

describe("the sample cut of an animated WebP source", () => {
  it("cuts its 2-second windows as FFV1 files with the same frame size, without a full decode", async () => {
    if (!webpOk) return;
    const dir = join(scratch, "cut-a60");
    const prepared = await prepareMedia(join(scratch, "a60.webp"), animated60, dir);
    expect(prepared.probe).toMatchObject({ width: 320, height: 568, videoCodec: "webp" });
    const samples = await cutSamples(prepared.source, prepared.probe, join(dir, "samples"), Date.now() + 120_000);
    expect(samples).toHaveLength(1);
    const probe = await probeMedia(samples[0], 30_000);
    expect(probe).toMatchObject({ width: 320, height: 568, videoCodec: "ffv1" });
    expect(probe!.durationS).toBeCloseTo(2, 0);
  }, 120_000);

  it("refuses a 2-second window with more frames than the sanity cap", async () => {
    if (!webpOk) return;
    // At 2 000 ticks a second a 2-second window is 4 000 frames, over the cap of 2 000.
    const prepared = await prepareMedia(join(scratch, "a60.webp"), animated60, join(scratch, "cut-cap"));
    const fast = new WebpAnimation(animated60, 2000);
    await expect(cutSamples(fast, { ...prepared.probe, fps: 2000 }, join(scratch, "cut-cap", "s"), Date.now() + 120_000)).rejects.toBeInstanceOf(WindowTooLarge);
  }, 120_000);
});

describe("a long animated WebP whose all frames together exceed the per-frame limit", () => {
  it("gets encoded candidates: the limit is per frame", async () => {
    if (!webpOk) return;
    // 300 frames of 320x568: 54 Mpx together, each frame 0.18 Mpx. A limit of 500 000 px per frame refuses none of them.
    const url = "http://127.0.0.1:1/long.webp";
    const asset: MediaAsset = {
      key: mediaKeyOf("animated", "img", url, [320]),
      url,
      page: "http://127.0.0.1:1/",
      kind: "animated",
      context: "img",
      widths: [320],
      perView: 100_000,
      perPlay: 100_000,
      buffer: animated300,
    };
    const workDir = join(scratch, "phase-long");
    const opts: MediaOptions = {
      budget: 20,
      timeS: 600,
      vmafBar: 93,
      stillBar: 65,
      survey: false,
      workDir,
      log: () => undefined,
      framePixelLimit: 500_000,
    };
    const results = await runMediaPhase([asset], opts);
    const entry = results.byKey.get(asset.key);
    expect(entry?.notEncoded, entry?.notEncoded).not.toBe("too-large");
    expect(entry?.probe).toMatchObject({ width: 320, height: 568 });
    const candidates: CandidateResult[] = entry?.candidates ?? [];
    expect(candidates.length, entry?.notEncoded).toBeGreaterThan(0);
  }, 600_000);

  it("refuses a frame over the limit as too large, before any sample is cut", async () => {
    if (!webpOk) return;
    const error = await prepareMedia(join(scratch, "a300.webp"), animated300, join(scratch, "refuse"), 100_000).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(PixelsTooLarge);
    expect(isAbortError(error)).toBe(false);
  });
});
