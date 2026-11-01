// Page results for the agent-flow tests (broken, worst, summary, run): plain objects shaped like a scan file, no browser.
import type { PageNumbers, PageResult } from "../src/remote.js";

/** Page numbers of a page with `kbPerView` KB of image bytes per view and `exactPct` exact saving. */
export function numbersOf(kbPerView: number, exactPct: number, sharpnessKB = 0): PageNumbers {
  return {
    meanImageBytes: kbPerView * 1024,
    exactPct,
    exactEstPct: exactPct,
    fixablePct: exactPct,
    sharpnessKB,
  };
}

/** A measured (ok) page result with the given numbers and image count. */
export function okPage(url: string, kbPerView: number, exactPct: number, over: Partial<PageResult> = {}): PageResult {
  const host = new URL(url).host;
  return {
    url,
    host,
    scannedAt: "2026-01-01T00:00:00.000Z",
    imgtuneVersion: "0",
    metric: "ssimulacra2",
    delta: 2,
    viewports: ["desktop"],
    status: "ok",
    nextjs: false,
    perViewport: {},
    groups: [],
    counts: { images: 3, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
    page: numbersOf(kbPerView, exactPct),
    ...over,
  };
}

/** A page result with a status other than ok, and no numbers. */
export function otherPage(url: string, status: PageResult["status"], over: Partial<PageResult> = {}): PageResult {
  return { ...okPage(url, 0, 0), status, page: undefined, error: status, ...over };
}
