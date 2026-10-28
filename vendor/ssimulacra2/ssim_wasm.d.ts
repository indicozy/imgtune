/* tslint:disable */
/* eslint-disable */

/**
 * SSIMULACRA2 score (100 = identical, lower = worse) of `dst` against `src`.
 * Both buffers are RGBA8, `width * height * 4` bytes each, row-major, top-left first.
 */
export function score(width: number, height: number, src: Uint8Array, dst: Uint8Array): number;
