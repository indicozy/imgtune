import { describe, expect, it } from "vitest";
import { CHROMIUM_ARGS, ChromiumMissingError, MISSING_CHROMIUM_MESSAGE, mapLaunchError } from "../src/browser.js";

describe("mapLaunchError", () => {
  it("maps Playwright's missing-executable error to the one-line install hint", () => {
    const err = new Error(
      "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1248/chrome\nLooks like Playwright was just installed.",
    );
    const mapped = mapLaunchError(err);
    expect(mapped).toBeInstanceOf(ChromiumMissingError);
    expect((mapped as Error).message).toBe(MISSING_CHROMIUM_MESSAGE);
    expect(MISSING_CHROMIUM_MESSAGE).toBe("Chromium for Playwright is not installed. Run: npx playwright install chromium");
  });

  it("accepts a curly apostrophe in the same message", () => {
    expect(mapLaunchError(new Error("Executable doesn’t exist at /x"))).toBeInstanceOf(ChromiumMissingError);
  });

  it("returns other launch errors unchanged", () => {
    const err = new Error("Target page, context or browser has been closed");
    expect(mapLaunchError(err)).toBe(err);
    expect(mapLaunchError("boom")).toBe("boom");
  });
});

describe("CHROMIUM_ARGS", () => {
  it("keeps the GPU process and SwiftShader out of the measuring browser", () => {
    expect(CHROMIUM_ARGS).toContain("--disable-gpu");
    expect(CHROMIUM_ARGS).toContain("--disable-software-rasterizer");
  });
});
