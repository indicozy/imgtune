// Records for animated images and `<video>` elements: the cheap levers only (no ffmpeg; the encodes come later). An
// animated image gets an `animated` fix on its ImageRecord (images.ts), and a video gets its own VideoRecord with its
// bytes per view and per play, its widths and the levers that need no probe. A fetched poster is audited as an image,
// so it is added to the page's images here, before the image pipeline runs.

import { sha1 } from "./atomic.js";
import type { AnimationInfo } from "./animated.js";
import type { CandidateResult } from "./media-encode.js";
import type { MediaProbe } from "./ffmpeg.js";
import { COMPONENT_NAME, sanitizeText, type OwnerTrace } from "./locate.js";
import type { ImageLocator, ResolvedSource } from "./images.js";
import { adapterFor, formatAutoOf } from "./loaders.js";
import {
  clusterVideoWidths,
  videoBytes,
  widthOptions,
  type AnimatedTarget,
  type LeverSteps,
  type PreloadKind,
  type VideoBytes,
  type WidthNeed,
  type WidthPlan,
} from "./media-model.js";
import type { ObservedImage, ObservedVideo, ViewportObservation } from "./remote.js";

/** Widths kept per video in scan mode (`--max-video-widths`, before the flag is wired). */
export const SCAN_MAX_VIDEO_WIDTHS = 2;

/**
 * The first index a poster takes as an image element. A poster is not an <img>, so its index is placed far above any
 * real one (the page's <img> indexes), keeping its element identity apart in the image pipeline.
 */
export const POSTER_INDEX_BASE = 1_000_000;

/** The fix of an animated image: the animation, what it is used as, and what it costs per view. */
export interface AnimatedFix {
  info: AnimationInfo;
  /** "img" for an <img>, "css-background" for a CSS background layer. */
  context: "img" | "css-background";
  target?: AnimatedTarget;
  /** The encodes (filled by the encode step). */
  estimate?: CandidateResult[];
  /** Why no encode was made (filled by the encode step). */
  notEncoded?: string;
  /** Bytes the image costs per page view: the average over the viewports, as the image savings are. */
  perViewBytes: number;
}

/** One `<video>` element of the page, with its bytes, widths and the levers it has. */
export interface VideoRecord {
  id: string;
  page: string;
  locator: ImageLocator;
  /** The URL the browser plays (currentSrc, or the first source when none was chosen). */
  src: string;
  sources: ObservedVideo["sources"];
  attributes: { autoplay: boolean; muted: boolean; loop: boolean; playsinline: boolean; preload: string; poster?: string };
  bytes: VideoBytes & {
    /**
     * True when the full file size is known. False: the full figure is the largest bytes the scan saw for the URL (a range
     * request may have moved less than the file), and the probe or a range total refines it.
     */
    fullBytesKnown: boolean;
  };
  perViewport: { viewport: string; boxWidth: number; dpr: number; inFirstViewport: boolean }[];
  probe?: MediaProbe;
  /** Scan mode: the widths the viewports are served (at most `maxWidths`). */
  widths?: WidthPlan;
  /** Audit mode: the plans at one, two and three widths, for the agent to choose from. */
  widthOptions?: WidthPlan[];
  levers: {
    audio?: { bytes: number };
    loading?: { perViewBytes: number; belowFold: boolean };
    codec?: { missing: "av1" };
    posterMissing?: true;
    /** Informational notes (never part of the claim): frame rate, loop duration, the source width. */
    info: string[];
  };
  estimate?: CandidateResult;
  steps?: LeverSteps;
  notEncoded?: string;
}

/**
 * The id of a video. Without a source file it is the group key, as before. With one it is the file step (the rule of the
 * image ids, images.ts baseKey), with the ordinal of the video among those of its file in document order, so two videos
 * of one file keep distinct ids. The id is `video:` and 12 hex digits of the hash.
 */
function videoIdOf(page: string, key: string, file: string | undefined, perFile: Map<string, number>): string {
  if (file === undefined) return `video:${sha1(`${page}\n${key}`).slice(0, 12)}`;
  const n = perFile.get(file) ?? 0;
  perFile.set(file, n + 1);
  return `video:${sha1(`${page}\nfile:${file}#${n}`).slice(0, 12)}`;
}

/**
 * Components above a video, nearest first: the same rule as remote.ts (componentNamesOf), capped at its MAX_OWNERS (8).
 * Written out here, not imported, so that this module does not import remote.ts at run time.
 */
function componentsOf(owners: OwnerTrace[]): string[] {
  return owners
    .flatMap((o) => (o.name !== undefined && COMPONENT_NAME.test(o.name) && o.name.length > 2 ? [o.name] : []))
    .slice(0, 8);
}

/** The `preload` kind of a video, as the byte rules read it: the autoplay attribute wins over preload. */
export function preloadKindOf(video: Pick<ObservedVideo, "autoplay" | "preload">): PreloadKind {
  if (video.autoplay) return "autoplay";
  switch (video.preload) {
    case "auto":
      return "auto";
    case "metadata":
      return "metadata";
    case "none":
      return "none";
    default:
      return "default";
  }
}

/**
 * The full-file bytes of each media URL: the largest bytes the scan saw for it in any viewport. A URL's bytes are the
 * bytes the page moved, so a partial (range) read can be smaller than the file; the largest read is the closest the
 * headers give without a range total.
 */
export function fullBytesOf(observations: ViewportObservation[]): Map<string, number> {
  const full = new Map<string, number>();
  for (const obs of observations) {
    for (const [url, record] of obs.media ?? []) full.set(url, Math.max(full.get(url) ?? 0, record.bytes));
  }
  return full;
}

/**
 * The observations with each fetched poster added to its viewport as an image, sized to the video's box. A poster that
 * was not fetched, or a hidden video's, is not added. The added image carries `posterOf` (the video's selector), so its
 * record says it is a poster. Returns new observations; the ones given are not changed.
 */
export function withPosterImages(observations: ViewportObservation[]): ViewportObservation[] {
  return observations.map((obs) => {
    const posters: ObservedImage[] = [];
    for (const video of obs.videos ?? []) {
      if (video.poster === undefined || video.hidden || video.poster.startsWith("data:")) continue;
      if (!obs.responses.get(video.poster)?.buffer) continue;
      posters.push({
        index: POSTER_INDEX_BASE + video.index,
        currentSrc: video.poster,
        renderedWidth: video.renderedWidth,
        renderedHeight: video.renderedHeight,
        srcset: "",
        classes: "",
        nextImage: false,
        inFirstViewport: video.inFirstViewport,
        locator: video.locator,
        posterOf: video.locator.selector,
      });
    }
    return posters.length > 0 ? { ...obs, images: [...obs.images, ...posters] } : obs;
  });
}

interface Seen {
  obs: ViewportObservation;
  video: ObservedVideo;
}

/** The key that finds a video across viewports: its components, else its test id, else its DOM path (as the images). */
function baseKeyOf(video: ObservedVideo): string {
  const components = componentsOf(video.locator.owners);
  if (components.length > 0) return `component:${components.join(">")}`;
  if (video.locator.testid) return `testid:${video.locator.testid}`;
  return `css:${video.locator.selector}`;
}

/** The videos of the page, grouped by element across viewports, in document order. */
function groupVideos(observations: ViewportObservation[]): Map<string, Seen[]> {
  const groups = new Map<string, Seen[]>();
  for (const obs of observations) {
    const ordinals = new Map<string, number>();
    for (const video of obs.videos ?? []) {
      const base = baseKeyOf(video);
      const n = ordinals.get(base) ?? 0;
      ordinals.set(base, n + 1);
      const key = `${base}#${n}`;
      const list = groups.get(key);
      if (list) list.push({ obs, video });
      else groups.set(key, [{ obs, video }]);
    }
  }
  return groups;
}

/** The bytes the scan saw for a media URL in one viewport (0 when the page did not load it there). */
function observedBytesOf(obs: ViewportObservation, url: string): number {
  return obs.media?.get(url)?.bytes ?? 0;
}

/**
 * True when a Cloudinary video URL (`/<cloud>/video/upload/<transforms>/<file>`) has `f_auto` among its transforms. The
 * image loader (loaders.ts) reads `image/upload` only, so the video path is read here.
 */
function cloudinaryVideoFormatAuto(url: URL): boolean {
  if (url.hostname !== "res.cloudinary.com") return false;
  const upload = /^\/[^/]+\/video\/upload\/(.+)$/.exec(url.pathname);
  if (!upload) return false;
  return upload[1].split("/").slice(0, -1).some((segment) => segment.split(",").includes("f_auto"));
}

/**
 * The info note of a video whose URL the CDN already serves in the format the browser takes (Cloudinary `f_auto`, imgix
 * `auto=format`): the codec lever does not apply, because the CDN negotiates the format per request. Undefined otherwise.
 */
export function formatHandledNote(src: string, page: string): string | undefined {
  let url: URL;
  try {
    url = new URL(src, page);
  } catch {
    return undefined;
  }
  if (cloudinaryVideoFormatAuto(url)) return "format handled by Cloudinary (f_auto): the CDN serves AV1 or H.264 per browser, no codec change";
  if (!formatAutoOf(src, page)) return undefined;
  const name = adapterFor(src, page).adapter.name;
  if (name === "imgix") return "format handled by imgix (auto=format): the CDN serves the format per browser, no codec change";
  return "format handled by the CDN (f_auto): the CDN serves the format per browser, no codec change";
}

/** True when the video's sources name an AV1 stream, by type or by an `.av1.mp4` file name. */
function hasAv1(video: ObservedVideo): boolean {
  if (video.sources.some((s) => /av01|av1/i.test(s.type ?? ""))) return true;
  const urls = [video.currentSrc, ...video.sources.map((s) => s.src)];
  return urls.some((u) => /\.av1\.mp4(?:[?#]|$)/i.test(u));
}

/**
 * The VideoRecords of a page, from its observations. Each `<video>` is one record across the viewports it appears in.
 *
 * Bytes: the record takes the viewport where the video costs most per view, so the claim is never low. The full file is
 * `fullBytes` (see fullBytesOf) and is shown per play for every video.
 *
 * Widths: the viewports the video is shown in (hidden ones are left out) are clustered to at most `maxWidths` widths in
 * scan mode, and the plans for one, two and three widths are kept in audit mode, where the agent chooses.
 *
 * Levers (no probe here): `loading` when a video costs bytes on load and is below the fold (or preloads), `codec` when
 * no source is AV1, and `posterMissing` when there is no poster.
 */
export function videoRecordsOf(
  page: string,
  observations: ViewportObservation[],
  fullBytes: Map<string, number>,
  mode: "scan" | "audit",
  maxWidths: number,
  sources?: Map<ObservedVideo, ResolvedSource>,
): VideoRecord[] {
  const records: VideoRecord[] = [];
  // The records of each file so far: a file's videos are told apart by their document order (see videoIdOf).
  const perFile = new Map<string, number>();
  for (const [key, members] of groupVideos(observations)) {
    const ref = members[0].video;
    const source = sources?.get(ref);
    const src = ref.currentSrc;
    const observedMax = Math.max(0, ...members.map((m) => observedBytesOf(m.obs, m.video.currentSrc)));
    const full = fullBytes.get(src) ?? observedMax;

    const views = members.map((m) =>
      videoBytes({
        kind: preloadKindOf(m.video),
        playing: !m.video.paused || m.video.errorCode === 4,
        observedBytes: observedBytesOf(m.obs, m.video.currentSrc),
        fullBytes: full,
        visible: !m.video.hidden,
      }),
    );
    const heaviest = views.reduce((best, cur) => (cur.perView > best.perView ? cur : best));

    const shown = members.filter((m) => !m.video.hidden);
    const knownWidth = shown.map((m) => m.video.videoWidth).find((w): w is number => w !== undefined && w > 0);
    const needs: WidthNeed[] = shown.map((m) => ({
      viewport: m.obs.viewport.name,
      viewportWidth: m.obs.viewport.width,
      boxWidth: m.video.renderedWidth,
      dpr: m.obs.viewport.dpr,
    }));
    const info: string[] = [];
    const handled = formatHandledNote(src, page);
    if (handled !== undefined) info.push(handled);
    let sourceWidth = knownWidth;
    if (sourceWidth === undefined) {
      // Without the source width the widths are capped at the largest display need, which is all the page shows.
      sourceWidth = Math.max(1, ...shown.map((m) => Math.ceil(m.video.renderedWidth * m.obs.viewport.dpr)));
      if (shown.length > 0) info.push("source width not read: widths are capped at the largest display need");
    }

    const belowFold = members.every((m) => !m.video.inFirstViewport);
    const levers: VideoRecord["levers"] = { info };
    if (heaviest.perView > 0 && (belowFold || ref.preload === "auto")) {
      levers.loading = { perViewBytes: heaviest.perView, belowFold };
    }
    if (handled === undefined && !hasAv1(ref)) levers.codec = { missing: "av1" };
    if (ref.poster === undefined) levers.posterMissing = true;

    const locator: ImageLocator = {
      component: source?.component.length ? source.component : componentsOf(ref.locator.owners),
      selector: sanitizeText(ref.locator.selector, 300),
      classes: "",
      loader: "video",
    };
    if (ref.locator.testid !== undefined) locator.testid = sanitizeText(ref.locator.testid, 120);
    if (source?.file !== undefined) {
      // The project file:line of the element, when the owner resolved (see remote.ts resolveVideoSources).
      locator.file = source.file;
      locator.line = source.line;
      if (source.via !== undefined) locator.via = source.via;
      locator.kind = source.check ?? "unchecked";
      locator.verified = locator.kind === "image";
      if (source.ownerChain?.length) locator.ownerChain = source.ownerChain;
    }

    const record: VideoRecord = {
      id: videoIdOf(page, key, source?.file, perFile),
      page,
      locator,
      src,
      sources: ref.sources,
      attributes: {
        autoplay: ref.autoplay,
        muted: ref.muted,
        loop: ref.loop,
        playsinline: ref.playsinline,
        preload: ref.preload,
        ...(ref.poster !== undefined ? { poster: ref.poster } : {}),
      },
      bytes: { ...heaviest, fullBytesKnown: false },
      perViewport: members.map((m) => ({
        viewport: m.obs.viewport.name,
        boxWidth: m.video.renderedWidth,
        dpr: m.obs.viewport.dpr,
        inFirstViewport: m.video.inFirstViewport,
      })),
      levers,
    };
    if (mode === "audit") record.widthOptions = widthOptions(needs, sourceWidth);
    else record.widths = clusterVideoWidths(needs, maxWidths, sourceWidth);
    records.push(record);
  }
  return records;
}
