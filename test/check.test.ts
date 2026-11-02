// `imgtune check`: the argument parsing and the URL resolution (origin sitemap, list, page). No browser.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DEEP } from "../src/run.js";
import { parseCheckArgs, resolveCheckUrls } from "../src/check.js";

describe("parseCheckArgs", () => {
  it("takes one site, sitemap or page URL, with the defaults", () => {
    const args = parseCheckArgs(["https://shop.example"]);
    expect(args.target).toBe("https://shop.example/");
    expect(args.deep).toBe(DEFAULT_DEEP);
    expect(args.thirdParty).toEqual({ block: false, allowHosts: [] });
    expect(args.samplePerPattern).toBeUndefined();
  });

  it("takes --urls-from instead of a URL, and refuses both, and two URLs", () => {
    expect(parseCheckArgs(["--urls-from", "urls.txt"]).urlsFrom).toBe("urls.txt");
    expect(() => parseCheckArgs(["https://a.example", "--urls-from", "urls.txt"])).toThrow(/not both/);
    expect(() => parseCheckArgs(["https://a.example", "https://b.example"])).toThrow(/one site, sitemap or page URL/);
    expect(() => parseCheckArgs([])).toThrow(/usage: imgtune check/);
  });

  it("reads the deep, sampling, quality, GPU, concurrency and idle options", () => {
    const args = parseCheckArgs([
      "https://shop.example/sitemap.xml",
      "--sample-per-pattern",
      "2",
      "--deep",
      "7",
      "--qualities",
      "100,75,85",
      "--gpu-device",
      "1",
      "--page-concurrency",
      "3",
      "--idle-timeout",
      "5000",
      "--no-cache",
      "--ignore-robots",
      "--out",
      "/tmp/x",
    ]);
    expect(args).toMatchObject({
      samplePerPattern: 2,
      deep: 7,
      qualities: [75, 85, 100],
      gpu: { device: 1 },
      pageConcurrency: 3,
      idleTimeoutMs: 5000,
      noCache: true,
      ignoreRobots: true,
      out: "/tmp/x",
    });
  });

  it("refuses --sample-per-pattern without a list or sitemap, when the target is one page", () => {
    expect(parseCheckArgs(["https://shop.example/sitemap.xml", "--sample-per-pattern", "3"]).samplePerPattern).toBe(3);
    expect(parseCheckArgs(["--urls-from", "u.txt", "--sample-per-pattern", "3"]).samplePerPattern).toBe(3);
  });

  it("allows third-party requests by default, blocks them with --block-third-party, and keeps --allow-host with blocking", () => {
    expect(parseCheckArgs(["https://a.example", "--block-third-party", "--allow-host", "Cdn.x.io"]).thirdParty).toEqual({
      block: true,
      allowHosts: ["cdn.x.io"],
    });
    expect(() => parseCheckArgs(["https://a.example", "--allow-host", "cdn.x.io"])).toThrow(/has no effect without --block-third-party/);
  });

  it("accepts the deprecated --allow-third-party as a no-op", () => {
    expect(parseCheckArgs(["https://a.example", "--allow-third-party"]).thirdParty).toEqual({ block: false, allowHosts: [] });
  });

  it("refuses an unknown option and a value that is not a URL", () => {
    expect(() => parseCheckArgs(["https://a.example", "--frobnicate"])).toThrow(/Unknown option/);
    expect(() => parseCheckArgs(["ftp://a.example"])).toThrow(/http or https/);
  });
});

describe("resolveCheckUrls", () => {
  let dir: string;
  let server: Server;
  let origin: string;
  let sitemapOrigin: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-check-"));
    await writeFile(join(dir, "urls.txt"), "https://shop.example/a\n# comment\nhttps://shop.example/b\n");
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (url === "/sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(`<?xml version="1.0"?><urlset><url><loc>${origin}/p/one</loc></url><url><loc>${origin}/p/two</loc></url></urlset>`);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sitemapOrigin = origin;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads a URL list given with --urls-from", async () => {
    const logs: string[] = [];
    const resolved = await resolveCheckUrls(parseCheckArgs(["--urls-from", join(dir, "urls.txt")]), dir, (m) => logs.push(m));
    expect(resolved.urls).toEqual(["https://shop.example/a", "https://shop.example/b"]);
    expect(logs[0]).toMatch(/2 URL\(s\)/);
  });

  it("reads the sitemap of an origin", async () => {
    const resolved = await resolveCheckUrls(parseCheckArgs([sitemapOrigin]), dir, () => {});
    expect(resolved.urls).toEqual([`${sitemapOrigin}/p/one`, `${sitemapOrigin}/p/two`]);
    expect(resolved.site).toBe(sitemapOrigin);
  });

  it("falls back to the home page alone when the origin has no sitemap, and says so", async () => {
    const logs: string[] = [];
    const resolved = await resolveCheckUrls(parseCheckArgs([`${sitemapOrigin}/no-such-path/`]), dir, (m) => logs.push(m));
    expect(resolved.urls).toEqual([`${sitemapOrigin}/no-such-path/`]);
    const alone = await resolveCheckUrls(parseCheckArgs([`http://127.0.0.1:1/`]), dir, (m) => logs.push(m));
    expect(alone.urls).toEqual(["http://127.0.0.1:1/"]);
    expect(logs.some((m) => m.includes("checking the home page alone"))).toBe(true);
  });

  it("takes one page URL as the only URL", async () => {
    const resolved = await resolveCheckUrls(parseCheckArgs([`${sitemapOrigin}/p/one`]), dir, () => {});
    expect(resolved.urls).toEqual([`${sitemapOrigin}/p/one`]);
  });
});
