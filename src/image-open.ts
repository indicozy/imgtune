// sharp over a downloaded file, with the pixel limit every scan applies. Kept apart from remote.ts so the image helpers
// (vector-art.ts, the media code) can open a file without importing the scan.

import sharp, { type Sharp } from "sharp";

/** The most input pixels sharp accepts for a downloaded file. */
export const MAX_INPUT_PIXELS = 100_000_000;

/** sharp over a downloaded file, refusing inputs above `limit` pixels. */
export function openImage(buffer: Buffer, limit = MAX_INPUT_PIXELS): Sharp {
  return sharp(buffer, { limitInputPixels: limit });
}
