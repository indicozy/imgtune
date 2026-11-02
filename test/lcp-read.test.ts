import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import sharp from "sharp";
import { launchChromium } from "../src/browser.js";
import { installLcpObserver, readLcp } from "../src/remote.js";

const PAGES: Record<string, string> = {
  // The eager image is the LCP: the page's first <img> is the largest thing in the viewport.
  "/eager": `<img id="hero" src="/hero.png" style="display:block;width:300px;height:300px">`,
  // Text is the LCP: no image is painted.
  "/text": `<h1 style="font-size:60px;margin:20px">A heading that is the largest block of text on this page</h1>`,
  // A slow image in the viewport: it is the LCP once it is painted, so the read waits for it.
  "/slow": `<p>short</p><img src="/slow.png" style="display:block;width:400px;height:400px">`,
  // A lazy image below the fold is not in the first view: the LCP is the text above it.
  "/lazy": `<h1 style="font-size:48px;margin:20px">Heading above the fold</h1><div style="height:2000px"></div><img loading="lazy" src="/hero.png" style="width:900px;height:900px">`,
};

describe("readLcp (real Chromium, local pages)", () => {
  let server: Server;
  let base: string;
  let browser: Browser;
  // Chromium does not take a 1x1 image as an LCP candidate (a tracking pixel), so the image is a real 300x300 one.
  let picture: Buffer;

  beforeAll(async () => {
    picture = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/hero.png") return res.writeHead(200, { "content-type": "image/png" }).end(picture);
      if (url === "/slow.png") {
        setTimeout(() => res.writeHead(200, { "content-type": "image/png" }).end(picture), 400);
        return;
      }
      const body = PAGES[url.split("?")[0]];
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>t</title><body style="margin:0">${body}</body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function lcpOf(path: string) {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await installLcpObserver(context);
    try {
      const page = await context.newPage();
      await page.goto(`${base}${path}`, { waitUntil: "load" });
      return await readLcp(page);
    } finally {
      await context.close();
    }
  }

  it("names the eager image that is the LCP, by its index among the page's images", async () => {
    expect(await lcpOf("/eager")).toEqual({ kind: "image", index: 0 });
  });

  it("waits for an in-view image that is still loading before it names the LCP", async () => {
    expect(await lcpOf("/slow")).toEqual({ kind: "image", index: 0 });
  });

  it("says another element is the LCP when a text block is", async () => {
    expect(await lcpOf("/text")).toEqual({ kind: "other" });
  });

  it("does not count a lazy image below the fold", async () => {
    expect(await lcpOf("/lazy")).toEqual({ kind: "other" });
  });
});
