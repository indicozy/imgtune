// The measured state of a scanned page, kept in the out dir between its measurement and its analysis. A scan measures
// every page (phase 1) and then analyses them with the run's estimates (phase 2), so an interrupted run has measured pages
// that are not written yet. Each measured page is staged here as soon as it is measured: its observations as JSON, and
// the bytes of its responses as content-addressed blobs, so phase 2 reads a page's bytes back from disk rather than
// holding every page's bytes in memory. A staged page is removed once its complete JSON is written, and the folder is
// removed when the run finishes.
import { readFile, rm, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { contentHash } from "./result-cache.js";

/** The folder under the out dir that holds the staged pages and their blobs (a name the JSON readers ignore). */
export const STAGE_DIR_NAME = ".staged";

const BLOB_DIR = "blobs";
const HASH = /^[0-9a-f]{64}$/;

/** The stage folder of an out dir. */
export const stageDirOf = (outDir: string): string => join(outDir, STAGE_DIR_NAME);

/** Stores a response body under its content hash, once; returns the hash. */
export async function putBlob(stageDir: string, data: Buffer): Promise<string> {
  const hash = contentHash(data);
  const path = join(stageDir, BLOB_DIR, hash);
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await mkdir(join(stageDir, BLOB_DIR), { recursive: true });
    await writeFileAtomic(path, data, { root: stageDir });
  }
  return hash;
}

/** A body stored by putBlob. Throws when it is missing or its name is not a hash. */
export async function getBlob(stageDir: string, hash: string): Promise<Buffer> {
  if (!HASH.test(hash)) throw new Error(`staged blob name is not a content hash: ${hash.slice(0, 80)}`);
  return readFile(join(stageDir, BLOB_DIR, hash));
}

/** Writes a staged page's JSON atomically. */
export async function writeStagedJson(stageDir: string, file: string, value: unknown): Promise<void> {
  await mkdir(stageDir, { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(value)}\n`, { root: stageDir });
}

/** Reads a staged page's JSON; undefined when there is none or it does not parse (a torn write is measured again). */
export async function readStagedJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Removes the stage folder of a run once every measured page is complete. */
export async function removeStage(stageDir: string): Promise<void> {
  await rm(stageDir, { recursive: true, force: true });
}
