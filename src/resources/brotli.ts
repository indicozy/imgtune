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

/**
 * Brotli size of a buffer at quality 5: about 20 times faster than quality 11, for the analyzers that compare two sizes of
 * the same kind (the rounded and the served JSON), where the ratio is what the finding reports. Always an estimate.
 */
export function brotliSizeFast(buf: Buffer): { bytes: number; estimate: true } {
  const out = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
  return { bytes: out.length, estimate: true };
}
