// Makes a media file readable by the pipeline and probes it: the shared step of `imgtune image` (media-file.ts) and the scan's
// media phase (media-phase.ts). Kept apart from media-file.ts, which imports the scan's remote.ts helpers, so the phase can use
// it without a cycle. A plain file is probed with ffprobe; an animated WebP is read frame by frame (webp-animation.ts), since
// ffmpeg cannot read it, and its probe is taken from the animation.

import { animationOf, type AnimationInfo } from "./animated.js";
import { probeMedia, type MediaProbe } from "./ffmpeg.js";
import type { ClipSource } from "./media-encode.js";
import { WebpAnimation } from "./webp-animation.js";
import { MAX_INPUT_PIXELS_FFMPEG } from "./media-limits.js";

/** Longest a probe of one file may take, in ms. */
export const PROBE_MS = 30_000;
/** The frame rate of an animated WebP's constant-rate timeline. */
export const WEBP_FPS = 30;

/** A file as the pipeline reads it: its source (a path, or an animated WebP read by frame), and its probe. */
export interface PreparedMedia {
  source: ClipSource;
  probe: MediaProbe;
  animation?: AnimationInfo;
}

/**
 * Makes a file readable and probes it. An animated WebP is opened as a WebpAnimation (no frame is decoded here): its probe is its
 * canvas size and its length. `framePixelLimit` is the per-frame pixel limit (MAX_INPUT_PIXELS_FFMPEG by default; a test lowers
 * it). An APNG reports no length to ffprobe, so its animation length stands in. Throws with the reason when the file cannot be
 * read, or is too large to score.
 */
export async function prepareMedia(
  path: string,
  buffer: Buffer,
  _dir: string,
  framePixelLimit: number = MAX_INPUT_PIXELS_FFMPEG,
  _signal?: AbortSignal,
): Promise<PreparedMedia> {
  const animation = animationOf(buffer);
  if (animation?.format === "webp") {
    const webp = new WebpAnimation(buffer, WEBP_FPS, framePixelLimit);
    const probe: MediaProbe = { durationS: webp.durationMs / 1000, width: webp.width, height: webp.height, fps: WEBP_FPS, videoCodec: "webp" };
    return { source: webp, probe, animation };
  }
  const probe = await probeMedia(path, PROBE_MS);
  if (!probe) throw new Error("ffprobe could not read this file");
  const sized = animation && !(probe.durationS > 0) ? { ...probe, durationS: animation.durationMs / 1000 } : probe;
  return { source: path, probe: sized, animation };
}
