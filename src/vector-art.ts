// Vector art: a flat raster (a logo, an icon, a flat illustration) that could be an SVG. The cheap check reads the pixels
// of a still image at 256x256 and calls it flat when a few colours cover it. The proof traces it with vtracer
// (@neplex/vectorizer, an optional dependency), renders the SVG back at the served size and scores it against the served
// image at half size: an antialiased raster is not ground truth, and the traced SVG is sharper at the edges. Nothing here
// throws on a bad image or a missing vectorizer: the caller gets undefined and says why.

import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { brotliCompressSync, constants } from "node:zlib";
import sharp, { type Sharp } from "sharp";
import { openImage } from "./image-open.js";
import { score } from "./metric.js";
import type { RawImage } from "./ssim.js";

/** The vectorizer version the package pins (optionalDependencies). It is part of the cache key of a trace. */
export const VECTORIZER_VERSION = "0.1.0";
/** The fidelity bar: the half-size SSIMULACRA2 of the rendered SVG against the served image. */
export const VECTOR_BAR = 70;
/** The SVG must be at least this much smaller than the served bytes for the hint to be given. */
export const VECTOR_MIN_SAVING = 0.3;
/** The side of the square the flatness is read at (nearest kernel). */
export const FLAT_SIZE = 256;
/** A flat image: the 16 most common colours cover at least this share of its pixels... */
export const FLAT_TOP16_MIN = 0.97;
/** ...and it has at most this many colours (after 5-bit quantisation of each channel). */
export const FLAT_MAX_COLORS = 300;
/**
 * ...and at most this share of its neighbouring pixel pairs differ by a small step (1 to 8 levels in some channel). Soft
 * shading and photo-like gradients are made of small steps; flat art has none, or hard edges.
 */
export const FLAT_SMOOTH_MAX = 0.12;
/** A larger image is not traced at all (decoding and tracing it cost seconds, and the screens it comes from are not art). */
export const VECTOR_MAX_MEGAPIXELS = 5;
/** The trace input: at most this many pixels, and this long side. */
export const TRACE_MAX_PIXELS = 1_000_000;
export const TRACE_MAX_SIDE = 1024;
/** Smaller files are not worth a vector check: their bytes are too few to matter. */
export const VECTOR_MIN_BYTES = 2048;
/** A flat image this big or bigger in bytes gets the "looks like vector art" note when no SVG was traced. */
export const VECTOR_LOOKS_MIN_BYTES = 10 * 1024;
/** The time allowed for one image's trace and fidelity check, in ms. The trace cannot be stopped: a late result is dropped. */
export const VECTOR_CAP_MS = 2000;
/** The most pixels the fidelity check scores: the half-size pair is scaled down to this (both images alike). */
export const SCORE_MAX_PIXELS = 1_000_000;
/** A pixel counts as a bad pixel when its RGB L1 difference from the served image is above this. */
const BAD_PIXEL_L1 = 96;

export interface Flatness {
  /** Distinct colours after 5-bit quantisation of each channel. */
  uniqueColors: number;
  /** Share of pixels covered by the 16 most common colours. */
  top16Share: number;
  /** Share of pixels whose alpha is exactly 0 or 255. */
  alphaBinaryShare: number;
  /** Share of neighbouring pixel pairs (at FLAT_SIZE) that differ by a small step (see FLAT_SMOOTH_MAX). */
  smoothShare: number;
  /** The image's own size in megapixels (as displayed). */
  megapixels: number;
  flat: boolean;
}

export type Vectorizer = typeof import("@neplex/vectorizer");

/** Why a flat image has no traced SVG (see VectorFix.notChecked). */
export type VectorNotChecked =
  | "survey"
  | "quality off"
  | "svg-budget 0"
  | "over --svg-budget"
  | "vectorizer not installed"
  | "timeout"
  | "trace failed";

/**
 * The vector check of one image record (images.ts, fix.vector). Numbers only, so the JSON stays small. The saving is the
 * served bytes per view minus the SVG's, averaged over the viewports as the other savings are. `wins` is set when that
 * saving is the record's claimed one (it is at least the raster fix's), so the hint leads with the SVG.
 */
export interface VectorFix {
  flatness: Flatness;
  svgBytes?: number;
  score?: number;
  badPixelShare?: number;
  passed?: boolean;
  savedPerView?: number;
  wins?: true;
  /** The traced SVG, relative to the project folder (the scan folder's svg/ when it passed). */
  tracedFile?: string;
  notChecked?: VectorNotChecked;
}

/** The raster formats the vector check reads: a still image in one of them. */
const STILL_FORMATS = new Set(["png", "webp", "jpeg", "avif", "gif"]);

/**
 * The flatness of a served file the vector check can read: a still raster of at least VECTOR_MIN_BYTES. Undefined otherwise
 * (an animated file, a format it does not read, or a file too small to matter). Never throws.
 */
export async function stillFlatness(
  response: { bytes: number; buffer?: Buffer },
  served: { format?: string },
  animated: boolean,
): Promise<Flatness | undefined> {
  if (animated || response.buffer === undefined || response.bytes < VECTOR_MIN_BYTES) return undefined;
  if (served.format === undefined || !STILL_FORMATS.has(served.format)) return undefined;
  return flatnessOf(response.buffer);
}

const WHITE = "#ffffff";
const flatMemo = new WeakMap<Buffer, Promise<Flatness | undefined>>();

/**
 * How flat an image is, read at FLAT_SIZE with the nearest kernel. Undefined when the bytes do not decode. Memoised per
 * buffer, so one response is read once.
 */
export function flatnessOf(buffer: Buffer): Promise<Flatness | undefined> {
  let pending = flatMemo.get(buffer);
  if (pending === undefined) {
    pending = computeFlatness(buffer);
    flatMemo.set(buffer, pending);
  }
  return pending;
}

async function computeFlatness(buffer: Buffer): Promise<Flatness | undefined> {
  try {
    const { data, info } = await openImage(buffer)
      .rotate()
      .resize(FLAT_SIZE, FLAT_SIZE, { fit: "inside", kernel: "nearest", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = info.width * info.height;
    if (pixels === 0) return undefined;
    const counts = new Map<number, number>();
    let binary = 0;
    for (let i = 0; i < data.length; i += 4) {
      const key = ((data[i] >> 3) << 15) | ((data[i + 1] >> 3) << 10) | ((data[i + 2] >> 3) << 5) | (data[i + 3] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (data[i + 3] === 0 || data[i + 3] === 255) binary++;
    }
    const top16 = [...counts.values()].sort((a, b) => b - a).slice(0, 16).reduce((sum, n) => sum + n, 0);
    const top16Share = top16 / pixels;
    const uniqueColors = counts.size;
    const smoothShare = smallStepShare(data, info.width, info.height);
    const size = await displayedSize(buffer);
    const megapixels = size === undefined ? 0 : round3((size.width * size.height) / 1e6);
    return {
      uniqueColors,
      top16Share: round3(top16Share),
      alphaBinaryShare: round3(binary / pixels),
      smoothShare: round3(smoothShare),
      megapixels,
      flat: top16Share >= FLAT_TOP16_MIN && uniqueColors <= FLAT_MAX_COLORS && smoothShare <= FLAT_SMOOTH_MAX && megapixels <= VECTOR_MAX_MEGAPIXELS,
    };
  } catch {
    return undefined;
  }
}

/** The share of horizontal and vertical neighbour pairs whose largest channel difference is a small step (1 to 8). */
function smallStepShare(data: Buffer, width: number, height: number): number {
  let small = 0;
  let pairs = 0;
  const diff = (i: number, j: number): number =>
    Math.max(Math.abs(data[i] - data[j]), Math.abs(data[i + 1] - data[j + 1]), Math.abs(data[i + 2] - data[j + 2]));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (x + 1 < width) {
        const d = diff(i, i + 4);
        pairs++;
        if (d >= 1 && d <= 8) small++;
      }
      if (y + 1 < height) {
        const d = diff(i, i + width * 4);
        pairs++;
        if (d >= 1 && d <= 8) small++;
      }
    }
  }
  return pairs === 0 ? 0 : small / pairs;
}

/** The size of an image as it is displayed (orientation applied), from its header. Undefined when it cannot be read. */
export async function displayedSize(buffer: Buffer): Promise<{ width: number; height: number } | undefined> {
  try {
    const meta = await openImage(buffer).metadata();
    if (!meta.width || !meta.height) return undefined;
    const turned = (meta.orientation ?? 1) >= 5;
    return turned ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
  } catch {
    return undefined;
  }
}

let vectorizer: Promise<Vectorizer | undefined> | undefined;

/** The vectorizer module, loaded once. Undefined when the optional dependency is not installed or will not load. Never throws. */
export function loadVectorizer(): Promise<Vectorizer | undefined> {
  vectorizer ??= import("@neplex/vectorizer").then(
    (mod) => (typeof mod.vectorize === "function" && mod.Preset !== undefined ? mod : undefined),
    () => undefined,
  );
  return vectorizer;
}

/**
 * The SVG traced from an image, with the Poster preset, after the trace input is downscaled (traceInput) and the cleanup.
 * Undefined when the vectorizer is missing or the trace fails. Never throws.
 */
export async function traceSvg(buffer: Buffer, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted || (await loadVectorizer()) === undefined) return undefined;
  try {
    const svg = await traceInWorker(await traceInput(buffer), signal);
    return svg === undefined ? undefined : cleanSvg(svg);
  } catch {
    return undefined;
  }
}

/**
 * The vectorizer runs in a worker thread, so an abort really stops it: the native trace does not honour an AbortSignal once it
 * has started, and only ending the thread stops the CPU. A worker is started per trace (a few per run, under the budget).
 * Undefined when the trace fails, the worker dies, or the signal aborts (the worker is then terminated).
 */
const TRACE_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const vectorizer = require(workerData.entry);
vectorizer.vectorize(Buffer.from(workerData.png), vectorizer.Preset.Poster).then(
  (svg) => parentPort.postMessage({ svg }),
  () => parentPort.postMessage({ error: true }),
);
`;

function traceInWorker(png: Buffer, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    const entry = createRequire(import.meta.url).resolve("@neplex/vectorizer");
    const worker = new Worker(TRACE_WORKER, { eval: true, workerData: { entry, png } });
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: { svg?: unknown }) => finish(typeof message.svg === "string" ? message.svg : undefined));
    worker.on("error", () => finish(undefined));
    worker.on("exit", () => finish(undefined));
    if (signal?.aborted) onAbort();
  });
}

/**
 * The image as a PNG for the trace, rotated as displayed and downscaled to at most TRACE_MAX_PIXELS with a long side of at most
 * TRACE_MAX_SIDE: a bigger input costs seconds of tracing for no gain in a vector.
 */
async function traceInput(buffer: Buffer): Promise<Buffer> {
  const size = await displayedSize(buffer);
  if (size === undefined) throw new Error("not an image");
  const { width, height } = size;
  const scale = Math.min(1, Math.sqrt(TRACE_MAX_PIXELS / (width * height)), TRACE_MAX_SIDE / Math.max(width, height));
  let img = openImage(buffer).rotate();
  if (scale < 1) img = img.resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { kernel: "lanczos3" });
  return img.png().toBuffer();
}

/**
 * Light cleanup of a traced SVG: whitespace between tags goes, and the numbers of path data are rounded to one decimal
 * (a 1/10 px change at most). The fidelity is scored on the cleaned SVG, so the rounding is measured, not assumed.
 */
export function cleanSvg(svg: string): string {
  return svg
    .replace(/>\s+</g, "><")
    .replace(/\sd="([^"]*)"/g, (_match, d: string) => ` d="${d.replace(/-?\d+\.\d+/g, (n) => (Math.round(Number(n) * 10) / 10).toFixed(1))}"`)
    .trim();
}

/** The brotli (quality 11) size of an SVG: the bytes it costs on the wire, the same at every DPR. */
export function svgBytes(svg: string): number {
  return brotliCompressSync(Buffer.from(svg, "utf8"), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
}

/**
 * The fidelity of an SVG against the served image it traces. The SVG is rendered back at the served size; the score is
 * SSIMULACRA2 at half size (both images halved with lanczos3, so the raster's antialiasing is not the ground truth; capped
 * at SCORE_MAX_PIXELS for a very large image), and badPixelShare is the share of pixels at that scoring size whose RGB L1
 * difference is over BAD_PIXEL_L1. Both are on white.
 */
export async function svgFidelity(served: Buffer, svg: string): Promise<{ score: number; badPixelShare: number }> {
  const full = await decodeOnWhite(openImage(served).rotate());
  // Scored at half size, and at most SCORE_MAX_PIXELS: a large logo costs seconds at full size, and the scale is the same
  // for both images, so the score is the same kind of number.
  const scale = Math.min(0.5, Math.sqrt(SCORE_MAX_PIXELS / (full.width * full.height)));
  const width = Math.max(1, Math.round(full.width * scale));
  const height = Math.max(1, Math.round(full.height * scale));
  const ref = await resizeTo(full, width, height);
  const test = await drawAt(svg, width, height);
  // ssimulacra2 needs at least 8 px a side: a smaller image is scored at the size it has.
  const value =
    width >= 8 && height >= 8 ? await score("ssimulacra2", ref, test) : await score("ssimulacra2", full, await drawAt(svg, full.width, full.height));
  return { score: value, badPixelShare: badPixelShareOf(ref, test) };
}

/**
 * The SVG drawn at width x height, the same way the served image is brought to that size (lanczos3). When the trace is
 * smaller than the target (a large image, traced from a downscaled input), it is drawn at the target as vectors: resizing a
 * small raster up would blur its edges.
 */
async function drawAt(svg: string, width: number, height: number): Promise<RawImage> {
  const root = /<svg[^>]*?\swidth="([\d.]+)"\s+height="([\d.]+)"/.exec(svg);
  const traced = root === null ? { width, height } : { width: Number(root[1]), height: Number(root[2]) };
  const drawn = traced.width >= width && traced.height >= height ? traced : { width, height };
  const vector = svgSized(svg, root, drawn.width, drawn.height, traced);
  const raster = await decodeOnWhite(sharp(Buffer.from(vector)));
  return drawn.width === width && drawn.height === height ? raster : resizeTo(raster, width, height);
}

/** The SVG with its own size set to width x height, and a viewBox of its traced size (vectors scale without loss). */
function svgSized(svg: string, root: RegExpExecArray | null, width: number, height: number, traced: { width: number; height: number }): string {
  if (root === null) return svg;
  return svg.replace(root[0], root[0].replace(`width="${root[1]}" height="${root[2]}"`, `width="${width}" height="${height}" viewBox="0 0 ${traced.width} ${traced.height}"`));
}

async function decodeOnWhite(img: Sharp): Promise<RawImage> {
  const { data, info } = await img.flatten({ background: WHITE }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

async function resizeTo(img: RawImage, width: number, height: number): Promise<RawImage> {
  const { data, info } = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .resize(width, height, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

function badPixelShareOf(ref: RawImage, test: RawImage): number {
  const pixels = ref.width * ref.height;
  if (pixels === 0) return 0;
  let bad = 0;
  for (let i = 0; i < ref.data.length; i += 4) {
    const d = Math.abs(ref.data[i] - test.data[i]) + Math.abs(ref.data[i + 1] - test.data[i + 1]) + Math.abs(ref.data[i + 2] - test.data[i + 2]);
    if (d > BAD_PIXEL_L1) bad++;
  }
  return round3(bad / pixels);
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
