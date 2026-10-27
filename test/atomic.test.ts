import { describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/atomic.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "imgtune-atomic-"));

describe("writeFileAtomic", () => {
  it("writes a plain file inside the root", async () => {
    const root = tempDir();
    const file = join(root, "report.json");
    writeFileSync(file, "old");

    await writeFileAtomic(file, "new", { root });

    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it("refuses a symlink for tool-owned files and leaves the target untouched", async () => {
    const root = tempDir();
    const outside = join(tempDir(), "bashrc");
    writeFileSync(outside, "original");
    const link = join(root, "imgtune.state.json");
    symlinkSync(outside, link);

    await expect(writeFileAtomic(link, "{}", { root })).rejects.toThrow(/refusing to write through symlink/);

    expect(readFileSync(outside, "utf8")).toBe("original");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(root)).toEqual(["imgtune.state.json"]);
  });

  it("writes a source file through a symlink whose target is inside the root", async () => {
    const root = tempDir();
    const real = join(root, "src", "real.tsx");
    mkdirSync(join(root, "src"));
    writeFileSync(real, "old");
    const link = join(root, "src", "link.tsx");
    symlinkSync(real, link);

    await writeFileAtomic(link, "new", { root, followSymlink: true });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("new");
  });

  it("refuses to write a source file through a symlink that points outside the root", async () => {
    const root = tempDir();
    const outside = join(tempDir(), "outside.tsx");
    writeFileSync(outside, "original");
    const link = join(root, "link.tsx");
    symlinkSync(outside, link);

    await expect(writeFileAtomic(link, "new", { root, followSymlink: true })).rejects.toThrow(
      /refusing to write outside the project/,
    );

    expect(readFileSync(outside, "utf8")).toBe("original");
  });

  it("refuses a path whose parent directory resolves outside the root", async () => {
    const root = tempDir();
    const outsideDir = tempDir();
    symlinkSync(outsideDir, join(root, ".imgtune"));

    await expect(writeFileAtomic(join(root, ".imgtune", "report.json"), "{}", { root })).rejects.toThrow(
      /refusing to write outside the project/,
    );

    expect(readdirSync(outsideDir)).toEqual([]);
  });

  it("lets concurrent writes to one file all succeed, last wins, and leaves no temp file", async () => {
    const root = tempDir();
    const target = join(root, "file.txt");
    writeFileSync(target, "seed");
    const contents = Array.from({ length: 8 }, (_, i) => `v${i}`);

    await Promise.all(contents.map((c) => writeFileAtomic(target, c, { root })));

    expect(contents).toContain(readFileSync(target, "utf8"));
    expect(readdirSync(root)).toEqual(["file.txt"]);
  });
});
