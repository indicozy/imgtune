// Audio analyzer: the audio files a page loads (mp3, wav, ogg, m4a, aac, flac, opus). Each file is probed with the system
// ffprobe; a WAV or FLAC, a lossy file over 128 kbps stereo (64 kbps mono) and a stereo file whose channels are the same
// get a re-encode to Opus. The saving is measured on a 10 s sample, extrapolated to the whole file and labelled an
// estimate. A file that the page downloads on load (autoplay or preload="auto") also gets the lazy-loading fix. Without
// ffmpeg, the analyzer reports the bytes and the extension only. It never throws.

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { probeAudio, probeFfmpeg, runFfmpeg, type AudioProbe } from "../ffmpeg.js";
import { heavyValue } from "./cache.js";
import type { PageContext, ResourceAnalyzer, ResourceFinding, ResourceRecord } from "./types.js";

/** File extensions treated as audio when the content type is not audio/*. */
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);
/** Adaptive-stream pieces (HLS, DASH): out of scope, the bytes of one segment say nothing about the stream. */
const SEGMENT_PATH = /(^|\/)(hls|dash|segments?|chunks?)(\/|$)|\.(ts|m4s|m3u8)$/i;
const LOSSLESS_EXTS = new Set(["wav", "flac", "aif", "aiff"]);
const LOSSLESS_CODEC = /^(pcm_|flac|alac|wavpack|ape|tta)/;

/** The length of the sample the re-encodes are measured on, in seconds. */
export const SAMPLE_S = 10;
/** The re-encode targets: Opus 96 kbps stereo, Opus 64 kbps mono; AAC 128 kbps as the fallback. */
export const OPUS_STEREO_KBPS = 96;
export const OPUS_MONO_KBPS = 64;
export const AAC_KBPS = 128;
export const AAC_MONO_KBPS = 64;
/** Bitrates above which a file is re-encoded: 128 kbps stereo, 64 kbps mono. */
const STEREO_LIMIT_KBPS = 128;
const MONO_LIMIT_KBPS = 64;
/** A re-encode is reported only when it saves this much, absolutely and as a share of the bytes per view. */
export const MIN_SAVING_BYTES = 5 * 1024;
export const MIN_SAVING_SHARE = 0.1;
/** Side-to-mid energy ratio under which a stereo file counts as one channel (-40 dB). */
const NEAR_MONO_RATIO = 1e-4;

const PROBE_TIMEOUT_MS = 10_000;
const ENCODE_TIMEOUT_MS = 30_000;

function hashUrl(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 12);
}

function fileName(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return name || "audio";
  } catch {
    return "audio";
  }
}

function extOf(url: string): string {
  try {
    return extname(new URL(url).pathname).slice(1).toLowerCase();
  } catch {
    return "";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isAudioRecord(r: ResourceRecord): boolean {
  if (SEGMENT_PATH.test(new URL(r.url).pathname)) return false;
  return r.contentType.startsWith("audio/") || AUDIO_EXTS.has(extOf(r.url));
}

/** Encodes the first `sampleS` seconds of `file`; the encoded length in bytes, or undefined when ffmpeg fails. */
async function encodedSampleBytes(
  file: string,
  o: { codec: "opus" | "aac"; mono: boolean; kbps: number; sampleS: number },
): Promise<number | undefined> {
  const codecArgs = o.codec === "opus"
    ? ["-c:a", "libopus", "-b:a", `${o.kbps}k`, "-f", "ogg"]
    : ["-c:a", "aac", "-b:a", `${o.kbps}k`, "-f", "adts"];
  const r = await runFfmpeg(
    ["-i", file, "-t", String(o.sampleS), "-vn", "-ac", o.mono ? "1" : "2", ...codecArgs, "pipe:1"],
    { timeoutMs: ENCODE_TIMEOUT_MS },
  );
  return r.code === 0 && r.stdout.length > 0 ? r.stdout.length : undefined;
}

/** True when the two channels of the first SAMPLE_S seconds are the same signal (the side is 40 dB below the mid). */
async function isNearMono(file: string): Promise<boolean> {
  const r = await runFfmpeg(
    ["-i", file, "-t", String(SAMPLE_S), "-vn", "-ac", "2", "-ar", "16000", "-f", "f32le", "pipe:1"],
    { timeoutMs: ENCODE_TIMEOUT_MS },
  );
  if (r.code !== 0 || r.stdout.length < 8) return false;
  const copy = r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength);
  const samples = new Float32Array(copy, 0, Math.floor(copy.byteLength / 4));
  let mid = 0;
  let side = 0;
  for (let i = 0; i + 1 < samples.length; i += 2) {
    const m = (samples[i] + samples[i + 1]) / 2;
    const s = (samples[i] - samples[i + 1]) / 2;
    mid += m * m;
    side += s * s;
  }
  return mid > 0 && side / mid < NEAR_MONO_RATIO;
}

/** The finding for a file that could not be probed (no ffmpeg, no body, or an unreadable file): bytes only. */
function unprobedFinding(r: ResourceRecord, eager: boolean, selector: string | undefined, reason: string): ResourceFinding {
  const name = fileName(r.url);
  return {
    id: `audio:${hashUrl(r.url)}`,
    kind: "audio",
    url: r.url,
    bytes: r.bytes,
    savedBytes: 0,
    estimate: true,
    title: `audio ${name}: ${formatBytes(r.bytes)} per view${eager ? ", fetched on load" : ""}; ${reason}`,
    fix: ["install ffmpeg to measure the re-encode (ffmpeg enables the full hints)"],
    details: { fetchedBytes: r.bytes, eager, reason },
    ...(selector !== undefined ? { locator: { selector } } : {}),
  };
}

async function analyzeOne(r: ResourceRecord, ctx: PageContext, ffmpegOk: boolean): Promise<ResourceFinding | undefined> {
  const el = ctx.audio.find((a) => a.src === r.url);
  const eager = el !== undefined && (el.autoplay || el.preload === "auto");
  const selector = el?.selector;
  if (!r.body) return unprobedFinding(r, eager, selector, "no body in the scan (over 20 MB or not captured), not probed");
  if (!ffmpegOk) return unprobedFinding(r, eager, selector, "ffmpeg not found, bitrate not measured");

  const dir = await mkdtemp(join(tmpdir(), "imgtune-audio-"));
  try {
    const ext = extOf(r.url) || "bin";
    const file = join(dir, `in.${ext}`);
    await writeFile(file, r.body);
    const probe: AudioProbe | undefined = await probeAudio(file, PROBE_TIMEOUT_MS);
    if (!probe) return unprobedFinding(r, eager, selector, "ffprobe could not read it");

    const name = fileName(r.url);
    const stereo = probe.channels >= 2;
    const bitrate = probe.bitrate ?? (probe.durationS > 0 ? (r.bytes * 8) / probe.durationS : undefined);
    const kbps = bitrate === undefined ? undefined : Math.round(bitrate / 1000);
    // The whole file: the container's bitrate times the length, when both are given (a partial fetch then shows).
    const fullBytes = probe.bitrate !== undefined && probe.durationS > 0
      ? Math.max(r.bytes, Math.round((probe.bitrate * probe.durationS) / 8))
      : r.bytes;
    const perView = eager ? fullBytes : r.bytes;
    const lossless = LOSSLESS_EXTS.has(ext) || LOSSLESS_CODEC.test(probe.codec);
    const overLimit = kbps !== undefined && kbps > (stereo ? STEREO_LIMIT_KBPS : MONO_LIMIT_KBPS);
    const nearMono = stereo ? await isNearMono(file) : false;
    const wantsReencode = lossless || overLimit || nearMono;
    const mono = !stereo || nearMono;
    const kbpsTarget = mono ? OPUS_MONO_KBPS : OPUS_STEREO_KBPS;

    const details: Record<string, unknown> = {
      codec: probe.codec,
      channels: probe.channels,
      sampleRate: probe.sampleRate,
      durationS: probe.durationS,
      bitrateKbps: kbps,
      lossless,
      nearMono,
      fetchedBytes: r.bytes,
      fullBytes,
      eager,
      preload: el?.preload,
      autoplay: el?.autoplay ?? false,
    };

    let encodedFull: number | undefined;
    let aacFull: number | undefined;
    let saved = 0;
    let reportReencode = false;
    if (wantsReencode && probe.durationS > 0 && fullBytes > 0) {
      const sampleS = Math.min(SAMPLE_S, probe.durationS);
      // The sample encodes are heavy and depend on the file and the settings: once per run, and not once the budget is spent
      // (then no re-encode is claimed for the file).
      const sampleKey = `audio:${hashUrl(r.url)}:${r.bytes}:${mono ? 1 : 0}:${sampleS}`;
      const opusSample = await heavyValue(`${sampleKey}:opus:${kbpsTarget}`, () => encodedSampleBytes(file, { codec: "opus", mono, kbps: kbpsTarget, sampleS }));
      const aacKbps = mono ? AAC_MONO_KBPS : AAC_KBPS;
      const aacSample = await heavyValue(`${sampleKey}:aac:${aacKbps}`, () => encodedSampleBytes(file, { codec: "aac", mono, kbps: aacKbps, sampleS }));
      if (opusSample !== undefined) {
        encodedFull = Math.round((opusSample * probe.durationS) / sampleS);
        aacFull = aacSample === undefined ? undefined : Math.round((aacSample * probe.durationS) / sampleS);
        const encodedPerView = Math.round(encodedFull * (perView / fullBytes));
        saved = perView - encodedPerView;
        reportReencode = saved >= Math.max(MIN_SAVING_BYTES, MIN_SAVING_SHARE * perView);
        details.opusFullBytes = encodedFull;
        details.aacFullBytes = aacFull;
        details.targetKbps = kbpsTarget;
        details.targetChannels = mono ? 1 : 2;
      }
    }

    if (!reportReencode && !eager) return undefined;

    const channelsArg = mono ? " -ac 1" : "";
    const fix: string[] = [];
    if (reportReencode && encodedFull !== undefined) {
      fix.push(
        `re-encode to Opus: ffmpeg -i ${name} -vn${channelsArg} -c:a libopus -b:a ${kbpsTarget}k out.webm ` +
          `(expected ~${formatBytes(encodedFull)} for the whole file)`,
      );
      if (aacFull !== undefined) {
        fix.push(
          `or AAC for older Safari: ffmpeg -i ${name} -vn${channelsArg} -c:a aac -b:a ${mono ? AAC_MONO_KBPS : AAC_KBPS}k -movflags +faststart out.m4a ` +
            `(expected ~${formatBytes(aacFull)})`,
        );
      }
    }
    if (eager) {
      fix.push(
        `lazy load: <audio preload="none"> (or drop autoplay) so the file is fetched on play, not on load; ` +
          `saves ${formatBytes(fullBytes)} per view on load`,
      );
    }

    const eagerNote = eager ? ", fetched on load" : "";
    const channelsNote = nearMono ? "stereo with identical channels" : stereo ? "stereo" : "mono";
    const savedBytes = reportReencode ? saved : fullBytes;
    return {
      id: `audio:${hashUrl(r.url)}`,
      kind: "audio",
      url: r.url,
      bytes: perView,
      savedBytes,
      estimate: true,
      title: `audio ${name}: ${probe.codec}${kbps === undefined ? "" : ` ${kbps} kbps`} ${channelsNote}, ` +
        `${formatBytes(perView)} per view${eagerNote}` +
        (reportReencode && encodedFull !== undefined ? `; Opus ${kbpsTarget}k ~${formatBytes(encodedFull)}` : ""),
      fix,
      details,
      ...(selector !== undefined ? { locator: { selector } } : {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const analyzer: ResourceAnalyzer = {
  kind: "audio",
  wants(r: ResourceRecord): boolean {
    try {
      return isAudioRecord(r);
    } catch {
      return false;
    }
  },
  async analyze(records: ResourceRecord[], ctx: PageContext): Promise<ResourceFinding[]> {
    try {
      const caps = await probeFfmpeg();
      const ffmpegOk = caps.ffmpeg && caps.ffprobe;
      const out: ResourceFinding[] = [];
      for (const r of records) {
        try {
          if (!isAudioRecord(r)) continue;
          const f = await analyzeOne(r, ctx, ffmpegOk);
          if (f) out.push(f);
        } catch {
          // One unreadable file does not drop the others.
        }
      }
      return out;
    } catch {
      return [];
    }
  },
};
