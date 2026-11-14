// Reads just enough of a font file for the font analyzer: its container format, a WOFF/WOFF2/EOT unwrap to plain sfnt
// bytes, and the tables the checks need (maxp, head, OS/2, name, cmap, fvar). Nothing is rendered or fully parsed.
// Every function returns null (or an empty result) on malformed input; none of them throws.
import { inflateSync } from "node:zlib";
import * as wawoff2 from "wawoff2";

export type FontFormat = "woff2" | "woff" | "sfnt" | "eot" | "collection" | "unknown";

export interface VariationAxis {
  tag: string;
  min: number;
  default: number;
  max: number;
}

export interface FontInfo {
  numGlyphs: number;
  /** Names from the name table: typographic family (ID 16) and family (ID 1), when present. */
  families: string[];
  /** OS/2 usWeightClass (100–900). */
  weightClass?: number;
  italic: boolean;
  axes: VariationAxis[];
  /** Sorted, merged inclusive code point ranges the Unicode cmap maps to a glyph. */
  ranges: [number, number][];
  /** Number of code points in `ranges`. */
  codepoints: number;
}

export function detectFormat(buf: Buffer): FontFormat {
  if (buf.length < 4) return "unknown";
  const tag = buf.toString("latin1", 0, 4);
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "ttcf") return "collection";
  if (tag === "OTTO" || tag === "true" || buf.readUInt32BE(0) === 0x00010000) return "sfnt";
  if (buf.length >= 36 && buf.readUInt16LE(34) === 0x504c) return "eot";
  return "unknown";
}

/** Plain sfnt bytes for a font file, or null when it cannot be unwrapped. */
export async function toSfnt(buf: Buffer, format: FontFormat): Promise<Buffer | null> {
  try {
    switch (format) {
      case "sfnt":
        return buf;
      case "woff2":
        return Buffer.from(await wawoff2.decompress(buf));
      case "woff":
        return woff1ToSfnt(buf);
      case "eot":
        return eotToSfnt(buf);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** WOFF 1.0: each table is zlib-deflated when its compressed length is smaller. Rebuild the sfnt table directory. */
function woff1ToSfnt(buf: Buffer): Buffer | null {
  const flavor = buf.readUInt32BE(4);
  const numTables = buf.readUInt16BE(12);
  const tables: { tag: Buffer; data: Buffer }[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    const offset = buf.readUInt32BE(at + 4);
    const compLength = buf.readUInt32BE(at + 8);
    const origLength = buf.readUInt32BE(at + 12);
    const raw = buf.subarray(offset, offset + compLength);
    if (raw.length !== compLength) return null;
    const data = compLength < origLength ? inflateSync(raw) : raw;
    if (data.length !== origLength) return null;
    tables.push({ tag: buf.subarray(at, at + 4), data });
  }
  return buildSfnt(flavor, tables);
}

/** EOT without MTX compression or XOR obfuscation is the sfnt font data at the end of the header. */
function eotToSfnt(buf: Buffer): Buffer | null {
  const eotSize = buf.readUInt32LE(0);
  const fontDataSize = buf.readUInt32LE(4);
  const flags = buf.readUInt32LE(12);
  if (flags & 0x4) return null; // MicroType Express compressed
  if (eotSize > buf.length || fontDataSize > eotSize) return null;
  const data = Buffer.from(buf.subarray(eotSize - fontDataSize, eotSize));
  if (flags & 0x10000000) for (let i = 0; i < data.length; i++) data[i] ^= 0x50;
  return detectFormat(data) === "sfnt" ? data : null;
}

function buildSfnt(flavor: number, tables: { tag: Buffer; data: Buffer }[]): Buffer {
  const n = tables.length;
  const entrySelector = Math.floor(Math.log2(n));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(n * 16 - searchRange, 10);
  const body: Buffer[] = [];
  let offset = header.length;
  tables.forEach((t, i) => {
    const at = 12 + i * 16;
    t.tag.copy(header, at);
    header.writeUInt32BE(0, at + 4); // checksum: not verified by any reader used here
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(t.data.length, at + 12);
    const padded = Buffer.alloc((t.data.length + 3) & ~3);
    t.data.copy(padded);
    body.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...body]);
}

interface TableRef {
  offset: number;
  length: number;
}

function readTables(buf: Buffer): Map<string, TableRef> | null {
  if (buf.length < 12) return null;
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, TableRef>();
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const tag = buf.toString("latin1", at, at + 4);
    const offset = buf.readUInt32BE(at + 8);
    const length = buf.readUInt32BE(at + 12);
    if (offset + length <= buf.length) tables.set(tag, { offset, length });
  }
  return tables;
}

/** Reads the tables the checks need from a plain sfnt. Returns null for a malformed or unsupported file. */
export function parseSfnt(buf: Buffer): FontInfo | null {
  try {
    if (detectFormat(buf) !== "sfnt") return null;
    const tables = readTables(buf);
    if (!tables) return null;
    const maxp = tables.get("maxp");
    const cmap = tables.get("cmap");
    if (!maxp || !cmap) return null;
    const numGlyphs = buf.readUInt16BE(maxp.offset + 4);
    const head = tables.get("head");
    const macStyle = head ? buf.readUInt16BE(head.offset + 44) : 0;
    const os2 = tables.get("OS/2");
    const weightClass = os2 ? buf.readUInt16BE(os2.offset + 4) : undefined;
    const fsSelection = os2 && os2.length >= 64 ? buf.readUInt16BE(os2.offset + 62) : 0;
    const ranges = readCmap(buf, cmap);
    const codepoints = ranges.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
    const fvar = tables.get("fvar");
    const name = tables.get("name");
    return {
      numGlyphs,
      families: name ? familyNames(buf, name) : [],
      weightClass,
      italic: Boolean(fsSelection & 1) || Boolean(macStyle & 2),
      axes: fvar ? readAxes(buf, fvar) : [],
      ranges,
      codepoints,
    };
  } catch {
    return null;
  }
}

function readAxes(buf: Buffer, fvar: TableRef): VariationAxis[] {
  const axesOffset = buf.readUInt16BE(fvar.offset + 4);
  const axisCount = buf.readUInt16BE(fvar.offset + 8);
  const axisSize = buf.readUInt16BE(fvar.offset + 10);
  const axes: VariationAxis[] = [];
  for (let i = 0; i < axisCount; i++) {
    const at = fvar.offset + axesOffset + i * axisSize;
    axes.push({
      tag: buf.toString("latin1", at, at + 4),
      min: buf.readInt32BE(at + 4) / 65536,
      default: buf.readInt32BE(at + 8) / 65536,
      max: buf.readInt32BE(at + 12) / 65536,
    });
  }
  return axes;
}

/** Name IDs 16 then 1, from the Windows (UTF-16BE) records, else the Mac (Latin-1) records. */
function familyNames(buf: Buffer, name: TableRef): string[] {
  const count = buf.readUInt16BE(name.offset + 2);
  const stringOffset = name.offset + buf.readUInt16BE(name.offset + 4);
  const found = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const at = name.offset + 6 + i * 12;
    const platform = buf.readUInt16BE(at);
    const nameId = buf.readUInt16BE(at + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = buf.readUInt16BE(at + 8);
    const start = stringOffset + buf.readUInt16BE(at + 10);
    const raw = buf.subarray(start, start + length);
    const text = decodeName(platform, raw);
    // A Windows record wins over a Mac one for the same ID.
    if (!found.has(nameId) || platform === 3) found.set(nameId, text.trim());
  }
  return [found.get(16), found.get(1)].filter((s): s is string => Boolean(s));
}

function decodeName(platform: number, raw: Buffer): string {
  if (platform === 3 || platform === 0) {
    // UTF-16BE: copy the even-length prefix, swap to little-endian for Node's decoder.
    return Buffer.from(raw.subarray(0, raw.length & ~1)).swap16().toString("utf16le");
  }
  return raw.toString("latin1");
}

/** Unicode code point ranges from the best Unicode cmap subtable (3,10 then 3,1 then any platform 0, then 3,0). */
function readCmap(buf: Buffer, cmap: TableRef): [number, number][] {
  const count = buf.readUInt16BE(cmap.offset + 2);
  const subtables: { platform: number; encoding: number; offset: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = cmap.offset + 4 + i * 8;
    subtables.push({
      platform: buf.readUInt16BE(at),
      encoding: buf.readUInt16BE(at + 2),
      offset: cmap.offset + buf.readUInt32BE(at + 4),
    });
  }
  const pick =
    subtables.find((s) => s.platform === 3 && s.encoding === 10) ??
    subtables.find((s) => s.platform === 3 && s.encoding === 1) ??
    subtables.find((s) => s.platform === 0) ??
    subtables.find((s) => s.platform === 3 && s.encoding === 0);
  if (!pick) return [];
  const format = buf.readUInt16BE(pick.offset);
  const raw = format === 4 ? format4Codes(buf, pick.offset) : format === 12 ? format12Groups(buf, pick.offset) : [];
  return mergeCodes(raw);
}

function format4Codes(buf: Buffer, sub: number): [number, number][] {
  const segCount = buf.readUInt16BE(sub + 6) / 2;
  const endAt = sub + 14;
  const startAt = endAt + segCount * 2 + 2;
  const deltaAt = startAt + segCount * 2;
  const rangeAt = deltaAt + segCount * 2;
  const out: [number, number][] = [];
  for (let s = 0; s < segCount; s++) {
    const end = buf.readUInt16BE(endAt + s * 2);
    const start = buf.readUInt16BE(startAt + s * 2);
    const delta = buf.readUInt16BE(deltaAt + s * 2);
    const rangeOffset = buf.readUInt16BE(rangeAt + s * 2);
    for (let c = start; c <= end && c < 0xffff; c++) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (c + delta) & 0xffff;
      } else {
        glyph = buf.readUInt16BE(rangeAt + s * 2 + rangeOffset + (c - start) * 2);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) out.push([c, c]);
    }
  }
  return out;
}

function format12Groups(buf: Buffer, sub: number): [number, number][] {
  const groups = buf.readUInt32BE(sub + 12);
  const out: [number, number][] = [];
  for (let g = 0; g < groups; g++) {
    const at = sub + 16 + g * 12;
    out.push([buf.readUInt32BE(at), buf.readUInt32BE(at + 4)]);
  }
  return out;
}

/** Sorts and merges inclusive ranges, and drops anything above U+10FFFF. */
export function mergeCodes(input: [number, number][]): [number, number][] {
  const sorted = input
    .map(([a, b]): [number, number] => [a, Math.min(b, 0x10ffff)])
    .filter(([a, b]) => a <= b)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Intersection of two sorted, merged range lists. */
export function intersectRanges(a: [number, number][], b: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (lo <= hi) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

export function countRanges(ranges: [number, number][]): number {
  return ranges.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
}

export function inRanges(ranges: [number, number][], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}
