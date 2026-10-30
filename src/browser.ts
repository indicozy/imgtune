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
 * Chromium flags for measuring. `--disable-software-rasterizer` stops Chrome from starting SwiftShader. Its worker
 * threads get a CPU set of their own from Chrome, which can fall outside the CPUs the CLI was started on.
 * Measurements (layout, rendered sizes, transferred bytes, image decoding) do not depend on the rasterizer.
 */
export const CHROMIUM_ARGS: readonly string[] = ["--disable-gpu", "--disable-software-rasterizer"];

/** The headless Chromium every measuring command uses. */
export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, args: [...CHROMIUM_ARGS] });
  } catch (err) {
    throw mapLaunchError(err);
  }
}
