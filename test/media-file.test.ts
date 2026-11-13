// Single-file media (src/media-file.ts) and the animated WebP timeline cap (src/media-encode.ts): a timeline over the cap is
// refused before its frames are built, as "too large to score" in the report and as reason too-large in the search.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeFfmpeg, probeMedia } from "../src/ffmpeg.js";
import { candidateCodecOf, prepareMedia, renderAnimated, renderReference, type AnimatedFileResult, type ReferenceFileResult } from "../src/media-file.js";
import { searchQuality, type CandidateResult } from "../src/media-encode.js";
import { makeScorer } from "../src/metric.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/media/", import.meta.url));
const fixture = (name: string): string => join(FIXTURES, name);
/** A per-frame pixel limit no frame of the animated fixtures fits in (anim.webp frames are 320x180). */
const TINY_LIMIT = 1000;

let scratch = "";
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "imgtune-media-file-test-"));
});
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("animated WebP: the limits and the search", () => {
  it("refuses a frame over 40 Mpx before any decode, as too large to score", async () => {
    // A 9000 x 5000 frame is 45 Mpx: refused from the probe, with no sample read and no encode.
    const probe = { durationS: 2, width: 9000, height: 5000, fps: 30, videoCodec: "gif" as const };
    const outcome = await searchQuality([], probe, "animated-avif", 9000, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now() + 60_000,
      caps: { ffmpeg: true, ffprobe: true, vmaf: true, av1: "libsvtav1", x264: true, webpAnim: true, avifMuxer: true, av1Nvenc: false, h264Nvenc: false },
      score: makeScorer("ssimulacra2"),
      workDir: join(scratch, "pixels"),
    });
    expect(outcome).toEqual({ ok: false, reason: "too-large" });
  });

  it("returns aborted at once when the run's signal is already aborted, and writes nothing", async () => {
    const caps = await probeFfmpeg();
    const probe = (await probeMedia(fixture("anim.gif"), 10_000))!;
    const controller = new AbortController();
    controller.abort();
    const outcome = await searchQuality([], probe, "animated-avif", probe.width, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now() + 120_000,
      caps,
      score: makeScorer("ssimulacra2"),
      workDir: join(scratch, "aborted"),
      signal: controller.signal,
    });
    expect(outcome).toEqual({ ok: false, reason: "aborted" });
  });

  it("makes the single-file mode print the error for a frame over the per-frame limit (prepareMedia)", async () => {
    const buffer = await readFile(fixture("anim.webp"));
    await expect(prepareMedia(fixture("anim.webp"), buffer, join(scratch, "prep-big"), TINY_LIMIT)).rejects.toThrow(/^too large to score/);
  });
});

/** One candidate result, with the fields the report prints. */
function candidate(codec: CandidateResult["codec"], quality: number, stillBar: number): CandidateResult {
  return {
    codec,
    width: 320,
    quality,
    sampleBytes: 1000,
    sampleSeconds: 2,
    bytes: 39 * 1024,
    vmaf: 93.4,
    still: stillBar + 5,
    stillBar,
    vmafBar: 93,
    estimate: true,
    audio: false,
    measuredBytes: 39 * 1024,
    encoder: "cpu",
  };
}

/** An animated result with the given candidates, for the text only (no encode). */
function animatedResult(candidates: AnimatedFileResult["candidates"]): AnimatedFileResult {
  return {
    label: "anim.gif",
    evidence: "media-file",
    imgtuneVersion: "test",
    kind: "animated",
    current: { format: "gif", width: 320, height: 180, bytes: 175 * 1024, seconds: 3, frames: 30 },
    width: { source: "file", px: 320 },
    bars: { vmaf: 93, stillRequested: 65 },
    candidates,
  };
}

describe("renderAnimated: the bars line and the too-large reason", () => {
  it("says the still bar is lowered only when a candidate's bar is below the requested one", () => {
    const lowered = renderAnimated(animatedResult([{ codec: "animated-avif", outcome: { ok: true, best: candidate("animated-avif", 40, 29.5), tried: 3 } }]));
    expect(lowered).toMatch(/bars VMAF 93, still p10 65 \(lowered for a source whose own best encode scores low\)/);
    const kept = renderAnimated(animatedResult([{ codec: "animated-avif", outcome: { ok: true, best: candidate("animated-avif", 40, 65), tried: 3 } }]));
    expect(kept).toMatch(/bars VMAF 93, still p10 65\n/);
    expect(kept).not.toMatch(/lowered/);
  });

  it("prints too-large as too large to score, not as the bare reason", () => {
    const text = renderAnimated(animatedResult([{ codec: "animated-webp", outcome: { ok: false, reason: "too-large" } }]));
    expect(text).toMatch(/animated-webp\s+no quality meets the bars \(too large to score\)/);
  });
});

describe("renderReference: the ceiling is named for a candidate of another codec", () => {
  const reference = (format: string): ReferenceFileResult => ({
    label: "clip-h264.mp4",
    evidence: "media-reference",
    imgtuneVersion: "test",
    current: { format, width: 640, height: 360, bytes: 100 * 1024 },
    reference: { label: "clip.mp4", width: 640, height: 360, seconds: 8 },
    width: 640,
    vmaf: 95.3,
    vmafBar: 93,
    still: 81.5,
    stillBar: 65,
    stillBarRequested: 65,
    ceiling: 75.4,
    samples: 3,
    pass: true,
  });

  it("names the AV1 CRF 20 ceiling for a candidate whose codec has no ceiling of its own", () => {
    expect(renderReference(reference("h264"))).toMatch(/still bar ceiling: the reference's best AV1 CRF 20 encode \(candidate h264\)/);
  });

  it("names the ceiling of the candidate's own codec, at its best quality", () => {
    const h264 = { ...reference("h264"), ceilingCodec: "h264-mp4" as const };
    expect(renderReference(h264)).toMatch(/still bar ceiling: the reference's best H\.264 CRF 18 encode \(candidate h264\)/);
    const webp = { ...reference("webp"), ceilingCodec: "animated-webp" as const };
    expect(renderReference(webp)).toMatch(/still bar ceiling: the reference's best WebP q 90 encode/);
  });
});

describe("candidateCodecOf: a candidate is judged in its own codec", () => {
  const probe = (videoCodec: string) => ({ durationS: 2, width: 320, height: 180, fps: 30, videoCodec });
  it("takes an animated WebP, H.264 and AV1 as their own codec, and anything else as AV1", () => {
    expect(candidateCodecOf({ animation: { format: "webp", frames: 3, durationMs: 300, loop: 0 }, probe: probe("ffv1") })).toBe("animated-webp");
    expect(candidateCodecOf({ probe: probe("h264") })).toBe("h264-mp4");
    expect(candidateCodecOf({ probe: probe("av1") })).toBe("av1-mp4");
    expect(candidateCodecOf({ probe: probe("vp9") })).toBe("av1-mp4");
  });
});
