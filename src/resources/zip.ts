import { inflateRawSync } from "node:zlib";

/** One entry of a zip archive (a .lottie file). Only what the lottie analyzer reads. */
export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate; other methods are skipped. */
  method: number;
  /** Bytes the entry takes inside the archive. */
  compressedSize: number;
  /** Uncompressed size. */
  size: number;
  /** Decompressed bytes, or undefined when the entry is unreadable or too large. */
  data(): Buffer | undefined;
}

/** Largest entry the reader will inflate (a lottie animation or a raster). */
export const ZIP_MAX_ENTRY_BYTES = 50 * 1024 * 1024;

/**
 * Reads the central directory of a zip archive (no zip64). Never throws: returns [] for anything it does not understand.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  try {
    const eocd = findEocd(buf);
    if (eocd < 0) return [];
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
      entries.push({
        name,
        method,
        compressedSize,
        size,
        data: () => readEntry(buf, local, method, compressedSize, size),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } catch {
    return [];
  }
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readEntry(buf: Buffer, local: number, method: number, compressedSize: number, size: number): Buffer | undefined {
  if (size > ZIP_MAX_ENTRY_BYTES || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return undefined;
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const raw = buf.subarray(start, start + compressedSize);
  if (raw.length !== compressedSize) return undefined;
  if (method === 0) return raw;
  if (method === 8) {
    try {
      return inflateRawSync(raw, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
    } catch {
      return undefined;
    }
  }
  return undefined;
}
