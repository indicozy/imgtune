// Makes a media file readable by ffmpeg and probes it: the shared step of `imgtune image` (media-file.ts) and the scan's media
// phase (media-phase.ts). Kept apart from media-file.ts, which imports the scan's remote.ts helpers, so the phase can use it
// without a cycle.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { animationOf, type AnimationInfo } from "./animated.js";
import { probeMedia, runFfmpeg, type MediaProbe } from "./ffmpeg.js";
import { rawTimelineInput, timelineChunks, webpPages } from "./media-encode.js";

/** Longest a probe of one file may take, in ms. */
export const PROBE_MS = 30_000;
/** Frame rate of the lossless copy made from an animated WebP. */
export const WEBP_FPS = 30;

/** A file as ffmpeg reads it: the path to read, and its probe (length, size, frame rate). */
export interface PreparedMedia {
  path: string;
  probe: MediaProbe;
  animation?: AnimationInfo;
}

/**
 * Makes a file readable by ffmpeg and probes it. An animated WebP cannot be read by ffmpeg, so its pages are decoded once and
 * streamed to ffmpeg, which writes them as a lossless FFV1 file at WEBP_FPS in `dir` (the timeline is never built in
 * memory). An APNG reports no length to ffprobe, so its animation length stands in. Throws with the reason when the file
 * cannot be read, or is too large to score (before any decode).
 */
export async function prepareMedia(path: string, buffer: Buffer, dir: string, capBytes?: number, signal?: AbortSignal): Promise<PreparedMedia> {
  const animation = animationOf(buffer);
  if (animation?.format === "webp") {
    const webp = await webpPages(buffer, WEBP_FPS, capBytes);
    await mkdir(dir, { recursive: true });
    const out = join(dir, "webp-frames.mkv");
    const result = await runFfmpeg(
      ["-loglevel", "error", ...rawTimelineInput(webp, WEBP_FPS), "-an", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-y", out],
      { timeoutMs: 4 * PROBE_MS, signal, stdin: () => timelineChunks(webp) },
    );
    if (result.code !== 0) throw new Error("ffmpeg could not write the frames of this animated WebP");
    const probe = await probeMedia(out, PROBE_MS);
    if (!probe) throw new Error("ffprobe could not read the frames of this animated WebP");
    return { path: out, probe, animation };
  }
  const probe = await probeMedia(path, PROBE_MS);
  if (!probe) throw new Error("ffprobe could not read this file");
  const sized = animation && !(probe.durationS > 0) ? { ...probe, durationS: animation.durationMs / 1000 } : probe;
  return { path, probe: sized, animation };
}

