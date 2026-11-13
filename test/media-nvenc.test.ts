import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inputOptions, nvencEnv, nvencOptions, probeFfmpeg, probeMedia, runFfmpeg, withGpu, type FfmpegCaps } from "../src/ffmpeg.js";
import {
  NVENC_BYTE_FACTOR,
  NVENC_MIN_WIDTH,
  NvencFailure,
  cpuEquivalentBytes,
  cutSamples,
  encoderArgs,
  searchQuality,
  usesNvenc,
  vmafOf,
  withNvencFallback,
} from "../src/media-encode.js";
import { makeScorer } from "../src/metric.js";
import { estLabel, qualityApprox, videoStatusOf } from "../src/hints.js";
import { parseImageArgs } from "../src/image-file.js";
import { parseScanArgs } from "../src/remote.js";
import type { CandidateResult } from "../src/media-encode.js";
import type { VideoRecord } from "../src/video-analysis.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "media");
const fixture = (name: string): string => join(FIXTURES, name);
const scratch = mkdtempSync(join(tmpdir(), "imgtune-nvenc-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The GPU the NVENC tests use, by CUDA index (PCI bus order): the RTX 4060. */
const GPU = 1;

const caps: FfmpegCaps = {
  ffmpeg: true,
  ffprobe: true,
  vmaf: true,
  av1: "libsvtav1",
  x264: true,
  webpAnim: true,
  avifMuxer: true,
  av1Nvenc: true,
  h264Nvenc: true,
  vmafCuda: false,
};

describe("NVENC arguments", () => {
  it("encodes AV1 with av1_nvenc, the NVENC options and the constant quality, and no CPU encoder", () => {
    const args = encoderArgs("av1-mp4", 30, caps, true);
    expect(args.slice(0, 2)).toEqual(["-c:v", "av1_nvenc"]);
    expect(args).toEqual(expect.arrayContaining(["-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "30", "-b:v", "0", "-gpu", "0"]));
    expect(args).not.toContain("libsvtav1");
    expect(args).not.toContain("-crf");
  });

  it("encodes the animated AVIF's AV1 stream with NVENC too, in the MP4 twin the search scores", () => {
    const args = encoderArgs("animated-avif", 40, caps, true);
    expect(args.slice(0, 2)).toEqual(["-c:v", "av1_nvenc"]);
    expect(args.slice(-2)).toEqual(["-f", "mp4"]);
  });

  it("encodes H.264 with h264_nvenc and the same options", () => {
    const args = encoderArgs("h264-mp4", 24, caps, true);
    expect(args.slice(0, 2)).toEqual(["-c:v", "h264_nvenc"]);
    expect(args).toEqual(expect.arrayContaining(["-cq", "24", "-gpu", "0"]));
    expect(args).not.toContain("libx264");
  });

  it("keeps the CPU arguments unchanged without NVENC (SVT-AV1 CRF, libx264 CRF)", () => {
    expect(encoderArgs("av1-mp4", 30, caps)).toEqual(expect.arrayContaining(["-c:v", "libsvtav1", "-crf", "30"]));
    expect(encoderArgs("h264-mp4", 23, caps)).toEqual(expect.arrayContaining(["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]));
    expect(encoderArgs("av1-mp4", 30, caps, false)).not.toContain("av1_nvenc");
  });

  it("uses libaom's CRF on the CPU when SVT-AV1 is not built in, and NVENC still ignores it", () => {
    const libaom = { ...caps, av1: "libaom-av1" as const, av1Nvenc: false };
    expect(encoderArgs("av1-mp4", 30, libaom)).toEqual(expect.arrayContaining(["-c:v", "libaom-av1", "-crf", "30"]));
    expect(encoderArgs("av1-mp4", 30, { ...libaom, av1Nvenc: true }, true)).toEqual(expect.arrayContaining(["-c:v", "av1_nvenc"]));
  });
});

describe("when a candidate is encoded with NVENC", () => {
  it("needs a GPU, the codec's NVENC encoder, and a width of at least 144 px", () => {
    expect(usesNvenc("av1-mp4", 640, caps, GPU)).toBe(true);
    expect(usesNvenc("av1-mp4", 640, caps, undefined)).toBe(false);
    expect(usesNvenc("h264-mp4", 640, { ...caps, h264Nvenc: false }, GPU)).toBe(false);
    expect(usesNvenc("animated-avif", 640, { ...caps, av1Nvenc: false }, GPU)).toBe(false);
  });

  it("falls back to the CPU below the NVENC minimum width (143 px is CPU, 144 px is NVENC)", () => {
    expect(NVENC_MIN_WIDTH).toBe(144);
    expect(usesNvenc("av1-mp4", NVENC_MIN_WIDTH - 1, caps, GPU)).toBe(false);
    expect(usesNvenc("av1-mp4", NVENC_MIN_WIDTH, caps, GPU)).toBe(true);
  });

  it("never uses NVENC for animated WebP, which has no GPU encoder", () => {
    expect(usesNvenc("animated-webp", 640, caps, GPU)).toBe(false);
  });
});

describe("byte scaling", () => {
  it("reports an NVENC encode's bytes divided by 1.4, and a CPU encode's bytes unchanged", () => {
    expect(NVENC_BYTE_FACTOR).toBe(1.4);
    expect(cpuEquivalentBytes(1400, true)).toBeCloseTo(1000, 9);
    expect(cpuEquivalentBytes(1400, false)).toBe(1400);
  });
});

describe("the CPU fallback of one candidate", () => {
  it("runs with NVENC, and gives the CPU encode when NVENC is not wanted", async () => {
    const calls: boolean[] = [];
    const out = await withNvencFallback(true, async (nvenc) => {
      calls.push(nvenc);
      return "ok";
    });
    expect(out).toEqual({ value: "ok", nvenc: true });
    expect(calls).toEqual([true]);
    expect(await withNvencFallback(false, async (nvenc) => nvenc)).toEqual({ value: false, nvenc: false });
  });

  it("encodes the whole candidate again on the CPU when NVENC fails", async () => {
    const calls: boolean[] = [];
    const out = await withNvencFallback(true, async (nvenc) => {
      calls.push(nvenc);
      if (nvenc) throw new NvencFailure("device lost");
      return "cpu";
    });
    expect(calls).toEqual([true, false]);
    expect(out).toEqual({ value: "cpu", nvenc: false });
  });

  it("lets any other error through, without a CPU retry", async () => {
    await expect(
      withNvencFallback(true, async () => {
        throw new Error("deadline");
      }),
    ).rejects.toThrow("deadline");
  });
});

/** Real NVENC runs. Skipped unless the build lists NVENC and the test encode works on the GPU. */
const nvencCaps = await withGpu(await probeFfmpeg(), GPU);
const score = makeScorer("ssimulacra2");

describe.skipIf(!nvencCaps.av1Nvenc)("NVENC search on clip.mp4 (GPU " + GPU + ")", () => {
  it("passes the bars with NVENC at 640 px, and reports the CPU-equivalent bytes; the times are logged", async () => {
    const probe = (await probeMedia(fixture("clip.mp4"), 10_000))!;
    const dir = join(scratch, "nvenc-640");
    const samples = await cutSamples(fixture("clip.mp4"), probe, dir, Date.now() + 120_000);

    const cpuStart = Date.now();
    const cpu = await searchQuality(samples, probe, "av1-mp4", 640, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now() + 120_000,
      caps: nvencCaps,
      score,
      workDir: join(dir, "cpu"),
    });
    const cpuMs = Date.now() - cpuStart;

    const nvStart = Date.now();
    const nv = await searchQuality(samples, probe, "av1-mp4", 640, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now() + 120_000,
      caps: nvencCaps,
      gpu: GPU,
      score,
      workDir: join(dir, "nvenc"),
    });
    const nvMs = Date.now() - nvStart;
    console.log(`clip.mp4 640 px AV1: CPU search ${cpuMs} ms, NVENC search ${nvMs} ms`);

    expect(cpu.ok && nv.ok).toBe(true);
    if (!cpu.ok || !nv.ok) return;
    expect(nv.best.encoder).toBe("nvenc");
    expect(nv.best.vmaf).toBeGreaterThanOrEqual(93);
    expect(nv.best.still).toBeGreaterThanOrEqual(nv.best.stillBar);
    expect(nv.best.bytes).toBeCloseTo(nv.best.measuredBytes / NVENC_BYTE_FACTOR, 6);
    expect(nv.best.measuredBytes).toBeGreaterThan(nv.best.bytes);
    expect(cpu.best.encoder).toBe("cpu");
    expect(cpu.best.bytes).toBe(cpu.best.measuredBytes);
    // The speed is logged, not asserted: a 2 s sample pays about 0.45 s of CUDA start-up per NVENC process, which the
    // SVT-AV1 encode of the same sample does not, so the NVENC search can be the slower one (see the report).
    expect(nvMs).toBeGreaterThan(0);
    expect(nv.best.bytes).toBeLessThan(statSync(fixture("clip.mp4")).size);
  }, 300_000);

  it("encodes a candidate narrower than 144 px on the CPU, not NVENC", async () => {
    const probe = (await probeMedia(fixture("clip.mp4"), 10_000))!;
    const dir = join(scratch, "narrow");
    const samples = await cutSamples(fixture("clip.mp4"), probe, dir, Date.now() + 120_000);
    const outcome = await searchQuality(samples, probe, "av1-mp4", 136, {
      vmafBar: 93,
      stillBar: 65,
      deadline: Date.now() + 120_000,
      caps: nvencCaps,
      gpu: GPU,
      score,
      workDir: join(dir, "work"),
    });
    if (outcome.ok) expect(outcome.best.encoder).toBe("cpu");
    else expect(["no-passing-quality", "time-limit"]).toContain(outcome.reason);
  }, 300_000);
});

describe("hint labels of an NVENC candidate", () => {
  const cpu: CandidateResult = {
    codec: "av1-mp4",
    width: 640,
    quality: 40,
    sampleBytes: 1000,
    sampleSeconds: 2,
    bytes: 2000,
    measuredBytes: 2000,
    encoder: "cpu",
    vmaf: 95,
    still: 70,
    stillBar: 65,
    vmafBar: 93,
    estimate: true,
    audio: false,
  };
  const nvenc: CandidateResult = { ...cpu, encoder: "nvenc", quality: 30, measuredBytes: 2800, bytes: 2000 };

  it("labels an NVENC estimate as GPU-encoded and scaled, and a CPU estimate as plain", () => {
    expect(estLabel(nvenc)).toBe("est. (GPU-encoded, scaled to a CPU encode ÷1.4)");
    expect(estLabel(cpu)).toBe("est.");
  });

  it("marks an NVENC quality as approximate, and a CPU quality not", () => {
    expect(qualityApprox(nvenc)).toBe(" (approx.)");
    expect(qualityApprox(cpu)).toBe("");
  });

  it("renders the video status with both marks", () => {
    expect(videoStatusOf({ estimate: nvenc } as unknown as VideoRecord)).toBe("av1 CRF 30 (approx.), 640px, 2 KB est. (GPU-encoded, scaled to a CPU encode ÷1.4)");
  });
});

describe("--cpu-encode", () => {
  it("is read by the scan and the image command, and is off by default", () => {
    expect(parseScanArgs(["https://example.com"]).cpuEncode).toBeUndefined();
    expect(parseScanArgs(["https://example.com", "--cpu-encode"]).cpuEncode).toBe(true);
    expect(parseImageArgs(["a.gif"]).cpuEncode).toBeUndefined();
    expect(parseImageArgs(["a.gif", "--cpu-encode"]).cpuEncode).toBe(true);
  });
});

/** libvmaf_cuda agrees with libvmaf. Skipped unless the build lists libvmaf_cuda and the device passes its test. */
describe.skipIf(!nvencCaps.vmafCuda)("libvmaf_cuda against libvmaf (GPU " + GPU + ")", () => {
  it("scores the same clip.mp4 candidate within 0.1 on the CPU and the GPU", async () => {
    const probe = (await probeMedia(fixture("clip.mp4"), 10_000))!;
    const dir = join(scratch, "vmaf-agree");
    const samples = await cutSamples(fixture("clip.mp4"), probe, dir, Date.now() + 120_000);
    const candidate = join(dir, "candidate.mp4");
    const made = await runFfmpeg(
      ["-i", samples[0], "-vf", "scale=640:-2:flags=lanczos", "-c:v", "libsvtav1", "-preset", "10", "-crf", "40", "-svtav1-params", "lp=2", "-pix_fmt", "yuv420p", "-an", "-y", candidate],
      { timeoutMs: 120_000 },
    );
    expect(made.code).toBe(0);
    const fps = probe.fps > 0 ? probe.fps : 30;
    const cpu = await vmafOf([...inputOptions(candidate), "-i", candidate], samples[0], 640, fps, join(dir, "cpu.json"), Date.now() + 120_000);
    const gpu = await vmafOf([...inputOptions(candidate), "-i", candidate], samples[0], 640, fps, join(dir, "gpu.json"), Date.now() + 120_000, undefined, undefined, GPU);
    console.log(`VMAF libvmaf ${cpu.toFixed(4)}, libvmaf_cuda ${gpu.toFixed(4)}`);
    expect(Math.abs(cpu - gpu)).toBeLessThan(0.1);
  }, 240_000);
});

describe.skipIf(!nvencCaps.av1Nvenc)("NVENC output at the bottom of the quality range", () => {
  it("is scored at cq 20: the AV1 level is pinned, so the stream decodes", async () => {
    const probe = (await probeMedia(fixture("clip.mp4"), 10_000))!;
    const dir = join(scratch, "nvenc-cq20");
    const samples = await cutSamples(fixture("clip.mp4"), probe, dir, Date.now() + 120_000);
    const candidate = join(dir, "cq20.mp4");
    const made = await runFfmpeg(
      ["-i", samples[0], "-vf", "scale=640:-2:flags=lanczos", "-c:v", "av1_nvenc", ...nvencOptions(20, true), "-pix_fmt", "yuv420p", "-an", "-y", candidate],
      { timeoutMs: 120_000, env: nvencEnv(GPU) },
    );
    expect(made.code).toBe(0);
    const vmaf = await vmafOf([...inputOptions(candidate), "-i", candidate], samples[0], 640, probe.fps > 0 ? probe.fps : 30, join(dir, "cq20.json"), Date.now() + 120_000, undefined, undefined, GPU);
    expect(vmaf).toBeGreaterThan(90);
  }, 240_000);
});
