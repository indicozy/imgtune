import { describe, expect, it } from "vitest";
import { evalSizesSlot, sizesPxAt, undersizedProposal, type ProposalPoint } from "../src/candidates.js";
import { parseSrcset } from "../src/srcset-parse.js";

const SRCSET = "http://127.0.0.1:3300/p-320.jpg 320w, http://127.0.0.1:3300/p-640.jpg 640w, http://127.0.0.1:3300/p-1280.jpg 1280w";
const parse = (srcset: string) => parseSrcset(srcset, "http://127.0.0.1:3300/");

describe("evalSizesSlot", () => {
  it("reads px, vw, calc, min, max and clamp forms", () => {
    expect(evalSizesSlot("160px", 1440)).toBe(160);
    expect(evalSizesSlot("33vw", 1000)).toBeCloseTo(330);
    expect(evalSizesSlot("calc(50vw - 20px)", 390)).toBeCloseTo(175);
    expect(evalSizesSlot("max(160px, 20vw)", 1000)).toBe(200);
    expect(evalSizesSlot("min(400px, 50vw)", 1000)).toBe(400);
    expect(evalSizesSlot("clamp(100px, 50vw, 300px)", 1000)).toBe(300);
    expect(evalSizesSlot("max(calc(0.5 * clamp(375px, 100vw, 1440px) + 10px), 160px)", 1440)).toBe(730);
  });

  it("returns undefined for text it does not read, instead of guessing", () => {
    expect(evalSizesSlot("foo(1px)", 1000)).toBeUndefined();
    expect(evalSizesSlot("16px 5", 1000)).toBeUndefined();
    expect(evalSizesSlot("", 1000)).toBeUndefined();
  });

  it("picks the media branch that holds at the viewport", () => {
    expect(sizesPxAt("(max-width: 421px) 280px, 160px", 390)).toBe(280);
    expect(sizesPxAt("(max-width: 421px) 280px, 160px", 1440)).toBe(160);
  });
});

describe("undersizedProposal", () => {
  const desktop: ProposalPoint = { viewport: "desktop", viewportWidth: 1440, dpr: 2, renderedWidth: 668, srcset: SRCSET };
  const phone: ProposalPoint = { viewport: "iphone-15", viewportWidth: 390, dpr: 3, renderedWidth: 175, srcset: SRCSET };

  it("is undersized when one measured viewport loads a file below its need", () => {
    // 160px at desktop: 320w is loaded, 1280 px is needed (668 px at dpr 2, capped).
    const text = undersizedProposal("160px", [phone, desktop], parse);
    expect(text).toMatch(/^desktop \(1440 px, dpr 2\): the proposed sizes load 320w, below the 1280 px needed$/);
  });

  it("is not undersized when every measured viewport gets its file", () => {
    expect(undersizedProposal("33vw", [phone, desktop], parse)).toBeUndefined();
  });

  it("uses every viewport, not one: a proposal fine at the phone is undersized at the desktop", () => {
    expect(undersizedProposal("(max-width: 500px) 175px, 160px", [phone], parse)).toBeUndefined();
    expect(undersizedProposal("(max-width: 500px) 175px, 160px", [phone, desktop], parse)).toMatch(/^desktop/);
  });

  it("counts a proposal it cannot evaluate as undersized", () => {
    expect(undersizedProposal("foo(1px)", [desktop], parse)).toMatch(/cannot be evaluated/);
  });

  it("skips viewports where the element did not render", () => {
    expect(undersizedProposal("160px", [{ ...desktop, renderedWidth: 0 }], parse)).toBeUndefined();
  });
});
