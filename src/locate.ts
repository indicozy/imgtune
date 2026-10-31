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

/** One plain map's sources and segments, or undefined when the object is not a map with sources and mappings. */
function plainMap(json: { sources?: unknown; mappings?: unknown } | undefined): SourceMapData | undefined {
  if (!json || !Array.isArray(json.sources) || typeof json.mappings !== "string") return undefined;
  return { sources: json.sources.map(String), lines: decodeMappings(json.mappings) };
}

/**
 * Joins the sections of an index map (Turbopack writes one for each chunk) into one map: each section's segments move by
 * its offset, and its sources are appended. Sections without an inline map are skipped.
 */
function flattenSections(sections: { offset?: { line?: number; column?: number }; map?: unknown }[]): SourceMapData | undefined {
  const sources: string[] = [];
  const lines: number[][][] = [];
  for (const section of sections) {
    const map = plainMap(section.map as { sources?: unknown; mappings?: unknown } | undefined);
    if (!map) continue;
    const offsetLine = section.offset?.line ?? 0;
    const offsetColumn = section.offset?.column ?? 0;
    const base = sources.length;
    sources.push(...map.sources);
    map.lines.forEach((segments, i) => {
      const target = offsetLine + i;
      while (lines.length <= target) lines.push([]);
      for (const segment of segments) {
        const moved = [...segment];
        if (i === 0) moved[0] += offsetColumn;
        if (moved.length >= 4) moved[1] += base;
        lines[target].push(moved);
      }
    });
  }
  if (sources.length === 0) return undefined;
  for (const segments of lines) segments.sort((a, b) => a[0] - b[0]);
  return { sources, lines };
}

/** Parses a source map's JSON text (a plain map or an index map). Undefined when it is neither. */
export function parseSourceMap(text: string): SourceMapData | undefined {
  try {
    const json = JSON.parse(text) as { sources?: unknown; mappings?: unknown; sections?: unknown };
    if (Array.isArray(json.sections)) return flattenSections(json.sections as { offset?: { line?: number; column?: number }; map?: unknown }[]);
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

const SOURCE_ROOT_MARKERS = /\/(app|src|pages|components|lib)\//;

/**
 * The project-relative path of a bundler source name, or undefined for a file that is not the app's own source:
 * dependencies (node_modules), runtime and internal modules, and anything that is not a script or MDX file. Handles
 * webpack:// (its first segment is the bundle name), turbopack:/// ([project]), webpack-internal:/// and file:// paths.
 */
export function projectPath(source: string): string | undefined {
  if (/node_modules|\[turbopack\]|webpack\/runtime/i.test(source)) return undefined;
  let rest = source;
  const scheme = /^([a-z-]+):\/\//i.exec(rest);
  const kind = scheme ? scheme[1].toLowerCase() : "";
  if (scheme) rest = rest.slice(scheme[0].length);
  // An absolute file path keeps its project folder from the first app-like folder on; otherwise its basename.
  if (kind === "file" || (kind === "" && rest.startsWith("/"))) {
    const marker = SOURCE_ROOT_MARKERS.exec(rest);
    rest = marker ? rest.slice(marker.index + 1) : rest.slice(rest.lastIndexOf("/") + 1);
  }
  const segments = rest.split("/").filter((s) => s !== "");
  if (kind === "webpack" && segments.length > 0) segments.shift();
  while (segments.length > 0 && (segments[0] === "." || segments[0] === ".." || /^[([].*[)\]]$/.test(segments[0]))) segments.shift();
  const path = segments.join("/");
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
