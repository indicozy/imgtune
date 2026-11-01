import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerLineOf, parseReportArgs, readLedger, renderReport, type LedgerLine } from "../src/report.js";
import type { CompareReport } from "../src/compare.js";

const line = (over: Partial<LedgerLine> & { id: string; status: LedgerLine["status"] }): LedgerLine => ({
  file: "src/Card.tsx:42",
  rung: "measured-page",
  fix: "sizes; quality 75",
  ...over,
});

const compare: CompareReport = {
  before: "https://shop.example/bags",
  after: "https://shop.example/bags",
  views: ["iphone-15", "desktop"],
  paired: { images: 12, beforeBytes: 300 * 1024, afterBytes: 250 * 1024, saved: 60 * 1024, addedForSharpness: 4 * 1024, grewWithoutSharpness: { images: 1, bytes: 1024 } },
  pageTotal: { before: 500 * 1024, after: 460 * 1024 },
  appeared: [{ id: "n1", where: "x", bytes: 1, views: 2 }],
  disappeared: [],
  changes: [],
  dropped: { before: 0, after: 0 },
};

describe("parseReportArgs", () => {
  it("defaults the ledger, and reads the compare file and the output", () => {
    expect(parseReportArgs([])).toEqual({ ledger: ".imgtune/ledger.jsonl" });
    expect(parseReportArgs(["--compare", "c.json", "--out", "r.md"])).toEqual({ ledger: ".imgtune/ledger.jsonl", compare: "c.json", out: "r.md" });
    expect(() => parseReportArgs(["--gpu"])).toThrow(/Unknown option/);
    expect(() => parseReportArgs(["--out"])).toThrow(/needs a value/);
  });
});

describe("ledgerLineOf", () => {
  it("keeps a line with an id and a known status, and refuses the rest", () => {
    expect(ledgerLineOf({ id: "0763e0f5e352", file: "a.tsx:1", rung: "measured-page", fix: "sizes", status: "verified", verified: true })).toMatchObject({ id: "0763e0f5e352", status: "verified", verified: true });
    expect(ledgerLineOf({ id: "bad id!", status: "verified" })).toBeUndefined();
    expect(ledgerLineOf({ id: "ok", status: "done" })).toBeUndefined();
    expect(ledgerLineOf({ id: "ok", status: "fixed", file: "x".repeat(400) })?.file).toBe("");
    expect(ledgerLineOf(null)).toBeUndefined();
  });
});

describe("readLedger", () => {
  it("reads the usable lines and counts the others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imgtune-ledger-"));
    await writeFile(
      join(dir, "ledger.jsonl"),
      [
        JSON.stringify({ id: "a1", status: "verified", file: "a.tsx:1", rung: "measured-page", fix: "sizes", verified: true }),
        "{not json",
        JSON.stringify({ id: "a2", status: "nope" }),
        "",
        JSON.stringify({ id: "a3", status: "reverted", reason: "recheck failed: bytes rose" }),
      ].join("\n"),
    );
    const read = await readLedger("ledger.jsonl", dir);
    expect(read.lines.map((l) => l.id)).toEqual(["a1", "a3"]);
    expect(read.dropped).toBe(2);
  });
});

describe("renderReport", () => {
  it("counts the statuses and prints the bytes from the compare file", () => {
    const md = renderReport(
      [line({ id: "a", status: "verified" }), line({ id: "b", status: "fixed" }), line({ id: "c", status: "reverted", reason: "undersized" }), line({ id: "d", status: "reported", fix: "image file 68 KB to 11 KB" })],
      1,
      compare,
    );
    expect(md).toContain("| applied (in place now: fixed, verified or failed) | 2 |");
    expect(md).toContain("| reverted | 1 |");
    expect(md).toContain("| extras reported (not applied) | 1 |");
    expect(md).toContain("1 line(s) not usable and left out");
    expect(md).toContain("| saved | 60.0 KB |");
    expect(md).toContain("| added for sharpness | 4.0 KB |");
    expect(md).toContain("Not counted: 1 image(s) appeared and 0 disappeared.");
  });

  it("prints a reverted usage with its reason", () => {
    const md = renderReport([line({ id: "r1", status: "reverted", reason: "carousel sizes raised bytes 51 -> 63 KB" })], 0, undefined);
    expect(md).toContain("## Reverted");
    expect(md).toContain("`carousel sizes raised bytes 51 -> 63 KB`");
    expect(md).toContain("No compare file given");
  });

  it("escapes page-derived text: no HTML, no link, no mention, no table break", () => {
    const hostile = line({ id: "h1", status: "reverted", file: "a|b<img src=x onerror=alert(1)>.tsx:1", reason: "[click](https://evil.example) @maintainer `code` `" });
    const md = renderReport([hostile], 0, undefined);
    const rows = md.split("\n").filter((l) => l.startsWith("| `h1`"));
    expect(rows).toHaveLength(1);
    expect(md).not.toContain("<img");
    // A link or a mention is only text inside a code span: the span holds it, so nothing renders as one.
    expect(rows[0]).toMatch(/`[^`]*\[click\]\(https:\/\/evil\.example\)[^`]*`/);
    expect(rows[0]).toMatch(/`[^`]*@maintainer[^`]*`/);
    // The pipe in the file name is escaped, so the row keeps its four cells.
    expect(rows[0]).toContain("\\|");
    expect(rows[0].split(" | ")).toHaveLength(4);
  });
});
