import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseAudioProbeJson, probeFfmpeg, resetFfmpegProbe, runFfmpeg } from "../src/ffmpeg.js";
import { analyzer } from "../src/resources/audio.js";
import type { PageContext, ResourceRecord } from "../src/resources/types.js";

// Synthetic audio only: WAV and MP3 files are generated here with the system ffmpeg, so no site content is committed.

/** 16-bit PCM WAV of a sine tone; `identical` puts the same tone on both channels (mono content in a stereo file). */
function wavBytes(seconds: number, opts: { channels?: number; sampleRate?: number; identical?: boolean } = {}): Buffer {
  const channels = opts.channels ?? 2;
  const rate = opts.sampleRate ?? 44100;
  const frames = Math.round(seconds * rate);
  const dataLen = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const freq = opts.identical || c === 0 ? 440 : 660;
      // Two tones with a little noise, so the encoders cannot shrink the file to nothing.
      const noiseSeed = opts.identical ? 0 : c * 104729;
      const v = 0.4 * Math.sin((2 * Math.PI * freq * i) / rate) + 0.05 * (((i * 7919 + noiseSeed) % 1000) / 1000 - 0.5);
      buf.writeInt16LE(Math.round(v * 32767), 44 + (i * channels + c) * 2);
    }
  }
  return buf;
}

const PAGE = "https://example.test/";

function record(url: string, body: Buffer | undefined, contentType: string, bytes = body?.length ?? 0): ResourceRecord {
  return {
    url,
    pageUrl: PAGE,
    viewport: "desktop",
    resourceType: "media",
    contentType,
    bytes,
    status: 200,
    thirdParty: false,
    body,
  };
}

function ctx(audio: PageContext["audio"] = []): PageContext {
  return {
    url: PAGE,
    viewport: { name: "desktop", width: 1440, height: 900, dpr: 1 },
    text: "",
    usedFonts: [],
    fontFaces: [],
    icons: [],
    audio,
    lottie: [],
    models: [],
  };
}

describe("parseAudioProbeJson", () => {
  it("reads codec, channels, rate and the container bitrate", () => {
    const probe = parseAudioProbeJson({
      streams: [{ codec_type: "audio", codec_name: "mp3", channels: 2, sample_rate: "44100", bit_rate: "128000" }],
      format: { duration: "12.5", bit_rate: "129000" },
    });
    expect(probe).toEqual({ codec: "mp3", channels: 2, sampleRate: 44100, bitrate: 129000, durationS: 12.5 });
  });

  it("falls back to the stream bitrate and a zero duration when the format gives neither", () => {
    const probe = parseAudioProbeJson({ streams: [{ codec_type: "audio", codec_name: "opus", channels: 1, bit_rate: "64000" }] });
    expect(probe).toEqual({ codec: "opus", channels: 1, bitrate: 64000, durationS: 0 });
  });

  it("returns undefined without an audio stream", () => {
    expect(parseAudioProbeJson({ streams: [{ codec_type: "video", codec_name: "h264" }] })).toBeUndefined();
    expect(parseAudioProbeJson({})).toBeUndefined();
  });
});

describe("audio wants()", () => {
  it("wants audio content types and audio file extensions", () => {
    expect(analyzer.wants(record("https://cdn.test/a.mp3", undefined, "audio/mpeg"))).toBe(true);
    expect(analyzer.wants(record("https://cdn.test/a.bin", undefined, "audio/wav"))).toBe(true);
    expect(analyzer.wants(record("https://cdn.test/sound.ogg", undefined, "application/octet-stream"))).toBe(true);
  });

  it("skips video, and HLS or DASH segments (adaptive streams are out of scope)", () => {
    expect(analyzer.wants(record("https://cdn.test/a.mp4", undefined, "video/mp4"))).toBe(false);
    expect(analyzer.wants(record("https://cdn.test/hls/x/audio/segments/1.aac", undefined, "audio/aac"))).toBe(false);
    expect(analyzer.wants(record("https://cdn.test/dash/a.m4s", undefined, "audio/mp4"))).toBe(false);
  });
});

describe("audio analyzer", () => {
  let hasFfmpeg = false;
  let mp3At128: Buffer = Buffer.alloc(0);
  let mp3At320: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    resetFfmpegProbe();
    hasFfmpeg = (await probeFfmpeg()).ffmpeg;
    if (!hasFfmpeg) return;
    const encode = async (bitrate: string): Promise<Buffer> => {
      const r = await runFfmpeg(
        [
          "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
          "-f", "lavfi", "-i", "sine=frequency=660:duration=6",
          "-filter_complex", "[0][1]amerge=inputs=2,aformat=channel_layouts=stereo",
          "-c:a", "libmp3lame", "-b:a", bitrate, "-f", "mp3", "pipe:1",
        ],
        { timeoutMs: 60_000 },
      );
      return Buffer.from(r.stdout);
    };
    mp3At128 = await encode("128k");
    mp3At320 = await encode("320k");
  });

  afterAll(() => resetFfmpegProbe());

  it("re-encodes stereo WAV to Opus with a measured, estimated saving", async () => {
    if (!hasFfmpeg) return;
    const body = wavBytes(5);
    const [f] = await analyzer.analyze([record("https://cdn.test/intro.wav", body, "audio/wav")], ctx());
    expect(f).toBeDefined();
    expect(f.kind).toBe("audio");
    expect(f.id).toMatch(/^audio:[0-9a-f]{12}$/);
    expect(f.bytes).toBe(body.length);
    expect(f.savedBytes).toBeGreaterThan(body.length * 0.8);
    expect(f.estimate).toBe(true);
    expect(f.fix.join("\n")).toContain("libopus");
    expect(f.fix.join("\n")).toContain("-b:a 96k");
    expect(f.title).toContain("1411 kbps");
  });

  it("downmixes identical-channel stereo to mono", async () => {
    if (!hasFfmpeg) return;
    const body = wavBytes(5, { identical: true });
    const [f] = await analyzer.analyze([record("https://cdn.test/mono-in-stereo.wav", body, "audio/wav")], ctx());
    expect(f).toBeDefined();
    expect(f.fix.join("\n")).toContain("-ac 1");
    expect(f.fix.join("\n")).toContain("-b:a 64k");
    // The AAC fallback of a mono file is 64 kbps too, not the stereo 128 kbps.
    expect(f.fix.join("\n")).toContain("-ac 1 -c:a aac -b:a 64k");
  });

  it("leaves a 128 kbps stereo MP3 alone", async () => {
    if (!hasFfmpeg) return;
    const out = await analyzer.analyze([record("https://cdn.test/track.mp3", mp3At128, "audio/mpeg")], ctx());
    expect(out).toEqual([]);
  });

  it("re-encodes a 320 kbps stereo MP3", async () => {
    if (!hasFfmpeg) return;
    const [f] = await analyzer.analyze([record("https://cdn.test/track.mp3", mp3At320, "audio/mpeg")], ctx());
    expect(f).toBeDefined();
    expect(f.savedBytes).toBeGreaterThan(0);
    expect(f.fix.join("\n")).toContain("libopus");
  });

  it("reports the eager download of an autoplay or preload=auto file, with the preload fix", async () => {
    if (!hasFfmpeg) return;
    const body = mp3At128;
    const audio = [{ src: "https://cdn.test/track.mp3", autoplay: false, loop: false, preload: "auto", muted: false, selector: "audio" }];
    const [f] = await analyzer.analyze([record("https://cdn.test/track.mp3", body, "audio/mpeg")], ctx(audio));
    expect(f).toBeDefined();
    expect(f.savedBytes).toBeGreaterThan(body.length * 0.98);
    expect(f.savedBytes).toBeLessThan(body.length * 1.02);
    expect(f.fix.join("\n")).toContain('preload="none"');
  });

  it("does not claim a saving for a lazy file that is already fetched lazily", async () => {
    if (!hasFfmpeg) return;
    const audio = [{ src: "https://cdn.test/track.mp3", autoplay: false, loop: false, preload: "none", muted: false, selector: "audio" }];
    const out = await analyzer.analyze([record("https://cdn.test/track.mp3", mp3At128, "audio/mpeg")], ctx(audio));
    expect(out).toEqual([]);
  });

  it("never throws on a body that is not audio", async () => {
    const out = await analyzer.analyze([record("https://cdn.test/x.mp3", Buffer.from("not audio at all"), "audio/mpeg")], ctx());
    expect(Array.isArray(out)).toBe(true);
    expect(out.every((f) => f.savedBytes >= 0)).toBe(true);
  });

  it("without ffmpeg, reports bytes and the extension only, with no saving", async () => {
    const saved = process.env.IMGTUNE_FFMPEG;
    process.env.IMGTUNE_FFMPEG = "/nonexistent/ffmpeg-for-test";
    resetFfmpegProbe();
    try {
      const body = wavBytes(2);
      const out = await analyzer.analyze([record("https://cdn.test/a.wav", body, "audio/wav")], ctx());
      expect(out.length).toBe(1);
      expect(out[0].savedBytes).toBe(0);
      expect(out[0].bytes).toBe(body.length);
      expect(out[0].fix.join("\n")).toContain("ffmpeg");
    } finally {
      if (saved === undefined) delete process.env.IMGTUNE_FFMPEG;
      else process.env.IMGTUNE_FFMPEG = saved;
      resetFfmpegProbe();
    }
  });
});
