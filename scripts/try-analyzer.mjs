#!/usr/bin/env node
// Runs one resource analyzer on real pages, outside the scan (the test harness of the 0.3.0 resource streams).
//
//   node scripts/try-analyzer.mjs <kind> <url-list> [--concurrency 2] [--timeout 45000]
//
// Build first (`pnpm run build`): the analyzer is loaded from dist/resources/<kind>.js. For each URL the harness opens
// the page with Playwright at 1440x900, scrolls it, and builds the ResourceRecord[] (with bodies the analyzer's wants()
// asks for) and the PageContext, the same way the scan does. It then runs the analyzer and prints the findings as JSON
// on stdout. Progress goes to stderr. Use it with a nice/taskset prefix and keep --concurrency at 2 or less.
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const [kind, listFile] = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
if (!kind || !listFile) {
  console.error("usage: node scripts/try-analyzer.mjs <kind> <url-list> [--concurrency 2] [--timeout 45000]");
  process.exit(2);
}
const concurrency = Math.min(2, Number(flag("--concurrency", 2)));
const timeout = Number(flag("--timeout", 45000));
/** With --dump DIR, each page's PageContext and records (bodies base64) are written to DIR for offline replay. */
const dumpDir = flag("--dump", undefined);
const VIEWPORT = { name: "desktop", width: 1440, height: 900, dpr: 1 };
const MAX_BODY = 20 * 1024 * 1024;

const mod = await import(pathToFileURL(join(here, "..", "dist", "resources", `${kind}.js`)).href);
const analyzer = mod.analyzer;
if (!analyzer) throw new Error(`dist/resources/${kind}.js has no analyzer export`);

const urls = readFileSync(listFile, "utf8")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("#"));

const registrable = (host) => host.split(".").slice(-2).join(".");

/** Reads @font-face rules from a stylesheet: family, weight, style, unicode-range and the first src URL. */
function fontFaceRules(css, cssUrl) {
  const out = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = m[1];
    const prop = (name) => {
      const p = body.match(new RegExp(`${name}\\s*:\\s*([^;]+)`, "i"));
      return p ? p[1].trim() : undefined;
    };
    const src = prop("src") ?? "";
    const u = src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
    if (!u) continue;
    let url;
    try {
      url = new URL(u[1], cssUrl).href;
    } catch {
      continue;
    }
    out.push({
      family: (prop("font-family") ?? "").replace(/["']/g, "").trim(),
      weight: prop("font-weight") ?? "normal",
      style: prop("font-style") ?? "normal",
      unicodeRange: prop("unicode-range"),
      url,
    });
  }
  return out;
}

const normWeight = (w) => (w === "normal" ? "400" : w === "bold" ? "700" : w.replace(/\s+/g, " ").trim());
const normRange = (r) => (r ?? "").replace(/\s+/g, "").toUpperCase();

/** Pairs each document.fonts entry with the @font-face rule that declares it, to learn its URL. */
function matchFaces(domFaces, rules) {
  return domFaces.map((f) => {
    const family = f.family.replace(/["']/g, "").trim().toLowerCase();
    const same = rules.filter(
      (r) =>
        r.family.toLowerCase() === family &&
        normWeight(r.weight) === normWeight(f.weight) &&
        r.style.split(" ")[0] === f.style.split(" ")[0],
    );
    const byRange = same.find((r) => normRange(r.unicodeRange) === normRange(f.unicodeRange));
    const pick = byRange ?? same[0];
    return { ...f, url: pick?.url };
  });
}

async function runPage(browser, pageUrl) {
  const context = await browser.newContext({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height } });
  const page = await context.newPage();
  const responses = [];
  const cssTexts = new Map();
  page.on("response", (resp) => {
    const req = resp.request();
    const headers = resp.headers();
    const type = (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const entry = { resp, url: resp.url(), status: resp.status(), resourceType: req.resourceType(), contentType: type, headers };
    responses.push(entry);
    if (type === "text/css") entry.css = resp.text().then((t) => cssTexts.set(resp.url(), t)).catch(() => {});
  });
  const started = Date.now();
  try {
    await page.goto(pageUrl, { waitUntil: "load", timeout });
    // Scroll to the bottom in 300 ms steps (at most 15 s), then let the network settle for up to 8 s.
    await page.evaluate(async () => {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        const before = window.scrollY;
        window.scrollBy(0, 300);
        await new Promise((r) => setTimeout(r, 300));
        if (window.scrollY === before) break;
      }
    });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 300));
    const pageHost = new URL(page.url()).hostname;
    const domInfo = await page.evaluate(() => {
      const text = document.body ? document.body.innerText.slice(0, 200000) : "";
      const seen = new Map();
      for (const el of document.querySelectorAll("body *")) {
        const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasText || el.getClientRects().length === 0) continue;
        const cs = getComputedStyle(el);
        const family = cs.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
        const weight = Number.parseInt(cs.fontWeight, 10);
        const style = cs.fontStyle;
        const key = `${family}|${weight}|${style}`;
        if (!seen.has(key)) seen.set(key, { family, weight, style });
      }
      const faces = Array.from(document.fonts).map((f) => ({
        family: f.family,
        weight: f.weight,
        style: f.style,
        status: f.status,
        unicodeRange: f.unicodeRange,
      }));
      const icons = Array.from(document.querySelectorAll("link[rel~='icon'],link[rel='apple-touch-icon']")).map((l) => ({
        rel: l.getAttribute("rel"),
        href: l.href,
        sizes: l.getAttribute("sizes") ?? undefined,
        type: l.getAttribute("type") ?? undefined,
      }));
      return { text, usedFonts: [...seen.values()], faces, icons };
    });
    for (const e of responses) if (e.css) await e.css;
    const rules = [];
    for (const [url, css] of cssTexts) rules.push(...fontFaceRules(css, url));
    const fontFaces = matchFaces(domInfo.faces, rules);
    const ctx = {
      url: page.url(),
      viewport: { name: VIEWPORT.name, width: VIEWPORT.width, height: VIEWPORT.height, dpr: VIEWPORT.dpr },
      text: domInfo.text,
      usedFonts: domInfo.usedFonts,
      fontFaces,
      icons: domInfo.icons,
      audio: [],
      lottie: [],
      models: [],
    };
    const seenUrls = new Set();
    const records = [];
    const dumped = [];
    for (const e of responses) {
      if (seenUrls.has(e.url) || e.status >= 400) continue;
      seenUrls.add(e.url);
      const body = await e.resp.body().catch(() => undefined);
      if (!body) continue;
      const headers = e.headers;
      const rec = {
        url: e.url,
        pageUrl: page.url(),
        viewport: VIEWPORT.name,
        resourceType: e.resourceType,
        contentType: e.contentType,
        contentEncoding: headers["content-encoding"]?.toLowerCase(),
        bytes: body.length,
        status: e.status,
        thirdParty: (() => {
          try {
            return registrable(new URL(e.url).hostname) !== registrable(pageHost);
          } catch {
            return true;
          }
        })(),
      };
      if (analyzer.wants(rec) && body.length <= MAX_BODY) rec.body = body;
      records.push(rec);
      if (dumpDir && rec.body) dumped.push({ ...rec, body: rec.body.toString("base64") });
    }
    const wanted = records.filter((r) => r.body).length;
    if (dumpDir) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(dumpDir, { recursive: true });
      const name = `${new URL(pageUrl).hostname}.json`;
      writeFileSync(join(dumpDir, name), JSON.stringify({ ctx, records: dumped }));
    }
    const t0 = Date.now();
    const findings = await analyzer.analyze(records, ctx);
    return {
      url: pageUrl,
      finalUrl: page.url(),
      usedFonts: ctx.usedFonts,
      fontFaces: ctx.fontFaces.map(({ family, weight, style, status, unicodeRange, url }) => ({ family, weight, style, status, unicodeRange, url })),
      loadMs: t0 - started,
      analyzeMs: Date.now() - t0,
      responses: records.length,
      wanted,
      faceCount: fontFaces.length,
      findings,
    };
  } catch (err) {
    return { url: pageUrl, error: String(err && err.message ? err.message : err).slice(0, 300), findings: [] };
  } finally {
    await context.close().catch(() => {});
  }
}

const browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--disable-software-rasterizer"] });
const results = [];
try {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const result = await runPage(browser, url);
      console.error(`${url}: ${result.error ? "ERROR " + result.error : `${result.findings.length} findings, analyze ${result.analyzeMs} ms`}`);
      results[urls.indexOf(url)] = result;
    }
  });
  await Promise.all(workers);
} finally {
  await browser.close();
}
console.log(JSON.stringify(results.filter(Boolean), null, 2));
