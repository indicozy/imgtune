#!/usr/bin/env node
// Runs one resource analyzer on real pages, before the scan integration (stream R) exists.
//
//   node scripts/try-analyzer.mjs <kind> <url-list> [--out DIR] [--concurrency N] [--no-build]
//
// <kind> is an analyzer module in src/resources (lottie, svg, font, model, audio, ...). <url-list> is a text file with one
// page URL per line ('#' starts a comment). For each page the harness opens Chromium at 1440x900 (DPR 1), scrolls to the
// bottom, builds the ResourceRecord[] (bodies read for the responses the analyzer's wants() asks for, up to 20 MB) and the
// PageContext, runs the analyzer and prints the findings as JSON. Output: <DIR>/<host>.json per page, and a summary on stdout.
// The analyzers are compiled to dist/ first (tsc -p tsconfig.build.json) unless --no-build is given.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 20 * 1024 * 1024;
const VIEWPORT = { name: "desktop", width: 1440, height: 900, dpr: 1 };

function parseArgs(argv) {
  const pos = [];
  const opts = { out: undefined, concurrency: 2, build: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (a === "--no-build") opts.build = false;
    else pos.push(a);
  }
  if (pos.length !== 2) {
    console.error("usage: node scripts/try-analyzer.mjs <kind> <url-list> [--out DIR] [--concurrency N] [--no-build]");
    process.exit(2);
  }
  return { kind: pos[0], list: pos[1], ...opts };
}

/** Last two labels, or three for co.uk-style suffixes. Good enough for the third-party flag. */
function registrable(host) {
  const parts = host.split(".");
  const twoPart = /^(co|com|org|net|ac|gov)$/.test(parts.at(-2) ?? "") && (parts.at(-1)?.length ?? 0) === 2;
  return parts.slice(twoPart ? -3 : -2).join(".");
}

function baseType(ct) {
  return (ct ?? "").split(";")[0].trim().toLowerCase();
}

/** Browser-side: what the page shows. Kept close to the PageContext contract in src/resources/types.ts. */
const COLLECT = () => {
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return undefined;
    }
  };
  const selectorOf = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const cls = [...node.classList].filter((c) => /^[a-zA-Z][\w-]{1,40}$/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      parts.unshift(part);
      if (node.id) break;
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  };
  const text = (document.body?.innerText ?? "").slice(0, 200000);
  const usedMap = new Map();
  for (const el of document.querySelectorAll("body *")) {
    if (usedMap.size > 400) break;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    const family = (cs.fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim();
    const weight = Number(cs.fontWeight) || 400;
    const style = cs.fontStyle || "normal";
    usedMap.set(`${family}|${weight}|${style}`, { family, weight, style });
  }
  const fontFaces = [];
  try {
    document.fonts.forEach((f) =>
      fontFaces.push({
        family: f.family.replace(/["']/g, ""),
        weight: f.weight,
        style: f.style,
        status: f.status,
        ...(f.unicodeRange && f.unicodeRange !== "U+0-10FFFF" ? { unicodeRange: f.unicodeRange } : {}),
      }),
    );
  } catch {
    // document.fonts is unavailable: no faces.
  }
  const icons = [...document.querySelectorAll("link[rel~='icon'], link[rel='apple-touch-icon'], link[rel='mask-icon']")]
    .map((l) => ({ rel: l.getAttribute("rel") ?? "", href: abs(l.getAttribute("href") ?? "") ?? "", sizes: l.getAttribute("sizes") ?? undefined, type: l.getAttribute("type") ?? undefined }))
    .filter((i) => i.href);
  const audio = [...document.querySelectorAll("audio")]
    .map((el) => ({ src: abs(el.currentSrc || el.getAttribute("src") || el.querySelector("source")?.getAttribute("src") || "") ?? "", autoplay: el.autoplay, loop: el.loop, preload: el.preload, muted: el.muted, selector: selectorOf(el) }))
    .filter((a) => a.src);
  const lottie = [...document.querySelectorAll("lottie-player, dotlottie-player, dotlottie-wc, [data-animation-path], [data-lottie-path], [data-animation-url]")].map((el) => {
    const src = el.getAttribute("src") ?? el.getAttribute("data-animation-path") ?? el.getAttribute("data-lottie-path") ?? el.getAttribute("data-animation-url") ?? undefined;
    return { ...(src ? { src: abs(src) } : {}), selector: selectorOf(el), ...rect(el) };
  });
  const models = [...document.querySelectorAll("model-viewer[src]")].map((el) => ({ src: abs(el.getAttribute("src") ?? "") ?? undefined, selector: selectorOf(el), ...rect(el) }));
  return { text, usedFonts: [...usedMap.values()], fontFaces, icons, audio, lottie, models };
};

async function scrollPage(page) {
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(innerHeight * 0.8));
    for (let y = 0; y < document.body.scrollHeight && y < 60000; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
}

async function runPage(browser, pageUrl, analyzer, outDir) {
  const started = Date.now();
  const host = new URL(pageUrl).host;
  const context = await browser.newContext({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height }, deviceScaleFactor: VIEWPORT.dpr });
  const page = await context.newPage();
  const seen = new Map(); // url -> { resp, meta }
  page.on("response", (resp) => {
    const url = resp.url();
    if (seen.has(url) || !/^https?:/.test(url)) return;
    const h = resp.headers();
    seen.set(url, {
      resp,
      meta: {
        url,
        status: resp.status(),
        contentType: baseType(h["content-type"]),
        contentEncoding: h["content-encoding"]?.toLowerCase(),
        headerBytes: Number(h["content-length"] ?? -1),
        resourceType: resp.request().resourceType(),
      },
    });
  });
  const result = { page: pageUrl, host, viewport: VIEWPORT.name, error: undefined };
  try {
    await page.goto(pageUrl, { waitUntil: "load", timeout: 45_000 });
    await scrollPage(page);
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    const ctxRaw = await page.evaluate(COLLECT);
    const pageCtx = { url: page.url(), viewport: VIEWPORT, ...ctxRaw };
    const finalHost = new URL(page.url()).host;
    const records = [];
    for (const { resp, meta } of seen.values()) {
      const base = {
        url: meta.url,
        pageUrl: page.url(),
        viewport: VIEWPORT.name,
        resourceType: meta.resourceType,
        contentType: meta.contentType,
        ...(meta.contentEncoding ? { contentEncoding: meta.contentEncoding } : {}),
        bytes: Math.max(0, meta.headerBytes),
        status: meta.status,
        thirdParty: registrable(new URL(meta.url).host) !== registrable(finalHost),
      };
      // Chunked responses have no Content-Length: wants() then decides on the type alone (the size is known after the read).
      if (!analyzer.wants({ ...base, bytes: meta.headerBytes >= 0 ? meta.headerBytes : MAX_BODY })) continue;
      let body;
      try {
        const buf = await resp.body();
        if (buf.length <= MAX_BODY) body = buf;
      } catch {
        // Some responses have no body (redirects, aborted fetches): they are skipped.
      }
      if (body === undefined) continue;
      const rec = { ...base, bytes: body.length, body };
      if (!analyzer.wants(rec)) continue;
      records.push(rec);
    }
    const t0 = Date.now();
    const findings = await analyzer.analyze(records, pageCtx);
    result.analyzeMs = Date.now() - t0;
    result.records = records.map((r) => ({ url: r.url, contentType: r.contentType, bytes: r.bytes }));
    result.responses = seen.size;
    result.findings = findings;
    result.lottieOnPage = pageCtx.lottie.length;
    const dir = join(outDir, host.replace(/[^\w.-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    records.forEach((r, i) => writeFileSync(join(dir, `${i}-${r.body.length}.bin`), r.body));
  } catch (err) {
    result.error = String(err?.message ?? err).slice(0, 300);
  } finally {
    result.ms = Date.now() - started;
    await context.close().catch(() => {});
  }
  writeFileSync(join(outDir, `${host.replace(/[^\w.-]/g, "_")}.json`), JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const { kind, list, out, concurrency, build } = parseArgs(process.argv.slice(2));
  if (build) execFileSync(join(ROOT, "node_modules/.bin/tsc"), ["-p", join(ROOT, "tsconfig.build.json")], { stdio: "inherit" });
  const mod = await import(pathToFileURL(join(ROOT, "dist/resources", `${kind}.js`)).href);
  const analyzer = mod.analyzer;
  if (!analyzer) throw new Error(`dist/resources/${kind}.js exports no analyzer`);
  const outDir = resolve(out ?? join("/mnt/ai_models/imgtune-work/030-L", `try-${kind}`));
  mkdirSync(outDir, { recursive: true });
  const urls = readFileSync(list, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const r = await runPage(browser, url, analyzer, outDir);
      results.push(r);
      console.error(`${r.host}: ${r.findings?.length ?? 0} findings, ${r.records?.length ?? 0} analysed, ${r.ms} ms${r.error ? `, error: ${r.error}` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 2)) }, worker));
  await browser.close();
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map((r) => ({ host: r.host, error: r.error, findings: r.findings ?? [] })), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
