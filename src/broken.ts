// A broken page: one whose measurement cannot be trusted as the app's numbers. Its status is "broken", it keeps its image
// records but no page numbers (so every total leaves it out), and the reason and the likely fix are recorded on it.
// The detection is on the page result only: no browser, no network.
import type { PageResult } from "./remote.js";

/** Why a page is broken, and what usually fixes it. */
export interface BrokenInfo {
  /** The kind of break: a document error, a failed stylesheet, or an image count that dropped to zero. */
  kind: "document" | "stylesheet" | "images";
  reason: string;
  fix: string;
}

/** The exit code of a run that found broken pages (scan --fail-on-broken, and run when it stops on them). */
export const BROKEN_EXIT = 4;

/** Hosts named in a reason: at most this many, the rest counted. */
const MAX_HOSTS = 3;

/** The hosts a page's failed stylesheets came from, as a short list for a reason. */
function hostList(hosts: string[]): string {
  const shown = hosts.slice(0, MAX_HOSTS).map((host) => JSON.stringify(host));
  const more = hosts.length > MAX_HOSTS ? ` and ${hosts.length - MAX_HOSTS} more` : "";
  return `${shown.join(", ")}${more}`;
}

/**
 * The reason a scanned page is broken, or undefined when it is not. Only an `ok` page can be broken: a blocked, redirected,
 * robots or failed page already has its own status. `expectedImages` is the image count the survey found on the page; a
 * full scan that finds none where the survey found some is broken.
 */
export function brokenOf(result: PageResult, expectedImages?: number): BrokenInfo | undefined {
  if (result.status !== "ok") return undefined;
  const documents = Object.entries(result.documentStatus ?? {});
  if (documents.length > 0) {
    const [viewport, code] = documents[0];
    return {
      kind: "document",
      reason: `the document answered HTTP ${code} at ${viewport}${documents.length > 1 ? ` (and ${documents.length - 1} more view(s))` : ""}`,
      fix: "the URL does not serve this page: check the path, and that the server being scanned serves this route",
    };
  }
  if (result.stylesheetsFailed !== undefined && Object.keys(result.stylesheetsFailed).length > 0) {
    const hosts = result.stylesheetHosts ?? [];
    // The most failed in any one view: the same sheet at two viewports is one sheet, not two.
    const count = Math.max(...Object.values(result.stylesheetsFailed));
    const from = hosts.length > 0 ? ` from ${hostList(hosts)}` : "";
    return {
      kind: "stylesheet",
      reason: `${count} linked stylesheet(s)${from} did not load: the page is not styled as the app is`,
      fix:
        hosts.length > 0
          ? `the CSS host ${hostList(hosts)} is unreachable from this machine or refuses the request: check it resolves, or the asset prefix the server was started with (Next.js: NEXT_PUBLIC_CDN_URL for both build and start)`
          : "check the asset prefix the server was started with (Next.js: NEXT_PUBLIC_CDN_URL for both build and start)",
    };
  }
  if (expectedImages !== undefined && expectedImages > 0 && result.counts.images === 0) {
    return {
      kind: "images",
      reason: `no images, where the survey found ${expectedImages}`,
      fix: "the scan reached another page (a redirect, a login, an empty state): open the URL in a browser and check it",
    };
  }
  return undefined;
}

/**
 * The page with its broken status applied when it is broken, else the page as it is. A broken page's page numbers and
 * groups are removed, so no total, table or hint counts it; its image records stay, for a reader who wants to see them.
 */
export function withBroken(result: PageResult, expectedImages?: number): PageResult {
  const broken = brokenOf(result, expectedImages);
  if (broken === undefined) return result;
  const kept: PageResult = { ...result, status: "broken", error: broken.reason, broken, groups: [] };
  delete kept.page;
  return kept;
}

/** Whether a survey stops the run before its deep phase, and why. */
export interface SurveyStop {
  stop: boolean;
  reason?: string;
  fix?: string;
}

/**
 * The fail-fast rule of `run`: stop before the deep phase when more than half of the survey pages are broken, or when no
 * survey page was measured at all. The reason names the most common broken reason and its fix.
 */
export function surveyStop(survey: PageResult[]): SurveyStop {
  const broken = survey.filter((page) => page.status === "broken");
  const measured = survey.filter((page) => page.status === "ok" && page.page !== undefined).length;
  if (measured === 0) {
    const counts = new Map<string, number>();
    for (const page of survey) counts.set(page.status, (counts.get(page.status) ?? 0) + 1);
    const detail = [...counts].map(([status, n]) => `${n} ${status}`).join(", ");
    return {
      stop: true,
      reason: `no survey page was measured (${detail || "no pages"})`,
      fix: "open the first URL in a browser: check it answers, and that the server is the one you meant to scan",
    };
  }
  if (broken.length * 2 <= survey.length) return { stop: false };
  const common = mostCommon(broken);
  return {
    stop: true,
    reason: `${broken.length} of ${survey.length} survey pages are broken; most: ${common?.reason ?? "unknown"}`,
    fix: common?.fix ?? "check the server being scanned",
  };
}

/** The broken info most pages share (by kind), with the first such page's reason and fix. */
function mostCommon(pages: PageResult[]): BrokenInfo | undefined {
  const byKind = new Map<string, { info: BrokenInfo; n: number }>();
  for (const page of pages) {
    if (page.broken === undefined) continue;
    const entry = byKind.get(page.broken.kind);
    if (entry) entry.n++;
    else byKind.set(page.broken.kind, { info: page.broken, n: 1 });
  }
  let best: { info: BrokenInfo; n: number } | undefined;
  for (const entry of byKind.values()) if (best === undefined || entry.n > best.n) best = entry;
  return best?.info;
}
