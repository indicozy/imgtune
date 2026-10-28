import sharp from "sharp";
import { encode } from "./encode.js";
import type { Scorer } from "./metric.js";
import type { SearchDeps } from "./search.js";
import { ssim, type RawImage } from "./ssim.js";

type Format = "avif" | "webp";
type FormatMap<T> = { [F in Format]?: T };

/** Median of a list (middle pair averaged for even n); 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface CalibrationSample {
  ref: RawImage;
  format: Format;
  cdnQuality: number;
  cdnBytes: number;
}

/** Nearest local `cdn` quality to `cdnBytes`: coarse scan 20..100 step 5, then refine +-4 step 1 within 1..100. */
async function matchLocalQuality(ref: RawImage, format: Format, cdnBytes: number, enc: typeof encode): Promise<number> {
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
 * `offset_i = cdnQuality_i - localMatch_i`; the result is the median, rounded. Returns `undefined` when there are
 * no samples.
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
  return { offset: Math.round(median(offsets)), n: offsets.length };
}

export interface ConfirmSample {
  src: string;
  ref: RawImage;
  width: number;
}

export interface ConfirmOptions {
  fetchImpl?: typeof fetch;
  percentile?: number;
  /** Formats to probe and judge (Next's default `images.formats` is webp only). */
  formats?: Format[];
  /** Scores each variant against its reference; the threshold is on this scale. Production passes the configured metric. */
  score?: Scorer;
}

/** `ok` passes; every other status is a failed sample for that format. */
export type ProbeStatus = "ok" | "ssim-fail" | "http" | "content-type" | "decode" | "fetch";
export type FailureStatus = Exclude<ProbeStatus, "ok">;

const ACCEPT: Record<Format, string> = {
  avif: "image/avif,image/webp,*/*",
  webp: "image/webp,*/*",
};
/** A hung `/_next/image` fails its probe instead of stalling the audit. */
const CONFIRM_TIMEOUT_MS = 30_000;

interface FormatOutcome {
  status: ProbeStatus;
  ssim?: number;
  bytes?: number;
  error?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fetch one `/_next/image` variant and score it against the reference. Failures are reported, never thrown. */
async function probeOne(
  baseUrl: string,
  sample: ConfirmSample,
  format: Format,
  q: number,
  threshold: number,
  fetchImpl: typeof fetch,
  score: Scorer,
): Promise<FormatOutcome> {
  const url = `${baseUrl}/_next/image?url=${encodeURIComponent(sample.src)}&w=${sample.width}&q=${q}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: ACCEPT[format] }, signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS) });
  } catch (e) {
    return { status: "fetch", error: message(e) };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: "http", error: `HTTP ${res.status}` };
  }
  let body: Buffer;
  try {
    body = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { status: "fetch", error: message(e) };
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith(`image/${format}`)) {
    return { status: "content-type", bytes: body.length, error: `content-type ${contentType || "(none)"}` };
  }

  let decoded: RawImage;
  try {
    const raw = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let data = raw.data;
    let width = raw.info.width;
    let height = raw.info.height;
    if (width !== sample.ref.width || height !== sample.ref.height) {
      const resized = await sharp(data, { raw: { width, height, channels: 4 } })
        .resize(sample.ref.width, sample.ref.height, { kernel: "lanczos3", fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true });
      data = resized.data;
      width = resized.info.width;
      height = resized.info.height;
    }
    decoded = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height };
  } catch (e) {
    return { status: "decode", bytes: body.length, error: message(e) };
  }
  const value = await score(sample.ref, decoded);
  return { status: value >= threshold ? "ok" : "ssim-fail", ssim: value, bytes: body.length };
}

/**
 * Confirm a `next-default` quality against the live optimizer. For each sample and each probed format the
 * `/_next/image` variant is fetched, decoded and scored against the local reference. A format passes when
 * the share of passing samples is at least `percentile` (default 0.95); confirmed requires every probed format to
 * pass. Failed samples are counted per status in `failures` and left out of the medians. Formats that are not probed
 * (default: webp only) have undefined fields. With no samples or no formats the result is not confirmed.
 */
export async function confirmNextDefault(
  baseUrl: string,
  samples: ConfirmSample[],
  q: number,
  threshold: number,
  opts: ConfirmOptions = {},
): Promise<{
  confirmed: boolean;
  ssim: FormatMap<number>;
  bytes: FormatMap<number>;
  failures: FormatMap<Record<FailureStatus, number>>;
  errors: FormatMap<string>;
}> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const score = opts.score ?? ssim;
  const percentile = opts.percentile ?? 0.95;
  const formats = [...new Set(opts.formats ?? (["webp"] as Format[]))];
  const result: Awaited<ReturnType<typeof confirmNextDefault>> = {
    confirmed: formats.length > 0 && samples.length > 0,
    ssim: {},
    bytes: {},
    failures: {},
    errors: {},
  };

  for (const format of formats) {
    const outcomes: FormatOutcome[] = [];
    for (const sample of samples) {
      outcomes.push(await probeOne(baseUrl, sample, format, q, threshold, fetchImpl, score));
    }
    const passing = outcomes.filter((o) => o.status === "ok").length;
    if (samples.length === 0 || passing / samples.length < percentile) result.confirmed = false;

    result.ssim[format] = median(outcomes.flatMap((o) => (o.ssim === undefined ? [] : [o.ssim])));
    result.bytes[format] = median(outcomes.flatMap((o) => (o.bytes === undefined ? [] : [o.bytes])));

    const failures: Record<FailureStatus, number> = { "ssim-fail": 0, http: 0, "content-type": 0, decode: 0, fetch: 0 };
    for (const o of outcomes) if (o.status !== "ok") failures[o.status]++;
    result.failures[format] = failures;
    const firstError = outcomes.find((o) => o.error !== undefined)?.error;
    if (firstError !== undefined) result.errors[format] = firstError;
  }
  return result;
}

/** Index of the `}` that closes the `{` at `open`, skipping string literals; -1 if unbalanced. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = stringEnd(text, i);
    } else if (c === "{") {
      depth++;
    } else if (c === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Index of the quote that closes the string literal opened at `i` (text.length if unterminated). */
function stringEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === text[i]) return j;
  }
  return text.length;
}

/**
 * Same length as `body`, with every character inside a nested `{}` or `()` and every string literal replaced by a
 * space. Only direct properties of the object survive, plus the contents of `[...]` arrays at that level.
 */
function directLevel(body: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = Math.min(stringEnd(body, i), body.length - 1);
      out += " ".repeat(end - i + 1);
      i = end;
    } else if (c === "{" || c === "(") {
      depth++;
      out += " ";
    } else if (c === "}" || c === ")") {
      depth--;
      out += " ";
    } else {
      out += depth > 0 ? " " : c;
    }
  }
  return out;
}

/** Insert q into the inner text of a `[ ... ]` integer list, keeping it sorted, unique and laid out as it was. */
function insertSorted(inner: string, q: number): string {
  const numbers = [...inner.matchAll(/\d+/g)].map((m) => ({ value: Number(m[0]), index: m.index ?? 0 }));
  if (numbers.length === 0) return String(q);
  if (numbers.some((n) => n.value === q)) return inner;
  const next = numbers.find((n) => n.value > q);
  if (next) {
    const leading = /\s*$/.exec(inner.slice(0, next.index))?.[0] || " ";
    return inner.slice(0, next.index) + `${q},${leading}` + inner.slice(next.index);
  }
  const last = numbers[numbers.length - 1];
  const leading = /\s*$/.exec(inner.slice(0, last.index))?.[0] || " ";
  const end = last.index + String(last.value).length;
  return inner.slice(0, end) + `,${leading}${q}` + inner.slice(end);
}

/**
 * Insert `q` into the `images: { qualities: [ ... ] }` literal of a next.config source text. Only a `qualities`
 * property that is a direct member of an `images` object is edited (not a top-level one, nor one under
 * `experimental` or inside a nested object). The array stays sorted with no duplicates; the rest of the text and the
 * array's own layout are kept. Returns `undefined` when there is no such literal array of integers.
 */
export function withQuality(configText: string, q: number): string | undefined {
  const opener = /\bimages\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(configText))) {
    const open = m.index + m[0].length - 1;
    const close = matchingBrace(configText, open);
    if (close === -1) return undefined;
    const body = configText.slice(open + 1, close);
    const found = /\bqualities\s*:\s*\[([^\]]*)\]/.exec(directLevel(body));
    if (!found) continue;
    // Read the array from the original text (the masked copy blanks strings), so non-numeric entries are rejected.
    const bodyInnerStart = found.index + found[0].length - 1 - found[1].length;
    const inner = body.slice(bodyInnerStart, bodyInnerStart + found[1].length);
    if (!/^[\s\d,]*$/.test(inner)) return undefined;
    const innerStart = open + 1 + bodyInnerStart;
    return configText.slice(0, innerStart) + insertSorted(inner, q) + configText.slice(innerStart + inner.length);
  }
  return undefined;
}
