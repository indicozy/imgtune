import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComponentResult } from "../src/analyse.js";
import { readReport, rank, renderTable, writeReport } from "../src/report.js";
import { readImageConfig } from "../src/nextconfig.js";
import type { ImgtuneConfig } from "../src/types.js";

function result(overrides: Partial<ComponentResult> & { usageId: string }): ComponentResult {
  return {
    component: "Card",
    relFile: "src/Card.tsx",
    line: 3,
    instances: 2,
    current: { quality: 75, medianBytes: 100 * 1024, bytesByViewport: {} },
    proposed: { width: 160, projectedBytes: 60 * 1024, ssim: 0.981 },
    savedBytesTotal: 0,
    estimated: true,
    servedFormats: ["avif"],
    notes: [],
    ...overrides,
  };
}

const config = { projectDir: "/x", paths: ["src"], urls: {}, viewports: [] } as unknown as ImgtuneConfig;

describe("rank", () => {
  it("orders by saved bytes descending and puts not-measured rows last", () => {
    const ranked = rank([
      result({ usageId: "a", savedBytesTotal: 10 }),
      result({ usageId: "missing", current: { quality: 75, bytesByViewport: {} }, savedBytesTotal: 0 }),
      result({ usageId: "b", savedBytesTotal: 50 }),
      result({ usageId: "c", savedBytesTotal: 30 }),
    ]);
    expect(ranked.map((r) => r.usageId)).toEqual(["b", "c", "a", "missing"]);
  });
});

describe("renderTable", () => {
  it("shows est. for cdn rows and joins notes", () => {
    const table = renderTable([
      result({ usageId: "a", savedBytesTotal: 2048, notes: ["n1", "n2"] }),
    ]);
    const [header, rule, row] = table.trimEnd().split("\n");
    expect(header).toMatch(/^#\s+component\s+file:line\s+instances\s+sizes now -> new/);
    expect(rule).toMatch(/^-+/);
    expect(row).toContain("est.");
    expect(row).toContain("src/Card.tsx:3");
    expect(row).toContain("100.0 -> 60.0");
    expect(row).toContain("2.0");
    expect(row).toContain("n1; n2");
  });
});

describe("writeReport / readReport", () => {
  it("writes version 1 with hashes of the touched files and next.config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgtune-report-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "Card.tsx"), "export const x = 1;\n");
    writeFileSync(join(dir, "next.config.mjs"), "export default { images: {} };\n");
    const imageConfig = readImageConfig(dir);

    await writeReport(dir, [result({ usageId: "src/Card.tsx:3:1" })], { config, imageConfig, sitemapSource: "local" });
    const report = await readReport(dir);

    expect(report.version).toBe(1);
    expect(report.sitemapSource).toBe("local");
    expect(report.results).toHaveLength(1);
    expect(Object.keys(report.fileHashes).sort()).toEqual(["next.config.mjs", "src/Card.tsx"]);
    expect(report.fileHashes["src/Card.tsx"]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("throws when no report exists", async () => {
    await expect(readReport(mkdtempSync(join(tmpdir(), "imgtune-report-")))).rejects.toThrow(
      "no audit report found; run imgtune audit",
    );
  });
});
