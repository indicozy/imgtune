import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import { launchChromium } from "../src/browser.js";
import { countDocumentNavigations } from "../src/measure.js";

const HTML = (body: string) => `<!doctype html><meta charset="utf-8"><title>t</title>${body}`;

describe("countDocumentNavigations (real Chromium, local pages)", () => {
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML(`<p>${req.url}</p>`));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("counts a document load, but not pushState, replaceState or a hash change", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const navigations = await countDocumentNavigations(context, page);
      await page.goto(`${base}/start`);
      expect(navigations()).toBe(1);
      await page.evaluate(() => {
        history.pushState({}, "", "/pushed");
        history.replaceState({}, "", "/replaced");
        location.hash = "#section";
      });
      await page.waitForTimeout(200);
      expect(navigations()).toBe(1);
      await page.goto(`${base}/next`);
      expect(navigations()).toBe(2);
    } finally {
      await context.close();
    }
  });

  it("counts a script's location change as a navigation", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const navigations = await countDocumentNavigations(context, page);
      await page.goto(`${base}/start`);
      await page.evaluate((url) => {
        location.href = url;
      }, `${base}/moved`);
      await page.waitForURL(`${base}/moved`);
      await page.waitForLoadState("load");
      expect(navigations()).toBe(2);
    } finally {
      await context.close();
    }
  });
});
