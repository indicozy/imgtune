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
      result({
        usageId: "a",
        savedBytesTotal: 2048,
        notes: ["n1", "n2"],
        current: { quality: 75, medianBytes: 100 * 1024, bytesByViewport: { "iphone-15": 100 * 1024 } },
        proposed: { width: 160, projectedBytes: 60 * 1024, bytesByViewport: { "iphone-15": 60 * 1024 } },
        mobileViewports: ["iphone-15"],
      }),
    ]);
    const [header, rule, row] = table.trimEnd().split("\n");
    expect(header).toMatch(/^#\s+component\s+file:line\s+instances\s+sizes now -> new/);
    expect(header).toContain("phone KB now -> new");
    expect(header).toContain("desktop KB now -> new");
    expect(header).not.toContain("KB/img");
    expect(rule).toMatch(/^-+/);
    expect(row).toContain("est.");
    expect(row).toContain("src/Card.tsx:3");
    expect(row).toContain("100.0 -> 60.0");
    expect(row).toContain("2.0");
    expect(row).toContain("n1; n2");
  });

  it("fills the phone and desktop columns from each viewport and shows growth as +KB grow", () => {
    const table = renderTable([
      result({
        usageId: "a",
        savedBytesTotal: -3.1 * 1024,
        current: {
          quality: 75,
          medianBytes: 100 * 1024,
          bytesByViewport: { "iphone-15": 100 * 1024, desktop: 200 * 1024 },
        },
        proposed: { width: 160, bytesByViewport: { "iphone-15": 60 * 1024, desktop: 215 * 1024 } },
        mobileViewports: ["iphone-15"],
      }),
    ]);
    const row = table.trimEnd().split("\n")[2];
    expect(row).toContain("100.0 -> 60.0");
    expect(row).toContain("200.0 -> 215.0");
    expect(row).toContain("+3.1 grow");
  });

  it("uses the first mobile viewport as the phone when iphone-15 is not measured", () => {
    const table = renderTable([
      result({
        usageId: "a",
        current: { quality: 75, bytesByViewport: { "pixel-7": 50 * 1024, desktop: 80 * 1024 } },
        proposed: { width: 160, bytesByViewport: { "pixel-7": 40 * 1024 } },
        mobileViewports: ["pixel-7"],
      }),
    ]);
    const row = table.trimEnd().split("\n")[2];
    expect(row).toContain("50.0 -> 40.0");
    expect(row).toContain("80.0");
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

  it("rejects a report whose proposed quality or sizes is not safe to write into source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgtune-report-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "Card.tsx"), "export const x = 1;\n");
    const imageConfig = readImageConfig(dir);
    const write = (proposed: Partial<ComponentResult["proposed"]>) =>
      writeReport(dir, [result({ usageId: "src/Card.tsx:3:1", proposed: { width: 160, ...proposed } })], {
        config,
        imageConfig,
      });

    const bad: Partial<ComponentResult["proposed"]>[] = [
      { quality: 1000 },
      { quality: 0 },
      { quality: 2.5 },
      { quality: "85" as unknown as number },
      { sizes: 33 as unknown as string },
    ];
    for (const proposed of bad) {
      await write(proposed);
      await expect(readReport(dir)).rejects.toThrow(/invalid report .*src\/Card\.tsx:3/);
    }

    await write({ quality: 85, sizes: "33vw" });
    expect((await readReport(dir)).results[0].proposed.quality).toBe(85);
  });

  it("rejects a sizes or sizesFull that is not a sizes value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgtune-report-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "Card.tsx"), "export const x = 1;\n");
    const imageConfig = readImageConfig(dir);
    const injected = 'x" onError={alert(1)}';
    for (const proposed of [{ sizesFull: injected }, { sizes: injected }, { sizes: "(orientation: landscape) 50vw" }]) {
      await writeReport(dir, [result({ usageId: "src/Card.tsx:3:1", proposed: { width: 160, ...proposed } })], {
        config,
        imageConfig,
      });
      await expect(readReport(dir)).rejects.toThrow(/invalid report .*src\/Card\.tsx:3.*is not a sizes value/);
    }

    await writeReport(dir, [result({ usageId: "src/Card.tsx:3:1", proposed: { width: 160, sizes: "(max-width: 768px) 33vw, 280px", sizesFull: "calc(50vw - 20px)" } })], {
      config,
      imageConfig,
    });
    expect((await readReport(dir)).results[0].proposed.sizesFull).toBe("calc(50vw - 20px)");
  });

  it("throws when no report exists", async () => {
    await expect(readReport(mkdtempSync(join(tmpdir(), "imgtune-report-")))).rejects.toThrow(
      "no audit report found; run imgtune audit",
    );
  });
});
