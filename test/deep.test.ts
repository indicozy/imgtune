// Deep-page selection (deep.ts): one page per route type, the heaviest types first, the cap, and what was left out.
import { describe, expect, it } from "vitest";
import { groupRoutes } from "../src/routes.js";
import { selectDeepPages } from "../src/deep.js";
import { okPage, otherPage } from "./page-fixtures.js";

const SHOP = "https://shop.example";

describe("selectDeepPages", () => {
  it("takes the heaviest page of each route type, by image KB per view, with exact KB only as the tie-break", () => {
    const results = [
      okPage(`${SHOP}/ae-en/cart`, 40, 5),
      okPage(`${SHOP}/sa-ar/cart`, 90, 2),
      okPage(`${SHOP}/ae-en/faqs`, 30, 10),
      okPage(`${SHOP}/sa-ar/faqs`, 30, 60),
    ];
    const routes = groupRoutes(results.map((r) => r.url));
    const { picks } = selectDeepPages(results, routes, 10);
    expect(picks.map((p) => [p.type, p.url])).toEqual([
      ["/cart", `${SHOP}/sa-ar/cart`],
      ["/faqs", `${SHOP}/sa-ar/faqs`],
    ]);
    expect(picks[0].typePages).toBe(2);
    expect(picks[0].typeKbPerView).toBeCloseTo(130, 5);
  });

  it("orders the types by their total KB per view (pages times mean), not by the mean", () => {
    const results = [
      okPage(`${SHOP}/a/x-1`, 300, 1),
      okPage(`${SHOP}/b/y-1`, 50, 1),
      okPage(`${SHOP}/b/y-2`, 50, 1),
      okPage(`${SHOP}/b/y-3`, 50, 1),
      okPage(`${SHOP}/b/y-4`, 50, 1),
      okPage(`${SHOP}/b/y-5`, 50, 1),
      okPage(`${SHOP}/b/y-6`, 50, 1),
      okPage(`${SHOP}/b/y-7`, 50, 1),
    ];
    const routes = groupRoutes(results.map((r) => r.url));
    const { picks } = selectDeepPages(results, routes, 10);
    expect(picks.map((p) => p.type)).toEqual(["/b/*", "/a/*"]);
  });

  it("caps the picks and lists every type after the cap as left out", () => {
    const results = [okPage(`${SHOP}/cart`, 90, 1), okPage(`${SHOP}/faqs`, 60, 1), okPage(`${SHOP}/about`, 30, 1)];
    const routes = groupRoutes(results.map((r) => r.url));
    const selection = selectDeepPages(results, routes, 2);
    expect(selection.picks.map((p) => p.type)).toEqual(["/cart", "/faqs"]);
    expect(selection.leftOut).toEqual([{ type: "/about", pages: 1, typeKbPerView: 30, reason: "cap" }]);
  });

  it("leaves a type with no images out as no-images, and never picks a page that was not measured", () => {
    const results = [
      okPage(`${SHOP}/cart`, 0, 0, { counts: { images: 0, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} } }),
      okPage(`${SHOP}/faqs`, 20, 5),
      otherPage(`${SHOP}/about`, "blocked"),
    ];
    const routes = groupRoutes(results.map((r) => r.url));
    const selection = selectDeepPages(results, routes, 5);
    expect(selection.picks.map((p) => p.type)).toEqual(["/faqs"]);
    expect(selection.leftOut).toEqual([{ type: "/cart", pages: 1, typeKbPerView: 0, reason: "no-images" }]);
  });

  it("uses the route map's types when a grouping is given one", () => {
    const results = [okPage(`${SHOP}/cart`, 40, 5), okPage(`${SHOP}/faqs`, 30, 5)];
    const routes = groupRoutes(results.map((r) => r.url), { routeMap: [{ pattern: "/cart", segments: ["cart"], params: [], type: "checkout flow" }] });
    expect(selectDeepPages(results, routes, 5).picks.map((p) => p.type)).toEqual(["checkout flow", "/faqs"]);
  });

  it("returns nothing for a count of zero, and for no measured pages", () => {
    expect(selectDeepPages([okPage(`${SHOP}/cart`, 1, 1)], groupRoutes([`${SHOP}/cart`]), 0).picks).toEqual([]);
    expect(selectDeepPages([], groupRoutes([]), 20)).toEqual({ picks: [], leftOut: [] });
  });
});
