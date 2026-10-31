// Source locator helpers: a minimal source-map reader (VLQ mappings, no dependency), the cleaning of bundler source
// names to project paths, and the URL pattern of an image loader. Pure apart from the injected map loader.

import { adapterFor } from "./loaders.js";

/** A browser stack frame that points into a bundled chunk. */
export interface StackFrame {
  url: string;
  /** 1-based, as the browser's stack reports them. */
  line: number;
  col: number;
}

/** A React owner, nearest first: its component name when it has one, its own JSX site, or the source React 18 recorded. */
export interface OwnerTrace {
  name?: string;
  source?: { file: string; line: number };
  frames: StackFrame[];
}

/** The source-map fields this module reads. `lines[i]` holds the segments of generated line i + 1. */
export interface SourceMapData {
  sources: string[];
  lines: number[][][];
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]));

/** The signed values of one VLQ segment. */
function decodeSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = B64_VALUE.get(ch);
    if (digit === undefined) throw new Error(`invalid source map character ${ch}`);
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
    } else {
      const negative = value % 2 === 1;
      const magnitude = Math.floor(value / 2);
      values.push(negative ? -magnitude : magnitude);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

/**
 * The segments of a `mappings` string: per generated line, [generatedColumn, sourceIndex, sourceLine, sourceColumn]
 * (the source fields are absent for a segment with no source). Columns reset per line; the source fields carry on across
 * the whole string, as the format specifies.
 */
export function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const line of mappings.split(";")) {
    let generatedColumn = 0;
    const segments: number[][] = [];
    for (const segment of line.split(",")) {
      if (segment === "") continue;
      const values = decodeSegment(segment);
      generatedColumn += values[0];
      const decoded = [generatedColumn];
      if (values.length >= 4) {
        sourceIndex += values[1];
        sourceLine += values[2];
        sourceColumn += values[3];
        decoded.push(sourceIndex, sourceLine, sourceColumn);
      }
      segments.push(decoded);
    }
    lines.push(segments);
  }
  return lines;
}

/** Most generated lines an index map may place: a hostile offset cannot make the reader allocate more. */
export const MAX_MAP_LINES = 1_000_000;
/** Most sections and sources one map may carry. */
const MAX_SECTIONS = 10_000;
const MAX_SOURCES = 10_000;

/** One plain map's sources and segments, or undefined when the object is not a map with sources and mappings. */
function plainMap(json: unknown): SourceMapData | undefined {
  const map = json as { sources?: unknown; mappings?: unknown } | null;
  if (!map || typeof map !== "object" || !Array.isArray(map.sources) || typeof map.mappings !== "string") return undefined;
  if (map.sources.length > MAX_SOURCES) return undefined;
  return { sources: map.sources.map(String), lines: decodeMappings(map.mappings) };
}

/** A section offset: a non-negative safe integer, or undefined. */
const offsetOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Joins the sections of an index map (Turbopack writes one for each chunk) into one map: each section's segments move by
 * its offset, and its sources are appended. Offsets come from the scanned site, so a section is skipped when its offset
 * is not a non-negative integer, goes backwards, or would place lines past MAX_MAP_LINES.
 */
function flattenSections(sections: unknown[]): SourceMapData | undefined {
  if (sections.length > MAX_SECTIONS) return undefined;
  const sources: string[] = [];
  const lines: number[][][] = [];
  let lastLine = 0;
  for (const raw of sections) {
    const section = raw as { offset?: { line?: unknown; column?: unknown }; map?: unknown } | null;
    if (!section || typeof section !== "object") continue;
    const offsetLine = offsetOf(section.offset?.line);
    const offsetColumn = offsetOf(section.offset?.column);
    if (offsetLine === undefined || offsetColumn === undefined || offsetLine < lastLine) continue;
    const map = plainMap(section.map);
    if (!map || offsetLine + map.lines.length > MAX_MAP_LINES) continue;
    lastLine = offsetLine;
    const base = sources.length;
    sources.push(...map.sources);
    while (lines.length < offsetLine + map.lines.length) lines.push([]);
    map.lines.forEach((segments, i) => {
      const target = offsetLine + i;
      for (const segment of segments) {
        const moved = [...segment];
        if (i === 0) moved[0] += offsetColumn;
        if (moved.length >= 4) moved[1] += base;
        lines[target].push(moved);
      }
    });
  }
  if (sources.length === 0) return undefined;
  for (const segments of lines) segments.sort((x, y) => x[0] - y[0]);
  return { sources, lines };
}

/** Parses a source map's JSON text (a plain map or an index map). Undefined when it is neither. */
export function parseSourceMap(text: string): SourceMapData | undefined {
  try {
    const json = JSON.parse(text) as { sections?: unknown } | null;
    if (json && Array.isArray(json.sections)) return flattenSections(json.sections);
    return plainMap(json);
  } catch {
    return undefined;
  }
}

/** The original source and line of a generated position (both 1-based), or undefined when no segment covers it. */
export function originalPosition(map: SourceMapData, line: number, col: number): { source: string; line: number } | undefined {
  const segments = map.lines[line - 1];
  if (!segments) return undefined;
  const target = col - 1;
  let best: number[] | undefined;
  for (const segment of segments) {
    if (segment[0] > target) break;
    if (segment.length >= 4) best = segment;
  }
  if (!best) return undefined;
  const source = map.sources[best[1]];
  if (source === undefined) return undefined;
  return { source, line: best[2] + 1 };
}

/** Bundler schemes a source name may carry. Any other scheme (file:, http:, about:, rsc:) is not a project source. */
const SOURCE_SCHEMES = new Set(["webpack", "turbopack", "webpack-internal", "file"]);
/** The folders an app's own sources sit under: a file: name (an absolute path) is kept from the first of them on. */
const APP_FOLDER = /(^|\/)(app|src|pages|components|lib)\//;
/** A project path: word characters, dots, dashes, slashes, and the brackets and spaces of Next's route folders. */
const SAFE_PATH = /^[\w@.\-/[\]() +]+$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\\]/;
export const MAX_SOURCE_NAME = 1024;
export const MAX_PATH = 256;

/** A React component name a locator may carry: an identifier of at most 64 characters. */
export const COMPONENT_NAME = /^[A-Za-z_$][\w$.]{0,63}$/;

/**
 * Text a page controls, as it may be stored and printed: control characters (newlines included) removed, and at most
 * `limit` characters.
 */
export function sanitizeText(text: string, limit = 120): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").slice(0, limit);
}

/**
 * The project-relative path of a bundler source name, or undefined when it is not a file of the app. Refused: any
 * control character or backslash, any scheme but the bundlers' own, an absolute path, a `..` segment, dependencies and
 * runtime modules, a file that is not a script or MDX file, and a path with characters outside SAFE_PATH. The name is
 * untrusted (it comes from the scanned site's source map), so the result is only ever a relative path under the project.
 */
export function projectPath(source: string): string | undefined {
  if (source.length > MAX_SOURCE_NAME || CONTROL.test(source)) return undefined;
  if (/node_modules|\[turbopack\]|webpack\/runtime/i.test(source)) return undefined;
  let rest = source;
  const scheme = /^([a-z-]+):\/\//i.exec(rest);
  const kind = scheme ? scheme[1].toLowerCase() : "";
  if (scheme && !SOURCE_SCHEMES.has(kind)) return undefined;
  if (!scheme && rest.startsWith("/")) return undefined;
  if (scheme) rest = rest.slice(scheme[0].length);
  if (kind === "file") {
    // An absolute path (Turbopack writes these): only its part from an app folder on, so the machine's own folders stay out.
    const marker = APP_FOLDER.exec(rest);
    if (!marker) return undefined;
    rest = rest.slice(marker.index + marker[1].length);
  }
  const segments = rest.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === "..")) return undefined;
  if (kind === "webpack" && segments.length > 0) segments.shift();
  while (segments.length > 0 && (segments[0] === "." || /^[([].*[)\]]$/.test(segments[0]))) segments.shift();
  const path = segments.join("/");
  if (path === "" || path.length > MAX_PATH || path.startsWith("/") || !SAFE_PATH.test(path)) return undefined;
  if (!/\.(tsx?|jsx?|mdx?)$/i.test(path)) return undefined;
  return path;
}

/**
 * The URL with its size and quality parameters taken out, so every rendition of one image has the same pattern: the
 * query keys w, width, q, quality and dpr are dropped; a CDN's transform segment (cdn-cgi options, Cloudinary's
 * transformations) becomes `*`.
 */
export function urlPattern(src: string, pageUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(src, pageUrl);
  } catch {
    return undefined;
  }
  for (const key of ["w", "width", "q", "quality", "dpr"]) url.searchParams.delete(key);
  url.hash = "";
  url.pathname = url.pathname
    .replace(/(\/cdn-cgi\/image\/)[^/]+\//, "$1*/")
    .replace(/(\/image\/upload\/)(?:[a-z]{1,3}_[^/]+\/)+/, "$1*/");
  const query = url.searchParams.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}

/**
 * The loader name of an image URL for the locator: a known CDN loader by its adapter name, next/image as
 * "next-default", a same-origin file as "plain-img", and any other host as "cdn:<host>".
 */
export function loaderName(src: string, pageUrl: string): string {
  let url: URL;
  try {
    url = new URL(src, pageUrl);
  } catch {
    return "plain-img";
  }
  const { adapter } = adapterFor(src, pageUrl);
  if (adapter.name === "next") return "next-default";
  if (adapter.name !== "generic") return adapter.name;
  if (url.origin === new URL(pageUrl).origin) return "plain-img";
  return `cdn:${url.host}`;
}

/**
 * The owner that names the image's source: the first (nearest) one with a project file, from React 18's recorded source
 * or from its stack frames resolved through the chunk's source map. Undefined when none resolves.
 */
export async function resolveOwners(
  owners: OwnerTrace[],
  loadMap: (chunkUrl: string) => Promise<SourceMapData | undefined>,
): Promise<{ file: string; line: number } | undefined> {
  for (const owner of owners) {
    if (owner.source) {
      const file = projectPath(owner.source.file);
      if (file) return { file, line: owner.source.line };
    }
    for (const frame of owner.frames.slice(0, 2)) {
      const chunk = frame.url.split("?")[0];
      const map = await loadMap(chunk);
      if (!map) continue;
      const found = originalPosition(map, frame.line, frame.col);
      const file = found ? projectPath(found.source) : undefined;
      if (found && file) return { file, line: found.line };
    }
  }
  return undefined;
}
