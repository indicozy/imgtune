import { describe, expect, it } from "vitest";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/atomic.js";

describe("writeFileAtomic", () => {
  it("replaces the target of a symlink and leaves the link in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgtune-atomic-"));
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    writeFileSync(real, "old");
    symlinkSync(real, link);

    await writeFileAtomic(link, "new");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("new");
  });

  it("lets concurrent writes to one file all succeed, last wins, and leaves no temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgtune-atomic-"));
    const target = join(dir, "file.txt");
    writeFileSync(target, "seed");
    const contents = Array.from({ length: 8 }, (_, i) => `v${i}`);

    await Promise.all(contents.map((c) => writeFileAtomic(target, c)));

    expect(contents).toContain(readFileSync(target, "utf8"));
    expect(readdirSync(dir)).toEqual(["file.txt"]);
  });
});
