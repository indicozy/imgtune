// Where a project file (a path such as src/a.tsx, as a source map gives it) is read from when a scan checks its source.
// A scan run from a sub-folder (an app inside a monorepo) used to look for src/a.tsx under that folder and found nothing,
// so every source came out `unread`. The folder is now chosen per file: --root when given, else the nearest folder above
// the scan's cwd that holds the file, else the nearest one with a project marker. A file that is still not found is
// reported with the folder it was looked up in.

import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { safeText } from "./text.js";

/** Files that mark a project's root when no folder above the cwd holds the file. */
export const PROJECT_MARKERS: readonly string[] = ["package.json", ".git"];

/** How many unread files the note names in full (the rest are counted). */
const NOTE_FILES = 10;

async function kindAt(path: string): Promise<"file" | "dir" | undefined> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return "dir";
    return info.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/** The folder `start` and then each of its ancestors, nearest first. */
export function ancestorsOf(start: string): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/**
 * The folder the project file is read from. `explicit` (the absolute --root) wins. Otherwise: the nearest folder among
 * `start` and its ancestors that holds the file; when none does, the nearest one with a project marker; when none has
 * either, `start` itself.
 */
export async function sourceRootOf(start: string, file: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) return resolve(explicit);
  const folders = ancestorsOf(start);
  for (const dir of folders) {
    if ((await kindAt(join(dir, file))) === "file") return dir;
  }
  for (const dir of folders) {
    for (const marker of PROJECT_MARKERS) {
      if ((await kindAt(join(dir, marker))) !== undefined) return dir;
    }
  }
  return resolve(start);
}

/**
 * The line that says which sources were not read and why, or undefined when there are none. A file that is absent from
 * its root is named with that root; a file that is there but too large or unreadable is said so.
 */
export async function unreadSourceNote(files: readonly string[], start: string, explicit?: string): Promise<string | undefined> {
  const unique = [...new Set(files)];
  if (unique.length === 0) return undefined;
  const parts: string[] = [];
  for (const file of unique.slice(0, NOTE_FILES)) {
    const root = await sourceRootOf(start, file, explicit);
    const present = (await kindAt(join(root, file))) === "file";
    parts.push(`${safeText(file)} (${present ? "too large or unreadable" : `not found under ${safeText(root)}`})`);
  }
  const more = unique.length > NOTE_FILES ? `, and ${unique.length - NOTE_FILES} more` : "";
  return `unread: ${unique.length} source file(s) could not be read: ${parts.join(", ")}${more}. Run from the project root, or pass --root <dir>.\n`;
}

/** Whether `path` is an existing folder (for checking --root). */
export async function isFolder(path: string): Promise<boolean> {
  return (await kindAt(path)) === "dir";
}
