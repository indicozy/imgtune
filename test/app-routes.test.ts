// Route patterns of a Next.js app (app-routes.ts), read from the fixture tree under test/fixtures/audit-app (empty page files).
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { sourceFilesOf } from "../src/audit.js";
import { appRouteGrouping, matchRoute, routesFromFiles, staticRouteUrls } from "../src/app-routes.js";
import { groupRoutes } from "../src/routes.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/audit-app", import.meta.url));
const ORIGIN = "https://shop.example";

describe("routesFromFiles on the fixture app", () => {
  it("reads the App Router and Pages Router page files, and nothing else", async () => {
    const files = await sourceFilesOf(FIXTURE);
    expect(files).toContain("app/page.tsx");
    expect(files).toContain("app/api/hello/route.ts");
    const patterns = routesFromFiles(files).map((r) => r.pattern);
    expect([...patterns].sort()).toEqual(["/", "/about", "/blog/*", "/cart", "/docs/**", "/posts/*", "/product/*", "/shop/**"]);
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
  });
});

describe("matchRoute", () => {
  it("matches the most specific route: static beats a parameter, a parameter beats a catch-all", () => {
    const set = routesFromFiles(["app/[...all]/page.tsx", "app/blog/[slug]/page.tsx", "app/blog/featured/page.tsx"]);
    expect(matchRoute(`${ORIGIN}/blog/featured`, set)?.pattern).toBe("/blog/featured");
    expect(matchRoute(`${ORIGIN}/blog/hello`, set)?.pattern).toBe("/blog/*");
    expect(matchRoute(`${ORIGIN}/anything/else`, set)?.pattern).toBe("/**");
  });

  it("matches the optional catch-all with zero segments, and a decoded path", async () => {
    const set = routesFromFiles(await sourceFilesOf(FIXTURE));
    expect(matchRoute(`${ORIGIN}/shop`, set)?.pattern).toBe("/shop/**");
    expect(matchRoute(`${ORIGIN}/docs`, set)?.pattern).toBe("/docs/**");
    expect(matchRoute(`${ORIGIN}/docs/a/b/c`, set)?.pattern).toBe("/docs/**");
    expect(matchRoute(`${ORIGIN}/blog/caf%C3%A9`, set)?.pattern).toBe("/blog/*");
  });

  it("matches the home page only at the root, and returns nothing for a path no route covers", async () => {
    const set = routesFromFiles(await sourceFilesOf(FIXTURE));
    expect(matchRoute(`${ORIGIN}/`, set)?.pattern).toBe("/");
    expect(matchRoute(`${ORIGIN}/nope/x`, set)).toBeUndefined();
    expect(matchRoute("not a url", set)).toBeUndefined();
  });
});

describe("appRouteGrouping and staticRouteUrls", () => {
  it("types each URL by its route file, and a URL no route matches by the fallback grouping", async () => {
    const routes = routesFromFiles(await sourceFilesOf(FIXTURE));
    const urls = [`${ORIGIN}/blog/a`, `${ORIGIN}/blog/b`, `${ORIGIN}/cart`, `${ORIGIN}/unknown/a`, `${ORIGIN}/unknown/b`];
    const fallback = groupRoutes(urls);
    const grouping = appRouteGrouping(urls, routes, fallback);
    expect(grouping.typeOf(`${ORIGIN}/blog/a`)).toBe("app/blog/[slug]/page.tsx");
    expect(grouping.types.find((t) => t.type === "app/blog/[slug]/page.tsx")?.urls).toHaveLength(2);
    expect(grouping.typeOf(`${ORIGIN}/cart`)).toBe("app/(shop)/cart/page.tsx");
    expect(grouping.typeOf(`${ORIGIN}/unknown/a`)).toBe(fallback.typeOf(`${ORIGIN}/unknown/a`));
    expect(grouping.types.reduce((n, t) => n + t.urls.length, 0)).toBe(urls.length);
  });

  it("adds the static routes of the app as URLs of the origin", async () => {
    const urls = staticRouteUrls(ORIGIN, routesFromFiles(await sourceFilesOf(FIXTURE)));
    expect(urls).toEqual(expect.arrayContaining([`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/cart`]));
    expect(urls.some((u) => u.includes("blog") || u.includes("docs"))).toBe(false);
  });
});
