import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { scanFile } from "./scan.js";
import type { ImageUsage } from "./types.js";

/** Files `next dev` may rewrite; backed up with the instrumented files when present. */
const SIDE_FILES = ["next-env.d.ts", "tsconfig.json"];
const UNWRAP_STATIC_IMPORT = `((s) => typeof s === "object" && s ? s.src : s)`;
const STATE_DIR = ".imgtune";
/** Tool-owned directories that must never be symlinks. */
const STATE_SUBDIRS = [
  STATE_DIR,
  `${STATE_DIR}/backup`,
  `${STATE_DIR}/backup/files`,
  `${STATE_DIR}/backup/conflicts`,
];

interface ManifestEntry {
  /** Project-relative path, `/`-separated. */
  file: string;
  /** Equal to `file`; the copy lives at files/<backup>. */
  backup: string;
  /** False when the file did not exist before the run; restore deletes it. */
  existed: boolean;
  /** sha1 of the content instrument wrote. Absent for side files. */
  instrumentedSha1?: string;
}

interface Manifest {
  version: 1;
  createdAt: string;
  entries: ManifestEntry[];
}

function layout(root: string) {
  const backupDir = join(root, STATE_DIR, "backup");
  return {
    backupDir,
    manifest: join(backupDir, "manifest.json"),
    lastRestored: join(backupDir, "last-restored.json"),
    files: join(backupDir, "files"),
    lastRestoredFiles: join(backupDir, "last-restored-files"),
    conflicts: join(backupDir, "conflicts"),
  };
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function sha1(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** True when `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function strictlyWithin(parent: string, child: string): boolean {
  return relative(parent, child) !== "" && within(parent, child);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function assertNoSymlinks(root: string): void {
  for (const rel of STATE_SUBDIRS) {
    if (isSymlink(join(root, ...rel.split("/")))) {
      throw new Error(`refusing to use ${rel}: it is a symlink`);
    }
  }
}

/**
 * Real location of `abs`, following symlinks. A path that does not exist yet resolves
 * through its nearest existing ancestor; a dangling symlink is an error.
 */
function realLocation(abs: string): string {
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch (err) {
      if (!isNotFound(err) || isSymlink(current)) throw err;
    }
    tail.unshift(basename(current));
    current = dirname(current);
  }
}

/** Throws unless `target` resolves (following symlinks) inside `base`. */
function assertWithin(base: string, target: string): void {
  if (!within(realpathSync(base), realLocation(target))) {
    throw new Error(`refusing to write outside ${toPosix(base)}: ${target}`);
  }
}

/** Project-relative POSIX path of a file that must live inside the project. */
function projectRel(root: string, file: string): string {
  if (!strictlyWithin(root, file) || relative(root, file).split(sep)[0] === STATE_DIR) {
    throw new Error(`cannot back up a file outside the project: ${file}`);
  }
  return toPosix(relative(root, file));
}

function copyPath(root: string, entry: ManifestEntry): string {
  return join(layout(root).files, ...entry.backup.split("/"));
}

function invalidManifest(path: string, reason: string): never {
  throw new Error(`invalid imgtune manifest ${path}: ${reason}`);
}

function parseManifestJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return invalidManifest(path, "not JSON");
  }
}

/**
 * The manifest lives in the project and may be hand-edited or shipped by a repo, so
 * every entry is checked before any file is touched.
 */
function validateEntry(root: string, realRoot: string, entry: unknown, path: string): void {
  const e = entry as Partial<ManifestEntry> | null;
  if (
    !e ||
    typeof e !== "object" ||
    typeof e.file !== "string" ||
    typeof e.backup !== "string" ||
    typeof e.existed !== "boolean"
  ) {
    invalidManifest(path, "malformed entry");
  }
  if (e.instrumentedSha1 !== undefined && typeof e.instrumentedSha1 !== "string") {
    invalidManifest(path, `${e.file}: bad instrumentedSha1`);
  }
  if (isAbsolute(e.file)) invalidManifest(path, `${e.file} is an absolute path`);
  const abs = resolve(root, e.file);
  if (!strictlyWithin(root, abs) || relative(root, abs).split(sep)[0] === STATE_DIR) {
    invalidManifest(path, `${e.file} is outside the project`);
  }
  const rel = toPosix(relative(root, abs));
  if (e.file !== rel || e.backup !== rel) {
    invalidManifest(path, `${e.file} is not a normalized project path`);
  }
  let real: string;
  try {
    real = realLocation(abs);
  } catch (err) {
    invalidManifest(path, `${e.file}: ${(err as Error).message}`);
  }
  if (!within(realRoot, real)) invalidManifest(path, `${e.file} resolves outside the project`);
}

function validateManifest(root: string, raw: string, path: string): Manifest {
  const data = parseManifestJson(raw, path) as Partial<Manifest> | null;
  if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.entries)) {
    invalidManifest(path, "unsupported version or shape");
  }
  const realRoot = realpathSync(root);
  for (const entry of data.entries) validateEntry(root, realRoot, entry, path);
  return data as Manifest;
}

async function readManifest(root: string): Promise<Manifest | undefined> {
  const path = layout(root).manifest;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  return validateManifest(root, raw, path);
}

function readManifestSync(root: string): Manifest | undefined {
  const path = layout(root).manifest;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  return validateManifest(root, raw, path);
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

/** Temp file + fsync + rename, so a crash never leaves a half-written manifest. */
async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  await writeFileAtomic(layout(root).manifest, `${JSON.stringify(manifest, null, 2)}\n`, { root, sync: true });
}

/** Synchronous write that refuses to follow a symlink out of `base`. */
function writeWithin(base: string, target: string, data: Buffer | string): void {
  mkdirSync(dirname(target), { recursive: true });
  assertWithin(base, target);
  writeFileSync(target, data);
}

/**
 * Adds files to the open backup manifest (creating the manifest if none is open).
 * A file that already has an entry keeps its first copy, which is the pristine one.
 */
export async function backupFiles(projectDir: string, files: string[]): Promise<void> {
  const root = resolve(projectDir);
  assertNoSymlinks(root);
  const paths = layout(root);
  await mkdir(paths.backupDir, { recursive: true });

  let manifest = await readManifest(root);
  if (!manifest) {
    manifest = { version: 1, createdAt: new Date().toISOString(), entries: [] };
    await writeManifest(root, manifest);
  }

  for (const file of new Set(files.map((f) => resolve(root, f)))) {
    const rel = projectRel(root, file);
    if (manifest.entries.some((e) => e.file === rel)) continue;

    const entry: ManifestEntry = { file: rel, backup: rel, existed: true };
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
      assertWithin(paths.files, copy);
      await writeDurable(copy, bytes);
    }
    manifest.entries.push(entry);
    await writeManifest(root, manifest);
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Attributes inserted right after the tag name of one `<Image>` / `<img>`. `text` is the
 * file as scanned, so the raw attribute source is available.
 */
function instrumentationFor(usage: ImageUsage, text: string): string {
  let out = ` data-imgtune="${escapeAttr(usage.id)}"`;
  const src = usage.props.src;
  if (src.kind === "literal" && typeof src.value === "string") {
    const attr = text.slice(src.start, src.end);
    const value = attr.slice(attr.indexOf("=") + 1).trimStart();
    if (value.startsWith('"') || value.startsWith("'")) {
      // JSX keeps the entity text of a string attribute raw, and so does the recorded value.
      out += ` data-imgtune-src="${value.slice(1, -1).replace(/"/g, "&quot;")}"`;
    } else {
      // `{"..."}`: a JS string, so its characters are escaped for the attribute.
      out += ` data-imgtune-src="${escapeAttr(src.value)}"`;
    }
  } else if (src.kind === "expression" && usage.srcExpressionText !== undefined) {
    out += ` data-imgtune-src={${UNWRAP_STATIC_IMPORT}((${usage.srcExpressionText}))}`;
  }
  return out;
}

function instrumentText(text: string, usages: ImageUsage[]): string {
  let out = text;
  for (const usage of [...usages].sort((a, b) => b.tagNameEnd - a.tagNameEnd)) {
    const at = usage.tagNameEnd;
    out = out.slice(0, at) + instrumentationFor(usage, text) + out.slice(at);
  }
  return out;
}

function sameUsage(a: ImageUsage, b: ImageUsage): boolean {
  return (
    a.id === b.id &&
    a.tagNameEnd === b.tagNameEnd &&
    a.srcExpressionText === b.srcExpressionText &&
    JSON.stringify(a.props) === JSON.stringify(b.props)
  );
}

async function recordInstrumented(root: string, file: string, hash: string): Promise<void> {
  const rel = projectRel(root, file);
  const manifest = await readManifest(root);
  const entry = manifest?.entries.find((e) => e.file === rel);
  if (!manifest || !entry) throw new Error(`no manifest entry for ${rel}`);
  entry.instrumentedSha1 = hash;
  await writeManifest(root, manifest);
}

/**
 * Backs up every file it will touch (plus the side files), then inserts the instrumentation
 * attributes. Every file is validated against a fresh scan before anything is backed up or written.
 */
export async function instrument(projectDir: string, usages: ImageUsage[]): Promise<void> {
  const root = resolve(projectDir);
  assertNoSymlinks(root);
  if (existsSync(layout(root).manifest)) {
    throw new Error(
      `previous run not restored: ${layout(root).manifest} exists; run restore first`,
    );
  }

  const byFile = new Map<string, ImageUsage[]>();
  for (const usage of usages) {
    const file = resolve(root, usage.file);
    byFile.set(file, [...(byFile.get(file) ?? []), usage]);
  }

  // A symlinked file is written through to its target, so the target must be inside the project too.
  const realRoot = realpathSync(root);
  for (const file of byFile.keys()) {
    if (!within(realRoot, realpathSync(file))) {
      throw new Error(`refusing to instrument a file outside the project: ${file}`);
    }
  }

  // Validate every file first: the text must be the same before and after the scan, and
  // every usage must still sit at the offsets it was scanned with.
  const originals = new Map<string, string>();
  for (const [file, list] of byFile) {
    const before = await readFile(file, "utf8");
    const fresh = scanFile(file, root);
    const after = await readFile(file, "utf8");
    const unchanged =
      before === after &&
      list.every((usage) => {
        const match = fresh.find((f) => f.id === usage.id);
        return match !== undefined && sameUsage(usage, match);
      });
    if (!unchanged) throw new Error(`file changed since scan: ${list[0].relFile}`);
    originals.set(file, before);
  }

  const sideFiles = SIDE_FILES.map((name) => join(root, name)).filter((p) => existsSync(p));
  await backupFiles(root, [...byFile.keys(), ...sideFiles]);

  for (const [file, list] of byFile) {
    const next = instrumentText(originals.get(file) ?? "", list);
    await writeFile(file, next, "utf8");
    await recordInstrumented(root, file, sha1(next));
  }
}

/**
 * Synchronous restore, usable from process `exit` handlers. Writes every backed-up file
 * back byte-for-byte (deleting files that did not exist before), then archives the
 * manifest as `last-restored.json`. A no-op when no manifest is open.
 */
export function restoreSync(projectDir: string): { restored: string[] } {
  const root = resolve(projectDir);
  assertNoSymlinks(root);
  const paths = layout(root);
  const manifest = readManifestSync(root);
  if (!manifest) return { restored: [] };

  // Verify every backup copy before writing anything, so nothing is half-restored.
  for (const entry of manifest.entries) {
    if (!entry.existed) continue;
    if (!existsSync(copyPath(root, entry))) {
      throw new Error(`backup copy missing for ${entry.file}; manifest kept at ${paths.manifest}`);
    }
    assertWithin(paths.files, copyPath(root, entry));
  }

  // A file changed since instrument wrote it was edited during the run: keep that version.
  for (const entry of manifest.entries) {
    const target = join(root, ...entry.file.split("/"));
    if (!entry.instrumentedSha1 || !existsSync(target)) continue;
    const disk = readFileSync(target);
    if (sha1(disk) === entry.instrumentedSha1) continue;
    writeWithin(paths.conflicts, join(paths.conflicts, ...entry.file.split("/")), disk);
    process.stderr.write(
      `imgtune: ${entry.file} was edited during the run; your version is saved at .imgtune/backup/conflicts/${entry.file}\n`,
    );
  }

  for (const entry of manifest.entries) {
    const target = join(root, ...entry.file.split("/"));
    if (entry.existed) {
      writeFileSync(target, readFileSync(copyPath(root, entry)));
    } else if (existsSync(target)) {
      unlinkSync(target);
    }
  }

  // The manifest moves first: if a crash interrupts the rest, the next start is a no-op.
  renameSync(paths.manifest, paths.lastRestored);
  rmSync(paths.lastRestoredFiles, { recursive: true, force: true });
  if (existsSync(paths.files)) renameSync(paths.files, paths.lastRestoredFiles);

  return { restored: manifest.entries.map((e) => join(root, ...e.file.split("/"))) };
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
