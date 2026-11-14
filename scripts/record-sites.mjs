// Records the pages of a URL list to HAR files, for replay (IMGTUNE_REPLAY_HAR, see src/replay.ts): one HAR per URL and
// viewport, the viewports as the scan uses them, each page scrolled to the bottom and back, then settled.
// Usage: node scripts/record-sites.mjs <url-list> <out-dir> [viewports, default iphone-15,desktop]
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The file-name key of a URL: the same as src/replay.ts harKey. */
const harKey = (url) => createHash("sha1").update(url).digest("hex").slice(0, 12);

const [listFile, outDir, viewportArg = "iphone-15,desktop"] = process.argv.slice(2);
if (!listFile || !outDir) {
  console.error("usage: node scripts/record-sites.mjs <url-list> <out-dir> [viewports]");
  process.exit(2);
}
const { DEFAULT_VIEWPORTS } = await import(pathToFileURL(fileURLToPath(new URL("../dist/config.js", import.meta.url))).href); // needs the build
const wanted = viewportArg.split(",");
const viewports = DEFAULT_VIEWPORTS.filter((v) => wanted.includes(v.name));
const urls = readFileSync(listFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
try {
  for (const url of urls) {
    for (const v of viewports) {
      const path = join(outDir, `${harKey(url)}-${v.name}.har`);
      const context = await browser.newContext({
        viewport: { width: v.width, height: v.height },
        deviceScaleFactor: v.dpr,
        isMobile: v.mobile,
        hasTouch: v.mobile,
        userAgent: v.userAgent,
        serviceWorkers: "block",
        recordHar: { path, content: "embed" },
      });
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "load", timeout: 90_000 }).catch(() => undefined);
        const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
        for (let y = 0; y < height; y += Math.max(400, v.height)) {
          await page.evaluate((top) => window.scrollTo(0, top), y);
          await page.waitForTimeout(250);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
      } finally {
        await context.close();
      }
      console.log(`recorded ${url} ${v.name} -> ${path}`);
    }
  }
} finally {
  await browser.close();
}
