#!/usr/bin/env node
// Runs one resource analyzer on real pages and prints its findings as JSON. For testing before the scan integration.
//
//   node scripts/try-analyzer.mjs <kind> <url-list> [--concurrency 2]
//
// <kind> is a ResourceKind (src/resources/<kind>.ts); run `pnpm build` first (the analyzers are read from dist/).
// <url-list> is a text file with one page URL per line. Each page is opened in Chromium at 1440x900 (DPR 1), scrolled to
// the bottom, and every response is recorded as a ResourceRecord (with its body when the analyzer's wants() asks for
// it and the body is at most 20 MB). The PageContext is read from the DOM after the scroll. The analyzer runs once per
// page and the findings come out as JSON: { kind, pages: [{ url, error?, records, findings }] }.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BODY_CAP = 20 * 1024 * 1024;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const argv = process.argv.slice(2);
const kind = argv[0];
const listFile = argv[1];
const concurrencyIdx = argv.indexOf("--concurrency");
const concurrency = concurrencyIdx >= 0 ? Math.max(1, Math.min(2, Number(argv[concurrencyIdx + 1]) || 2)) : 2;
if (!kind || !listFile) {
  console.error("usage: node scripts/try-analyzer.mjs <kind> <url-list> [--concurrency 2]");
  process.exit(2);
}

const modulePath = join(ROOT, "dist", "resources", `${kind}.js`);
if (!existsSync(modulePath)) {
  console.error(`missing ${modulePath}: run pnpm build first`);
  process.exit(2);
}
const { analyzer } = await import(pathToFileURL(modulePath).href);

/** The PageContext, read from the DOM after the scroll. */
async function readContext(page, url) {
  return page.evaluate((pageUrl) => {
    const sel = (el) => {
      const tag = el.tagName.toLowerCase();
      if (el.id) return `${tag}#${el.id}`;
      const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean)[0];
      return cls ? `${tag}.${cls}` : tag;
    };
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    };
    const audio = [...document.querySelectorAll("audio")].map((el) => {
      const src = el.currentSrc || el.getAttribute("src") || el.querySelector("source")?.src || "";
      return {
        src,
        autoplay: el.autoplay,
        loop: el.loop,
        preload: el.getAttribute("preload") || el.preload || "",
        muted: el.muted,
        selector: sel(el),
      };
    }).filter((a) => a.src);
    const models = [...document.querySelectorAll("model-viewer")].map((el) => ({
      src: el.getAttribute("src") || undefined,
      selector: sel(el),
      ...box(el),
    }));
    const lottie = [...document.querySelectorAll("lottie-player, dotlottie-player, dotlottie-wc")].map((el) => ({
      src: el.getAttribute("src") || undefined,
      selector: sel(el),
      ...box(el),
    }));
    const icons = [...document.querySelectorAll("link[rel~='icon'], link[rel='apple-touch-icon'], link[rel='mask-icon']")].map(
      (el) => ({
        rel: el.getAttribute("rel") || "",
        href: el.href,
        sizes: el.getAttribute("sizes") || undefined,
        type: el.getAttribute("type") || undefined,
      }),
    );
    const fontFaces = [];
    document.fonts.forEach((f) => {
      fontFaces.push({ family: f.family, weight: f.weight, style: f.style, status: f.status, unicodeRange: f.unicodeRange });
    });
    return {
      url: pageUrl,
      viewport: { name: "desktop", width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      text: (document.body?.innerText || "").slice(0, 200000),
      usedFonts: [],
      fontFaces,
      icons,
      audio,
      lottie,
      models,
    };
  }, url);
}

/** Opens one page and returns its records (bodies as needed) and PageContext. */
async function visit(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: UA,
    locale: "en-US",
  });
  const records = new Map();
  const pending = [];
  try {
    const page = await context.newPage();
    page.on("response", (resp) => {
      pending.push((async () => {
        const url2 = resp.url();
        if (records.has(url2)) return;
        const headers = await resp.allHeaders().catch(() => ({}));
        const request = resp.request();
        const rec = {
          url: url2,
          pageUrl: url,
          viewport: "desktop",
          resourceType: request.resourceType(),
          contentType: (headers["content-type"] || "").split(";")[0].trim().toLowerCase(),
          contentEncoding: headers["content-encoding"]?.trim().toLowerCase() || undefined,
          bytes: Number(headers["content-length"] || 0),
          status: resp.status(),
          thirdParty: false,
        };
        records.set(url2, rec);
        // The analyzer wants() needs only the metadata; the body is fetched once it asks for it.
        const wants = analyzerWants(rec);
        if (!wants || resp.status() >= 400) return;
        // Chromium gives no body for a 206 (range) media response, so such a file is downloaded again, up to the cap.
        const body = (await resp.body().catch(() => undefined)) ?? (await refetch(url2, url));
        if (body && body.length <= BODY_CAP) {
          rec.body = body;
          rec.bytes = body.length;
        }
      })().catch(() => {}));
    });
    let error;
    try {
      await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    } catch (e) {
      error = String(e?.message || e).slice(0, 300);
    }
    // Scroll to the bottom in steps, so lazy media and the audio elements they hold are in the DOM.
    await page.evaluate(async () => {
      const deadline = Date.now() + 15_000;
      for (let y = 0; y < document.body.scrollHeight && Date.now() < deadline; y += 400) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 300));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    const ctx = await readContext(page, url).catch(() => undefined);
    await Promise.allSettled(pending);
    return { error, records: [...records.values()], ctx };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Downloads a response again with Node's fetch, streaming it up to the body cap; undefined when it is larger or fails. */
async function refetch(url, pageUrl) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, referer: pageUrl, "accept-encoding": "identity" } });
    if (!res.ok || !res.body) return undefined;
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > BODY_CAP) {
        return undefined;
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch {
    return undefined;
  }
}

function analyzerWants(rec) {
  try {
    return analyzer.wants({ ...rec, body: undefined });
  } catch {
    return false;
  }
}

const urls = (await readFile(listFile, "utf8")).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
// Default flags, as the census ran: the scan's CHROMIUM_ARGS turn WebGL off, which hides 3D models (see the report).
const browser = await chromium.launch({ headless: true });
const results = new Array(urls.length);
let next = 0;
async function worker() {
  while (next < urls.length) {
    const i = next++;
    const url = urls[i];
    try {
      const { error, records, ctx } = await visit(browser, url);
      if (!ctx) {
        results[i] = { url, error: error || "no page context", records: records.length, findings: [] };
        continue;
      }
      const wanted = records.filter((r) => analyzerWants(r));
      const findings = await analyzer.analyze(wanted, ctx);
      results[i] = {
        url,
        error,
        records: records.length,
        wanted: wanted.length,
        ...(argv.includes("--records") ? { recordList: records.map(({ body, ...r }) => ({ ...r, bodyBytes: body?.length })) } : {}),
        findings: findings.map((f) => ({ ...f })),
      };
    } catch (e) {
      results[i] = { url, error: String(e?.message || e).slice(0, 300), findings: [] };
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
await browser.close();
process.stdout.write(JSON.stringify({ kind, pages: results }, null, 2) + "\n");
