import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";

const STATE_FILE = "imgtune.state.json";

export interface StateEntry {
  usageId: string;
  relFile: string;
  component: string;
  /** sha1 of the file content right after `apply` wrote it. */
  fileHash: string;
  applied: { sizes?: string; quality?: number };
  /** ISO time of the apply. */
  at: string;
  verification?: {
    status: "verified" | "regressed";
    at: string;
    bytes: Record<string, number>;
    ssim: { avif?: number; webp?: number };
    raiseTo?: number;
  };
}

interface StateFile {
  version: 1;
  entries: StateEntry[];
}

/** Entries of `<projectDir>/imgtune.state.json`; none when the file does not exist yet. */
export async function loadState(projectDir: string): Promise<StateEntry[]> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, STATE_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<StateFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`${STATE_FILE}: unsupported format`);
  }
  return parsed.entries;
}

/** Merges `entries` into the stored state (an entry replaces the stored one with the same usageId) and writes it. */
export async function saveState(projectDir: string, entries: StateEntry[]): Promise<void> {
  const merged = new Map<string, StateEntry>();
  for (const entry of await loadState(projectDir)) merged.set(entry.usageId, entry);
  for (const entry of entries) merged.set(entry.usageId, entry);
  const file: StateFile = { version: 1, entries: [...merged.values()] };
  await writeFileAtomic(join(projectDir, STATE_FILE), `${JSON.stringify(file, null, 2)}\n`, { root: projectDir });
}

/** True when the entry was recorded against the file content as it is now. */
export function isDone(entry: StateEntry | undefined, currentFileHash: string): boolean {
  return entry !== undefined && entry.fileHash === currentFileHash;
}
