import { chromium, type Browser } from "playwright";

/** The one line printed when Playwright has no Chromium to launch. */
export const MISSING_CHROMIUM_MESSAGE = "Chromium for Playwright is not installed. Run: npx playwright install chromium";

/** Raised when the Chromium binary Playwright expects is missing. The CLI prints its message and exits 2. */
export class ChromiumMissingError extends Error {
  constructor() {
    super(MISSING_CHROMIUM_MESSAGE);
    this.name = "ChromiumMissingError";
  }
}

/** A launch failure caused by a missing binary becomes ChromiumMissingError; any other error is returned unchanged. */
export function mapLaunchError(err: unknown): unknown {
  const text = err instanceof Error ? err.message : String(err);
  return /Executable doesn['’]t exist/.test(text) ? new ChromiumMissingError() : err;
}

/**
 * Chromium flags for measuring. `--disable-gpu` keeps the GPU process out. The software rasterizer (SwiftShader) is left
 * on: with `--disable-software-rasterizer` WebGL is off, and a page with a 3D viewer never requests its model (a census
 * site made 5 model requests with the default flags and none without). Only WebGL pages pay the extra CPU for it.
 */
export const CHROMIUM_ARGS: readonly string[] = ["--disable-gpu"];

/** The headless Chromium every measuring command uses. */
export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, args: [...CHROMIUM_ARGS] });
  } catch (err) {
    throw mapLaunchError(err);
  }
}
