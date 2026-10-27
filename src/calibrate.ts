import sharp from "sharp";
import { encode } from "./encode.js";
import type { SearchDeps } from "./search.js";
import { ssim, type RawImage } from "./ssim.js";

export interface CalibrationSample {
  ref: RawImage;
  format: "avif" | "webp";
  cdnQuality: number;
  cdnBytes: number;
}

/** Nearest local `cdn` quality to `cdnBytes`: coarse scan 20..100 step 5, then refine +-4 step 1 within 1..100. */
async function matchLocalQuality(
  ref: RawImage,
  format: "avif" | "webp",
  cdnBytes: number,
  enc: typeof encode,
): Promise<number> {
  const sizeAt = async (q: number) => (await enc(ref, format, q, "cdn")).bytes;
  let best = 20;
  let bestDiff = Infinity;
  const consider = async (q: number) => {
    const diff = Math.abs((await sizeAt(q)) - cdnBytes);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = q;
    }
  };
  for (let q = 20; q <= 100; q += 5) await consider(q);
  const coarse = best;
  for (let q = Math.max(1, coarse - 4); q <= Math.min(100, coarse + 4); q++) {
    if (q % 5 === 0) continue; // multiples of 5 were covered by the coarse scan
    await consider(q);
  }
  return best;
}

/**
 * Median offset between the CDN's quality and the local `cdn`-profile quality that gives the same byte size.
 * `offset_i = cdnQuality_i - localMatch_i`; the result is the median (average of the middle pair for even n,
 * rounded). Returns `undefined` when there are no samples.
 */
export async function calibrationOffset(
  samples: CalibrationSample[],
  deps: SearchDeps = {},
): Promise<{ offset: number; n: number } | undefined> {
  if (samples.length === 0) return undefined;
  const enc = deps.encode ?? encode;
  const offsets: number[] = [];
  for (const s of samples) {
    const localMatch = await matchLocalQuality(s.ref, s.format, s.cdnBytes, enc);
    offsets.push(s.cdnQuality - localMatch);
  }
  offsets.sort((a, b) => a - b);
  const mid = offsets.length / 2;
  const median = offsets.length % 2 === 1 ? offsets[Math.floor(mid)] : (offsets[mid - 1] + offsets[mid]) / 2;
  return { offset: Math.round(median), n: offsets.length };
}

export interface ConfirmSample {
  src: string;
  ref: RawImage;
  width: number;
}

export interface ConfirmOptions {
  fetchImpl?: typeof fetch;
  percentile?: number;
}

const ACCEPT: Record<"avif" | "webp", string> = {
  avif: "image/avif,image/webp,*/*",
  webp: "image/webp,*/*",
};

interface FormatOutcome {
  passed: boolean;
  ssim?: number;
  bytes?: number;
}

/** Fetch one `/_next/image` variant and score it against the reference. Failures are reported, never thrown. */
async function probeOne(
  baseUrl: string,
  sample: ConfirmSample,
  format: "avif" | "webp",
  q: number,
  threshold: number,
  fetchImpl: typeof fetch,
): Promise<FormatOutcome> {
  const url = `${baseUrl}/_next/image?url=${encodeURIComponent(sample.src)}&w=${sample.width}&q=${q}`;
  try {
    const res = await fetchImpl(url, { headers: { Accept: ACCEPT[format] } });
    if (!res.ok) return { passed: false };
    const body = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith(`image/${format}`)) return { passed: false, bytes: body.length };

    const decodedRaw = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let decoded: RawImage = {
      data: new Uint8ClampedArray(decodedRaw.data.buffer, decodedRaw.data.byteOffset, decodedRaw.data.byteLength),
      width: decodedRaw.info.width,
      height: decodedRaw.info.height,
    };
    if (decoded.width !== sample.ref.width || decoded.height !== sample.ref.height) {
      const resized = await sharp(decodedRaw.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } })
        .resize(sample.ref.width, sample.ref.height, { kernel: "lanczos3", fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true });
      decoded = {
        data: new Uint8ClampedArray(resized.data.buffer, resized.data.byteOffset, resized.data.byteLength),
        width: resized.info.width,
        height: resized.info.height,
      };
    }
    const score = ssim(sample.ref, decoded);
    return { passed: score >= threshold, ssim: score, bytes: body.length };
  } catch {
    return { passed: false };
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Confirm a `next-default` quality against the live optimizer. For each sample and each format (AVIF, then WebP)
 * the `/_next/image` variant is fetched, decoded and scored with SSIM against the local reference. A format passes
 * when the share of passing samples is at least `percentile` (default 0.95); confirmed requires both formats to pass.
 * Failed fetches and wrong content types count as failing samples and are left out of the medians. With no samples
 * the result is not confirmed and the medians are 0.
 */
export async function confirmNextDefault(
  baseUrl: string,
  samples: ConfirmSample[],
  q: number,
  threshold: number,
  opts: ConfirmOptions = {},
): Promise<{ confirmed: boolean; ssim: { avif: number; webp: number }; bytes: { avif: number; webp: number } }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const percentile = opts.percentile ?? 0.95;
  const formats = ["avif", "webp"] as const;
  const result = {
    confirmed: samples.length > 0,
    ssim: { avif: 0, webp: 0 },
    bytes: { avif: 0, webp: 0 },
  };

  for (const format of formats) {
    const outcomes: FormatOutcome[] = [];
    for (const sample of samples) {
      outcomes.push(await probeOne(baseUrl, sample, format, q, threshold, fetchImpl));
    }
    const passing = outcomes.filter((o) => o.passed).length;
    if (samples.length === 0 || passing / samples.length < percentile) result.confirmed = false;
    result.ssim[format] = median(outcomes.flatMap((o) => (o.ssim === undefined ? [] : [o.ssim])));
    result.bytes[format] = median(outcomes.flatMap((o) => (o.bytes === undefined ? [] : [o.bytes])));
  }
  return result;
}

/**
 * Insert `q` into the `images.qualities: [ ... ]` literal of a next.config source text.
 * The array stays sorted with no duplicates; the rest of the text, and the array's own layout (single or multi-line,
 * trailing comma), is kept. Returns `undefined` when there is no literal array of integers.
 */
export function withQuality(configText: string, q: number): string | undefined {
  const match = /\bqualities\s*:\s*\[([^\]]*)\]/.exec(configText);
  if (!match) return undefined;
  const inner = match[1];
  if (!/^[\s\d,]*$/.test(inner)) return undefined;

  const numbers = [...inner.matchAll(/\d+/g)].map((m) => ({ value: Number(m[0]), index: m.index ?? 0 }));
  let newInner: string;
  if (numbers.length === 0) {
    newInner = String(q);
  } else if (numbers.some((n) => n.value === q)) {
    return configText;
  } else {
    const next = numbers.find((n) => n.value > q);
    if (next) {
      const leading = /\s*$/.exec(inner.slice(0, next.index))?.[0] || " ";
      newInner = inner.slice(0, next.index) + `${q},${leading}` + inner.slice(next.index);
    } else {
      const last = numbers[numbers.length - 1];
      const leading = /\s*$/.exec(inner.slice(0, last.index))?.[0] || " ";
      const end = last.index + String(last.value).length;
      newInner = inner.slice(0, end) + `,${leading}${q}` + inner.slice(end);
    }
  }
  const innerStart = match.index + match[0].length - 1 - inner.length;
  return configText.slice(0, innerStart) + newInner + configText.slice(innerStart + inner.length);
}
