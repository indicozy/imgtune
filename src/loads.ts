// How a page's viewports are loaded. By default each viewport is its own page load, in its own browser context. With
// --shared-loads each class of viewports (mobile, desktop) is one page load: its first viewport is loaded fresh, and the
// others change the viewport and device pixel ratio of that open page (see observeLoads in remote.ts).
import type { Viewport } from "./types.js";

/** The viewports of one load, in the order they are read: the first is a fresh load, the rest are resizes of it. */
export type LoadGroup = Viewport[];

/** The order a load group's viewports are read in: the effective pixel width (CSS width x DPR), smallest first. */
export function effectivePixelWidth(viewport: Viewport): number {
  return viewport.width * viewport.dpr;
}

/**
 * The load groups of a page. A fresh load (the default) gives each viewport a group of its own. Otherwise (--shared-loads)
 * the viewports are grouped by whether they are mobile and whether they set a user agent (a group keeps one of each, so
 * its page is never loaded with a user agent the viewport would not have), and each group is ordered by effective pixel
 * width, smallest first.
 * The smallest candidate a page's srcset picks is then the one already loaded when a wider viewport asks for more, so
 * the browser never holds a larger candidate than a fresh load at that viewport would choose. Groups keep the order of
 * their first viewport; each viewport appears once.
 */
export function loadGroups(viewports: readonly Viewport[], sharedLoads: boolean): LoadGroup[] {
  if (!sharedLoads) return viewports.map((viewport) => [viewport]);
  const groups = new Map<string, Viewport[]>();
  for (const viewport of viewports) {
    const key = `${viewport.mobile ? "mobile" : "desktop"}|${viewport.userAgent !== undefined ? "ua" : "default-ua"}`;
    const group = groups.get(key);
    if (group) group.push(viewport);
    else groups.set(key, [viewport]);
  }
  return [...groups.values()].map((group) =>
    // Array.prototype.sort is stable: viewports of equal effective width keep their order.
    [...group].sort((a, b) => effectivePixelWidth(a) - effectivePixelWidth(b) || a.width - b.width),
  );
}
