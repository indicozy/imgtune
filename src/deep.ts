// Deep-page selection: which survey pages get the full scan. Each route type that has images contributes its heaviest page
// (image KB per view, exact KB only as the tie-break: a page whose images have no srcset has no exact saving, and the
// estimate is what finds it). The types are taken heaviest first by their total KB per view (pages x mean), and the count
// caps how many. Pure functions over the survey results and the route grouping.
import type { PageResult } from "./remote.js";
import type { RouteGrouping } from "./routes.js";
import { candidatesOf, type Candidate } from "./worst.js";

/** The deep page of one route type. */
export interface DeepPick {
  url: string;
  type: string;
  /** The survey pages of the type that were measured. */
  typePages: number;
  /** The deep page's image KB per view in the survey. */
  kbPerView: number;
  /** Total image KB per view of the type's measured pages (the order of the picks). */
  typeKbPerView: number;
}

/** A route type that was not deep-scanned, and why. */
export interface LeftOutType {
  type: string;
  pages: number;
  typeKbPerView: number;
  /** cap: the --deep count was reached. no-images: none of its pages has an image. */
  reason: "cap" | "no-images";
}

export interface DeepSelection {
  picks: DeepPick[];
  leftOut: LeftOutType[];
}

/** The heaviest page of a route type: image KB per view, then exact KB, then URL. */
function heaviest(members: Candidate[]): Candidate {
  return [...members].sort((a, b) => b.kbPerView - a.kbPerView || b.exactKB - a.exactKB || a.url.localeCompare(b.url))[0];
}

/**
 * The deep pages of a survey: at most `count` route types, each with its heaviest measured page. Route types with no image
 * are left out (reason no-images); the ones after the cap are left out with reason cap, so the output can say what was not
 * scanned. Picks are worst first.
 */
export function selectDeepPages(results: PageResult[], routes: RouteGrouping, count: number): DeepSelection {
  const byType = new Map<string, Candidate[]>();
  for (const candidate of candidatesOf(results, routes.typeOf)) {
    const list = byType.get(candidate.pattern);
    if (list) list.push(candidate);
    else byType.set(candidate.pattern, [candidate]);
  }
  const ranked = [...byType.entries()]
    .map(([type, members]) => ({
      type,
      members,
      typeKbPerView: members.reduce((sum, c) => sum + c.kbPerView, 0),
      worst: heaviest(members),
    }))
    .sort((a, b) => b.typeKbPerView - a.typeKbPerView || a.type.localeCompare(b.type));
  const picks: DeepPick[] = [];
  const leftOut: LeftOutType[] = [];
  for (const entry of ranked) {
    const base = { type: entry.type, pages: entry.members.length, typeKbPerView: entry.typeKbPerView };
    if (entry.worst.kbPerView <= 0) leftOut.push({ ...base, reason: "no-images" });
    else if (picks.length >= count) leftOut.push({ ...base, reason: "cap" });
    else {
      picks.push({
        url: entry.worst.url,
        type: entry.type,
        typePages: entry.members.length,
        kbPerView: entry.worst.kbPerView,
        typeKbPerView: entry.typeKbPerView,
      });
    }
  }
  return { picks, leftOut };
}
