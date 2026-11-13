/**
 * Pure rules for animated media and `<video>`: which widths to encode at, how many bytes a view or a play costs,
 * which target to recommend for a GIF, how to split a saving across levers, how to sample a clip, and which assets
 * fit the encode budget. No I/O and no ffmpeg here, so every rule can be tested without a browser or an encoder.
 */

/**
 * How a not-encoded reason code reads in a report. Codes that a report prints as words (the agent reads them): a code with
 * no entry passes through unchanged, as it is already a sentence (for example "ffmpeg not found").
 */
const REASON_TEXT: Record<string, string> = {
  "time-limit": "time limit reached",
  "no-passing-quality": "no setting passed the quality bar",
  "too-large": "too large to score",
  "no-encoder": "ffmpeg has no encoder for this codec",
  "no-vmaf": "ffmpeg has no libvmaf",
  "no-ffmpeg": "ffmpeg not found",
  "probe-failed": "ffprobe could not read the file",
  "score-failed": "the quality scorer failed",
  aborted: "aborted",
};

/** The text of a not-encoded reason (see REASON_TEXT). */
export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}

/** Widths a video rendition can be snapped to. Few buckets keep the encode count and the cache keys small. */
export const WIDTH_BUCKETS = [320, 480, 640, 720, 854, 960, 1080, 1280, 1440, 1920, 2560, 3840] as const;

/**
 * Snaps a needed pixel width to the smallest bucket at or above it, never above the source width. A need the source
 * cannot reach returns the source width, since encoding wider than the source adds bytes and no detail.
 */
export function snapWidth(need: number, sourceWidth: number): number {
  if (need >= sourceWidth) return sourceWidth;
  const bucket = WIDTH_BUCKETS.find((b) => b >= need);
  return bucket === undefined ? sourceWidth : Math.min(bucket, sourceWidth);
}

/** The `preload` attribute as written in the page, or "default" when it is absent. */
export type PreloadKind = "autoplay" | "auto" | "metadata" | "none" | "default";

/**
 * Bytes a `<video>` costs. `perView` is what the page pulls on load (the claim and the priority order); `perPlay` is
 * the full file, shown for every video so large click-to-play files are not missed.
 */
export interface VideoBytes {
  perView: number;
  perPlay: number;
  /** "full-file": counted from the file size. "observed": the bytes seen in the scan. "none": nothing loads. */
  perViewBasis: "full-file" | "observed" | "none";
  /** True when the browser decides how much to fetch (preload="auto"), so the observed figure varies by browser. */
  browserDependent: boolean;
}

/**
 * Applies the per-view rules. A video that is not visible (0×0 or `display:none`) costs nothing per view, because the
 * browser does not fetch it for the page. Autoplay fetches the whole file once it plays, so it counts the full file;
 * before that it counts what the scan saw. preload="auto" and the default fetch whatever the browser chooses, so they
 * count the observed bytes. metadata and none fetch no media on load.
 */
export function videoBytes(input: {
  kind: PreloadKind;
  playing: boolean;
  observedBytes: number;
  fullBytes: number;
  visible: boolean;
}): VideoBytes {
  const perPlay = input.fullBytes;
  const bounded = (view: VideoBytes): VideoBytes => ({ ...view, perView: Math.min(view.perView, perPlay) });
  if (!input.visible) return { perView: 0, perPlay, perViewBasis: "none", browserDependent: false };
  switch (input.kind) {
    case "autoplay":
      return input.playing
        ? bounded({ perView: input.fullBytes, perPlay, perViewBasis: "full-file", browserDependent: false })
        : bounded({ perView: input.observedBytes, perPlay, perViewBasis: "observed", browserDependent: false });
    case "auto":
      return bounded({ perView: input.observedBytes, perPlay, perViewBasis: "observed", browserDependent: true });
    case "default":
      return bounded({ perView: input.observedBytes, perPlay, perViewBasis: "observed", browserDependent: false });
    case "metadata":
    case "none":
      return { perView: 0, perPlay, perViewBasis: "none", browserDependent: false };
  }
}

/**
 * The bytes of a video once its full file length is known (from a Range probe): the per-play figure is the length, and the
 * per-view figure is the length when the view counts the full file (autoplay), else the observed bytes, never above the
 * length. Keeps perView ≤ perPlay.
 */
export function withFileLength(bytes: VideoBytes, length: number): VideoBytes {
  return {
    ...bytes,
    perPlay: length,
    perView: Math.min(bytes.perViewBasis === "full-file" ? length : bytes.perView, length),
  };
}

/** The chosen renditions for one video: the width each viewport gets and the `<source>` list that serves it. */
export interface WidthPlan {
  /** The distinct kept widths, ascending. */
  widths: number[];
  /**
   * One row per viewport, in input order. `need` is the snapped pixel width the box needs (ceil(box × DPR), snapped).
   * `width` is the width assigned to the viewport: it is never below `need`, and it is the width the browser picks.
   */
  perViewport: { viewport: string; need: number; width: number }[];
  /**
   * The `<source>` list in browser order: the largest range first, the first range last with no media. A source's
   * `media` is `(min-width: Npx)` with N the CSS width of its range's first viewport.
   */
  sources: { width: number; media: string | undefined }[];
  /** The `media` of every source that has one, in the same order as `sources`. */
  conditions: string[];
  /**
   * True when the box width is not monotonic in the viewport width (a box that is wider on the smaller viewport).
   * The media conditions still select the planned widths; the flag tells the hint renderer that the box, not the
   * viewport, drives the need, so it should print box widths.
   */
  containerDriven: boolean;
}

/** One viewport's input to the width clustering. */
export interface WidthNeed {
  viewport: string;
  viewportWidth: number;
  boxWidth: number;
  dpr: number;
}

/** Ignores floating-point noise such as 1080.0000000002 before taking the ceiling. */
function pixelNeed(boxWidth: number, dpr: number): number {
  return Math.ceil(boxWidth * dpr - 1e-9);
}

/** True when a larger viewport never gets a smaller box, so the widths can be picked by viewport. */
function isMonotonic(needs: readonly WidthNeed[]): boolean {
  for (const a of needs) {
    for (const b of needs) {
      if (a.viewportWidth < b.viewportWidth && a.boxWidth > b.boxWidth) return false;
    }
  }
  return true;
}

/** The contiguous ranges [first, last] (inclusive indexes) that a list of cut positions makes. */
function rangesFrom(count: number, cuts: readonly number[]): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  for (const cut of cuts) {
    ranges.push([start, cut]);
    start = cut + 1;
  }
  ranges.push([start, count - 1]);
  return ranges;
}

/**
 * Picks at most `max` widths for a video so that the browser serves each viewport a width that covers its need.
 *
 * The browser chooses a `<source>` by CSS viewport width, not by DPR, so the plan is built the same way. The viewports
 * are sorted by CSS width (ties keep input order) and cut into at most `max` contiguous ranges. A cut is allowed only
 * where the CSS width grows, because two viewports of one width always get the same source. Each range gets the
 * largest snapped need in it, so every viewport in the range is covered. Every set of cuts is tried (at most six
 * viewports, so brute force is cheap). The set with the smallest sum of per-viewport widths wins; ties go to fewer
 * ranges, then to the smaller sum of distinct widths. Adjacent ranges that end at the same width are merged.
 *
 * `sources` is the `<source>` list in browser order: the largest range first, each with `(min-width: N)` where N is the
 * CSS width of the range's first viewport, and the first range as the final source with no media. The browser takes
 * the first source whose media matches the viewport, so it serves each viewport exactly `perViewport[i].width`.
 */
export function clusterVideoWidths(needs: WidthNeed[], max: number, sourceWidth: number): WidthPlan {
  const containerDriven = !isMonotonic(needs);
  if (needs.length === 0) return { widths: [], perViewport: [], sources: [], conditions: [], containerDriven };

  const snapped = needs.map((n, order) => ({ ...n, order, need: snapWidth(pixelNeed(n.boxWidth, n.dpr), sourceWidth) }));
  const byCssWidth = [...snapped].sort((a, b) => a.viewportWidth - b.viewportWidth || a.order - b.order);
  const count = byCssWidth.length;
  const cuts: number[] = [];
  for (let j = 0; j < count - 1; j++) {
    if (byCssWidth[j].viewportWidth < byCssWidth[j + 1].viewportWidth) cuts.push(j);
  }
  const limit = Math.max(1, Math.floor(max));

  let best: { ranges: [number, number][]; widths: number[]; cost: number; distinctSum: number } | undefined;
  for (let mask = 0; mask < 1 << cuts.length; mask++) {
    const picked = cuts.filter((_, i) => (mask >> i) & 1);
    if (picked.length + 1 > limit) continue;
    const ranges = rangesFrom(count, picked);
    const widths = ranges.map(([first, last]) => Math.max(...byCssWidth.slice(first, last + 1).map((s) => s.need)));
    let cost = 0;
    ranges.forEach(([first, last], i) => {
      cost += widths[i] * (last - first + 1);
    });
    const distinctSum = [...new Set(widths)].reduce((acc, w) => acc + w, 0);
    if (
      !best ||
      cost < best.cost ||
      (cost === best.cost &&
        (ranges.length < best.ranges.length || (ranges.length === best.ranges.length && distinctSum < best.distinctSum)))
    ) {
      best = { ranges, widths, cost, distinctSum };
    }
  }

  const merged: { first: number; last: number; width: number }[] = [];
  best!.ranges.forEach(([first, last], i) => {
    const width = best!.widths[i];
    const previous = merged[merged.length - 1];
    if (previous && previous.width === width) previous.last = last;
    else merged.push({ first, last, width });
  });

  const sources: WidthPlan["sources"] = [];
  for (let i = merged.length - 1; i >= 0; i--) {
    const range = merged[i];
    sources.push({
      width: range.width,
      media: i === 0 ? undefined : `(min-width: ${byCssWidth[range.first].viewportWidth}px)`,
    });
  }

  const widthByOrder: number[] = new Array(count);
  for (const range of merged) {
    for (let k = range.first; k <= range.last; k++) widthByOrder[byCssWidth[k].order] = range.width;
  }
  const perViewport = snapped.map((s) => ({ viewport: s.viewport, need: s.need, width: widthByOrder[s.order] }));
  const widths = [...new Set(merged.map((r) => r.width))].sort((a, b) => a - b);
  const conditions = sources.flatMap((s) => (s.media === undefined ? [] : [s.media]));

  return { widths, perViewport, sources, conditions, containerDriven };
}

/**
 * The plans for `max` = 1, 2 and 3, for `audit`, which reports the bytes per view at each count and leaves the pick
 * to the agent.
 */
export function widthOptions(needs: WidthNeed[], sourceWidth: number): WidthPlan[] {
  return [1, 2, 3].map((max) => clusterVideoWidths(needs, max, sourceWidth));
}

/** A GIF bigger than this is recommended as `<video>`; a smaller one as an animated AVIF/WebP image. */
export const GIF_VIDEO_THRESHOLD = 1_000_000;

/** The recommended replacement for an animated GIF, and the other options with their order. */
export type AnimatedTarget = {
  main: "animated-image" | "video";
  alternatives: ("animated-avif" | "animated-webp" | "video")[];
};

/**
 * Chooses the target for an animated GIF by where it is used. A CSS background cannot use `<video>` in a way that keeps
 * the same markup, so it gets animated AVIF or WebP only. A small `<img>` GIF only changes `src`. A big `<img>` GIF
 * is best as `<video autoplay muted loop playsinline>`, with the animated image kept as an alternative.
 */
export function animatedTarget(context: "img" | "css-background", avifBytes: number | undefined): AnimatedTarget {
  if (context === "css-background") return { main: "animated-image", alternatives: ["animated-avif", "animated-webp"] };
  if (avifBytes === undefined || avifBytes <= GIF_VIDEO_THRESHOLD) {
    return { main: "animated-image", alternatives: ["animated-avif", "animated-webp", "video"] };
  }
  return { main: "video", alternatives: ["animated-avif", "animated-webp"] };
}

/** Bytes saved by each lever, in the order the chain applies them. */
export interface LeverSteps {
  audio: number;
  resolution: number;
  codec: number;
  quality: number;
}

/**
 * Splits the saving of a re-encode into levers, so that nothing is double-counted. The stages are first made
 * non-increasing (a stage that grows the file is held at the level before it), so every step is at least zero and
 * the four steps sum to start − the lowest stage. When the last stage is the lowest, that is start − final. If the
 * last stage grows the file, the sum is start − recoded: a growing stage cannot carry a negative lever.
 */
export function attributeLevers(chain: {
  start: number;
  noAudio: number;
  resized: number;
  recoded: number;
  final: number;
}): LeverSteps {
  const noAudio = Math.min(chain.noAudio, chain.start);
  const resized = Math.min(chain.resized, noAudio);
  const recoded = Math.min(chain.recoded, resized);
  const final = Math.min(chain.final, recoded);
  return {
    audio: chain.start - noAudio,
    resolution: noAudio - resized,
    codec: resized - recoded,
    quality: recoded - final,
  };
}

/** Scales the bytes of a sample clip to the full duration. A sample with no length returns its bytes unchanged. */
export function extrapolate(sampleBytes: number, sampleSeconds: number, totalSeconds: number): number {
  if (sampleSeconds <= 0) return sampleBytes;
  return Math.round((sampleBytes * totalSeconds) / sampleSeconds);
}

/**
 * Start offsets, in seconds, of the 2-second sample clips. A clip of up to 6 s is sampled once, centred. A longer one
 * is sampled at 1/6, 1/2 and 5/6 of its length, each shifted back by 1 s so the clip sits around that point, and kept
 * inside the file. Clips under 2 s are sampled from the start.
 */
export function sampleOffsets(durationS: number): number[] {
  if (durationS < 2) return [0];
  if (durationS <= 6) return [Math.max(0, (durationS - 2) / 2)];
  return [1 / 6, 1 / 2, 5 / 6].map((f) => Math.min(Math.max(0, durationS * f - 1), durationS - 2));
}

/**
 * Orders assets for the encode budget: heaviest per-view bytes first, then per-play bytes, then key. Duplicate keys
 * are dropped, keeping the first (heaviest) copy. The first `budget` assets are encoded; the rest are skipped and
 * still get their cheap hints. The input is not mutated.
 */
export function rankForBudget<T extends { perView: number; perPlay: number; key: string }>(
  assets: T[],
  budget: number,
): { encode: T[]; skipped: T[] } {
  const sorted = [...assets].sort(
    (a, b) => b.perView - a.perView || b.perPlay - a.perPlay || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const a of sorted) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    unique.push(a);
  }
  const cut = Math.max(0, Math.floor(budget));
  return { encode: unique.slice(0, cut), skipped: unique.slice(cut) };
}
