import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  FFMPEG_MAX_PROCS,
  FfmpegOutputTooLarge,
  FfmpegTimeout,
  inputOptions,
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

describe("inputOptions", () => {
  it("whitelists http(s) and tcp/tls for URLs, adds the proxy only to URLs, and file/pipe for absolute paths", () => {
    expect(inputOptions("http://cdn.example/clip.mp4", "http://127.0.0.1:3128")).toEqual([
      "-protocol_whitelist",
      "http,https,tcp,tls,crypto,httpproxy",
      "-http_proxy",
      "http://127.0.0.1:3128",
    ]);
    expect(inputOptions("/srv/clip.mp4", "http://127.0.0.1:3128")).toEqual(["-protocol_whitelist", "file,pipe"]);
  });

  it("refuses a URL with no egress proxy, with its own message", () => {
    expect(() => inputOptions("https://cdn.example/clip.mp4")).toThrow("URL inputs require the egress proxy");
  });

  it("refuses anything that is neither an absolute path nor an http(s) URL", () => {
    expect(() => inputOptions("clip.mp4")).toThrow();
    expect(() => inputOptions("file:///etc/passwd")).toThrow();
    expect(() => inputOptions("concat:a|b")).toThrow();
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

  it("rejects a URL with no egress proxy", async () => {
    await expect(probeMedia("https://cdn.example/clip.mp4", 10_000)).rejects.toThrow("URL inputs require the egress proxy");
  });

  it("returns undefined for an input that is not an absolute path or an http(s) URL", async () => {
    expect(await probeMedia("file:///etc/passwd", 10_000)).toBeUndefined();
    expect(await probeMedia(fixture("clip.mp4").slice(1), 10_000)).toBeUndefined();
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

  it("keeps the last 64 KB of stderr, decoded without a split character", async () => {
    const bin = join(scratch, "chatty-ffmpeg.sh");
    // 200 KB of two-byte characters, then a marker: the kept tail must end with the marker and hold no U+FFFD.
    writeFileSync(bin, "#!/bin/sh\nyes '\u00e9' | head -c 200001 >&2\necho END-OF-RUN >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    setEnv({ IMGTUNE_FFMPEG: bin });
    const result = await runFfmpeg(["-version"], { timeoutMs: 10_000 });
    expect(result.code).toBe(1);
    expect(result.stderr.endsWith("END-OF-RUN\n")).toBe(true);
    expect(result.stderr).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  it("rejects with FfmpegOutputTooLarge when stdout passes its cap", async () => {
    const error = await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=d=5", "-f", "rawvideo", "-"], {
      timeoutMs: 60_000,
      maxStdoutBytes: 1_000_000,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(FfmpegOutputTooLarge);
    expect((error as FfmpegOutputTooLarge).maxStdoutBytes).toBe(1_000_000);
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

  it("streams the stdin chunks in order and reads them as a pipe, without holding them all", async () => {
    // Two 4x2 gray frames, fed one chunk each, come out unchanged: the process reads its input as it arrives.
    const chunks = [Buffer.alloc(8, 1), Buffer.alloc(8, 2)];
    const result = await runFfmpeg(["-f", "rawvideo", "-pix_fmt", "gray", "-s", "4x2", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
      timeoutMs: 20_000,
      stdin: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual(Buffer.concat(chunks));
  });

  it("rejects with AbortError when the signal aborts a run that reads stdin", async () => {
    const controller = new AbortController();
    const pending = runFfmpeg(["-f", "rawvideo", "-pix_fmt", "gray", "-s", "4x2", "-i", "pipe:0", "-f", "null", "-"], {
      timeoutMs: 60_000,
      signal: controller.signal,
      stdin: async function* () {
        // Never ends: the run is stopped by the signal, not by its input.
        for (;;) {
          yield Buffer.alloc(8, 3);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
    });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("process slots", () => {
  /** A fake ffmpeg that logs its start and end to `log` and sleeps `seconds` in between. */
  function fakeBinary(name: string, seconds: string, log: string): string {
    const bin = join(scratch, name);
    writeFileSync(bin, `#!/bin/sh\necho start >> "${log}"\nsleep ${seconds}\necho end >> "${log}"\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  /** The most runs alive at once, from a log of start and end lines in the order they happened. */
  function maxAlive(log: string): { max: number; starts: number } {
    let alive = 0;
    let max = 0;
    let starts = 0;
    for (const line of readFileSync(log, "utf8").split("\n")) {
      if (line === "start") {
        starts++;
        alive++;
        max = Math.max(max, alive);
      } else if (line === "end") {
        alive--;
      }
    }
    return { max, starts };
  }

  it("never runs more than FFMPEG_MAX_PROCS processes at once, and does run that many", async () => {
    const log = join(scratch, "slots-six.log");
    writeFileSync(log, "");
    setEnv({ IMGTUNE_FFMPEG: fakeBinary("slots-six.sh", "0.3", log) });
    const runs = Array.from({ length: 6 }, () => runFfmpeg(["-version"], { timeoutMs: 20_000 }));
    const results = await Promise.all(runs);
    expect(results.every((r) => r.code === 0)).toBe(true);
    const { max, starts } = maxAlive(log);
    expect(starts).toBe(6);
    expect(FFMPEG_MAX_PROCS).toBe(4);
    expect(max).toBe(FFMPEG_MAX_PROCS);
  });

  it("counts the timeout from the call, so a run queued past its timeout rejects and never starts", async () => {
    const log = join(scratch, "slots-queued.log");
    writeFileSync(log, "");
    setEnv({ IMGTUNE_FFMPEG: fakeBinary("slots-blockers.sh", "1", log) });
    const blockers = Array.from({ length: FFMPEG_MAX_PROCS }, () => runFfmpeg(["-version"], { timeoutMs: 20_000 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    const queued = await runFfmpeg(["-version"], { timeoutMs: 200 }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(queued).toBeInstanceOf(FfmpegTimeout);
    expect(Date.now() - started).toBeLessThan(900);
    await Promise.all(blockers);
    // Only the blockers ever started: the queued run was removed from the queue when its timeout fired.
    expect(maxAlive(log).starts).toBe(FFMPEG_MAX_PROCS);
  });
});
