// The size limits of the media pipeline, and the errors a refused input raises. Kept apart from media-encode.ts so the
// WebP reader (webp-animation.ts) can use them without importing the encoder.

/**
 * The most pixels a frame may have before ffmpeg or the decoder is asked to read it (8K is about 33 Mpx): above this the input
 * is refused before any decode or encode, since ffmpeg would allocate frames of several GB. Reported as "too-large".
 */
export const MAX_INPUT_PIXELS_FFMPEG = 40_000_000;

/** The most frames one 2-second sample window may hold (a sanity cap: at 30 fps a window is 60 frames). */
export const MAX_WINDOW_FRAMES = 2000;

/** A frame over the pixel limit: refused before any decode or encode. Its message starts "too large to score". */
export class PixelsTooLarge extends Error {
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number, limit: number = MAX_INPUT_PIXELS_FFMPEG) {
    super(
      `too large to score: a frame of ${width}x${height} has ${(width * height / 1_000_000).toFixed(1)} Mpx, above the ${limit / 1_000_000} Mpx limit`,
    );
    this.name = "PixelsTooLarge";
    this.width = width;
    this.height = height;
  }
}

/** A sample window with more frames than MAX_WINDOW_FRAMES. Its message starts "too large to score". */
export class WindowTooLarge extends Error {
  constructor(frames: number) {
    super(`too large to score: a 2 s sample window holds ${frames} frames (the cap is ${MAX_WINDOW_FRAMES})`);
    this.name = "WindowTooLarge";
  }
}

/** True for the refusals above: the input is too large to score, so the search reports "too-large". */
export function isTooLarge(err: unknown): boolean {
  return err instanceof PixelsTooLarge || err instanceof WindowTooLarge;
}
