// The checked fetcher's redirects: the URL a body was read from (getPage), and the exact-origin rule (sameOriginAs). A
// sibling subdomain of the same registrable domain is off the exact origin, so a redirect to it is refused; the older
// registrable-domain rule (sameSiteAs) still follows it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { makeFetcher } from "../src/fetch.js";
import type { Resolver } from "../src/address.js";

let port = 0;
let server: Server;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>${body}`);
    };
    if (url === "/start") {
      res.writeHead(302, { location: "/landing" });
      res.end();
    } else if (url === "/landing") {
      html("<p>landing</p>");
    } else if (url === "/sibling") {
      // A sibling subdomain of the site's domain: every name resolves to this server through the injected resolver.
      res.writeHead(302, { location: `http://cdn.shop.example:${port}/sibling-page` });
      res.end();
    } else if (url === "/sibling-page") {
      html("<p>sibling</p>");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Every name resolves to the loopback address of the test server; the site is shop.example on the test port. */
const loopback: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];

describe("getPage and the origin rule", () => {
  it("follows a redirect on the same origin, and reports the URL the body was read from", async () => {
    const fetcher = makeFetcher({ userAgent: "imgtune-test", resolver: loopback });
    const origin = `http://shop.example:${port}`;
    const answer = await fetcher.getPage(`${origin}/start`, { allowPrivate: true, sameOriginAs: origin });
    expect(answer?.finalUrl).toBe(`${origin}/landing`);
    expect(answer?.body.toString("utf8")).toContain("landing");
  });

  it("refuses a redirect to a sibling subdomain under the exact-origin rule", async () => {
    const fetcher = makeFetcher({ userAgent: "imgtune-test", resolver: loopback });
    const origin = `http://shop.example:${port}`;
    expect(await fetcher.getPage(`${origin}/sibling`, { allowPrivate: true, sameOriginAs: origin })).toBeUndefined();
  });

  it("still follows that sibling redirect under the registrable-domain rule (sameSiteAs), which the crawl no longer uses", async () => {
    const fetcher = makeFetcher({ userAgent: "imgtune-test", resolver: loopback });
    const origin = `http://shop.example:${port}`;
    const answer = await fetcher.getPage(`${origin}/sibling`, { allowPrivate: true, sameSiteAs: origin });
    expect(answer?.finalUrl).toBe(`http://cdn.shop.example:${port}/sibling-page`);
  });
});
