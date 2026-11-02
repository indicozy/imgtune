// Route patterns of a Next.js app (app-routes.ts), read from the fixture tree under test/fixtures/audit-app (empty page files).
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { sourceFilesOf } from "../src/audit.js";
import { learnedValues, matchRoute, routeFileOf, routesFromFiles, seedUrlsOf, staticRouteUrls } from "../src/app-routes.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/audit-app", import.meta.url));
const ORIGIN = "https://shop.example";

describe("routesFromFiles on the fixture app", () => {
  it("reads the App Router and Pages Router page files, and nothing else", async () => {
    const files = await sourceFilesOf(FIXTURE);
    expect(files).toContain("app/page.tsx");
    expect(files).toContain("app/api/hello/route.ts");
    const patterns = routesFromFiles(files).map((r) => r.pattern);
    expect([...patterns].sort()).toEqual([
      "/",
      "/*",
      "/*/**",
      "/*/about-us",
      "/about",
      "/blog/*",
      "/cart",
      "/docs/**",
      "/posts/*",
      "/product/*",
      "/sentry-example-page",
      "/shop/**?",
    ]);
  });

  it("names each route by its file, with groups dropped and the file path kept as written", async () => {
    const byPattern = new Map(routesFromFiles(await sourceFilesOf(FIXTURE)).map((r) => [r.pattern, r.file]));
    expect(byPattern.get("/blog/*")).toBe("app/blog/[slug]/page.tsx");
    expect(byPattern.get("/cart")).toBe("app/(shop)/cart/page.tsx");
    expect(byPattern.get("/posts/*")).toBe("pages/posts/[id].tsx");
    expect(byPattern.get("/")).toBe("app/page.tsx");
  });

  it("skips parallel slots, intercepting routes, private folders, route handlers and special pages", async () => {
    const patterns = routesFromFiles(await sourceFilesOf(FIXTURE)).map((r) => r.pattern);
    for (const skipped of ["/feed", "/photo/*", "/_private", "/hello", "/api/x", "/_app", "/404"]) {
      expect(patterns).not.toContain(skipped);
    }
  });

  it("keeps the first file of a pattern that two files give", () => {
    const routes = routesFromFiles(["app/(a)/x/page.tsx", "app/(b)/x/page.tsx"]);
    expect(routes).toHaveLength(1);
    expect(routes[0].file).toBe("app/(a)/x/page.tsx");
  });

  it("gives a folder without a page nothing, and a root catch-all the pattern /**", () => {
    expect(routesFromFiles(["app/feed/page.tsx", "app/feed/layout.tsx"]).map((r) => r.pattern)).toEqual(["/feed"]);
    expect(routesFromFiles(["app/[...all]/page.tsx"]).map((r) => r.pattern)).toEqual(["/**"]);
    expect(routesFromFiles(["app/[[...all]]/page.tsx"]).map((r) => r.pattern)).toEqual(["/**?"]);
  });
});

describe("matchRoute", () => {
  it("matches the most specific route: static beats a parameter, a parameter beats a catch-all", () => {
    const set = routesFromFiles(["app/[...all]/page.tsx", "app/blog/[slug]/page.tsx", "app/blog/featured/page.tsx"]);
    expect(matchRoute(`${ORIGIN}/blog/featured`, set)?.pattern).toBe("/blog/featured");
    expect(matchRoute(`${ORIGIN}/blog/hello`, set)?.pattern).toBe("/blog/*");
    expect(matchRoute(`${ORIGIN}/anything/else`, set)?.pattern).toBe("/**");
  });

  it("matches an optional catch-all with zero segments, a required one only with one or more, and a decoded path", async () => {
    const set = routesFromFiles(await sourceFilesOf(FIXTURE));
    expect(matchRoute(`${ORIGIN}/shop`, set)?.pattern).toBe("/shop/**?");
    expect(matchRoute(`${ORIGIN}/docs`, set)?.pattern).toBe("/*");
    expect(matchRoute(`${ORIGIN}/docs/a/b/c`, set)?.pattern).toBe("/docs/**");
    expect(matchRoute(`${ORIGIN}/ae-en/a/b`, set)?.pattern).toBe("/*/**");
    expect(matchRoute(`${ORIGIN}/ae-en`, set)?.pattern).toBe("/*");
    expect(matchRoute(`${ORIGIN}/blog/caf%C3%A9`, set)?.pattern).toBe("/blog/*");
  });

  it("matches the home page only at the root, and returns nothing for a path no route covers", async () => {
    const set = routesFromFiles(await sourceFilesOf(FIXTURE));
    expect(matchRoute(`${ORIGIN}/`, set)?.pattern).toBe("/");
    expect(matchRoute(`${ORIGIN}/nope/x`, routesFromFiles(["app/page.tsx", "app/blog/[slug]/page.tsx"]))).toBeUndefined();
    expect(matchRoute("not a url", set)).toBeUndefined();
  });
});

describe("routeFileOf, the seeds and the learned values", () => {
  it("names the route file of a URL, and none for a URL no route covers", async () => {
    const routes = routesFromFiles(await sourceFilesOf(FIXTURE));
    expect(routeFileOf(`${ORIGIN}/blog/a`, routes)).toBe("app/blog/[slug]/page.tsx");
    expect(routeFileOf(`${ORIGIN}/cart`, routes)).toBe("app/(shop)/cart/page.tsx");
    expect(routeFileOf(`${ORIGIN}/ae-en/about-us`, routes)).toBe("app/[store]/about-us/page.tsx");
    expect(routeFileOf(`${ORIGIN}/unknown/a/b/c`, routes)).toBe("app/[store]/[...plpPath]/page.tsx");
    expect(routeFileOf(`${ORIGIN}/nope`, routes)).toBe("app/[store]/page.tsx");
  });

  it("seeds the static routes of the app as URLs of the origin, and not the catch-alls", async () => {
    const urls = staticRouteUrls(ORIGIN, routesFromFiles(await sourceFilesOf(FIXTURE)));
    expect(urls).toEqual(expect.arrayContaining([`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/cart`, `${ORIGIN}/sentry-example-page`]));
    expect(urls.some((u) => u.includes("blog") || u.includes("docs") || u.includes("*"))).toBe(false);
  });

  it("expands a static route under a dynamic first segment once for each learned value, and not a route with a later dynamic segment", async () => {
    const routes = routesFromFiles(await sourceFilesOf(FIXTURE));
    const seeds = seedUrlsOf(ORIGIN, routes, ["ae-en", "el-seed"]);
    expect(seeds).toEqual(expect.arrayContaining([`${ORIGIN}/ae-en/about-us`, `${ORIGIN}/el-seed/about-us`, `${ORIGIN}/ae-en`, `${ORIGIN}/el-seed`]));
    expect(seeds.some((u) => u.includes("**") || u.includes("*"))).toBe(false);
    expect(seeds.filter((u) => u.includes("/ae-en/"))).toEqual([`${ORIGIN}/ae-en/about-us`]);
  });

  it("learns the first value from where the home page redirects, then the other segments by frequency", () => {
    const routes = routesFromFiles(["app/[store]/page.tsx", "app/[store]/about-us/page.tsx", "app/about/page.tsx"]);
    const seen = [
      `${ORIGIN}/ae-en?utm_source=x`,
      `${ORIGIN}/el-seed`,
      `${ORIGIN}/el-seed/a`,
      `${ORIGIN}/about`,
      `${ORIGIN}/sa-ar/a`,
      `${ORIGIN}/robots.txt`,
      `${ORIGIN}/api/x`,
    ];
    expect(learnedValues(seen, routes, 3)).toEqual(["ae-en", "el-seed", "sa-ar"]);
    expect(learnedValues(seen, routes, 1)).toEqual(["ae-en"]);
  });

  it("learns no first value when the home page does not redirect (its own final URL is the origin)", () => {
    const routes = routesFromFiles(["app/[store]/page.tsx"]);
    expect(learnedValues([`${ORIGIN}/`, `${ORIGIN}/sa-ar/x`], routes, 3)).toEqual(["sa-ar"]);
    expect(learnedValues([], routes, 3)).toEqual([]);
  });
});
