#!/usr/bin/env node
// Runs one resource analyzer on real pages, outside the scan: the test harness of src/resources/ (shared by the streams).
//
//   node scripts/try-analyzer.mjs <kind> <url-list-file> [--out file.json]
//
// For each URL in the list (one per line, # comments allowed) it opens the page in Chromium at 1440x900 (DPR 1), scrolls
// to the bottom, captures the responses the way the scan does (resources/capture.ts), reads the page context, and runs
// the registered analyzer of <kind> through the resource phase (resources/phase.ts, icons included). It prints the
// findings as JSON. Needs a build first: `npm run build`. Keep the output in a scratch folder outside the repo.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined;
const [kind, listFile] = args.filter((_, i) => i !== outIndex && i !== outIndex + 1);
if (!kind || !listFile) {
  console.error("usage: node scripts/try-analyzer.mjs <kind> <url-list-file> [--out file.json]");
  process.exit(2);
}

const root = resolve(new URL("..", import.meta.url).pathname);
const { ANALYZERS } = await import(`${root}/dist/resources/index.js`);
const { analyzeResources } = await import(`${root}/dist/resources/phase.js`);
const { readPageContext, readResourceBody, resourceRecordOf } = await import(`${root}/dist/resources/capture.js`);

const analyzer = ANALYZERS.find((a) => a.kind === kind);
if (!analyzer) {
  console.error(`no analyzer for kind "${kind}" (registered: ${ANALYZERS.map((a) => a.kind).join(", ")})`);
  process.exit(2);
}

const urls = readFileSync(listFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

// Icons the page did not load are fetched by the phase, with this fetcher (no retries, no private addresses).
const fetcher = {
  async get(url, opts = {}) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return undefined;
      const body = Buffer.from(await res.arrayBuffer());
      return opts.maxBytes !== undefined && body.length > opts.maxBytes ? undefined : body;
    } catch {
      return undefined;
    }
  },
};

const browser = await chromium.launch();
const report = [];
try {
  for (const url of urls) {
    const started = Date.now();
    const entry = { url, findings: [], error: undefined, ms: 0 };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      const records = new Map();
      const reads = [];
      context.on("response", (response) => {
        const type = response.request().resourceType();
        if (type === "media" || type === "websocket") return;
        const record = resourceRecordOf(response, url, "desktop", response.headers()["content-type"]);
        records.set(response.url(), record);
        reads.push(readResourceBody(record, response).catch(() => {}));
      });
      await page.goto(url, { waitUntil: "load", timeout: 45_000 }).catch((err) => {
        entry.error = `load: ${err.message.split("\n")[0]}`;
      });
      // Scroll to the bottom in steps, so lazy resources start loading.
      await page
        .evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 600) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 120));
          }
        })
        .catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      await Promise.race([Promise.all(reads), new Promise((r) => setTimeout(r, 8_000))]);
      const pageContext = await readPageContext(page);
      if (pageContext !== undefined) {
        const view = {
          viewport: { name: "desktop", width: 1440, height: 900, dpr: 1, mobile: false },
          resources: [...records.values()],
          pageContext,
        };
        const all = await analyzeResources([view], url, { fetcher, allowPrivate: false });
        entry.findings = all.filter((f) => f.kind === kind);
      }
    } catch (err) {
      entry.error = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    } finally {
      await context.close();
    }
    entry.ms = Date.now() - started;
    report.push(entry);
    console.error(`${url}: ${entry.findings.length} finding(s), ${entry.ms} ms${entry.error ? ` (${entry.error})` : ""}`);
  }
} finally {
  await browser.close();
}

const text = `${JSON.stringify({ kind, pages: report }, null, 2)}\n`;
if (outFile) writeFileSync(outFile, text);
else process.stdout.write(text);
