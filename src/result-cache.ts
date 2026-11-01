// The result cache: the local quality search's numbers (the bytes of a local encode, and the SSIMULACRA2 score of one),
// kept on disk under `.imgtune/cache/` in the scan's folder, so a rescan or a second run does not encode the same pixels
// again. Each entry is one small file named by the hash of its key. The key holds the original's content hash, the width,
// the format, the quality, the profile, the scorer and the encoder, and the tool version (see cacheScope), so a changed
// encoder, scorer or imgtune version never reads an old number. The directory is bounded: trimCache removes the oldest
// entries by modification time. Entries come from disk, so they are untrusted: anything that is not a small object with the
// same key and a finite number is ignored, and nothing in the cache is ever executed.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { IMGTUNE_VERSION } from "./version.js";

/** The cache folder, relative to the scan's folder. */
export const CACHE_DIR = join(".imgtune", "cache");
/** The most the cache may hold; the oldest entries go first. */
export const CACHE_MAX_BYTES = 500 * 1024 * 1024;
/** Bumped when what an entry means changes, so the old entries are never read again. */
export const CACHE_VERSION = 1;

const ENTRY_NAME = /^[0-9a-f]{64}\.json$/;
/** An entry is a key and a number: anything larger is not one of ours. */
const MAX_ENTRY_BYTES = 1024;
/** Keys are short and built here; a longer one is refused rather than hashed or written. */
const MAX_KEY_LENGTH = 4096;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** The scope every key of one reference and scorer carries: its original's content hash, width, scorer, encoder and tool. */
export function cacheScope(original: Buffer, width: number, scorerId: string, encoderId: string): string {
  return [sha256(original), `w${width}`, scorerId, encoderId, `imgtune ${IMGTUNE_VERSION}`, `cache ${CACHE_VERSION}`].join("|");
}

/** The served file's content hash, for a key of the score the browser's own file gets. */
export function contentHash(data: Buffer): string {
  return sha256(data);
}

export class ResultCache {
  private dirReady = false;

  constructor(
    private readonly dir: string,
    private readonly maxBytes = CACHE_MAX_BYTES,
  ) {}

  private fileOf(key: string): string {
    return join(this.dir, `${sha256(key)}.json`);
  }

  /** The number stored under `key`, or undefined: absent, corrupt, of another key, or not a finite number. */
  async get(key: string): Promise<number | undefined> {
    if (key.length > MAX_KEY_LENGTH) return undefined;
    const file = this.fileOf(key);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_ENTRY_BYTES) return undefined;
      const parsed = JSON.parse(await readFile(file, "utf8")) as { k?: unknown; v?: unknown } | null;
      if (parsed === null || typeof parsed !== "object") return undefined;
      if (parsed.k !== key || typeof parsed.v !== "number" || !Number.isFinite(parsed.v)) return undefined;
      return parsed.v;
    } catch {
      return undefined;
    }
  }

  /** Stores a finite number under `key`. A failed write is ignored: the cache is only ever a shortcut. */
  async put(key: string, value: number): Promise<void> {
    if (key.length > MAX_KEY_LENGTH || !Number.isFinite(value)) return;
    try {
      if (!this.dirReady) {
        await mkdir(this.dir, { recursive: true });
        this.dirReady = true;
      }
      await writeFileAtomic(this.fileOf(key), JSON.stringify({ k: key, v: value }), { root: this.dir });
    } catch {
      // Ignored: the number is recomputed the next time.
    }
  }

  /** Removes the oldest entries until the folder holds at most 90% of the limit. Only files named like entries are touched. */
  async trim(): Promise<{ removed: number; kept: number }> {
    return trimCache(this.dir, this.maxBytes);
  }
}

/** Removes the oldest entry files (by modification time) until the folder is within `maxBytes` (90% of it once trimmed). */
export async function trimCache(dir: string, maxBytes: number): Promise<{ removed: number; kept: number }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { removed: 0, kept: 0 };
  }
  const entries: { file: string; size: number; mtime: number }[] = [];
  let total = 0;
  for (const name of names) {
    if (!ENTRY_NAME.test(name)) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      entries.push({ file, size: info.size, mtime: info.mtimeMs });
      total += info.size;
    } catch {
      // A file that vanished is not counted.
    }
  }
  let removed = 0;
  if (total > maxBytes) {
    const target = maxBytes * 0.9;
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (total <= target) break;
      await rm(entry.file, { force: true });
      total -= entry.size;
      removed++;
    }
  }
  return { removed, kept: entries.length - removed };
}
