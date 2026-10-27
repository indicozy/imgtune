import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDone, loadState, saveState, type StateEntry } from "../src/state.js";

const entry = (usageId: string, fileHash: string, quality?: number): StateEntry => ({
  usageId,
  relFile: "src/A.tsx",
  component: "A",
  fileHash,
  applied: { sizes: "33vw", ...(quality === undefined ? {} : { quality }) },
  at: "2026-10-28T00:00:00.000Z",
});

describe("state file", () => {
  it("loads nothing when the file does not exist", async () => {
    expect(await loadState(mkdtempSync(join(tmpdir(), "imgtune-state-")))).toEqual([]);
  });

  it("round-trips entries and replaces an entry with the same usageId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgtune-state-"));
    await saveState(dir, [entry("src/A.tsx:4:10", "h1"), entry("src/B.tsx:1:1", "h2")]);
    await saveState(dir, [entry("src/A.tsx:4:10", "h3", 62)]);

    const loaded = await loadState(dir);
    // The replaced entry keeps its position; the new one is written in place of the old.
    expect(loaded).toEqual([entry("src/A.tsx:4:10", "h3", 62), entry("src/B.tsx:1:1", "h2")]);
    const onDisk = JSON.parse(readFileSync(join(dir, "imgtune.state.json"), "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.entries).toHaveLength(2);
  });

  it("isDone is true only while the file hash matches", () => {
    const e = entry("src/A.tsx:4:10", "h1");
    expect(isDone(e, "h1")).toBe(true);
    expect(isDone(e, "h2")).toBe(false);
    expect(isDone(undefined, "h1")).toBe(false);
  });

  it("rejects an unknown format", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgtune-state-"));
    writeFileSync(join(dir, "imgtune.state.json"), JSON.stringify({ version: 2, entries: [] }));
    await expect(loadState(dir)).rejects.toThrow("unsupported format");
  });
});
