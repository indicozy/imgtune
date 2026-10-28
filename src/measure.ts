/// <reference lib="dom" />
import type { Browser, Page, Response } from "playwright";
import { launchChromium } from "./browser.js";
import { srcsetWidths } from "./srcset-parse.js";
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
  /** pixel width of the served file (not the density-corrected DOM value) */
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
export const BODY_READ_TIMEOUT_MS = 5_000;
const PIXEL_PROBE_TIMEOUT_MS = 5_000;

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
  /** The raw srcset attribute; parsed in Node, since the page only hands it over. */
  srcset: string;
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
  const browser = await launchChromium();
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

    let collected: CollectedImage[];
    try {
      const page = await context.newPage();
      await loadSettled(page, baseUrl + pagePath, "img[data-imgtune]");
      collected = await collectImages(page);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`imgtune: failed to load ${pagePath} at ${viewport.name}: ${message}`);
      return [];
    }

    await settleWithin(bodyReads, BODY_READ_TIMEOUT_MS);
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
        srcsetWidths: srcsetWidths(img.srcset),
        bytes: fetched?.bytes,
        contentType: fetched?.contentType,
        accept,
      };
    });
  } finally {
    await context.close();
  }
}

/**
 * Loads `url` in `page` the way every measurement does: waits for the load event, scrolls the page to its bottom and
 * back so lazy images start, then waits for the network and for the images matched by `imageSelector` to complete.
 * Resolves with the document response (null when the page has none).
 */
export async function loadSettled(page: Page, url: string, imageSelector: string): Promise<Response | null> {
  const response = await page.goto(url, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
  await scrollThrough(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
  await page
    .waitForFunction(
      (selector) =>
        Array.from(document.querySelectorAll<HTMLImageElement>(selector)).every((img) => !img.currentSrc || img.complete),
      imageSelector,
      { timeout: IMAGES_COMPLETE_TIMEOUT_MS },
    )
    .catch(() => {});
  return response;
}

/** Waits for the promises to settle, but never longer than `ms`. */
export async function settleWithin(promises: Promise<void>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([Promise.all(promises), timeout]);
  clearTimeout(timer);
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
  return page.evaluate(
    async (probeTimeoutMs) => {
      // An Image with only a src has no srcset, so its naturalWidth is the file's pixel width. Its bytes come from
      // the cache the page just filled. A probe that fails or hangs counts as 0.
      const widths = new Map<string, Promise<number>>();
      const pixelWidth = (src: string): Promise<number> => {
        let pending = widths.get(src);
        if (!pending) {
          const probe = new Image();
          probe.src = src;
          pending = new Promise<number>((resolve) => {
            const timer = setTimeout(() => resolve(0), probeTimeoutMs);
            probe.decode().then(
              () => {
                clearTimeout(timer);
                resolve(probe.naturalWidth);
              },
              () => {
                clearTimeout(timer);
                resolve(0);
              },
            );
          });
          widths.set(src, pending);
        }
        return pending;
      };

      return Promise.all(
        Array.from(document.querySelectorAll<HTMLImageElement>("img[data-imgtune]"), async (img) => {
          const rect = img.getBoundingClientRect();
          return {
            usageId: img.getAttribute("data-imgtune") ?? "",
            renderedWidth: rect.width,
            renderedHeight: rect.height,
            naturalWidth: img.currentSrc ? await pixelWidth(img.currentSrc) : 0,
            currentSrc: img.currentSrc,
            originalSrc: img.getAttribute("data-imgtune-src") || undefined,
            sizesAttr: img.getAttribute("sizes") || undefined,
            srcset: img.getAttribute("srcset") ?? "",
          };
        }),
      );
    },
    PIXEL_PROBE_TIMEOUT_MS,
  );
}
