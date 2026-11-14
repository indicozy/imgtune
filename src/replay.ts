// Replay of recorded pages (development tooling, not a user option). With IMGTUNE_REPLAY_HAR=<dir> set, a scan serves each
// page from the HAR that scripts/record-sites.mjs recorded for it (one per URL and viewport), so reruns need no network.
// A request the HAR does not hold is aborted. Unset, nothing changes.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The file-name key of a page URL. */
export function harKey(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 12);
}

/** The HAR file of a page at a viewport, or undefined when replay is off. Throws when replay is on and the HAR is missing. */
export function replayHarPath(pageUrl: string, viewport: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.IMGTUNE_REPLAY_HAR;
  if (dir === undefined || dir === "") return undefined;
  const file = join(dir, `${harKey(pageUrl)}-${viewport}.har`);
  if (!existsSync(file)) throw new Error(`no recorded HAR for ${pageUrl} at ${viewport} in ${dir}`);
  return file;
}
