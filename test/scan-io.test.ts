import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_STORAGE_STATE_BYTES,
  parseScanArgs,
  pageFileName,
  progressLine,
  readStorageState,
  recordOptionsOf,
  runScan,
  sameRecordOptions,
  type PageResult,
  type ScanReport,
} from "../src/remote.js";
import { DEFAULT_VIEWPORTS } from "../src/config.js";

describe("parseScanArgs: scan I/O options", () => {
  it("reads --resume, the limits, --urls-from, --sample-per-pattern and --storage-state", () => {
    const args = parseScanArgs([
      "--resume",
      "--max-pages",
      "3",
      "--max-images",
      "50",
      "--urls-from",
      "urls.txt",
      "--sample-per-pattern",
      "2",
      "--storage-state",
      "session.json",
    ]);
    expect(args).toMatchObject({
      resume: true,
      maxPages: 3,
      maxImages: 50,
      urlsFrom: "urls.txt",
      samplePerPattern: 2,
      storageState: "session.json",
      urls: [],
    });
  });

  it("accepts --urls-from in place of a URL, and rejects no URL at all", () => {
    expect(parseScanArgs(["--urls-from", "https://shop.example/sitemap.xml"]).urlsFrom).toBe("https://shop.example/sitemap.xml");
    expect(() => parseScanArgs(["--resume"])).toThrow(/at least one URL or --urls-from/);
  });

  it("refuses a sample without a URL source, and limits that are not whole numbers of at least 1", () => {
    expect(() => parseScanArgs(["https://a.example/", "--sample-per-pattern", "2"])).toThrow(/needs --urls-from/);
    expect(() => parseScanArgs(["https://a.example/", "--max-pages", "0"])).toThrow(/whole number of at least 1/);
    expect(() => parseScanArgs(["https://a.example/", "--max-images", "2.5"])).toThrow(/whole number of at least 1/);
  });
});

describe("progressLine", () => {
  const page = (url: string, meanImageBytes: number, exactEstPct: number): PageResult =>
    ({
      url,
      status: "ok",
      page: { meanImageBytes, exactPct: 0, exactEstPct, fixablePct: 0, sharpnessKB: 0 },
    }) as unknown as PageResult;

  it("prints the pages done, the image bytes measured and the estimated share", () => {
    const done = [page("https://a.example/1", 1.5 * 1024 * 1024, 10), page("https://a.example/2", 1.6 * 1024 * 1024, 12)];
    expect(progressLine(done, 12)).toBe("page 2/12 done · 3.1 MB measured · est. 11%");
  });

  it("names a page that was not measured", () => {
    const blocked = { url: "https://a.example/3", status: "blocked" } as unknown as PageResult;
    expect(progressLine([blocked], 5)).toBe("page 1/5 done (blocked) · 0.0 MB measured · est. 0%");
  });
});

describe("recordOptionsOf and sameRecordOptions", () => {
  const base = { aggressive: false, quality: true, viewports: DEFAULT_VIEWPORTS.slice(0, 2), ignoreRobots: false };

  it("is the same for the same options and different when one changes", () => {
    const recorded = recordOptionsOf(base);
    expect(sameRecordOptions(recorded, recordOptionsOf({ ...base, viewports: [...base.viewports] }))).toBe(true);
    expect(sameRecordOptions(recorded, recordOptionsOf({ ...base, quality: false }))).toBe(false);
    expect(sameRecordOptions(recorded, recordOptionsOf({ ...base, viewports: base.viewports.slice(1) }))).toBe(false);
    expect(sameRecordOptions(recorded, recordOptionsOf({ ...base, storageState: { cookies: [], origins: [] } }))).toBe(false);
    expect(sameRecordOptions(undefined, recorded)).toBe(false);
  });
});

describe("readStorageState", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-state-"));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads a storage state file", async () => {
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify({ cookies: [{ name: "sid", value: "x", domain: "shop.example", path: "/" }], origins: [] }));
    const state = await readStorageState(path);
    expect(state).toEqual({ cookies: [{ name: "sid", value: "x", domain: "shop.example", path: "/" }], origins: [] });
  });

  it("refuses a file that is not JSON without printing its contents", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "session=SECRET-VALUE-123");
    const error = await readStorageState(path).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error?.message).toContain("is not JSON");
    expect(error?.message).not.toContain("SECRET-VALUE-123");
  });

  it("refuses a JSON file that is not a storage state, and a file over the size cap", async () => {
    const list = join(dir, "list.json");
    await writeFile(list, "[1, 2]");
    await expect(readStorageState(list)).rejects.toThrow("is not a storage state");
    const big = join(dir, "big.json");
    await writeFile(big, " ".repeat(MAX_STORAGE_STATE_BYTES + 1));
    await expect(readStorageState(big)).rejects.toThrow("larger than");
  });
});

describe("runScan: resume, limits and the completeness marker (real pages on a local server)", () => {
  let server: Server | undefined;
  let base = "";
  let dir = "";
  const pages = ["/p1", "/p2", "/p3"];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-resume-"));
    const started = await new Promise<{ server: Server; port: number }>((resolve) => {
      const s = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><body><img src="/img.png" width="64" height="64" alt=""></body></html>`);
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: s, port: (s.address() as AddressInfo).port }));
    });
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const options = (outDir: string, extra: Partial<Parameters<typeof runScan>[1]> = {}) => ({
    outDir,
    cwd: dir,
    aggressive: false,
    quality: false,
    viewports: DEFAULT_VIEWPORTS.filter((v) => v.name === "iphone-15").map((v) => ({ ...v })),
    log: () => {},
    ...extra,
  });

  it("stops at --max-pages, leaves complete pages behind, and resumes the rest without rescanning", async () => {
    const out = join(dir, "scan-a");
    const urls = pages.map((p) => `${base}${p}`);
    const report: ScanReport = {};
    const first = await runScan(urls, options(out, { maxPages: 1, report }));
    expect(first).toHaveLength(1);
    expect(report.stopped).toEqual({ reason: "max-pages", limit: 1, pages: 1, total: 3, images: 1 });

    const written = JSON.parse(await readFile(join(out, pageFileName(new URL(urls[0]))), "utf8")) as PageResult;
    expect(written.complete).toBe(true);
    expect(written.options?.quality).toBe(false);

    const logged: string[] = [];
    const resumed = await runScan(urls, options(out, { resume: true, log: (m) => logged.push(m) }));
    expect(resumed).toHaveLength(3);
    expect(logged.filter((m) => m.startsWith("resumed ")).length).toBe(1);
    expect(logged.filter((m) => m.startsWith("scanning ")).length).toBe(2);
    expect(logged.at(-1)).toBe("page 3/3 done · 0.0 MB measured · est. 0%");
  }, 120_000);

  it("warns and scans again a page written with other options", async () => {
    const out = join(dir, "scan-b");
    const urls = [`${base}/p1`];
    await runScan(urls, options(out, { quality: false }));
    const logged: string[] = [];
    await runScan(urls, options(out, { resume: true, quality: true, log: (m) => logged.push(m) }));
    expect(logged.some((m) => m.startsWith("warning:") && m.includes("other options"))).toBe(true);
    expect(logged.some((m) => m.startsWith("scanning "))).toBe(true);
  }, 120_000);

  it("does not reuse a page without the completeness marker", async () => {
    const out = join(dir, "scan-c");
    const urls = [`${base}/p1`];
    await runScan(urls, options(out));
    const path = join(out, pageFileName(new URL(urls[0])));
    const page = JSON.parse(await readFile(path, "utf8")) as PageResult;
    delete page.complete;
    await writeFile(path, JSON.stringify(page));
    const logged: string[] = [];
    await runScan(urls, options(out, { resume: true, log: (m) => logged.push(m) }));
    expect(logged.some((m) => m.startsWith("resumed "))).toBe(false);
    expect(logged.some((m) => m.startsWith("scanning "))).toBe(true);
  }, 120_000);
});
