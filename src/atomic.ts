import { createHash } from "node:crypto";
import { chmod, rename, stat, writeFile } from "node:fs/promises";

export function sha1(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/**
 * Writes `data` to a sibling temp file, then renames it over `path`, so a crash never leaves a half-written file.
 * The existing file's permission bits are kept.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, "utf8");
  const mode = await stat(path).then(
    (s) => s.mode & 0o777,
    () => undefined,
  );
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, path);
}
