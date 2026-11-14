import { brotliCompressSync, constants } from "node:zlib";

/** Bodies up to this size are compressed at brotli quality 11; bigger ones at quality 9 and the figure is an estimate. */
export const BROTLI_FULL_MAX = 512 * 1024;

/** Brotli size of a buffer, the wire size an origin with brotli would send. */
export function brotliSize(buf: Buffer): { bytes: number; estimate: boolean } {
  const full = buf.length <= BROTLI_FULL_MAX;
  const out = brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: full ? 11 : 9,
      [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  return { bytes: out.length, estimate: !full };
}
