import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { withEstimates } from "../src/estimate-jobs.js";
import type { ObservedBackground } from "../src/backgrounds.js";
import {
  analysePage,
  pixelSize,
  type AnalysisContext,
  type ObservedImage,
  type ObservedVideo,
  type PageResult,
  type ViewportObservation,
} from "../src/remote.js";
import { fullBytesOf, videoRecordsOf, withPosterImages } from "../src/video-analysis.js";
import type { Viewport } from "../src/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/media/", import.meta.url));
const readFixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const PAGE = "https://shop.example/";
const HERO = "https://shop.example/hero.mp4";
const GIF = "https://shop.example/anim.gif";
const POSTER = "https://shop.example/poster.jpg";

const VIEW_PHONE: Viewport = { name: "iphone-15", width: 390, height: 844, dpr: 3, mobile: true };
const VIEW_DESK: Viewport = { name: "desktop", width: 1200, height: 800, dpr: 1, mobile: false };

function observedVideo(overrides: Partial<ObservedVideo> = {}): ObservedVideo {
  return {
    index: 0,
    currentSrc: HERO,
    sources: [{ src: HERO, type: "video/mp4" }],
    autoplay: true,
    muted: true,
    loop: true,
    playsinline: true,
    controls: false,
    preload: "",
    paused: false,
    renderedWidth: 390,
    renderedHeight: 220,
    inFirstViewport: true,
    hidden: false,
    videoWidth: 1280,
    locator: { selector: "div.hero > video", owners: [] },
    ...overrides,
  };
}

function observation(viewport: Viewport, extra: Partial<ViewportObservation> = {}): ViewportObservation {
  return {
    viewport,
    load: "fresh",
    status: 200,
    blocked: false,
    blockedRequests: 0,
    nextjs: false,
    images: [],
    responses: new Map(),
    ...extra,
  };
}

async function responseOf(url: string, buffer: Buffer, contentType: string) {
  return { url, contentType, bytes: buffer.length, buffer, pixels: await pixelSize(buffer) };
}

function pageBase(): PageResult {
  return {
    url: PAGE,
    host: "shop.example",
    scannedAt: new Date(0).toISOString(),
    imgtuneVersion: "test",
    metric: "ssimulacra2",
    delta: 2,
    viewports: ["iphone-15"],
    status: "ok",
    nextjs: false,
    perViewport: {},
    groups: [],
    counts: { images: 0, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
  };
}

function contextOf(): Omit<AnalysisContext, "store"> {
  return {
    pageUrl: PAGE,
    fetcher: { get: async () => undefined, hostIsBlocked: async () => false } as unknown as AnalysisContext["fetcher"],
    allowPrivate: false,
    deps: { score: () => 100 },
    quality: true,
    aggressive: false,
  };
}

/** Two viewports of one autoplay video: a phone (390 px box at dpr 3) and a desktop (1200 px box at dpr 1). */
function heroObservations(desktopBox = 1200): ViewportObservation[] {
  const media = new Map([[HERO, { url: HERO, contentType: "video/mp4", bytes: 400, status: 206 }]]);
  return [
    observation(VIEW_PHONE, { videos: [observedVideo({ renderedWidth: 390 })], media }),
    observation(VIEW_DESK, { videos: [observedVideo({ renderedWidth: desktopBox })], media }),
  ];
}

describe("videoRecordsOf in scan mode", () => {
  it("counts the full file per view for an autoplay video, plans at most two widths, and flags the cheap levers", () => {
    const records = videoRecordsOf(PAGE, heroObservations(), new Map([[HERO, 1000]]), "scan", 2);

    expect(records).toHaveLength(1);
    const [video] = records;
    expect(video.id).toMatch(/^video:[0-9a-f]{12}$/);
    expect(video.src).toBe(HERO);
    expect(video.attributes).toMatchObject({ autoplay: true, muted: true, loop: true, playsinline: true, preload: "" });
    expect(video.bytes.perView).toBe(1000);
    expect(video.bytes.perPlay).toBe(1000);
    expect(video.bytes.fullBytesKnown).toBe(false);
    expect(video.perViewport.map((p) => p.viewport)).toEqual(["iphone-15", "desktop"]);
    expect(video.widths?.widths.length).toBeLessThanOrEqual(2);
    expect(video.widthOptions).toBeUndefined();
    expect(video.levers.posterMissing).toBe(true);
    expect(video.levers.codec).toEqual({ missing: "av1" });
  });

  it("keeps two widths when a small desktop box needs far fewer pixels than the phone", () => {
    const [video] = videoRecordsOf(PAGE, heroObservations(300), new Map([[HERO, 1000]]), "scan", 2);
    expect(video.widths?.widths).toEqual([320, 1280]);
  });

  it("counts nothing per view for a hidden video, and still the full file per play", () => {
    const media = new Map([[HERO, { url: HERO, contentType: "video/mp4", bytes: 400, status: 206 }]]);
    const hidden = observation(VIEW_PHONE, { videos: [observedVideo({ hidden: true, renderedWidth: 0 })], media });
    const [video] = videoRecordsOf(PAGE, [hidden], new Map([[HERO, 1000]]), "scan", 2);
    expect(video.bytes).toMatchObject({ perView: 0, perPlay: 1000, perViewBasis: "none" });
  });

  it("reports no codec or poster lever when an AV1 source and a poster are present", () => {
    const av1 = observedVideo({
      sources: [
        { src: "https://shop.example/hero.av1.mp4", type: "video/mp4; codecs=av01.0.05M.08" },
        { src: HERO, type: "video/mp4" },
      ],
      poster: POSTER,
    });
    const [video] = videoRecordsOf(PAGE, [observation(VIEW_PHONE, { videos: [av1] })], new Map(), "scan", 2);
    expect(video.levers.codec).toBeUndefined();
    expect(video.levers.posterMissing).toBeUndefined();
  });

  it("suppresses the codec lever for a Cloudinary f_auto or imgix auto=format URL, and says the CDN handles the format", () => {
    const cloudinary = "https://res.cloudinary.com/demo/video/upload/f_auto,q_auto/hero.mp4";
    const imgix = "https://demo.imgix.net/hero.mp4?auto=format,compress";
    for (const url of [cloudinary, imgix]) {
      const video = observedVideo({ sources: [{ src: url, type: "video/mp4" }], currentSrc: url });
      const [record] = videoRecordsOf(PAGE, [observation(VIEW_PHONE, { videos: [video] })], new Map(), "scan", 2);
      expect(record.levers.codec).toBeUndefined();
      expect(record.levers.info.join("\n")).toMatch(/format handled by (Cloudinary|imgix) \((f_auto|auto=format)\)/);
    }
    const plain = observedVideo({ sources: [{ src: HERO, type: "video/mp4" }] });
    const [record] = videoRecordsOf(PAGE, [observation(VIEW_PHONE, { videos: [plain] })], new Map(), "scan", 2);
    expect(record.levers.codec).toEqual({ missing: "av1" });
    expect(record.levers.info.some((line) => line.startsWith("format handled"))).toBe(false);
  });

  it("marks a below-the-fold video that loads its file as a loading lever", () => {
    const below = observedVideo({ autoplay: false, preload: "auto", inFirstViewport: false });
    const media = new Map([[HERO, { url: HERO, contentType: "video/mp4", bytes: 400, status: 206 }]]);
    const [video] = videoRecordsOf(PAGE, [observation(VIEW_PHONE, { videos: [below], media })], new Map([[HERO, 1000]]), "scan", 2);
    expect(video.bytes).toMatchObject({ perView: 400, perViewBasis: "observed", browserDependent: true });
    expect(video.levers.loading).toEqual({ perViewBytes: 400, belowFold: true });
  });
});

describe("videoRecordsOf in audit mode", () => {
  it("reports the widths at one, two and three, and leaves the pick to the agent", () => {
    const [video] = videoRecordsOf(PAGE, heroObservations(300), new Map([[HERO, 1000]]), "audit", 2);
    expect(video.widthOptions).toHaveLength(3);
    expect(video.widthOptions?.map((plan) => plan.widths.length)).toEqual([1, 2, 2]);
    expect(video.widths).toBeUndefined();
  });
});

describe("fullBytesOf and withPosterImages", () => {
  it("takes the largest observed bytes of each media URL over the viewports", () => {
    const a = observation(VIEW_PHONE, { media: new Map([[HERO, { url: HERO, bytes: 300, status: 206 }]]) });
    const b = observation(VIEW_DESK, { media: new Map([[HERO, { url: HERO, bytes: 700, status: 200 }]]) });
    expect(fullBytesOf([a, b]).get(HERO)).toBe(700);
  });

  it("adds a poster as an image only when its response was fetched", async () => {
    const video = observedVideo({ poster: POSTER, renderedWidth: 390, renderedHeight: 219 });
    const missing = observation(VIEW_PHONE, { videos: [video] });
    expect(withPosterImages([missing])[0].images).toHaveLength(0);

    const jpeg = await sharp({ create: { width: 64, height: 36, channels: 3, background: "#345" } }).jpeg().toBuffer();
    const fetched = observation(VIEW_PHONE, { videos: [video], responses: new Map([[POSTER, await responseOf(POSTER, jpeg, "image/jpeg")]]) });
    const [poster] = withPosterImages([fetched])[0].images;
    expect(poster.currentSrc).toBe(POSTER);
    expect(poster.renderedWidth).toBe(390);
    expect(poster.posterOf).toBe("div.hero > video");
  });
});

describe("analysePage with animated and static GIFs (fake fetcher, no network)", () => {
  it("gives an animated GIF in an <img> an animated fix, and keeps its bytes in the image totals", async () => {
    const buffer = readFixture("anim.gif");
    const image: ObservedImage = {
      index: 0,
      currentSrc: GIF,
      renderedWidth: 320,
      renderedHeight: 180,
      srcset: "",
      classes: "",
      nextImage: false,
      inFirstViewport: true,
    };
    const obs = observation(VIEW_PHONE, { images: [image], responses: new Map([[GIF, await responseOf(GIF, buffer, "image/gif")]]) });

    const { value: page } = await withEstimates((store) => analysePage({ ...contextOf(), store }, [obs], pageBase()), 2);

    const [record] = page.images ?? [];
    expect(record.fix.animated?.info.frames).toBe(30);
    expect(record.fix.animated?.context).toBe("img");
    expect(record.fix.animated?.perViewBytes).toBe(buffer.length);
    expect(record.fix.animated?.target?.main).toBe("animated-image");
    expect(page.perViewport["iphone-15"].imageBytes).toBe(buffer.length);
    expect(page.videos).toBeUndefined();
  }, 120_000);

  it("gives a static GIF no animated fix, and proposes AVIF as it does for a PNG", async () => {
    const buffer = readFixture("still.gif");
    // 40 CSS px at dpr 1 needs 40 device pixels: a lossless PNG resize of the 320 px file is then smaller, so the AVIF
    // proposal (which needs a saving) applies. At 160 px the PNG is larger than the GIF, and nothing is proposed.
    const image: ObservedImage = {
      index: 0,
      currentSrc: GIF,
      renderedWidth: 40,
      renderedHeight: 23,
      srcset: "",
      classes: "",
      nextImage: false,
      inFirstViewport: true,
    };
    const obs = observation(VIEW_DESK, { images: [image], responses: new Map([[GIF, await responseOf(GIF, buffer, "image/gif")]]) });

    const { value: page } = await withEstimates((store) => analysePage({ ...contextOf(), store }, [obs], pageBase()), 2);

    const [record] = page.images ?? [];
    expect(record.current.format).toBe("gif");
    expect(record.fix.animated).toBeUndefined();
    expect(record.fix.bytes.saved).toBeGreaterThan(0);
    expect(record.fix.format).toBe("avif");
  }, 120_000);

  it("gives an animated GIF in a CSS background a css-background animated fix", async () => {
    const buffer = readFixture("anim.gif");
    const background: ObservedBackground = {
      index: 0,
      selector: "div.hero",
      classes: "hero",
      owners: [],
      width: 320,
      height: 180,
      hidden: false,
      backgroundImage: `url("${GIF}")`,
      backgroundSize: "auto",
    };
    const obs = observation(VIEW_PHONE, {
      backgrounds: [background],
      responses: new Map([[GIF, await responseOf(GIF, buffer, "image/gif")]]),
    });

    const { value: page } = await withEstimates((store) => analysePage({ ...contextOf(), store }, [obs], pageBase()), 2);

    const record = page.images?.find((r) => r.kind === "css-background");
    expect(record?.fix.animated?.context).toBe("css-background");
    expect(record?.fix.animated?.info.frames).toBe(30);
    expect(record?.fix.animated?.target?.alternatives).toEqual(["animated-avif", "animated-webp"]);
  }, 120_000);

  it("audits a fetched poster as an image sized to the video box, and reports the video with its poster", async () => {
    const jpeg = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#345" } }).jpeg({ quality: 90 }).toBuffer();
    const video = observedVideo({ poster: POSTER, renderedWidth: 390, renderedHeight: 219 });
    const obs = observation(VIEW_PHONE, {
      videos: [video],
      media: new Map([[HERO, { url: HERO, contentType: "video/mp4", bytes: 400, status: 206 }]]),
      responses: new Map([[POSTER, await responseOf(POSTER, jpeg, "image/jpeg")]]),
    });

    const { value: page } = await withEstimates((store) => analysePage({ ...contextOf(), store }, [obs], pageBase()), 2);

    const poster = page.images?.find((r) => r.evidence.notes.some((n) => n.startsWith("poster of")));
    expect(poster?.perViewport[0].neededPx).toBe(1170);
    expect(page.videos).toHaveLength(1);
    expect(page.videos?.[0].levers.posterMissing).toBeUndefined();
  }, 120_000);
});

describe("videoRecordsOf: the resolved source of a video (file:line)", () => {
  it("takes the file and line of a resolved source into the locator, and names the id by the file", () => {
    const observations = heroObservations();
    const hero = observations[0].videos?.[0] as ObservedVideo;
    const sources = new Map([[hero, { file: "src/Hero.tsx", line: 12, component: ["Hero"], check: "image" as const, via: "react-dev" as const, ownerChain: [] }]]);
    const [located] = videoRecordsOf(PAGE, observations, new Map([[HERO, 1000]]), "scan", 2, sources);
    const [unlocated] = videoRecordsOf(PAGE, heroObservations(), new Map([[HERO, 1000]]), "scan", 2);

    expect(located.locator).toMatchObject({ file: "src/Hero.tsx", line: 12, kind: "image", verified: true, via: "react-dev", component: ["Hero"] });
    expect(located.id).toMatch(/^video:[0-9a-f]{12}$/);
    expect(located.id).not.toBe(unlocated.id);
    expect(unlocated.locator.file).toBeUndefined();
  });

  it("keeps the id of an unresolved video as it was (the same record without a source)", () => {
    const [plain] = videoRecordsOf(PAGE, heroObservations(), new Map([[HERO, 1000]]), "scan", 2, new Map());
    const [again] = videoRecordsOf(PAGE, heroObservations(), new Map([[HERO, 1000]]), "scan", 2);
    expect(plain.id).toBe(again.id);
  });

  it("gives two videos of one file distinct ids", () => {
    const first = observedVideo({ locator: { selector: "div.a > video", owners: [] } });
    const second = observedVideo({ locator: { selector: "div.b > video", owners: [] } });
    const observations = [observation(VIEW_DESK, { videos: [first, second] })];
    const sources = new Map<ObservedVideo, { file: string; line: number; component: string[] }>([
      [first, { file: "src/Page.tsx", line: 5, component: [] }],
      [second, { file: "src/Page.tsx", line: 9, component: [] }],
    ]);
    const records = videoRecordsOf(PAGE, observations, new Map(), "scan", 2, sources);
    expect(records).toHaveLength(2);
    expect(records[0].locator.file).toBe("src/Page.tsx");
    expect(records[1].locator.file).toBe("src/Page.tsx");
    expect(records[0].id).not.toBe(records[1].id);
  });
});
