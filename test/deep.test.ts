// Deep-page selection (deep.ts): one page per route type, the heaviest types first, the cap, and what was left out.
import { describe, expect, it } from "vitest";
import { groupRoutes } from "../src/routes.js";
import { deepRetries, selectDeepPages } from "../src/deep.js";
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

describe("deepRetries", () => {
  const showcase = ["site-a", "site-b", "site-c", "site-d"].map((name) => `${SHOP}/showcase/${name}`);

  it("retries a failed deep page with the next-heaviest measured page of its route type", () => {
    const survey = [okPage(showcase[0], 300, 1), okPage(showcase[1], 200, 1), okPage(showcase[2], 100, 1), okPage(showcase[3], 50, 1)];
    const routes = groupRoutes(survey.map((r) => r.url));
    const picks = selectDeepPages(survey, routes, 10).picks.map((p) => p.url);
    expect(picks).toEqual([showcase[0]]);
    expect(deepRetries([showcase[0]], survey, routes, picks)).toEqual([{ type: "/showcase/*", failed: showcase[0], replacement: showcase[1] }]);
  });

  it("skips a candidate already picked and one with no images, and takes the next", () => {
    const survey = [okPage(showcase[0], 300, 1), okPage(showcase[1], 200, 1), okPage(showcase[2], 0, 0), okPage(showcase[3], 50, 1)];
    const routes = groupRoutes(survey.map((r) => r.url));
    expect(deepRetries([showcase[0]], survey, routes, [showcase[0], showcase[1]])).toEqual([
      { type: "/showcase/*", failed: showcase[0], replacement: showcase[3] },
    ]);
  });

  it("gives no retry when the route type has no other measured page with images", () => {
    const survey = [okPage(`${SHOP}/team`, 90, 5), okPage(`${SHOP}/faqs`, 60, 5), otherPage(`${SHOP}/faqs-2`, "failed")];
    const routes = groupRoutes(survey.map((r) => r.url));
    expect(deepRetries([`${SHOP}/team`], survey, routes, [`${SHOP}/team`])).toEqual([]);
  });

  it("never retries a page that is not measured in the survey, and retries each failed page once", () => {
    const survey = [okPage(showcase[0], 300, 1), otherPage(showcase[1], "failed"), okPage(showcase[2], 100, 1), okPage(showcase[3], 50, 1)];
    const routes = groupRoutes(survey.map((r) => r.url));
    const retries = deepRetries([showcase[0]], survey, routes, [showcase[0]]);
    expect(retries.map((r) => r.replacement)).toEqual([showcase[2]]);
  });
});
