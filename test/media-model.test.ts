import { describe, expect, it } from "vitest";
import {
  GIF_VIDEO_THRESHOLD,
  WIDTH_BUCKETS,
  animatedTarget,
  attributeLevers,
  clusterVideoWidths,
  extrapolate,
  rankForBudget,
  sampleOffsets,
  snapWidth,
  videoBytes,
  widthOptions,
} from "../src/media-model.js";

/** The six imgtune viewports from src/config.ts, as the clustering sees them for a full-width video. */
const SIX_VIEWPORTS = [
  { name: "iphone-se", width: 375, dpr: 2 },
  { name: "iphone-15", width: 390, dpr: 3 },
  { name: "pixel-7", width: 412, dpr: 2.625 },
  { name: "iphone-15-pro-max", width: 430, dpr: 3 },
  { name: "desktop", width: 1440, dpr: 2 },
  { name: "desktop-1280", width: 1280, dpr: 1 },
];

const fullWidthNeeds = SIX_VIEWPORTS.map((v) => ({
  viewport: v.name,
  viewportWidth: v.width,
  boxWidth: v.width,
  dpr: v.dpr,
}));

describe("WIDTH_BUCKETS", () => {
  it("lists the twelve snapping buckets in ascending order", () => {
    expect([...WIDTH_BUCKETS]).toEqual([320, 480, 640, 720, 854, 960, 1080, 1280, 1440, 1920, 2560, 3840]);
  });
});

describe("snapWidth", () => {
  it("rounds up to the smallest bucket at or above the need", () => {
    expect(snapWidth(700, 1920)).toBe(720);
    expect(snapWidth(100, 1920)).toBe(320);
    expect(snapWidth(720, 1920)).toBe(720);
  });

  it("caps at the source width when the need is above it", () => {
    expect(snapWidth(5000, 1920)).toBe(1920);
    expect(snapWidth(1500, 1200)).toBe(1200);
  });

  it("caps a bucket that is above the source width at the source width", () => {
    expect(snapWidth(1100, 1200)).toBe(1200);
  });
});

describe("videoBytes", () => {
  const base = { observedBytes: 300, fullBytes: 5_000_000, visible: true };

  it("counts the full file per view when autoplay is playing", () => {
    expect(videoBytes({ ...base, kind: "autoplay", playing: true })).toEqual({
      perView: 5_000_000,
      perPlay: 5_000_000,
      perViewBasis: "full-file",
      browserDependent: false,
    });
  });

  it("counts the observed bytes when autoplay is not playing", () => {
    expect(videoBytes({ ...base, kind: "autoplay", playing: false })).toEqual({
      perView: 300,
      perPlay: 5_000_000,
      perViewBasis: "observed",
      browserDependent: false,
    });
  });

  it("counts observed bytes for preload auto and marks it browser-dependent", () => {
    const v = videoBytes({ ...base, kind: "auto", playing: false });
    expect(v.perView).toBe(300);
    expect(v.perViewBasis).toBe("observed");
    expect(v.browserDependent).toBe(true);
  });

  it("counts observed bytes for the default preload", () => {
    const v = videoBytes({ ...base, kind: "default", playing: false });
    expect(v.perView).toBe(300);
    expect(v.perViewBasis).toBe("observed");
  });

  it("counts zero per view for metadata and none", () => {
    for (const kind of ["metadata", "none"] as const) {
      const v = videoBytes({ ...base, kind, playing: false });
      expect(v.perView).toBe(0);
      expect(v.perViewBasis).toBe("none");
      expect(v.perPlay).toBe(5_000_000);
    }
  });

  it("counts zero per view when the video is not visible, and still reports the full file per play", () => {
    const v = videoBytes({ kind: "autoplay", playing: false, observedBytes: 0, fullBytes: 5e6, visible: false });
    expect(v.perView).toBe(0);
    expect(v.perPlay).toBe(5e6);
  });
});

describe("clusterVideoWidths", () => {
  it("picks two widths for the six viewports of a full-width video", () => {
    const plan = clusterVideoWidths(fullWidthNeeds, 2, 1920);
    expect(plan.widths).toEqual([1280, 1920]);
    expect(plan.containerDriven).toBe(false);
    expect(plan.conditions).toHaveLength(1);
    expect(plan.conditions).toEqual(["(min-width: 430px)"]);
    for (const row of plan.perViewport) {
      expect(row.width).toBeGreaterThanOrEqual(row.need);
      expect(plan.widths).toContain(row.width);
    }
  });

  it("always keeps the largest snapped need so no viewport is under-served", () => {
    const plan = clusterVideoWidths(fullWidthNeeds, 1, 1920);
    expect(plan.widths).toEqual([1920]);
    expect(plan.conditions).toEqual([]);
  });

  it("gives one width for a 600 px video at every viewport with the same DPR", () => {
    const needs = SIX_VIEWPORTS.map((v) => ({
      viewport: v.name,
      viewportWidth: v.width,
      boxWidth: 600,
      dpr: 2,
    }));
    const plan = clusterVideoWidths(needs, 2, 1920);
    expect(plan.widths).toEqual([1280]);
    expect(plan.containerDriven).toBe(false);
    expect(plan.conditions).toEqual([]);
  });

  it("flags containerDriven when the box is wider on the smaller viewport", () => {
    const needs = [
      { viewport: "mobile", viewportWidth: 390, boxWidth: 350, dpr: 1 },
      { viewport: "tablet", viewportWidth: 768, boxWidth: 300, dpr: 1 },
    ];
    const plan = clusterVideoWidths(needs, 2, 1920);
    expect(plan.containerDriven).toBe(true);
    expect(plan.conditions).toHaveLength(1);
  });

  it("never returns more widths than max", () => {
    expect(clusterVideoWidths(fullWidthNeeds, 3, 1920).widths).toHaveLength(3);
  });
});

describe("widthOptions", () => {
  it("returns the plans for max 1, 2 and 3 in that order", () => {
    const plans = widthOptions(fullWidthNeeds, 1920);
    expect(plans.map((p) => p.widths.length)).toEqual([1, 2, 3]);
  });
});

describe("animatedTarget", () => {
  it("uses animated AVIF or WebP for a CSS background, never video", () => {
    expect(animatedTarget("css-background", 5_000_000)).toEqual({
      main: "animated-image",
      alternatives: ["animated-avif", "animated-webp"],
    });
  });

  it("uses an animated image for a small or unknown img GIF, with video as an alternative", () => {
    const small = { main: "animated-image", alternatives: ["animated-avif", "animated-webp", "video"] };
    expect(animatedTarget("img", 200_000)).toEqual(small);
    expect(animatedTarget("img", GIF_VIDEO_THRESHOLD)).toEqual(small);
    expect(animatedTarget("img", undefined)).toEqual(small);
  });

  it("uses video for a big img GIF, with the animated images as alternatives", () => {
    expect(animatedTarget("img", GIF_VIDEO_THRESHOLD + 1)).toEqual({
      main: "video",
      alternatives: ["animated-avif", "animated-webp"],
    });
  });

  it("sets the GIF video threshold to 1 MB", () => {
    expect(GIF_VIDEO_THRESHOLD).toBe(1_000_000);
  });
});

describe("attributeLevers", () => {
  it("splits the saving into audio, resolution, codec and quality steps", () => {
    expect(attributeLevers({ start: 100, noAudio: 90, resized: 50, recoded: 40, final: 30 })).toEqual({
      audio: 10,
      resolution: 40,
      codec: 10,
      quality: 10,
    });
  });

  it("clamps a step that grows bytes to zero", () => {
    const levers = attributeLevers({ start: 100, noAudio: 100, resized: 110, recoded: 60, final: 50 });
    expect(levers.resolution).toBe(0);
    expect(levers.codec).toBe(50);
  });
});

describe("extrapolate", () => {
  it("returns the sample bytes when the sample has no length", () => {
    expect(extrapolate(1234, 0, 60)).toBe(1234);
  });

  it("scales the sample bytes by total over sample seconds", () => {
    expect(extrapolate(1000, 2, 10)).toBe(5000);
  });
});

describe("sampleOffsets", () => {
  it("returns a single zero offset for clips under 2 s", () => {
    expect(sampleOffsets(0)).toEqual([0]);
    expect(sampleOffsets(1.5)).toEqual([0]);
  });

  it("returns one offset centred in a clip of up to 6 s", () => {
    expect(sampleOffsets(2)).toEqual([0]);
    expect(sampleOffsets(6)).toEqual([2]);
  });

  it("returns three offsets for longer clips", () => {
    expect(sampleOffsets(12)).toEqual([1, 5, 9]);
    expect(sampleOffsets(60)).toEqual([9, 29, 49]);
  });
});

describe("rankForBudget", () => {
  const asset = (key: string, perView: number, perPlay: number) => ({ key, perView, perPlay });

  it("encodes the heaviest assets first by per-view bytes, then per-play, then key", () => {
    const ranked = rankForBudget(
      [asset("b", 100, 500), asset("a", 100, 500), asset("c", 100, 900), asset("d", 300, 1)],
      10,
    );
    expect(ranked.encode.map((a) => a.key)).toEqual(["d", "c", "a", "b"]);
    expect(ranked.skipped).toEqual([]);
  });

  it("splits at the budget and reports the rest as skipped", () => {
    const ranked = rankForBudget([asset("small", 1, 1), asset("big", 9, 9), asset("mid", 5, 5)], 2);
    expect(ranked.encode.map((a) => a.key)).toEqual(["big", "mid"]);
    expect(ranked.skipped.map((a) => a.key)).toEqual(["small"]);
  });

  it("dedupes by key, keeping the heaviest copy", () => {
    const ranked = rankForBudget([asset("x", 1, 1), asset("x", 7, 7), asset("y", 3, 3)], 5);
    expect(ranked.encode.map((a) => [a.key, a.perView])).toEqual([
      ["x", 7],
      ["y", 3],
    ]);
    expect(ranked.skipped).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [asset("b", 1, 1), asset("a", 2, 2)];
    rankForBudget(input, 1);
    expect(input.map((a) => a.key)).toEqual(["b", "a"]);
  });
});
