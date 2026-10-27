import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ImageUsage } from "./types.js";

/** Files `next dev` may rewrite; backed up with the instrumented files when present. */
const SIDE_FILES = ["next-env.d.ts", "tsconfig.json"];
const UNWRAP_STATIC_IMPORT = `((s) => typeof s === "object" && s ? s.src : s)`;

interface ManifestEntry {
  /** Absolute path of the project file. */
  file: string;
  /** Path relative to the backup `files/` directory, always `/`-separated. */
  backup: string;
  /** False when the file did not exist before the run; restore deletes it. */
  existed: boolean;
}

interface Manifest {
  version: 1;
  createdAt: string;
  entries: ManifestEntry[];
}

function layout(projectDir: string) {
  const backupDir = join(projectDir, ".imgtune", "backup");
  return {
    manifest: join(backupDir, "manifest.json"),
    lastRestored: join(backupDir, "last-restored.json"),
    files: join(backupDir, "files"),
    lastRestoredFiles: join(backupDir, "last-restored-files"),
    backupDir,
  };
}

function copyPath(projectDir: string, entry: ManifestEntry): string {
  return join(layout(projectDir).files, ...entry.backup.split("/"));
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function parseManifest(raw: string, path: string): Manifest {
  const data = JSON.parse(raw) as Manifest;
  if (data.version !== 1 || !Array.isArray(data.entries)) {
    throw new Error(`unsupported imgtune manifest: ${path}`);
  }
  return data;
}

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    return parseManifest(await readFile(path, "utf8"), path);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

function readManifestSync(path: string): Manifest | undefined {
  try {
    return parseManifest(readFileSync(path, "utf8"), path);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

/** Write and fsync a file before anything relies on it. */
async function writeDurable(path: string, data: Buffer | string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Temp file + rename, so a crash never leaves a half-written manifest. */
async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeDurable(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(tmp, path);
}

function backupRelPath(projectDir: string, file: string): string {
  const rel = relative(projectDir, file);
  if (rel === "" || rel.startsWith("..") || resolve(projectDir, rel) !== file) {
    throw new Error(`cannot back up a file outside the project: ${file}`);
  }
  return rel.split(sep).join("/");
}

/**
 * Adds files to the open backup manifest (creating the manifest if none is open).
 * A file that already has an entry keeps its first copy, which is the pristine one.
 */
export async function backupFiles(projectDir: string, files: string[]): Promise<void> {
  const root = resolve(projectDir);
  const paths = layout(root);
  await mkdir(paths.backupDir, { recursive: true });

  let manifest = await readManifest(paths.manifest);
  if (!manifest) {
    manifest = { version: 1, createdAt: new Date().toISOString(), entries: [] };
    await writeManifest(paths.manifest, manifest);
  }

  for (const file of new Set(files.map((f) => resolve(root, f)))) {
    if (manifest.entries.some((e) => e.file === file)) continue;

    const backup = backupRelPath(root, file);
    const entry: ManifestEntry = { file, backup, existed: true };
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(file);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      entry.existed = false;
    }
    if (bytes) {
      const copy = copyPath(root, entry);
      await mkdir(dirname(copy), { recursive: true });
      await writeDurable(copy, bytes);
    }
    manifest.entries.push(entry);
    await writeManifest(paths.manifest, manifest);
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Attributes inserted right after the tag name of one `<Image>` / `<img>`. */
function instrumentationFor(usage: ImageUsage): string {
  let out = ` data-imgtune="${escapeAttr(usage.id)}"`;
  const src = usage.props.src;
  if (src.kind === "literal" && typeof src.value === "string") {
    out += ` data-imgtune-src="${escapeAttr(src.value)}"`;
  } else if (src.kind === "expression" && usage.srcExpressionText !== undefined) {
    out += ` data-imgtune-src={${UNWRAP_STATIC_IMPORT}(${usage.srcExpressionText})}`;
  }
  return out;
}

/**
 * Backs up every file it will touch (plus the side files), then inserts the
 * instrumentation attributes. Edits run from the end of each file so offsets hold.
 */
export async function instrument(projectDir: string, usages: ImageUsage[]): Promise<void> {
  const root = resolve(projectDir);
  if (existsSync(layout(root).manifest)) {
    throw new Error(
      `previous run not restored: ${layout(root).manifest} exists; run restore first`,
    );
  }

  const byFile = new Map<string, ImageUsage[]>();
  for (const usage of usages) {
    const file = resolve(root, usage.file);
    const list = byFile.get(file) ?? [];
    list.push(usage);
    byFile.set(file, list);
  }
  const sideFiles = SIDE_FILES.map((name) => join(root, name)).filter((p) => existsSync(p));
  await backupFiles(root, [...byFile.keys(), ...sideFiles]);

  for (const [file, list] of byFile) {
    let text = await readFile(file, "utf8");
    const ordered = [...list].sort((a, b) => b.tagNameEnd - a.tagNameEnd);
    for (const usage of ordered) {
      const at = usage.tagNameEnd;
      text = text.slice(0, at) + instrumentationFor(usage) + text.slice(at);
    }
    await writeFile(file, text, "utf8");
  }
}

/**
 * Synchronous restore, usable from process `exit` handlers. Writes every backed-up file
 * back byte-for-byte (deleting files that did not exist before), then archives the
 * manifest as `last-restored.json`. A no-op when no manifest is open.
 */
export function restoreSync(projectDir: string): { restored: string[] } {
  const root = resolve(projectDir);
  const paths = layout(root);
  const manifest = readManifestSync(paths.manifest);
  if (!manifest) return { restored: [] };

  // Check every backup before writing anything, so a missing copy never half-restores.
  for (const entry of manifest.entries) {
    if (entry.existed && !existsSync(copyPath(root, entry))) {
      throw new Error(`backup copy missing for ${entry.file}; manifest kept at ${paths.manifest}`);
    }
  }
  for (const entry of manifest.entries) {
    if (entry.existed) {
      writeFileSync(entry.file, readFileSync(copyPath(root, entry)));
    } else if (existsSync(entry.file)) {
      unlinkSync(entry.file);
    }
  }

  // Manifest moves first: if a crash interrupts the rest, the next start is a no-op.
  renameSync(paths.manifest, paths.lastRestored);
  rmSync(paths.lastRestoredFiles, { recursive: true, force: true });
  if (existsSync(paths.files)) renameSync(paths.files, paths.lastRestoredFiles);

  return { restored: manifest.entries.map((e) => e.file) };
}

export async function restore(projectDir: string): Promise<{ restored: string[] }> {
  return restoreSync(projectDir);
}

let activeProjectDir: string | undefined;
let handlersInstalled = false;

function restoreOnExit(): void {
  if (!activeProjectDir) return;
  try {
    restoreSync(activeProjectDir);
  } catch (err) {
    process.stderr.write(`imgtune: restore failed: ${(err as Error).message}\n`);
  }
}

/** Restores the project on exit, SIGINT, SIGTERM and uncaught exceptions. Idempotent. */
export function installRestoreHandlers(projectDir: string): void {
  activeProjectDir = resolve(projectDir);
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("exit", restoreOnExit);
  process.on("SIGINT", () => {
    restoreOnExit();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restoreOnExit();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    restoreOnExit();
    process.stderr.write(`${err.stack ?? String(err)}\n`);
    process.exit(1);
  });
}
