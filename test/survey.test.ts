// `scan --survey`: the fast site-wide preset. Its settings (an explicit flag always wins), its record in the page options,
// the label on everything it prints, and the refusals that keep a survey and a full scan apart (--resume, compare, report).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { compareCommand } from "../src/compare.js";
import { reportCommand } from "../src/report.js";
import {
  parseScanArgs,
  recordOptionsOf,
  renderMarkdown,
  renderScan,
  runScan,
  sameRecordOptions,
  scanCommand,
  scanPlan,
  type PageResult,
} from "../src/remote.js";
import { SURVEY_IDLE_TIMEOUT_MS, SURVEY_PAGE_CONCURRENCY, SURVEY_VIEWPORTS, surveyNote } from "../src/survey.js";
import type { Viewport } from "../src/types.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
const URL_PATH = "/p/item";

describe("parseScanArgs for --survey", () => {
  it("is off by default and on with the flag, which takes no value", () => {
    expect(parseScanArgs(["https://a.example/"]).survey).toBeUndefined();
    const args = parseScanArgs(["https://a.example/", "--survey", "https://a.example/list"]);
    expect(args.survey).toBe(true);
    expect(args.urls).toEqual(["https://a.example/", "https://a.example/list"]);
  });
});

describe("scanPlan: the survey preset and the flags that override it", () => {
  it("is the full scan's settings when --survey is not given", () => {
    expect(scanPlan(parseScanArgs(["https://a.example/"]))).toEqual({
      viewports: undefined,
      quality: true,
      pageConcurrency: 1,
      idleTimeoutMs: 10_000,
      survey: false,
    });
  });

  it("is two viewports, no quality, four pages and a 3 s idle cap with --survey alone", () => {
    expect(SURVEY_VIEWPORTS).toEqual(["iphone-15", "desktop"]);
    expect(scanPlan(parseScanArgs(["https://a.example/", "--survey"]))).toEqual({
      viewports: ["iphone-15", "desktop"],
      quality: false,
      pageConcurrency: 4,
      idleTimeoutMs: 3000,
      survey: true,
    });
  });

  it("lets an explicit --viewports, --page-concurrency and --idle-timeout win over the preset", () => {
    const plan = scanPlan(
      parseScanArgs(["https://a.example/", "--survey", "--viewports", "pixel-7", "--page-concurrency", "2", "--idle-timeout", "8000"]),
    );
    expect(plan).toMatchObject({ viewports: ["pixel-7"], pageConcurrency: 2, idleTimeoutMs: 8000, quality: false, survey: true });
  });

  it("treats --no-quality with --survey the same as the preset, and --no-quality alone as a full scan without quality", () => {
    expect(scanPlan(parseScanArgs(["https://a.example/", "--survey", "--no-quality"])).quality).toBe(false);
    expect(scanPlan(parseScanArgs(["https://a.example/", "--no-quality"]))).toMatchObject({ quality: false, survey: false });
  });

  it("names the preset's constants as the settings it uses", () => {
    expect(SURVEY_PAGE_CONCURRENCY).toBe(4);
    expect(SURVEY_IDLE_TIMEOUT_MS).toBe(3000);
  });
});

describe("the survey label and the recorded options", () => {
  it("says what a survey result is, singular and plural", () => {
    expect(surveyNote(2)).toBe("survey: 2 viewports, exact savings only, no est.");
    expect(surveyNote(1)).toBe("survey: 1 viewport, exact savings only, no est.");
  });

  it("records survey, and the non-default cap, in the page's options; a full scan records neither", () => {
    const base = { aggressive: false, quality: false, viewports: [desktop], ignoreRobots: false, storageState: undefined, gpu: undefined };
    expect(recordOptionsOf(base)).not.toHaveProperty("survey");
    const survey = recordOptionsOf({ ...base, survey: true, idleTimeoutMs: 3000 });
    expect(survey).toMatchObject({ survey: true, idleTimeoutMs: 3000 });
  });

  it("never matches a survey record with a full one, so --resume does not reuse across them", () => {
    const base = { aggressive: false, quality: false, viewports: [desktop], ignoreRobots: false, storageState: undefined, gpu: undefined };
    const full = recordOptionsOf(base);
    const survey = recordOptionsOf({ ...base, survey: true });
    expect(sameRecordOptions(survey, survey)).toBe(true);
    expect(sameRecordOptions(full, full)).toBe(true);
    expect(sameRecordOptions(survey, full)).toBe(false);
    expect(sameRecordOptions(full, survey)).toBe(false);
  });
});

describe("--survey scans on a local page", () => {
  let base = "";
  let server: Server | undefined;
  let scratch = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "imgtune-survey-"));
    const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#6a8" } }).png().toBuffer();
    // A plain image much wider than the 320 px it is drawn at: a local resize estimate applies to it.
    const wide = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#48a" } }).jpeg({ quality: 90 }).toBuffer();
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/pic.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png);
      }
      if (url === "/wide.jpg") {
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(wide);
      }
      if (url === URL_PATH) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><img src="/pic.png" width="320" height="200" alt=""></body></html>');
      }
      if (url === "/p/wide") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><img src="/wide.jpg" width="320" height="200" alt=""></body></html>');
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  });

  /** One page's JSON in `dir`, the only file a one-page scan writes there. */
  const pageJson = async (dir: string): Promise<string> => {
    const [name] = (await readdir(dir)).filter((file) => file.endsWith(".json"));
    return join(dir, name);
  };

  const readPage = async (file: string): Promise<PageResult> => JSON.parse(await readFile(file, "utf8")) as PageResult;

  it("scans the preset's viewports with no quality, prints the label, and records survey", async () => {
    const out = join(scratch, "survey-a");
    const lines: string[] = [];
    const { output, exitCode } = await scanCommand([`${base}${URL_PATH}`, "--survey", "--out", out], scratch, (m) => lines.push(m));
    expect(exitCode).toBe(0);
    expect(output.split("\n")[0]).toBe("survey: 2 viewports, exact savings only, no est.");
    const page = await readPage(await pageJson(out));
    expect(page.viewports).toEqual(["iphone-15", "desktop"]);
    expect(page.options).toMatchObject({ survey: true, quality: false, viewports: ["iphone-15", "desktop"], idleTimeoutMs: 3000 });
    expect(page.status).toBe("ok");
  }, 120_000);

  it("makes no estimate: a survey of an oversized plain image has no est., and the full scan of it does", async () => {
    const common = { aggressive: false, quality: false, viewports: [desktop], log: () => undefined };
    const full = await runScan([`${base}/p/wide`], { ...common, outDir: join(scratch, "est-full"), cwd: scratch });
    const survey = await runScan([`${base}/p/wide`], { ...common, outDir: join(scratch, "est-survey"), cwd: scratch, survey: true });
    const fullPage = full[0].page;
    const surveyPage = survey[0].page;
    expect(fullPage?.exactEstPct).toBeGreaterThan(fullPage?.exactPct ?? 0);
    expect(surveyPage?.exactEstPct).toBe(surveyPage?.exactPct);
    expect(Object.values(full[0].perViewport).some((view) => view.estSaved > 0)).toBe(true);
    expect(Object.values(survey[0].perViewport).every((view) => view.estSaved === 0)).toBe(true);
  }, 120_000);

  it("prints no survey label, and records no survey, for a full scan", async () => {
    const out = join(scratch, "full");
    const { output } = await scanCommand([`${base}${URL_PATH}`, "--no-quality", "--viewports", "desktop", "--out", out], scratch, () => undefined);
    expect(output).not.toMatch(/^survey:/m);
    const page = await readPage(await pageJson(out));
    expect(page.options).not.toHaveProperty("survey");
  }, 120_000);

  it("labels a survey Markdown summary and the scan's printed summary, and no full one", () => {
    const page = pageResult({ options: recordOptionsOf({ aggressive: false, quality: false, viewports: [desktop], survey: true }) });
    expect(renderScan([page], false)).toMatch(/^survey: 1 viewport, exact savings only, no est\./);
    expect(renderMarkdown([page], false)).toMatch(/survey: 1 viewport, exact savings only, no est\./);
    const full = pageResult({ options: recordOptionsOf({ aggressive: false, quality: false, viewports: [desktop] }) });
    expect(renderScan([full], false)).not.toMatch(/survey/);
    expect(renderMarkdown([full], false)).not.toMatch(/survey/);
  });

  it("refuses to resume a full page as a survey, and a survey page as a full scan", async () => {
    const out = join(scratch, "resume");
    const log: string[] = [];
    const common = { outDir: out, cwd: out, aggressive: false, quality: false, log: (m: string) => log.push(m) };
    await runScan([`${base}${URL_PATH}`], { ...common, viewports: [desktop] });
    // A survey run over a full page: the page is scanned again, with a warning, and the new page is a survey.
    const [survey] = await runScan([`${base}${URL_PATH}`], { ...common, viewports: [desktop], survey: true, resume: true });
    expect(log.some((m) => /was scanned with other options/.test(m))).toBe(true);
    expect(survey.options?.survey).toBe(true);
    // And back: a full run over the survey page is scanned again, not resumed.
    log.length = 0;
    const [full] = await runScan([`${base}${URL_PATH}`], { ...common, viewports: [desktop], resume: true });
    expect(log.some((m) => /was scanned with other options/.test(m))).toBe(true);
    expect(full.options).not.toHaveProperty("survey");
    // A survey run over a survey page is resumed as it is.
    log.length = 0;
    await runScan([`${base}${URL_PATH}`], { ...common, viewports: [desktop], survey: true, resume: true });
    log.length = 0;
    await runScan([`${base}${URL_PATH}`], { ...common, viewports: [desktop], survey: true, resume: true });
    expect(log.some((m) => /^resumed /.test(m))).toBe(true);
  }, 180_000);

  it("refuses to compare a survey scan with a full scan, and compares two survey scans with the label", async () => {
    const survey1 = join(scratch, "cmp-survey-1");
    const survey2 = join(scratch, "cmp-survey-2");
    const full = join(scratch, "cmp-full");
    const args = (out: string, extra: string[]) => [`${base}${URL_PATH}`, "--out", out, "--no-quality", "--viewports", "desktop", ...extra];
    await scanCommand(args(survey1, ["--survey", "--viewports", "desktop"]), scratch, () => undefined);
    await scanCommand(args(survey2, ["--survey", "--viewports", "desktop"]), scratch, () => undefined);
    await scanCommand(args(full, []), scratch, () => undefined);
    const survey1Json = await pageJson(survey1);
    const survey2Json = await pageJson(survey2);
    const fullJson = await pageJson(full);

    await expect(compareCommand([survey1Json, fullJson], scratch)).rejects.toThrow(/cannot compare .* \(a survey scan\) with .* \(a full scan\)/);
    await expect(compareCommand([fullJson, survey1Json], scratch)).rejects.toThrow(/a survey scan \(--survey\) and a full scan/);

    const text = await compareCommand([survey1Json, survey2Json], scratch);
    expect(text.output.split("\n")[0]).toBe("survey: 1 viewport, exact savings only, no est.");
    const json = await compareCommand([survey1Json, survey2Json, "--format", "json"], scratch);
    expect(JSON.parse(json.output)).toMatchObject({ survey: true });
    const plain = await compareCommand([fullJson, fullJson, "--format", "json"], scratch);
    expect(JSON.parse(plain.output)).not.toHaveProperty("survey");
  }, 180_000);

  it("labels the report's Bytes section for a survey compare, and refuses to mix survey and full compares", async () => {
    const survey1 = join(scratch, "cmp-survey-1");
    const survey2 = join(scratch, "cmp-survey-2");
    const surveyCompare = join(scratch, "compare-survey.json");
    const fullCompare = join(scratch, "compare-full.json");
    const ledger = join(scratch, "ledger.jsonl");
    await writeFile(ledger, "");
    const json = await compareCommand([await pageJson(survey1), await pageJson(survey2), "--format", "json"], scratch);
    await writeFile(surveyCompare, json.output);
    // The same compare without the survey mark is what a full compare file looks like.
    const plain = { ...JSON.parse(json.output), survey: undefined };
    await writeFile(fullCompare, JSON.stringify(plain));

    const labelled = await reportCommand(["--ledger", ledger, "--compare", surveyCompare], scratch);
    expect(labelled.output).toContain("survey: 1 viewport, exact savings only, no est.");
    const unlabelled = await reportCommand(["--ledger", ledger, "--compare", fullCompare], scratch);
    expect(unlabelled.output).not.toMatch(/survey:/);
    await expect(reportCommand(["--ledger", ledger, "--compare", surveyCompare, "--compare", fullCompare], scratch)).rejects.toThrow(
      /mix survey scans \(--survey\) with full scans/,
    );
  }, 180_000);
});

/** A measured page with the given options; everything else is empty. */
function pageResult(over: Partial<PageResult> = {}): PageResult {
  return {
    url: `https://shop.example${URL_PATH}`,
    host: "shop.example",
    scannedAt: "",
    imgtuneVersion: "0",
    metric: "ssimulacra2",
    delta: 2,
    viewports: ["desktop"],
    status: "ok",
    nextjs: false,
    perViewport: {},
    groups: [],
    counts: { images: 0, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
    ...over,
  };
}
