// The merge of the hidden-images and vector-art streams: a loaded-but-not-shown image is never also a vector claim, and
// its summary line states the cases the report counts.
import { describe, expect, it } from "vitest";
import { hintsOf, hiddenSummaryLine } from "../src/hints.js";
import type { ImageRecord } from "../src/images.js";
import type { PageResult } from "../src/remote.js";

describe("hidden images and vector art on one page", () => {
  it("states the loaded-but-not-shown summary with the cases that sum to the count", () => {
    const line = hiddenSummaryLine({ images: 3, bytesPerView: 2048, cases: { responsive: 1, lazy: 1, "never-shown-on-load": 1 } } as never);
    expect(line).toBe("loaded but not shown: 3 image(s), 2 KB/view (responsive 1, lazy 1, never shown on load 1); not in the savings");
  });

  it("gives a hidden image a hidden hint and no vector claim, even when it looks like vector art", () => {
    const record = {
      id: "h1",
      kind: "img",
      page: "https://shop.example/",
      locator: { selector: "img.logo", component: [] },
      current: { srcsetCandidates: [], naturalWidth: 800 },
      perViewport: [],
      fix: { bytes: { saved: 0, addedForSharpness: 0, sizes: 0, quality: 0 } },
      evidence: { rung: "measured", notes: [] },
      hidden: {
        action: "never-shown-on-load",
        perViewBytes: 9000,
        shownIn: [],
        viewports: ["desktop"],
      },
    } as unknown as ImageRecord;
    const result = { url: "https://shop.example/", status: "ok", images: [record] } as unknown as PageResult;
    const hints = hintsOf(result);
    expect(hints).toHaveLength(1);
    expect(hints[0].vector).toBeUndefined();
    expect(hints[0].hidden).toBeDefined();
  });
});
