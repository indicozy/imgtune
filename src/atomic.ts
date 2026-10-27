import { createHash, randomBytes } from "node:crypto";
import { open, realpath, rename, stat, unlink } from "node:fs/promises";

export function sha1(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/**
 * Writes `data` to a sibling temp file, then renames it over the target, so a crash never leaves a half-written file.
 * A symlink is followed: its target is replaced and the link stays. The target's permission bits are kept. The temp
 * name is random and created exclusively, so concurrent writers never share a temp file.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const target = await realpath(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return path;
    throw err;
  });
  const mode = await stat(target).then(
    (s) => s.mode & 0o777,
    () => undefined,
  );
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, "wx");
    if (mode !== undefined) await handle.chmod(mode);
    await handle.writeFile(data, "utf8");
    await handle.close();
    handle = undefined;
    await rename(tmp, target);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
