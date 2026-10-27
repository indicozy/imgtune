/**
 * Ported from Optiq: <workspace>/optiq-src/repo/src/quality.ts
 * (with `hasTransparentPixels` from <workspace>/optiq-src/repo/src/pixels.ts).
 *
 * Copyright Optiq contributors
 * Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0)
 *
 * Modified for imgtune: `RawImage` is declared locally and also accepts `Uint8Array`; `hasTransparentPixels` is inlined
 * (the rest of pixels.ts is not ported); the public entry points are `ssimDetailed` (Optiq's full result) and `ssim`
 * (the combined number). The SSIM algorithm itself is unchanged.
 */

/** 8-bit RGBA, non-premultiplied, row-major. */
export interface RawImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface SsimResult {
  /**
   * Combined score: weighted (6:1:1) mean of Y, Cb, Cr SSIM over *active* windows; for images with alpha, the
   * minimum over black and white backgrounds.
   */
  ssim: number;
  y: number;
  cb: number;
  cr: number;
  /** Background used for the reported (worst-case) channel scores, if the images have alpha. */
  background?: "black" | "white";
  /** Share of windows that were active (not perfectly flat and identical in both images). */
  activeShare: number;
  /** SSIM of the alpha plane alone, when either image has transparency. Included in `ssim` as a lower bound. */
  alpha?: number;
}

function hasTransparentPixels(img: RawImage): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const WINDOW = 8;
const STRIDE = 4;

function positions(len: number, k: number): number[] {
  const p: number[] = [];
  for (let i = 0; i + k <= len; i += STRIDE) p.push(i);
  if (p.length === 0 || p[p.length - 1] !== len - k) p.push(len - k);
  return p;
}

/**
 * SSIM with uniform 8x8 windows at stride 4 on BT.601 Y, Cb and Cr planes.
 * Pixels are composited onto `bg` (0 or 255) before conversion so that colour under transparent pixels is ignored
 * and alpha errors are visible.
 *
 * Pooling: windows that are perfectly flat and identical in both images (all three channels) score exactly 1 and are
 * excluded from the mean. Otherwise large untouched backgrounds dilute the average and hide artifacts around text and
 * edges in screenshots and illustrations. A codec that adds noise to a flat area makes that window active again.
 */
/** `bg`: composite on this background (0/255), `undefined` = opaque RGB, `"alpha"` = SSIM of the alpha plane only. */
function channelSsim(a: RawImage, b: RawImage, bg: number | "alpha" | undefined): [number, number, number, number] {
  const { width: W, height: H } = a;
  const k = Math.min(WINDOW, W, H);
  const n = k * k;
  const xs = positions(W, k);
  const ys = positions(H, k);
  const da = a.data;
  const db = b.data;
  // Per column, for each of 3 channels: sums of a, b, a², b², ab over a range of rows.
  const stride = 15;
  const accumulate = (y0: number, y1: number, cols: Float64Array) => {
    cols.fill(0);
    for (let y = y0; y < y1; y++) {
      let p = y * W * 4;
      for (let x = 0; x < W; x++, p += 4) {
        if (bg === "alpha") {
          const A1 = da[p + 3], A2 = db[p + 3], c = x * stride;
          cols[c] += A1; cols[c + 1] += A2; cols[c + 2] += A1 * A1; cols[c + 3] += A2 * A2; cols[c + 4] += A1 * A2;
          continue;
        }
        let r1 = da[p], g1 = da[p + 1], b1 = da[p + 2];
        let r2 = db[p], g2 = db[p + 1], b2 = db[p + 2];
        if (bg !== undefined) {
          const a1 = da[p + 3], a2 = db[p + 3];
          if (a1 !== 255) {
            const f = a1 / 255, g = bg * (1 - f);
            r1 = r1 * f + g; g1 = g1 * f + g; b1 = b1 * f + g;
          }
          if (a2 !== 255) {
            const f = a2 / 255, g = bg * (1 - f);
            r2 = r2 * f + g; g2 = g2 * f + g; b2 = b2 * f + g;
          }
        }
        const Y1 = 0.299 * r1 + 0.587 * g1 + 0.114 * b1;
        const U1 = 128 - 0.168736 * r1 - 0.331264 * g1 + 0.5 * b1;
        const V1 = 128 + 0.5 * r1 - 0.418688 * g1 - 0.081312 * b1;
        const Y2 = 0.299 * r2 + 0.587 * g2 + 0.114 * b2;
        const U2 = 128 - 0.168736 * r2 - 0.331264 * g2 + 0.5 * b2;
        const V2 = 128 + 0.5 * r2 - 0.418688 * g2 - 0.081312 * b2;
        const c = x * stride;
        cols[c] += Y1; cols[c + 1] += Y2; cols[c + 2] += Y1 * Y1; cols[c + 3] += Y2 * Y2; cols[c + 4] += Y1 * Y2;
        cols[c + 5] += U1; cols[c + 6] += U2; cols[c + 7] += U1 * U1; cols[c + 8] += U2 * U2; cols[c + 9] += U1 * U2;
        cols[c + 10] += V1; cols[c + 11] += V2; cols[c + 12] += V1 * V1; cols[c + 13] += V2 * V2; cols[c + 14] += V1 * V2;
      }
    }
  };
  // Windows are 8 rows tall at stride 4, so consecutive bands share 4 rows. Sums are kept per 4-row group and a band
  // is the sum of two groups: every pixel is converted and accumulated once instead of twice (audit: ~2x faster).
  const cols = new Float64Array(W * stride);
  let groupA = new Float64Array(W * stride);
  let groupB = new Float64Array(W * stride);
  let groupAIndex = -2; // never equals gi - 1 for gi >= 0
  const totals = [0, 0, 0];
  let windows = 0;
  let active = 0;
  const win = new Float64Array(3);
  for (const y0 of ys) {
    if (k === WINDOW && y0 % STRIDE === 0 && y0 + WINDOW <= H) {
      const gi = y0 / STRIDE;
      if (groupAIndex === gi - 1) {
        // The previous band's second group is this band's first.
        [groupA, groupB] = [groupB, groupA];
      } else {
        accumulate(y0, y0 + STRIDE, groupA);
      }
      accumulate(y0 + STRIDE, y0 + WINDOW, groupB);
      groupAIndex = gi;
      for (let i = 0; i < cols.length; i++) cols[i] = groupA[i] + groupB[i];
    } else {
      accumulate(y0, y0 + k, cols);
      groupAIndex = -2;
    }
    for (const x0 of xs) {
      let isActive = false;
      for (let ch = 0; ch < 3; ch++) {
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        for (let x = x0; x < x0 + k; x++) {
          const c = x * stride + ch * 5;
          sa += cols[c]; sb += cols[c + 1]; saa += cols[c + 2]; sbb += cols[c + 3]; sab += cols[c + 4];
        }
        const ma = sa / n, mb = sb / n;
        const va = Math.max(0, saa / n - ma * ma);
        const vb = Math.max(0, sbb / n - mb * mb);
        const cov = sab / n - ma * mb;
        if (va > 1e-9 || vb > 1e-9 || Math.abs(ma - mb) > 1e-9) isActive = true;
        win[ch] = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      }
      windows++;
      if (isActive) {
        active++;
        totals[0] += win[0];
        totals[1] += win[1];
        totals[2] += win[2];
      }
    }
  }
  if (active === 0) return [1, 1, 1, 0];
  return [totals[0] / active, totals[1] / active, totals[2] / active, active / windows];
}

export function ssimDetailed(reference: RawImage, test: RawImage): SsimResult {
  if (reference.width !== test.width || reference.height !== test.height) {
    throw new Error(`SSIM requires equal dimensions (${reference.width}x${reference.height} vs ${test.width}x${test.height})`);
  }
  const alpha = hasTransparentPixels(reference) || hasTransparentPixels(test);
  const backgrounds: (number | undefined)[] = alpha ? [0, 255] : [undefined];
  let worst: SsimResult | undefined;
  for (const bg of backgrounds) {
    const [y, cb, cr, activeShare] = channelSsim(reference, test, bg);
    const r: SsimResult = { ssim: (6 * y + cb + cr) / 8, y, cb, cr, activeShare };
    if (bg !== undefined) r.background = bg === 0 ? "black" : "white";
    if (!worst || r.ssim < worst.ssim) worst = r;
  }
  if (alpha) {
    // Compositing under-penalises alpha errors (audit: an icon scored 0.994 composited but 0.972 on alpha alone;
    // AVIF alpha errors reached 128/255 at shape edges). The alpha plane's own SSIM is a lower bound.
    const a = channelSsim(reference, test, "alpha")[0];
    worst!.alpha = a;
    if (a < worst!.ssim) worst!.ssim = a;
  }
  return worst!;
}

/** Combined SSIM score (Optiq's `.ssim`) in [-1, 1], 1 for identical images. */
export function ssim(reference: RawImage, test: RawImage): number {
  return ssimDetailed(reference, test).ssim;
}
