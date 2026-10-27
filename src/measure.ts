/// <reference lib="dom" />
import { chromium, type Browser, type Page, type Response } from "playwright";
import type { Viewport } from "./types.js";

export interface ImageObservation {
  usageId: string;
  page: string;
  viewport: string;
  viewportWidth: number;
  dpr: number;
  mobile: boolean;
  renderedWidth: number;
  renderedHeight: number;
  naturalWidth: number;
  currentSrc: string;
  originalSrc?: string;
  sizesAttr?: string;
  srcsetWidths: number[];
  bytes?: number;
  contentType?: string;
  accept: "default" | "webp";
}

export interface MeasureOptions {
  /** Also run the mobile viewports with `Accept: image/webp,*\/*` on image requests. */
  webpPass?: boolean;
}

const PAGE_LOAD_TIMEOUT_MS = 120_000;
const MAX_SCROLL_STEPS = 30;
const SCROLL_STEP_WAIT_MS = 250;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;
const IMAGES_COMPLETE_TIMEOUT_MS = 5_000;

type Accept = ImageObservation["accept"];

interface ImageResponse {
  bytes?: number;
  contentType?: string;
}

interface CollectedImage {
  usageId: string;
  renderedWidth: number;
  renderedHeight: number;
  naturalWidth: number;
  currentSrc: string;
  originalSrc?: string;
  sizesAttr?: string;
  srcsetWidths: number[];
}

/**
 * Loads each page at each viewport in a fresh browser context (so no cache is shared)
 * and returns one observation per instrumented image. Failed page loads are logged to
 * stderr and skipped.
 */
export async function measurePages(
  baseUrl: string,
  pages: string[],
  viewports: Viewport[],
  opts: MeasureOptions = {},
): Promise<ImageObservation[]> {
  const browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
  try {
    const observations: ImageObservation[] = [];
    for (const pagePath of pages) {
      for (const viewport of viewports) {
        observations.push(...(await measureOne(browser, baseUrl, pagePath, viewport, "default")));
      }
    }
    if (opts.webpPass) {
      for (const pagePath of pages) {
        for (const viewport of viewports.filter((v) => v.mobile)) {
          observations.push(...(await measureOne(browser, baseUrl, pagePath, viewport, "webp")));
        }
      }
    }
    return observations;
  } finally {
    await browser.close();
  }
}

async function measureOne(
  browser: Browser,
  baseUrl: string,
  pagePath: string,
  viewport: Viewport,
  accept: Accept,
): Promise<ImageObservation[]> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    userAgent: viewport.userAgent,
  });
  try {
    // Keyed by URL; a URL fetched more than once keeps the last response.
    const images = new Map<string, ImageResponse>();
    const bodyReads: Promise<void>[] = [];
    context.on("response", (response: Response) => {
      if (response.request().resourceType() !== "image") return;
      const entry: ImageResponse = { contentType: response.headers()["content-type"] };
      images.set(response.url(), entry);
      bodyReads.push(
        response.body().then(
          (body) => {
            entry.bytes = body.length;
          },
          () => {},
        ),
      );
    });

    if (accept === "webp") {
      await context.route("**/*", (route) => {
        if (route.request().resourceType() !== "image") return route.continue();
        return route.continue({
          headers: { ...route.request().headers(), accept: "image/webp,*/*" },
        });
      });
    }

    const page = await context.newPage();
    try {
      await page.goto(baseUrl + pagePath, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`imgtune: failed to load ${pagePath} at ${viewport.name}: ${message}`);
      return [];
    }

    await scrollThrough(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page
      .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
      .catch(() => {});
    await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll<HTMLImageElement>("img[data-imgtune]")).every(
            (img) => !img.currentSrc || img.complete,
          ),
        undefined,
        { timeout: IMAGES_COMPLETE_TIMEOUT_MS },
      )
      .catch(() => {});
    await Promise.all(bodyReads);

    const collected = await collectImages(page);
    return collected.map((img) => {
      const fetched = img.currentSrc ? images.get(img.currentSrc) : undefined;
      return {
        usageId: img.usageId,
        page: pagePath,
        viewport: viewport.name,
        viewportWidth: viewport.width,
        dpr: viewport.dpr,
        mobile: viewport.mobile,
        renderedWidth: img.renderedWidth,
        renderedHeight: img.renderedHeight,
        naturalWidth: img.naturalWidth,
        currentSrc: img.currentSrc,
        originalSrc: img.originalSrc,
        sizesAttr: img.sizesAttr,
        srcsetWidths: img.srcsetWidths,
        bytes: fetched?.bytes,
        contentType: fetched?.contentType,
        accept,
      };
    });
  } finally {
    await context.close();
  }
}

/** Scrolls one viewport height at a time until the bottom, so lazy images start loading. */
async function scrollThrough(page: Page): Promise<void> {
  for (let step = 0; step < MAX_SCROLL_STEPS; step++) {
    const atBottom = await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
      return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
    });
    await new Promise((resolve) => setTimeout(resolve, SCROLL_STEP_WAIT_MS));
    if (atBottom) return;
  }
}

async function collectImages(page: Page): Promise<CollectedImage[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>("img[data-imgtune]"), (img) => {
      const rect = img.getBoundingClientRect();
      const srcsetWidths: number[] = [];
      for (const candidate of (img.getAttribute("srcset") ?? "").split(",")) {
        const descriptor = candidate.trim().split(/\s+/)[1];
        const match = descriptor ? /^(\d+)w$/.exec(descriptor) : null;
        if (match) srcsetWidths.push(Number(match[1]));
      }
      return {
        usageId: img.getAttribute("data-imgtune") ?? "",
        renderedWidth: rect.width,
        renderedHeight: rect.height,
        naturalWidth: img.naturalWidth,
        currentSrc: img.currentSrc,
        originalSrc: img.getAttribute("data-imgtune-src") || undefined,
        sizesAttr: img.getAttribute("sizes") || undefined,
        srcsetWidths,
      };
    }),
  );
}
