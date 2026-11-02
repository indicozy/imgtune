// Which pages are the worst: the survey ranks them by exact KB per view (the saving the exact rung proves), and by route
// type. Pure functions over the page results: no browser, no files.
import type { PageResult } from "./remote.js";

/** One page the survey can rank: its URL, route type and its image bytes and exact saving per view. */
export interface Candidate {
  url: string;
  /** The route type of the page (see routes.ts). */
  pattern: string;
  /** Exact saving per page view, in KB (the survey has no estimate). */
  exactKB: number;
  /** Image bytes per page view, in KB. */
  kbPerView: number;
}

/** The candidates of a set of results: measured (ok) pages only. Broken, blocked and failed pages are not ranked. */
export function candidatesOf(results: PageResult[], typeOf: (url: string) => string): Candidate[] {
  const out: Candidate[] = [];
  for (const result of results) {
    if (result.status !== "ok" || result.page === undefined) continue;
    const n = result.page;
    out.push({
      url: result.url,
      pattern: typeOf(result.url),
      exactKB: (n.meanImageBytes * n.exactPct) / 100 / 1024,
      kbPerView: n.meanImageBytes / 1024,
    });
  }
  return out;
}

/** A route type with its pages: the mean exact KB per page, and the page that stands for it (its worst). */
export interface PatternRank {
  pattern: string;
  pages: number;
  meanExactKB: number;
  /** Image KB per view, the tie-break of the exact mean (a plain image has no exact saving). */
  meanKbPerView: number;
  worst: Candidate;
}

/** The route types, worst first: by the mean exact KB per page (so a type is not worse for having more pages). */
export function patternRanking(candidates: Candidate[]): PatternRank[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = groups.get(candidate.pattern);
    if (list) list.push(candidate);
    else groups.set(candidate.pattern, [candidate]);
  }
  const ranks: PatternRank[] = [];
  for (const [pattern, members] of groups) {
    const ordered = [...members].sort(byExactThenUrl);
    const total = members.reduce((sum, c) => sum + c.exactKB, 0);
    const weight = members.reduce((sum, c) => sum + c.kbPerView, 0);
    ranks.push({ pattern, pages: members.length, meanExactKB: total / members.length, meanKbPerView: weight / members.length, worst: ordered[0] });
  }
  return ranks.sort((a, b) => b.meanExactKB - a.meanExactKB || b.meanKbPerView - a.meanKbPerView || a.pattern.localeCompare(b.pattern));
}

/**
 * Worst first: by exact KB, then by image KB per view (a plain <img> with no srcset has no exact saving, so the image weight
 * is what ranks it), then by URL, so the order is the same on every run.
 */
export function byExactThenUrl(a: Candidate, b: Candidate): number {
  return b.exactKB - a.exactKB || b.kbPerView - a.kbPerView || a.url.localeCompare(b.url);
}
