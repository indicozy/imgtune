import { describe, expect, it } from "vitest";
import type { MediaRecord, ObservedImage, ObservedVideo, ViewportObservation } from "../src/remote.js";
import { fullBytesOf, videoRecordsOf, withPosterImages } from "../src/video-analysis.js";
import type { Viewport } from "../src/types.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
const mobile: Viewport = { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true };
const PAGE = "https://example.test/";

/** One observed video. `hidden` sets the reason (see HiddenReason); a shown video has none. */
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

/** A viewport's observation: its videos, and the media bytes the page load had received by then. */
function observation(
  viewport: Viewport,
  load: "fresh" | "resized",
  videos: ObservedVideo[],
  media: Record<string, number>,
  images: ObservedImage[] = [],
  responses: Record<string, number> = {},
): ViewportObservation {
  const mediaMap = new Map<string, MediaRecord>(Object.entries(media).map(([url, bytes]) => [url, { url, status: 200, bytes }]));
  const responseMap = new Map(Object.entries(responses).map(([url, bytes]) => [url, { url, bytes, contentType: "image/png" }]));
  return { viewport, load, blocked: false, blockedRequests: 0, nextjs: false, images, videos, media: mediaMap, responses: responseMap };
}

const records = (observations: ViewportObservation[]) => videoRecordsOf(PAGE, observations, fullBytesOf(observations), "scan", 2);
const byId = (list: ReturnType<typeof records>, id: string) => list.find((r) => r.locator.selector.includes(`#${id}`));

describe("a hidden video in the records", () => {
  it("is a responsive twin: its shown copy is the claim, its hidden copy's fetched bytes are the hidden fix", () => {
    const observations = [
      observation(desktop, "fresh", [video("heroDesk", "/a.mp4"), video("heroMob", "/b.mp4", { hiddenReason: "display" })], { "/a.mp4": 18_000, "/b.mp4": 6_000 }),
      observation(
        mobile,
        "resized",
        [video("heroDesk", "/a.mp4", { hiddenReason: "display" }), video("heroMob", "/b.mp4")],
        { "/a.mp4": 18_000, "/b.mp4": 6_000 },
      ),
    ];
    const mob = byId(records(observations), "heroMob");
    expect(mob?.hidden?.action).toBe("responsive");
    expect(mob?.hidden?.viewports).toEqual(["desktop"]);
    expect(mob?.hidden?.shownIn).toEqual(["mobile"]);
    expect(mob?.hidden?.perViewBytes).toBe(3000);
    expect(mob?.perViewport.find((p) => p.viewport === "desktop")?.hidden).toBe("display");
    expect(mob?.perViewport.find((p) => p.viewport === "mobile")?.hidden).toBeUndefined();
    // The claim: the shown copy's bytes at its viewport, averaged over the two viewports (6000 at mobile, nothing at desktop).
    expect(mob?.bytes.perView).toBe(3000);
    expect(mob?.widths?.perViewport.map((p) => p.viewport)).toEqual(["mobile"]);
  });

  it("is never shown on load when no viewport shows it: no claim, no width, and the bytes are the hidden fix's", () => {
    const observations = [observation(desktop, "fresh", [video("modal", "/m.mp4", { hiddenReason: "display", preload: "auto" })], { "/m.mp4": 9_000 })];
    const modal = byId(records(observations), "modal");
    expect(modal?.hidden?.action).toBe("never-shown-on-load");
    expect(modal?.hidden?.shownIn).toEqual([]);
    expect(modal?.hidden?.perViewBytes).toBe(9000);
    expect(modal?.bytes.perView).toBe(0);
    expect(modal?.bytes.perViewBasis).toBe("none");
    expect(modal?.widths?.widths).toEqual([]);
    expect(modal?.levers.codec).toBeUndefined();
    expect(modal?.levers.posterMissing).toBeUndefined();
  });

  it("is a carousel slide (lazy) when clipped, and a closed details copy (lazy) when its content is inside one", () => {
    const observations = [
      observation(desktop, "fresh", [video("slide2", "/s.mp4", { hiddenReason: "clipped" }), video("det", "/d.mp4", { hiddenReason: "display", inPanel: true })], {
        "/s.mp4": 9_000,
        "/d.mp4": 9_000,
      }),
    ];
    expect(byId(records(observations), "slide2")?.hidden?.action).toBe("lazy");
    expect(byId(records(observations), "det")?.hidden?.action).toBe("lazy");
    expect(byId(records(observations), "det")?.hidden?.inPanel).toBe(true);
  });

  it("is not reported when the browser fetched nothing for it (preload none, no bytes, no poster)", () => {
    const observations = [observation(desktop, "fresh", [video("idle", "/i.mp4", { hiddenReason: "display", preload: "none" })], {})];
    const idle = byId(records(observations), "idle");
    expect(idle?.hidden).toBeUndefined();
    expect(idle?.bytes.perView).toBe(0);
  });

  it("counts the bytes of a hidden copy at a resized viewport from the fresh load, only when the copy fetches on load", () => {
    // The desktop copy's file was fetched in the page load; at the resized mobile step its element is hidden and autoplays.
    const auto = [observation(desktop, "fresh", [video("auto", "/x.mp4")], { "/x.mp4": 5_000 }), observation(mobile, "resized", [video("auto", "/x.mp4", { hiddenReason: "display" })], { "/x.mp4": 5_000 })];
    expect(byId(records(auto), "auto")?.hidden?.perViewBytes).toBe(2500);
    // A copy with preload none fetches nothing on load: the same URL fetched at the fresh step adds nothing at mobile.
    const lazy = [
      observation(desktop, "fresh", [video("lazy", "/y.mp4", { autoplay: false, preload: "none" })], { "/y.mp4": 5_000 }),
      observation(mobile, "resized", [video("lazy", "/y.mp4", { hiddenReason: "display", autoplay: false, preload: "none" })], { "/y.mp4": 5_000 }),
    ];
    expect(byId(records(lazy), "lazy")?.hidden).toBeUndefined();
  });

  it("adds no bytes for a hidden copy whose URL a shown video plays at the same viewport (one file, one fetch)", () => {
    const observations = [
      observation(desktop, "fresh", [video("shown", "/same.mp4"), video("copy", "/same.mp4", { hiddenReason: "display" })], { "/same.mp4": 7_000 }),
    ];
    expect(byId(records(observations), "copy")?.hidden).toBeUndefined();
  });

  it("is the poster's bytes when the poster was fetched, and no poster image is added for it", () => {
    const hidden = video("posterVid", "/p.mp4", { hiddenReason: "display", preload: "auto", poster: "/poster.png" });
    const observations = [observation(desktop, "fresh", [hidden], { "/p.mp4": 4_000 }, [], { "/poster.png": 1_500 })];
    expect(byId(records(observations), "posterVid")?.hidden?.perViewBytes).toBe(5500);
    // A hidden video's poster is not audited as an image (its bytes are the video's fix).
    const withPosters = withPosterImages(observations);
    expect(withPosters[0].images.filter((i) => i.posterOf !== undefined)).toEqual([]);
  });
});

describe("the media phase and a video no viewport shows", () => {
  it("is an asset that is never encoded: its record has no shown copy, so the split keeps it out of the encode list", async () => {
    const { splitNeverShown, NEVER_SHOWN, videoAssetOf } = await import("../src/media-phase.js");
    const { reasonText } = await import("../src/media-model.js");
    const observations = [
      observation(desktop, "fresh", [video("twinDesk", "/a.mp4"), video("modal", "/m.mp4", { hiddenReason: "display" })], { "/a.mp4": 18_000, "/m.mp4": 9_000 }),
      observation(mobile, "fresh", [video("twinDesk", "/a.mp4", { hiddenReason: "display" }), video("modal", "/m.mp4", { hiddenReason: "display" })], {
        "/a.mp4": 18_000,
        "/m.mp4": 9_000,
      }),
    ];
    const { encode, neverShown } = splitNeverShown(records(observations).map((record) => videoAssetOf(record)));
    expect(encode.map((a) => a.url)).toEqual(["/a.mp4"]);
    expect(neverShown.map((a) => a.url)).toEqual(["/m.mp4"]);
    expect(NEVER_SHOWN).toBe("never-shown");
    expect(reasonText(NEVER_SHOWN)).toBe("never shown on load");
  });
});


describe("per-view bytes are per viewport, averaged over the viewports", () => {
  it("a desktop and mobile twin pair of equal copies: each viewport loads one copy, so the page's per-view total is one copy", () => {
    const observations = [
      observation(desktop, "fresh", [video("heroDesk", "/a.mp4"), video("heroMob", "/b.mp4", { hiddenReason: "display" })], { "/a.mp4": 10_000, "/b.mp4": 10_000 }),
      observation(mobile, "fresh", [video("heroDesk", "/a.mp4", { hiddenReason: "display" }), video("heroMob", "/b.mp4")], { "/a.mp4": 10_000, "/b.mp4": 10_000 }),
    ];
    const list = records(observations);
    const total = list.reduce((sum, r) => sum + r.bytes.perView, 0);
    expect(total).toBe(10_000);
    // Each copy's claim is its shown viewport's bytes, averaged over the two viewports.
    expect(byId(list, "heroDesk")?.bytes.perView).toBe(5000);
    expect(byId(list, "heroMob")?.bytes.perView).toBe(5000);
  });

  it("a per-viewport row carries the bytes that viewport loads for the copy, shown or hidden", () => {
    const observations = [
      observation(desktop, "fresh", [video("heroDesk", "/a.mp4"), video("heroMob", "/b.mp4", { hiddenReason: "display" })], { "/a.mp4": 18_000, "/b.mp4": 6_000 }),
      observation(mobile, "fresh", [video("heroDesk", "/a.mp4", { hiddenReason: "display" }), video("heroMob", "/b.mp4")], { "/a.mp4": 18_000, "/b.mp4": 6_000 }),
    ];
    const mob = byId(records(observations), "heroMob");
    expect(mob?.perViewport.find((p) => p.viewport === "desktop")?.bytes).toBe(6000);
    expect(mob?.perViewport.find((p) => p.viewport === "mobile")?.bytes).toBe(6000);
  });

  it("gives each hidden copy its URL and its bytes at the viewport, so the JSON can be checked", () => {
    const observations = [
      observation(desktop, "fresh", [video("heroDesk", "/a.mp4"), video("heroMob", "/b.mp4", { hiddenReason: "display" })], { "/a.mp4": 18_000, "/b.mp4": 6_000 }),
      observation(mobile, "fresh", [video("heroDesk", "/a.mp4", { hiddenReason: "display" }), video("heroMob", "/b.mp4")], { "/a.mp4": 18_000, "/b.mp4": 6_000 }),
    ];
    const desk = byId(records(observations), "heroDesk");
    expect(desk?.hidden?.copies).toEqual([{ viewport: "mobile", src: "/a.mp4", bytes: 18_000, reason: "display" }]);
  });
});
