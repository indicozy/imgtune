// Page results for the agent-flow tests (broken, worst, summary, run): plain objects shaped like a scan file, no browser.
import type { PageNumbers, PageResult } from "../src/remote.js";
import type { CandidateResult } from "../src/media-encode.js";
import type { VideoRecord } from "../src/video-analysis.js";

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

/** A candidate encode: the fixed fields a rendered hint reads, with the bars the record would carry. */
export function candidateOf(over: Partial<CandidateResult> & { vmafBar?: number } = {}): CandidateResult & { vmafBar?: number } {
  return {
    codec: "av1-mp4",
    width: 960,
    quality: 32,
    sampleBytes: 1000,
    sampleSeconds: 2,
    bytes: 412 * 1024,
    vmaf: 95.2,
    still: 72,
    stillBar: 70,
    estimate: true,
    audio: false,
    ...over,
  };
}

/** A `<video>` record of a page: autoplay off, preload metadata, 2000 KB file, one desktop viewport. */
export function videoOf(over: Partial<VideoRecord> = {}): VideoRecord {
  return {
    id: "video:abc",
    page: "https://shop.example/bags",
    locator: { component: ["Hero"], selector: "video.hero", classes: "", loader: "video" },
    src: "https://shop.example/media/hero.mp4",
    sources: [],
    attributes: { autoplay: false, muted: true, loop: false, playsinline: true, preload: "metadata" },
    bytes: { perView: 0, perPlay: 2000 * 1024, perViewBasis: "none", browserDependent: false, fullBytesKnown: true },
    perViewport: [{ viewport: "desktop", boxWidth: 480, dpr: 2, inFirstViewport: true }],
    levers: { info: [] },
    ...over,
  };
}
