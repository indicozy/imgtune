// `imgtune image <file|url|glob> [--width px] [--dpr 1,2] [--formats avif,webp,jpeg] [--min-score n]`: measures image
// files without a page. Without an original the file is its own reference, so each file must meet a bar against itself
// (SSIMULACRA2 90 by default, visually lossless; --min-score sets another). The lowest quality per format that meets the
// bar is reported. With --width the file is also measured at the width it is needed at (width x dpr). Files are read,
// never written, unless --write names a directory for optimised copies.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import sharp from "sharp";
import { isLocalTarget } from "./address.js";
import { encode, ENCODER_ID, loadReference } from "./encode.js";
import { makeFetcher, MAX_IMAGE_BYTES } from "./fetch.js";
import { gpuNote, parseGpuDevice, startGpuScorer, type GpuScorer } from "./gpu.js";
import { makeScorer, type Scorer } from "./metric.js";
import { minPassingQuality } from "./search.js";
import { cacheScope, CACHE_DIR, ResultCache } from "./result-cache.js";
import type { RawImage } from "./ssim.js";
import { decodeRaw, pixelSize, safeText, SCAN_TOLERANCE, scorerOf, type PageScorer } from "./remote.js";
import { IMGTUNE_VERSION } from "./version.js";

export type ImageFormat = "avif" | "webp" | "jpeg";
const ALL_FORMATS: ImageFormat[] = ["avif", "webp", "jpeg"];
/** Most inputs (files, globs and URLs together) one run measures. */
export const MAX_IMAGE_INPUTS = 200;
/** Most files one glob may match. */
const MAX_GLOB_MATCHES = 1000;
/** Quality the search starts from for every format (the scan's AVIF and WebP start). */
const START_QUALITY = 90;
/** The SSIMULACRA2 bar a file must meet against itself, when --min-score is not given: visually lossless. */
export const DEFAULT_FILE_BAR = 90;

export interface ImageArgs {
  inputs: string[];
  /** The CSS width the image is shown at. Undefined: the file is measured at its own size. */
  width?: number;
  dprs: number[];
  formats: ImageFormat[];
  /** A directory for optimised copies (never overwrites). */
  write?: string;
  /** The SSIMULACRA2 bar, instead of DEFAULT_FILE_BAR. */
  minScore?: number;
  format: "text" | "json";
  /** Score with the GPU scorer on this GPU index (--gpu, --gpu-device). Undefined: the CPU scores. */
  gpu?: { device: number };
  /** --no-cache: the numbers are computed again, and none is kept in .imgtune/cache. */
  noCache?: boolean;
}

const USAGE =
  "usage: imgtune image <file|url|glob> [...] [--width <css px>] [--dpr 1,2] [--formats avif,webp,jpeg] [--min-score <n>] [--write <dir>] [--format text|json] [--gpu] [--gpu-device <n>]";

function positiveNumber(name: string, text: string): number {
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) throw new Error(`${name} needs a number above 0, not ${safeText(text)}`);
  return Number(text);
}

/** The arguments after `image`. Throws with the message the CLI prints. */
export function parseImageArgs(argv: string[]): ImageArgs {
  const args: ImageArgs = { inputs: [], dprs: [1, 2], formats: [...ALL_FORMATS], format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args.inputs.push(arg);
      continue;
    }
    if (arg === "--gpu") {
      args.gpu ??= { device: 0 };
      continue;
    }
    if (arg === "--no-cache") {
      args.noCache = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value (${USAGE})`);
    i++;
    if (arg === "--width") args.width = positiveNumber(arg, value);
    else if (arg === "--dpr") {
      args.dprs = value.split(",").map((d) => positiveNumber("--dpr", d.trim()));
      if (args.dprs.length === 0) throw new Error(`--dpr needs at least one number (${USAGE})`);
    } else if (arg === "--formats") {
      const names = value.split(",").map((f) => f.trim().toLowerCase());
      for (const name of names) {
        if (!ALL_FORMATS.includes(name as ImageFormat)) throw new Error(`--formats is avif, webp or jpeg, not ${safeText(name)}`);
      }
      args.formats = [...new Set(names as ImageFormat[])];
    } else if (arg === "--min-score") {
      const score = Number(value);
      if (!/^\d+(\.\d+)?$/.test(value) || score <= 0 || score > 100) throw new Error(`--min-score needs a number above 0 and at most 100, not ${safeText(value)}`);
      args.minScore = score;
    } else if (arg === "--gpu-device") args.gpu = { device: parseGpuDevice(value) };
    else if (arg === "--write") args.write = value;
    else if (arg === "--format") {
      if (value !== "text" && value !== "json") throw new Error(`--format is text or json, not ${safeText(value)}`);
      args.format = value;
    } else throw new Error(`Unknown option ${safeText(arg)} (${USAGE})`);
  }
  if (args.inputs.length === 0) throw new Error(USAGE);
  return args;
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs: files, URLs and globs
// ---------------------------------------------------------------------------------------------------------------------

/** A glob segment as a regular expression: `*` and `?` stay in one segment, `{a,b}` is a choice. */
function segmentRegExp(segment: string): RegExp {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "{") {
      const close = segment.indexOf("}", i);
      if (close === -1) source += "\\{";
      else {
        source += `(?:${segment
          .slice(i + 1, close)
          .split(",")
          .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = close;
      }
    } else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

const isGlob = (text: string): boolean => /[*?{]/.test(text);

/**
 * The files a glob matches, in path order. `**` walks any depth (node_modules and dot folders are not entered); the
 * matches are files only and at most MAX_GLOB_MATCHES. A pattern without glob characters is returned as it is.
 */
export async function expandGlob(pattern: string, cwd: string): Promise<string[]> {
  if (!isGlob(pattern)) return [resolve(cwd, pattern)];
  const parts = pattern.split("/");
  const firstGlob = parts.findIndex(isGlob);
  const base = resolve(cwd, parts.slice(0, firstGlob).join("/") || ".");
  const rest = parts.slice(firstGlob);
  const found: string[] = [];

  const walk = async (dir: string, index: number): Promise<void> => {
    if (found.length >= MAX_GLOB_MATCHES) return;
    if (index === rest.length) {
      found.push(dir);
      return;
    }
    const segment = rest[index];
    if (segment === "**") {
      await walk(dir, index + 1);
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(join(dir, entry.name), index);
      }
      return;
    }
    if (!isGlob(segment)) {
      const next = join(dir, segment);
      if (index === rest.length - 1) {
        if ((await stat(next).catch(() => undefined))?.isFile()) found.push(next);
      } else await walk(next, index + 1);
      return;
    }
    const matcher = segmentRegExp(segment);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!matcher.test(entry.name)) continue;
      const next = join(dir, entry.name);
      if (index === rest.length - 1) {
        if (entry.isFile()) found.push(next);
      } else if (entry.isDirectory()) await walk(next, index + 1);
    }
  };
  await walk(base, 0);
  return [...new Set(found)].sort();
}

/** One input after expansion: a local file or a URL. */
export interface ImageInput {
  label: string;
  path?: string;
  url?: string;
}

/** The inputs of the command, with globs expanded and a limit on their count. */
export async function resolveInputs(inputs: string[], cwd: string): Promise<ImageInput[]> {
  const out: ImageInput[] = [];
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) {
      out.push({ label: input, url: input });
      continue;
    }
    for (const path of await expandGlob(input, cwd)) out.push({ label: relative(cwd, path) || path, path });
  }
  if (out.length === 0) throw new Error("no image matches the inputs");
  if (out.length > MAX_IMAGE_INPUTS) throw new Error(`${out.length} images match; at most ${MAX_IMAGE_INPUTS} per run`);
  return out;
}

/** The bytes of an input: a file under the size cap, or a URL through the checked fetcher. */
async function readInput(input: ImageInput, cwd: string, userAgent: string): Promise<Buffer> {
  if (input.url !== undefined) {
    const fetcher = makeFetcher({ userAgent });
    const body = await fetcher.get(input.url, { maxBytes: MAX_IMAGE_BYTES, allowPrivate: isLocalTarget(input.url) });
    if (body === undefined) throw new Error(`${safeText(input.url)} was not fetched (blocked, failed, or larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)`);
    return body;
  }
  const path = resolve(cwd, input.path as string);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${safeText(input.label)} is not a file`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`${safeText(input.label)} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
  return readFile(path);
}

// ---------------------------------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------------------------------

/** The quality and the bytes of the lowest quality per format that meets the bar, at one size. */
export interface FormatResult {
  quality?: number;
  bytes?: number;
  /** Set when even the top quality does not meet the bar. */
  missed?: true;
}

/** The result for one file at one width (the file's own, or the needed width at one dpr). */
export interface SizeResult {
  /** Device pixels the image is measured at (the reference width). */
  px: number;
  dpr?: number;
  perFormat: Record<ImageFormat, FormatResult>;
  best?: { format: ImageFormat; bytes: number; saving: number };
}

export interface FileResult {
  label: string;
  evidence: "file-mode";
  imgtuneVersion: string;
  current: { format?: string; width: number; height: number; bytes: number };
  /** Where the width comes from: the user's --width, or the file's own size (no width given). */
  width: { source: "user" | "file"; css?: number };
  /** The SSIMULACRA2 bar each quality met, measured against the file's own pixels: the default, or --min-score. */
  bar: { ssimulacra2: number; basis: "default" | "user" };
  sizes: SizeResult[];
  error?: string;
}

/** The bar of a run: --min-score when given, else the default. */
const barOf = (minScore: number | undefined): FileResult["bar"] =>
  minScore === undefined ? { ssimulacra2: DEFAULT_FILE_BAR, basis: "default" } : { ssimulacra2: minScore, basis: "user" };

/** The result cache of a run, and the scorer it is keyed by; `original` is the file's bytes (its content hash is the key). */
export interface FileCache {
  store: ResultCache;
  scorerId: string;
  original: Buffer;
  /** The CPU-scored count of the GPU scorer (see QualityDeps.cpuScored in remote.ts); absent for the CPU. */
  cpuScored?: () => number;
}

/** The score of the local encode at a quality, from the result cache when it has it (the same keys as a scan's). */
function scoreAtCached(cached: FileCache, reference: RawImage, format: ImageFormat, score: Scorer): (q: number) => Promise<number> {
  const scope = cacheScope(cached.original, reference.width, cached.scorerId, ENCODER_ID);
  return async (q) => {
    const key = `${scope}|score|${format}|${q}|cdn`;
    const hit = await cached.store.get(key);
    if (hit !== undefined) return hit;
    // Stored only when the CPU scored nothing meanwhile: the key names the GPU (see QualityDeps.cpuScored).
    const before = cached.cpuScored?.() ?? 0;
    const value = await score(reference, (await encode(reference, format as "avif" | "webp", q, "cdn")).decoded);
    if ((cached.cpuScored?.() ?? 0) === before) await cached.store.put(key, value);
    return value;
  };
}

/** The lowest quality per format meeting the bar, at a reference of one size. */
async function formatsAt(
  reference: RawImage,
  formats: ImageFormat[],
  score: Scorer,
  bar: number,
  cached?: FileCache,
): Promise<Record<ImageFormat, FormatResult>> {
  const perFormat = {} as Record<ImageFormat, FormatResult>;
  for (const format of ALL_FORMATS) {
    if (!formats.includes(format)) continue;
    if (format === "jpeg") {
      perFormat.jpeg = await jpegAtBar(reference, bar, score);
      continue;
    }
    const scoreAt = cached && scoreAtCached(cached, reference, format, score);
    const best = await minPassingQuality(reference, format, START_QUALITY, "cdn", bar, SCAN_TOLERANCE, { encode, score, scoreAt });
    const out = await encode(reference, format, best, "cdn");
    const passes = (await score(reference, out.decoded)) >= bar;
    perFormat[format] = passes ? { quality: best, bytes: out.bytes } : { missed: true };
  }
  return perFormat;
}

/** The smallest JPEG quality that meets the bar (a bisection over 30..100); missed when 100 does not. */
async function jpegAtBar(reference: RawImage, bar: number, score: Scorer): Promise<FormatResult> {
  const encodeJpeg = async (quality: number): Promise<{ bytes: number; ok: boolean }> => {
    const buffer = await sharp(reference.data, { raw: { width: reference.width, height: reference.height, channels: 4 } })
      .jpeg({ quality })
      .toBuffer();
    const decoded = await decodeRaw(buffer);
    return { bytes: buffer.length, ok: (await score(reference, decoded)) >= bar };
  };
  let lo = 30;
  let hi = 100;
  let top = await encodeJpeg(hi);
  if (!top.ok) return { missed: true };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const attempt = await encodeJpeg(mid);
    if (attempt.ok) {
      hi = mid;
      top = attempt;
    } else lo = mid + 1;
  }
  return { quality: hi, bytes: top.bytes };
}

/** The reference at a width: the file decoded and resized down to it (never up), as the scan's own references are. */
async function referenceFor(buffer: Buffer, width: number): Promise<RawImage> {
  return loadReference(buffer, width);
}

/** One file, measured at its own size and, with --width, at each needed width. Never throws: an error is recorded. */
export async function measureFile(
  input: ImageInput,
  buffer: Buffer,
  args: Pick<ImageArgs, "width" | "dprs" | "formats" | "minScore">,
  score: Scorer,
  cached?: FileCache,
): Promise<FileResult> {
  const info = await pixelSize(buffer);
  const bar = barOf(args.minScore);
  const base = {
    label: input.label,
    evidence: "file-mode" as const,
    imgtuneVersion: IMGTUNE_VERSION,
    current: { format: info?.format, width: info?.width ?? 0, height: info?.height ?? 0, bytes: buffer.length },
  };
  const placeholder = { bar, sizes: [] };
  if (!info) return { ...base, width: { source: args.width ? "user" : "file", css: args.width }, ...placeholder, error: "not a decodable image" };
  if (info.format === "svg" || info.format === "gif") {
    return { ...base, width: { source: args.width ? "user" : "file", css: args.width }, ...placeholder, error: `${info.format} is not measured (not a raster format the encoders take)` };
  }
  const targets: { px: number; dpr?: number }[] =
    args.width === undefined ? [{ px: info.width }] : args.dprs.map((dpr) => ({ px: Math.min(Math.ceil(args.width! * dpr), info.width), dpr }));
  const sizes: SizeResult[] = [];
  for (const target of targets) {
    const reference = await referenceFor(buffer, target.px);
    const perFormat = await formatsAt(reference, args.formats, score, bar.ssimulacra2, cached);
    const fits = (Object.entries(perFormat) as [ImageFormat, FormatResult][]).filter(([, r]) => r.bytes !== undefined);
    const best = fits.sort((a, b) => (a[1].bytes as number) - (b[1].bytes as number))[0];
    sizes.push({
      px: reference.width,
      dpr: target.dpr,
      perFormat,
      best: best ? { format: best[0], bytes: best[1].bytes as number, saving: buffer.length - (best[1].bytes as number) } : undefined,
    });
  }
  return {
    ...base,
    width: args.width === undefined ? { source: "file" } : { source: "user", css: args.width },
    bar,
    sizes,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Output: text or JSON, and the optional optimised copies
// ---------------------------------------------------------------------------------------------------------------------

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/** The text of one file's result: its bytes now, the bar, and each size's quality and bytes per format. */
export function renderFile(result: FileResult): string {
  const head = `${safeText(result.label)}  ${result.current.format ?? "?"} ${result.current.width}x${result.current.height}  ${kb(result.current.bytes)} now`;
  if (result.error) return `${head}\n  ${safeText(result.error)}\n`;
  const lines = [head, `  evidence file-mode; width ${result.width.source === "user" ? `${result.width.css} css px (from --width: the user's)` : "the file's own size (no --width given)"}`];
  const barNote = result.bar.basis === "default" ? "default, visually lossless; --min-score sets another" : "from --min-score";
  lines.push(`  bar SSIMULACRA2 ${result.bar.ssimulacra2} against the file itself (${barNote})`);
  for (const size of result.sizes) {
    const at = size.dpr !== undefined ? `at ${size.px} px (${result.width.css} css x ${size.dpr})` : `at ${size.px} px`;
    const parts = (Object.entries(size.perFormat) as [ImageFormat, FormatResult][]).map(([format, r]) =>
      r.bytes !== undefined ? `${format} q${r.quality} ${kb(r.bytes)}` : `${format} misses the bar`,
    );
    lines.push(`  ${at}: ${parts.join("   ")}`);
    if (size.best) {
      const change = size.best.saving >= 0 ? `saves ${kb(size.best.saving)}` : `adds ${kb(-size.best.saving)}`;
      lines.push(`    best ${size.best.format} ${kb(size.best.bytes)} (${change})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Writes an optimised copy of each file at its best format and quality, into `dir`. Never overwrites: a name that exists
 * is an error for that file. The copy is at the largest needed width (the file's own size without --width).
 */
export async function writeCopies(results: FileResult[], inputs: ImageInput[], cwd: string, dir: string, buffers: Map<string, Buffer>): Promise<string[]> {
  const target = resolve(cwd, dir);
  const notes: string[] = [];
  await mkdir(target, { recursive: true });
  for (const result of results) {
    if (result.error || result.sizes.length === 0) continue;
    const input = inputs.find((i) => i.label === result.label);
    const buffer = buffers.get(result.label);
    if (!input || !buffer || !input.path) continue;
    if (resolve(dirname(resolve(cwd, input.path))) === target) {
      notes.push(`${safeText(result.label)}: not written (the copy folder is the file's own folder)`);
      continue;
    }
    const size = result.sizes.reduce((a, b) => (b.px > a.px ? b : a));
    if (!size.best) {
      notes.push(`${safeText(result.label)}: not written (no format meets the bar)`);
      continue;
    }
    const reference = await referenceFor(buffer, size.px);
    const format = size.best.format;
    const quality = size.perFormat[format].quality as number;
    const out =
      format === "jpeg"
        ? await sharp(reference.data, { raw: { width: reference.width, height: reference.height, channels: 4 } }).jpeg({ quality }).toBuffer()
        : (await encode(reference, format, quality, "cdn")).buffer;
    const name = `${basename(input.path, extname(input.path))}.${format}`;
    const path = join(target, name);
    try {
      await writeFile(path, out, { flag: "wx" });
      notes.push(`${safeText(result.label)} -> ${safeText(relative(cwd, path) || path)} (${kb(out.length)}, q${quality}, ${size.px} px)`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      notes.push(code === "EEXIST" ? `${safeText(name)}: not written (the file exists)` : `${safeText(name)}: not written (${safeText((err as Error).message)})`);
    }
  }
  return notes;
}

/** `imgtune image`: measures each input and returns the text or JSON to print. */
export async function imageCommand(
  argv: string[],
  cwd: string,
  userAgent = `imgtune/${IMGTUNE_VERSION}`,
  log: (message: string) => void = (message) => process.stderr.write(`imgtune: ${message}\n`),
): Promise<{ output: string; exitCode: number }> {
  const args = parseImageArgs(argv);
  const gpu = args.gpu !== undefined ? await startGpuScorer(args.gpu.device, log) : undefined;
  const store = args.noCache === true ? undefined : new ResultCache(join(cwd, CACHE_DIR));
  await store?.trim();
  const cache =
    store === undefined
      ? undefined
      : { store, scorerId: gpu !== undefined ? `gpu:${gpu.deviceName}` : "cpu", cpuScored: gpu ? () => gpu.cpuScores : undefined };
  try {
    return await measureInputs(args, cwd, userAgent, gpu, cache);
  } finally {
    gpu?.close();
  }
}

async function measureInputs(
  args: ImageArgs,
  cwd: string,
  userAgent: string,
  gpu: GpuScorer | undefined,
  cache?: { store: ResultCache; scorerId: string },
): Promise<{ output: string; exitCode: number }> {
  const inputs = await resolveInputs(args.inputs, cwd);
  const score = makeScorer("ssimulacra2", { projectDir: cwd, gpu });
  const results: FileResult[] = [];
  const buffers = new Map<string, Buffer>();
  for (const input of inputs) {
    let buffer: Buffer;
    try {
      buffer = await readInput(input, cwd, userAgent);
    } catch (err) {
      results.push({
        label: input.label,
        evidence: "file-mode",
        imgtuneVersion: IMGTUNE_VERSION,
        current: { width: 0, height: 0, bytes: 0 },
        width: { source: args.width ? "user" : "file", css: args.width },
        bar: barOf(args.minScore),
        sizes: [],
        error: (err as Error).message,
      });
      continue;
    }
    buffers.set(input.label, buffer);
    results.push(await measureFile(input, buffer, args, score, cache && { ...cache, original: buffer }));
  }
  const notes = args.write !== undefined ? await writeCopies(results, inputs, cwd, args.write, buffers) : [];
  const failed = results.filter((r) => r.error !== undefined).length;
  const scorer: PageScorer = gpu !== undefined ? scorerOf(gpu) : { name: "cpu" };
  if (args.format === "json") {
    const body = { evidence: "file-mode", scorer, files: results, copies: notes };
    return { output: `${JSON.stringify(body, null, 2)}\n`, exitCode: failed > 0 ? 1 : 0 };
  }
  const head = gpu !== undefined ? `${gpuNote(gpu.device, gpu.deviceName, gpu.fallbackScores)}\n\n` : "";
  const text = results.map(renderFile).join("\n");
  const tail = notes.length > 0 ? `copies:\n${notes.map((n) => `  ${n}`).join("\n")}\n` : "";
  return { output: `${head}${text}${tail}`, exitCode: failed > 0 ? 1 : 0 };
}
