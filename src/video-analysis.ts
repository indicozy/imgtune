// Records for animated images and `<video>` elements: the cheap levers only (no ffmpeg; the encodes come later). An
// animated image gets an `animated` fix on its ImageRecord (images.ts), and a video gets its own VideoRecord with its
// bytes per view and per play, its widths and the levers that need no probe. A fetched poster is audited as an image,
// so it is added to the page's images here, before the image pipeline runs.

import { sha1 } from "./atomic.js";
import type { AnimationInfo } from "./animated.js";
import type { CandidateResult } from "./media-encode.js";
import type { MediaProbe } from "./ffmpeg.js";
import { COMPONENT_NAME, sanitizeText, type OwnerTrace } from "./locate.js";
import { hiddenFixCore, type HiddenEntry, type HiddenFix, type ImageLocator, type ResolvedSource } from "./images.js";
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
import type { HiddenReason, ObservedImage, ObservedVideo, ViewportObservation } from "./remote.js";

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
  /** The device width the image needs (the largest of its viewports), set with the encode (see attachMediaResults). */
  need?: number;
  /** The file's own width, set with the encode. A target above it is capped there (see the hint). */
  sourceWidth?: number;
}

/** A hidden copy that the browser fetched bytes for: its URL, the viewport, the bytes there, and why it is hidden there. */
export interface HiddenCopy {
  viewport: string;
  src: string;
  bytes: number;
  reason: HiddenReason;
}

/** A video's loaded-but-not-shown fix: the shared fields of an image's (HiddenFix), and each hidden copy (see HiddenCopy). */
export interface VideoHiddenFix extends HiddenFix {
  copies: HiddenCopy[];
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
  /**
   * One row per viewport the video is in: its box, and `bytes`, what that viewport loads for the video (the claim's bytes when
   * the copy is shown there, the hidden copy's bytes when it is not). `hidden` is the reason it is not shown there.
   */
  perViewport: { viewport: string; boxWidth: number; dpr: number; inFirstViewport: boolean; hidden?: HiddenReason; bytes: number }[];
  /**
   * Loaded but not shown: the browser fetched bytes for a copy of this video that no viewport shows in full. Its bytes are
   * reported apart from the claim (bytes above), and the case is the same as an image's (see HiddenFix). Absent when no copy
   * was fetched while hidden.
   */
  hidden?: VideoHiddenFix;
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
 * The fresh load's media bytes behind each observation. A resized viewport shares its group's page load, so its media map
 * holds the bytes of every earlier step too. A hidden copy's bytes at a resized viewport are taken from the fresh load's map
 * (see hiddenBytesOf), so a file fetched only for another viewport is not counted there.
 */
function freshMediaOf(observations: ViewportObservation[]): Map<ViewportObservation, ViewportObservation> {
  const fresh = new Map<ViewportObservation, ViewportObservation>();
  let current: ViewportObservation | undefined;
  for (const obs of observations) {
    if (obs.load === "fresh" || current === undefined) current = obs;
    fresh.set(obs, current);
  }
  return fresh;
}

/** The poster URL of a video that is a file the page can fetch (not a data: URI), or undefined. */
function fetchablePosterOf(video: ObservedVideo): string | undefined {
  return video.poster !== undefined && !video.poster.startsWith("data:") ? video.poster : undefined;
}

/**
 * The bytes a hidden copy costs per view at its viewport: the file the browser fetched for it (the same preload rules as a
 * shown video, see videoBytes), plus its poster when the poster was fetched in the fresh load and no shown image of the
 * viewport uses that URL. Zero when the copy's file is also shown at the viewport (one fetch, counted there), or when a
 * resized viewport's copy does not fetch on load (its bytes are not the fresh load's).
 */
function hiddenBytesOf(member: Seen, shownUrls: Set<string>, freshOf: Map<ViewportObservation, ViewportObservation>): number {
  const { obs, video } = member;
  const url = video.currentSrc;
  if (shownUrls.has(url)) return 0;
  const kind = preloadKindOf(video);
  const fresh = freshOf.get(obs) ?? obs;
  // A copy that does not fetch on load (preload none or metadata) has nothing of the page load to count at a resized viewport.
  const fetchesOnLoad = kind === "autoplay" || kind === "auto" || kind === "default";
  if (obs.load !== "fresh" && !fetchesOnLoad) return 0;
  const observed = observedBytesOf(obs.load === "fresh" ? obs : fresh, url);
  const bytes = videoBytes({
    kind,
    playing: !video.paused || video.errorCode === 4,
    observedBytes: observed,
    fullBytes: observed,
    visible: true,
  }).perView;
  const poster = fetchablePosterOf(video);
  const posterBytes =
    poster !== undefined && obs.load === "fresh" && !obs.images.some((img) => img.currentSrc === poster && img.hidden === undefined)
      ? (obs.responses.get(poster)?.bytes ?? 0)
      : 0;
  return bytes + posterBytes;
}

/**
 * The VideoRecords of a page, from its observations. Each `<video>` is one record across the viewports it appears in.
 *
 * Bytes: the claim is the shown copies only. The record takes the viewport where a shown copy costs most per view, so the
 * claim is never low. The full file is `fullBytes` (see fullBytesOf) and is shown per play for every video.
 *
 * Hidden: a copy that is not shown at a viewport (see ObservedVideo.hidden) is a loaded-but-not-shown fix when the browser
 * fetched bytes for it (hiddenBytesOf). Its bytes are the fix's, apart from the claim. A video shown at no viewport is never
 * shown on load: it has no width, no levers and no claim.
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
  const freshOf = freshMediaOf(observations);
  // The file each viewport shows in full, over every video of the page: a hidden copy of one of them adds no bytes there.
  const shownAt = new Map<string, Set<string>>();
  for (const obs of observations) {
    const urls = shownAt.get(obs.viewport.name) ?? new Set<string>();
    for (const video of obs.videos ?? []) if (!video.hidden) urls.add(video.currentSrc);
    shownAt.set(obs.viewport.name, urls);
  }
  for (const [key, members] of groupVideos(observations)) {
    const shown = members.filter((m) => !m.video.hidden);
    // The record's own file and attributes come from a shown copy when there is one.
    const ref = (shown[0] ?? members[0]).video;
    const source = sources?.get(ref);
    const src = ref.currentSrc;
    const observedMax = Math.max(0, ...members.map((m) => observedBytesOf(m.obs, m.video.currentSrc)));
    const full = fullBytes.get(src) ?? observedMax;

    // The claim: the shown copies. A video shown nowhere costs nothing in the claim.
    const views = shown.map((m) =>
      videoBytes({
        kind: preloadKindOf(m.video),
        playing: !m.video.paused || m.video.errorCode === 4,
        observedBytes: observedBytesOf(m.obs, m.video.currentSrc),
        fullBytes: full,
        visible: true,
      }),
    );
    const none = videoBytes({ kind: "none", playing: false, observedBytes: 0, fullBytes: full, visible: false });
    const heaviest = views.length > 0 ? views.reduce((best, cur) => (cur.perView > best.perView ? cur : best)) : none;
    // The claim is per viewport, averaged over the viewports (as an image's is): each viewport loads its own shown copy, so a
    // twin pair counts once, not twice. Bounded by the file's own length (perPlay), as the single-copy figure is.
    const shownBytesAt = new Map<Seen, number>();
    shown.forEach((m, i) => shownBytesAt.set(m, views[i].perView));
    const claimPerView = Math.min(
      heaviest.perPlay,
      observations.length > 0 ? views.reduce((sum, v) => sum + v.perView, 0) / observations.length : 0,
    );

    // The hidden fix: one entry per viewport the video is in, shown or hidden. A hidden copy with no bytes is not reported.
    const entries: HiddenEntry[] = [];
    const copies: HiddenCopy[] = [];
    for (const m of members) {
      const viewport = { name: m.obs.viewport.name, width: m.obs.viewport.width };
      if (!m.video.hidden) {
        entries.push({ viewport, bytes: 0, inPanel: false, hover: false });
        continue;
      }
      const bytes = hiddenBytesOf(m, shownAt.get(m.obs.viewport.name) ?? new Set<string>(), freshOf);
      shownBytesAt.set(m, bytes);
      if (bytes <= 0) continue;
      const reason = m.video.hiddenReason ?? "display";
      entries.push({ viewport, bytes, hidden: reason, inPanel: m.video.inPanel === true, hover: m.video.hover === true });
      copies.push({ viewport: viewport.name, src: m.video.currentSrc, bytes, reason });
    }
    const hiddenBase = hiddenFixCore(entries, observations.length);
    const hidden: VideoHiddenFix | undefined = hiddenBase !== undefined ? { ...hiddenBase, copies } : undefined;

    const shownNow = shown.length > 0;
    const info: string[] = [];
    const handled = formatHandledNote(src, page);
    if (handled !== undefined) info.push(handled);
    const knownWidth = shown.map((m) => m.video.videoWidth).find((w): w is number => w !== undefined && w > 0);
    const needs: WidthNeed[] = shown.map((m) => ({
      viewport: m.obs.viewport.name,
      viewportWidth: m.obs.viewport.width,
      boxWidth: m.video.renderedWidth,
      dpr: m.obs.viewport.dpr,
    }));
    let sourceWidth = knownWidth;
    if (sourceWidth === undefined) {
      // Without the source width the widths are capped at the largest display need, which is all the page shows.
      sourceWidth = Math.max(1, ...shown.map((m) => Math.ceil(m.video.renderedWidth * m.obs.viewport.dpr)));
      if (shownNow) info.push("source width not read: widths are capped at the largest display need");
    }

    const belowFold = shown.every((m) => !m.video.inFirstViewport);
    const levers: VideoRecord["levers"] = { info: shownNow ? info : [] };
    if (shownNow) {
      if (claimPerView > 0 && (belowFold || ref.preload === "auto")) {
        levers.loading = { perViewBytes: claimPerView, belowFold };
      }
      if (handled === undefined && !hasAv1(ref)) levers.codec = { missing: "av1" };
      if (ref.poster === undefined) levers.posterMissing = true;
    }

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
      bytes: { ...heaviest, perView: claimPerView, fullBytesKnown: false },
      perViewport: members.map((m) => ({
        viewport: m.obs.viewport.name,
        boxWidth: m.video.renderedWidth,
        dpr: m.obs.viewport.dpr,
        inFirstViewport: m.video.inFirstViewport,
        ...(m.video.hidden ? { hidden: m.video.hiddenReason ?? "display" } : {}),
        bytes: shownBytesAt.get(m) ?? 0,
      })),
      levers,
      ...(hidden !== undefined ? { hidden } : {}),
    };
    if (mode === "audit") record.widthOptions = widthOptions(needs, sourceWidth);
    else record.widths = clusterVideoWidths(needs, maxWidths, sourceWidth);
    records.push(record);
  }
  return records;
}
