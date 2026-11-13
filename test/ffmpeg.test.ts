import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  FfmpegTimeout,
  probeFfmpeg,
  probeMedia,
  resetFfmpegProbe,
  runFfmpeg,
} from "../src/ffmpeg.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "media");
const fixture = (name: string): string => join(FIXTURES, name);

// Scratch directory for a fake ffmpeg/ffprobe, removed in afterAll.
const scratch = mkdtempSync(join(tmpdir(), "imgtune-ffmpeg-test-"));

/** Sets env vars for one test; afterEach restores the originals. */
const savedEnv: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  resetFfmpegProbe();
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("probeFfmpeg", () => {
  it("finds every capability on this machine", async () => {
    const caps = await probeFfmpeg();
    expect(caps.ffmpeg && caps.ffprobe && caps.vmaf && caps.x264 && caps.webpAnim && caps.avifMuxer).toBe(true);
    expect(caps.av1).toBe("libsvtav1");
  });

  it("reports everything missing, without throwing, when the binary does not exist", async () => {
    setEnv({ IMGTUNE_FFMPEG: "/nonexistent/ffmpeg", IMGTUNE_FFPROBE: "/nonexistent/ffprobe" });
    resetFfmpegProbe();
    const caps = await probeFfmpeg();
    expect(caps).toEqual({
      ffmpeg: false,
      ffprobe: false,
      vmaf: false,
      av1: undefined,
      x264: false,
      webpAnim: false,
      avifMuxer: false,
    });
  });

  it("matches encoder, filter and muxer names as whole words and picks libaom when SVT-AV1 is absent", async () => {
    const bin = join(scratch, "fake-ffmpeg.sh");
    writeFileSync(join(scratch, "encoders.txt"), [
      "Encoders:",
      " V..... = Video",
      " A..... = Audio",
      " ------",
      " V....D libaom-av1           libaom AV1 encoder (codec av1)",
      " V....D libx264x             not the x264 encoder",
      " V....D libwebp_anim_fake    not the webp animation encoder",
      "",
    ].join("\n"));
    writeFileSync(join(scratch, "filters.txt"), [
      "Filters:",
      " ... libvmafx        VV->V      Not the VMAF filter",
      " ... scale           V->V       Scale the input video size",
      "",
    ].join("\n"));
    writeFileSync(join(scratch, "muxers.txt"), [
      "File formats:",
      " E avifx          AVIF-like muxer",
      " E mp4            MP4 muxer",
      "",
    ].join("\n"));
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *-encoders*) cat "${join(scratch, "encoders.txt")}" ;;`,
        `  *-filters*) cat "${join(scratch, "filters.txt")}" ;;`,
        `  *-muxers*) cat "${join(scratch, "muxers.txt")}" ;;`,
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    setEnv({ IMGTUNE_FFMPEG: bin, IMGTUNE_FFPROBE: bin });
    resetFfmpegProbe();
    const caps = await probeFfmpeg();
    expect(caps.ffmpeg).toBe(true);
    expect(caps.ffprobe).toBe(true);
    expect(caps.av1).toBe("libaom-av1");
    expect(caps.x264).toBe(false);
    expect(caps.webpAnim).toBe(false);
    expect(caps.vmaf).toBe(false);
    expect(caps.avifMuxer).toBe(false);
  });
});

describe("probeMedia", () => {
  it("reads duration, size, frame rate and codecs from an H.264 clip with audio", async () => {
    const media = await probeMedia(fixture("clip.mp4"), 10_000);
    expect(media).toBeDefined();
    expect(media!.durationS).toBeGreaterThan(7.8);
    expect(media!.durationS).toBeLessThan(8.2);
    expect(media!.width).toBe(1280);
    expect(media!.height).toBe(720);
    expect(media!.fps).toBeGreaterThan(29.9);
    expect(media!.fps).toBeLessThan(30.1);
    expect(media!.videoCodec).toBe("h264");
    expect(media!.audio?.codec).toBe("aac");
    expect(media!.bitrate).toBeGreaterThan(0);
  });

  it("reports no audio for a clip without an audio track", async () => {
    const media = await probeMedia(fixture("clip-noaudio.mp4"), 10_000);
    expect(media).toBeDefined();
    expect(media!.audio).toBeUndefined();
    expect(media!.videoCodec).toBe("h264");
  });

  it("returns undefined for a file that does not exist", async () => {
    expect(await probeMedia(fixture("no-such-file.mp4"), 10_000)).toBeUndefined();
  });
});

describe("runFfmpeg", () => {
  it("rejects with FfmpegTimeout and kills the process when the timeout passes", async () => {
    const started = Date.now();
    const error = await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=d=600", "-f", "null", "-"], {
      timeoutMs: 300,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(FfmpegTimeout);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("returns the exit code, stdout and stderr of a finished run", async () => {
    const args = ["-f", "lavfi", "-i", "color=c=red:s=16x16:d=0.1", "-frames:v", "3", "-pix_fmt", "rgb24"];
    const result = await runFfmpeg([...args, "-f", "rawvideo", "-"], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(16 * 16 * 3 * 3);
    expect(typeof result.stderr).toBe("string");
  });

  it("rejects without running when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runFfmpeg(["-f", "lavfi", "-i", "testsrc2=d=600", "-f", "null", "-"], {
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("stops a running process when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runFfmpeg(["-f", "lavfi", "-i", "testsrc2=d=600", "-f", "null", "-"], {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
