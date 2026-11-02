// The URL discovery of `imgtune audit` (audit.ts auditUrls) on a small local site: a home page that redirects to one locale,
// the locales learned from its links, the app's static and dynamic-first-segment seeds, a redirect to a sibling subdomain
// (refused), a sitemap that lists the production host (rewritten onto the local origin), and --urls-from (no discovery).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditUrls, groupAuditRoutes, parseAuditArgs, routeFilesByType, sourceFilesOf } from "../src/audit.js";
import { routesFromFiles } from "../src/app-routes.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/audit-app", import.meta.url));
const html = (links: string[]) => `<!doctype html><html><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

let base = "";
let server: Server;
let dir = "";
let logged: string[] = [];
const log = (message: string) => logged.push(message);

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    };
    const redirect = (location: string) => {
      res.writeHead(302, { location });
      res.end();
    };
    if (path === "/") redirect("/ae-en?utm_source=test");
    else if (path === "/ae-en")
      send(
        `<link rel="alternate" hrefLang="en-SA" href="https://shop.example/sa-en">` + html(["/ae-en/about-us", "/el-seed", "/about", "https://elsewhere.example/x"]),
      );
    else if (path === "/sa-en") send(html(["/sa-en/about-us"]));
    else if (path === "/sa-en/about-us") send(html([]));
    else if (path === "/ae-en/about-us" || path === "/el-seed/about-us" || path === "/about") send(html([]));
    else if (path === "/el-seed") send(html(["/el-seed/about-us", "/sign-in"]));
    else if (path === "/sign-in") redirect(`http://cdn.shop.example:${(server.address() as AddressInfo).port}/sign-in`);
    else if (path === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0"?><urlset><url><loc>https://shop.example/ae-en/sitemap-only</loc></url><url><loc>https://shop.example/ae-en/about-us?x=1</loc></url></urlset>`,
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "imgtune-discover-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("auditUrls on a local multi-locale site", () => {
  it("discovers the locales from the home page, seeds the app's routes under each, and refuses a sibling-subdomain redirect", async () => {
    logged = [];
    const routes = routesFromFiles(await sourceFilesOf(FIXTURE));
    const urls = await auditUrls(parseAuditArgs(["--app", FIXTURE, "--prod", base]), routes, dir, log);
    // The learned locales: the home page's redirect target (ae-en), then the other segments of its links and alternates.
    expect(logged.some((line) => line.includes("learned from the home page: ae-en, el-seed, sa-en"))).toBe(true);
    // The redirect's final URL keeps its query (the page the browser reads); the seed /ae-en is the same page without it.
    expect(urls).toEqual(
      expect.arrayContaining([`${base}/ae-en?utm_source=test`, `${base}/ae-en`, `${base}/el-seed`, `${base}/sa-en`, `${base}/ae-en/about-us`, `${base}/el-seed/about-us`, `${base}/sa-en/about-us`, `${base}/about`]),
    );
    // A redirect to a sibling subdomain is not followed; an off-origin link is not crawled.
    expect(urls.some((u) => u.includes("sign-in"))).toBe(false);
    expect(urls.some((u) => u.includes("elsewhere.example"))).toBe(false);
  });

  it("reads the sitemap of a local site that lists its production host on the local origin, and says so", async () => {
    logged = [];
    const routes = routesFromFiles(await sourceFilesOf(FIXTURE));
    const urls = await auditUrls(parseAuditArgs(["--app", FIXTURE, "--prod", base]), routes, dir, log);
    expect(logged.some((line) => line.includes("lists 2 URL(s) on another host") && line.includes("the other host is not fetched"))).toBe(true);
    expect(urls).toEqual(expect.arrayContaining([`${base}/ae-en/sitemap-only`, `${base}/ae-en/about-us?x=1`]));
    expect(urls.some((u) => u.includes("shop.example"))).toBe(false);
  });

  it("uses --urls-from as the whole URL list: no crawl, no seeds", async () => {
    logged = [];
    const list = join(dir, "list.txt");
    await writeFile(list, `${base}/about\n`, "utf8");
    const routes = routesFromFiles(await sourceFilesOf(FIXTURE));
    const urls = await auditUrls(parseAuditArgs(["--app", FIXTURE, "--prod", base, "--urls-from", "list.txt"]), routes, dir, log);
    expect(urls).toEqual([`${base}/about`]);
    expect(logged.some((line) => line.startsWith("--urls-from:"))).toBe(true);
  });

  it("strips the device variant after the store segment, so a desktop page and its mobile twin are one type", async () => {
    const routes = routesFromFiles(["app/[store]/desktop/about-us/page.jsx", "app/[store]/(mobile)/(help)/about-us/page.jsx"]);
    const urls = [`${base}/ae-en/desktop/about-us`, `${base}/ae-en/about-us`, `${base}/el-seed/desktop/about-us`];
    const grouping = groupAuditRoutes(urls, routes, []);
    expect(grouping.types).toHaveLength(1);
    expect(grouping.types[0]).toMatchObject({ type: "/about-us", locales: ["ae-en", "el-seed"], variants: ["desktop"] });
  });

  it("groups the URLs by template and names the route files each type renders from", async () => {
    const routes = routesFromFiles(await sourceFilesOf(FIXTURE));
    const urls = [`${base}/ae-en`, `${base}/el-seed`, `${base}/ae-en/about-us`, `${base}/el-seed/about-us`, `${base}/about`];
    const grouping = groupAuditRoutes(urls, routes, []);
    const files = routeFilesByType(grouping, routes);
    expect(files.get("/about")).toEqual(["app/about/page.tsx"]);
    expect(files.get("/about-us")).toEqual(["app/[store]/about-us/page.tsx"]);
    // Both stores' about pages are one type, with both store values as its locales.
    expect(grouping.types.find((t) => t.type === "/about-us")).toMatchObject({ urls: [`${base}/ae-en/about-us`, `${base}/el-seed/about-us`], locales: ["ae-en", "el-seed"] });
  });
});
