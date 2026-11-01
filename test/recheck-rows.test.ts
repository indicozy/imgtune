import { describe, expect, it } from "vitest";
import { batchLine, perView, rowLine } from "../src/recheck-rows.js";

describe("recheck rows", () => {
  it("prints a saving or an increase per view, in KB with one decimal", () => {
    expect(perView(12.34 * 1024)).toBe("saves 12.3 KB/view");
    expect(perView(-4 * 1024)).toBe("adds 4.0 KB/view");
  });

  it("prints one line per image: id, verdict, where, predicted and measured", () => {
    expect(rowLine({ id: "ab12", where: "Card.tsx:42", verdict: "PASS", predicted: 6 * 1024, measured: 5.5 * 1024 })).toBe(
      "ab12  PASS  Card.tsx:42  predicted saves 6.0 KB/view, measured saves 5.5 KB/view",
    );
    expect(rowLine({ id: "cd34", where: "Tile", verdict: "GONE", predicted: 2048 })).toBe(
      "cd34  GONE  Tile  predicted saves 2.0 KB/view, measured none",
    );
  });

  it("totals the batch: verdict counts, and the predicted and measured bytes over the images", () => {
    const line = batchLine(
      [
        { id: "a", where: "x", verdict: "PASS", predicted: 4096, measured: 4096 },
        { id: "b", where: "y", verdict: "FAIL", predicted: 2048, measured: -1024 },
        { id: "c", where: "z", verdict: "GONE", predicted: 1024 },
      ],
      1.25,
    );
    expect(line).toBe(
      "batch: 3 image(s) in 1.3 s: 1 PASS, 1 FAIL, 1 GONE; predicted saves 7.0 KB/view in total, measured saves 3.0 KB/view in total (2 image(s) measured)",
    );
  });
});
