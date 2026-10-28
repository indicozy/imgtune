import { describe, expect, it } from "vitest";
import { srcsetWidths } from "../src/srcset-parse.js";

describe("srcsetWidths (Node side of the measurement)", () => {
  it("reads the widths of candidates separated by a comma with no space", () => {
    expect(srcsetWidths("a.jpg 400w,b.jpg 800w")).toEqual([400, 800]);
  });

  it("keeps the commas inside a Cloudinary URL and reads each candidate's width", () => {
    const srcset =
      "https://res.cloudinary.com/demo/image/upload/w_400,q_80/a.jpg 400w, https://res.cloudinary.com/demo/image/upload/w_800,q_80/a.jpg 800w";
    expect(srcsetWidths(srcset)).toEqual([400, 800]);
  });

  it("skips x-descriptors, candidates with two descriptors, and widths outside 1..8192", () => {
    expect(srcsetWidths("a.jpg 1x, b.jpg 640w 2x, c.jpg 0w, d.jpg 9000w, e.jpg 640w")).toEqual([640]);
  });

  it("is empty for a missing or empty srcset", () => {
    expect(srcsetWidths("")).toEqual([]);
  });
});
