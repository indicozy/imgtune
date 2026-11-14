import { describe, expect, it } from "vitest";
import { hiddenVideoPagesLine, hiddenVideoSummaryLine, videoHiddenLines, videoLines, videoTotalsLine } from "../src/hints.js";
import type { PageResult } from "../src/remote.js";
import { videoRecordsOf, fullBytesOf, type VideoRecord } from "../src/video-analysis.js";
import type { ObservedVideo, ViewportObservation } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
const mobile: Viewport = { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true };
const PAGE = "https://example.test/";

function video(id: string, src: string, over: Partial<ObservedVideo> = {}): ObservedVideo {
  const hidden = over.hiddenReason !== undefined || over.hidden === true;
  return {
    index: 0,
    currentSrc: src,
    sources: [],
    autoplay: true,
    muted: true,
    loop: false,
    playsinline: true,
    controls: false,
    preload: "",
    paused: hidden,
    renderedWidth: hidden ? 0 : 320,
    renderedHeight: hidden ? 0 : 180,
    videoWidth: 320,
    inFirstViewport: true,
    hidden,
    locator: { selector: `video#${id}`, owners: [] },
    ...over,
  };
}

function observation(viewport: Viewport, videos: ObservedVideo[], media: Record<string, number>): ViewportObservation {
  return {
    viewport,
    load: "fresh",
    blocked: false,
    blockedRequests: 0,
    nextjs: false,
    images: [],
    videos,
    media: new Map(Object.entries(media).map(([url, bytes]) => [url, { url, status: 200, bytes }])),
    responses: new Map(),
  };
}

function recordsOf(observations: ViewportObservation[]): VideoRecord[] {
  return videoRecordsOf(PAGE, observations, fullBytesOf(observations), "scan", 2);
}

const twin = (): VideoRecord[] =>
  recordsOf([
    observation(desktop, [video("heroDesk", "/a.mp4"), video("heroMob", "/b.mp4", { hiddenReason: "display" })], { "/a.mp4": 18_000, "/b.mp4": 6_000 }),
    observation(mobile, [video("heroDesk", "/a.mp4", { hiddenReason: "display" }), video("heroMob", "/b.mp4")], { "/a.mp4": 18_000, "/b.mp4": 6_000 }),
  ]);

describe("the text of a hidden video", () => {
  it("names the case, the viewports and the fix for a responsive twin, with <source media> and a fallback", () => {
    const [desk] = twin().filter((r) => r.locator.selector.includes("heroDesk"));
    const text = videoLines(desk).join("\n");
    expect(text).toContain("loaded but not shown on load");
    expect(text).toContain('responsive twin, shown on load at "desktop"');
    expect(text).toContain("<source media=");
    expect(text).toContain("fallback");
    expect(text).toContain("not in the savings");
  });

  it("is never shown on load: remove it or load it on demand, and no encode, source or width line", () => {
    const observations = [observation(desktop, [video("modal", "/m.mp4", { hiddenReason: "display", preload: "auto" })], { "/m.mp4": 9_000 })];
    const modal = recordsOf(observations)[0];
    const text = videoLines(modal).join("\n");
    expect(text).toContain("never shown on load at any of 1 viewport(s): remove it, or load it on demand");
    expect(text).toContain("not encoded: never shown on load");
    expect(text).not.toContain("<source");
    expect(text).not.toContain("codec:");
    expect(text).not.toContain("loading:");
    expect(text).not.toContain("width(s)");
  });

  it("is lazy for a carousel slide: preload none, no autoplay until shown, poster only", () => {
    const observations = [observation(desktop, [video("slide2", "/s.mp4", { hiddenReason: "clipped" })], { "/s.mp4": 9_000 })];
    const text = videoLines(recordsOf(observations)[0]).join("\n");
    expect(text).toContain('preload="none", no autoplay until it is shown');
    expect(text).toContain("IntersectionObserver");
  });

  it("gives the hidden lines alone for a record with a hidden fix (the helper)", () => {
    const hidden = twin()[1].hidden;
    expect(hidden).toBeDefined();
    expect(videoHiddenLines(hidden!)[0]).toMatch(/^ {3}loaded but not shown on load: .+\/view, hidden at 1 of 2 viewport\(s\)/);
  });
});

describe("the totals and summary lines of hidden videos", () => {
  it("keeps the claim to the shown copies and adds the hidden bytes as their own part of the totals", () => {
    const records = twin();
    const total = videoTotalsLine(records) ?? "";
    // The claim is per viewport, averaged: desktop shows 18 KB, mobile 6 KB, so 12 KB per view. The hidden copies (18 KB at
    // mobile, 6 KB at desktop) are averaged the same way: 12 KB per view, apart from the claim.
    expect(total).toMatch(/^video: 12 KB\/view, .*; loaded but not shown 12 KB\/view in 2 video\(s\)/);
  });

  it("prints one summary line for a page, and one for the PR comment over all pages", () => {
    const records = twin();
    const line = hiddenVideoSummaryLine(records);
    expect(line).toBe("loaded but not shown: 2 video(s), 12 KB/view (responsive 2, lazy 0, never shown on load 0); not in the savings");
    expect(hiddenVideoSummaryLine(records.filter((r) => r.hidden === undefined))).toBeUndefined();
    const page = { url: PAGE, status: "ok", videos: records } as unknown as PageResult;
    // Two pages with two hidden videos each: one line over both.
    expect(hiddenVideoPagesLine([page, page])).toMatch(/^loaded but not shown: 4 video\(s\), 23 KB\/view/);
  });

});
