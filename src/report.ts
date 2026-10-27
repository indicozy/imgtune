import { readFile, mkdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ComponentResult } from "./analyse.js";
import { sha1, writeFileAtomic } from "./atomic.js";
import type { ImageConfig } from "./nextconfig.js";
import type { ImgtuneConfig } from "./types.js";

const REPORT_DIR = ".imgtune";
const REPORT_FILE = "report.json";

export interface ReportMeta {
  config: ImgtuneConfig;
  imageConfig: ImageConfig;
  sitemapSource?: string;
}

export interface Report {
  version: 1;
  createdAt: string;
  project: string;
  config: ImgtuneConfig;
  imageConfig: ImageConfig;
  sitemapSource?: string;
  /** sha1 of each file with a result, plus the next.config file, at write time. */
  fileHashes: Record<string, string>;
  results: ComponentResult[];
}

const measured = (r: ComponentResult): boolean => r.current.medianBytes !== undefined;

/** Measured rows by saved bytes, descending; not-measured rows last. Ties keep their input order. */
export function rank(results: ComponentResult[]): ComponentResult[] {
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      const am = measured(a.result);
      const bm = measured(b.result);
      if (am !== bm) return am ? -1 : 1;
      if (a.result.savedBytesTotal !== b.result.savedBytesTotal) {
        return b.result.savedBytesTotal - a.result.savedBytesTotal;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.result);
}

const kb = (bytes: number | undefined): string => (bytes === undefined ? "-" : (bytes / 1024).toFixed(1));
const change = (now: string, next: string | undefined): string => (next === undefined ? now : `${now} -> ${next}`);

/** Plain-text table, one row per result in rank order, fixed-width columns. */
export function renderTable(results: ComponentResult[]): string {
  const header = [
    "#",
    "component",
    "file:line",
    "instances",
    "sizes now -> new",
    "quality now -> new",
    "KB/img now -> new",
    "saved KB",
    "SSIM",
    "est./exact",
    "notes",
  ];
  const rows = rank(results).map((r, i) => {
    const isMeasured = measured(r);
    return [
      String(i + 1),
      r.component,
      `${r.relFile}:${r.line}`,
      String(r.instances),
      change(r.current.sizes ?? "-", r.proposed.sizes),
      change(String(r.current.quality), r.proposed.quality === undefined ? undefined : String(r.proposed.quality)),
      change(kb(r.current.medianBytes), r.proposed.projectedBytes === undefined ? undefined : kb(r.proposed.projectedBytes)),
      isMeasured ? kb(r.savedBytesTotal) : "-",
      r.proposed.ssim === undefined ? "-" : r.proposed.ssim.toFixed(3),
      isMeasured ? (r.estimated ? "est." : "exact") : "-",
      r.notes.join("; "),
    ];
  });
  const table = [header, ...rows];
  const widths = header.map((_, col) => Math.max(...table.map((row) => row[col].length)));
  const line = (row: string[]) => row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(header), rule, ...rows.map(line)].join("\n") + "\n";
}

/** Writes `.imgtune/report.json` with the sha1 of every file the results touch. */
export async function writeReport(projectDir: string, results: ComponentResult[], meta: ReportMeta): Promise<void> {
  const fileHashes: Record<string, string> = {};
  const relFiles = new Set(results.map((r) => r.relFile));
  if (meta.imageConfig.file) relFiles.add(toPosix(relative(projectDir, meta.imageConfig.file)));
  for (const relFile of relFiles) {
    fileHashes[relFile] = sha1(await readFile(join(projectDir, relFile)));
  }
  const report: Report = {
    version: 1,
    createdAt: new Date().toISOString(),
    project: projectDir,
    config: meta.config,
    imageConfig: meta.imageConfig,
    sitemapSource: meta.sitemapSource,
    fileHashes,
    results,
  };
  const dir = join(projectDir, REPORT_DIR);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
}

export async function readReport(projectDir: string): Promise<Report> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, REPORT_DIR, REPORT_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("no audit report found; run imgtune audit");
    }
    throw err;
  }
  const report = JSON.parse(raw) as Report;
  if (report.version !== 1) throw new Error(`${REPORT_DIR}/${REPORT_FILE}: unsupported version ${report.version}`);
  return report;
}

const toPosix = (path: string): string => path.split(sep).join("/");
