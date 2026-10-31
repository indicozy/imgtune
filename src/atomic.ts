import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";

export function sha1(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

export interface WriteOptions {
  /** Project root. Every write must land inside it, after symlinks are resolved. */
  root: string;
  /** Permission bits for a file this call creates. An existing file keeps its own. */
  mode?: number;
  /** fsync the temp file before the rename, for files a crash must not leave short. */
  sync?: boolean;
}

const isNotFound = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/** True when `path` is `root` (if allowed) or lies below it. Both paths must already be resolved. */
function inside(root: string, path: string, allowRoot: boolean): boolean {
  const rel = relative(root, path);
  if (rel === "") return allowRoot;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The file a write lands in. The parent directory must resolve inside the root. A symlink at `path` is refused.
 */
async function resolveWriteTarget(path: string, opts: WriteOptions): Promise<string> {
  const rootReal = await realpath(opts.root);
  const parentReal = await realpath(dirname(path));
  if (!inside(rootReal, parentReal, true)) throw new Error(`refusing to write outside the project: ${path}`);
  const plain = join(parentReal, basename(path));

  const info = await lstat(path).catch((err: unknown) => {
    if (isNotFound(err)) return undefined;
    throw err;
  });
  if (info?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${path}`);
  return plain;
}

/**
 * Writes `data` to a sibling temp file, then renames it over the target, so a crash never leaves a half-written file.
 * The temp name is random and created exclusively, so concurrent writers never share one. An existing file keeps its
 * permission bits. Symlinks are refused.
 */
export async function writeFileAtomic(path: string, data: string | Buffer, opts: WriteOptions): Promise<void> {
  const target = await resolveWriteTarget(path, opts);
  const mode = await stat(target).then(
    (s) => s.mode & 0o777,
    () => opts.mode,
  );
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(tmp, "wx");
    // Only a temp file this call created may be removed on failure.
    created = true;
    if (mode !== undefined) await handle.chmod(mode);
    await handle.writeFile(typeof data === "string" ? Buffer.from(data, "utf8") : data);
    if (opts.sync) await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, target);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
