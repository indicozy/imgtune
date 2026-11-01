import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VIEWPORTS } from "../src/config.js";
import { parseLocateArgs } from "../src/locate-only.js";
import { parseRecheckArgs } from "../src/recheck.js";
import { parseScanArgs, recordOptionsOf, runScan, sameRecordOptions } from "../src/remote.js";
import { parseSizesArgs } from "../src/sizes-recheck.js";
import {
  DEFAULT_THIRD_PARTY,
  isFirstParty,
  isThirdPartyBlocked,
  parseAllowHosts,
  siteDomainOf,
  thirdPartyFromFlags,
  type RequestFacts,
  type ThirdPartyPolicy,
} from "../src/third-party.js";

// A 1x1 PNG, enough for the image requests of the test page.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const PAGE = "https://shop.example.co.uk/products";
const BLOCK: ThirdPartyPolicy = { block: true, allowHosts: [] };
const ALLOW: ThirdPartyPolicy = { block: false, allowHosts: [] };

const facts = (requestUrl: string, resourceType: string, subFrame = false, pageUrl = PAGE): RequestFacts => ({
  pageUrl,
  requestUrl,
  resourceType,
  subFrame,
});

describe("siteDomainOf", () => {
  it("keeps the registrable domain, with two-level country suffixes", () => {
    expect(siteDomainOf("cdn.shop.example.co.uk")).toBe("example.co.uk");
    expect(siteDomainOf("www.example.com")).toBe("example.com");
    expect(siteDomainOf("example.com.au")).toBe("example.com.au");
  });

  it("gives each subdomain of a hosting platform its own site", () => {
    expect(siteDomainOf("alice.github.io")).toBe("alice.github.io");
    expect(siteDomainOf("bob.alice.github.io")).toBe("alice.github.io");
    expect(siteDomainOf("app.preview.vercel.app")).toBe("preview.vercel.app");
    expect(siteDomainOf("github.io")).toBe("github.io");
  });

  it("is the host itself for localhost and IP addresses", () => {
    expect(siteDomainOf("localhost")).toBe("localhost");
    expect(siteDomainOf("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("isFirstParty", () => {
  it("is first-party on the same host and on the same registrable domain", () => {
    expect(isFirstParty(PAGE, "https://shop.example.co.uk/app.js")).toBe(true);
    expect(isFirstParty(PAGE, "https://static.example.co.uk/app.js")).toBe(true);
    expect(isFirstParty("https://example.com/", "https://www.example.com/x.js")).toBe(true);
  });

  it("is third-party on another registrable domain, even one that shares a label", () => {
    expect(isFirstParty(PAGE, "https://example.com/app.js")).toBe(false);
    expect(isFirstParty(PAGE, "https://other.co.uk/app.js")).toBe(false);
    expect(isFirstParty("https://example.com/", "https://notexample.com/x.js")).toBe(false);
  });

  it("is third-party for a different tenant of a hosting platform", () => {
    expect(isFirstParty("https://alice.github.io/", "https://alice.github.io/a.js")).toBe(true);
    expect(isFirstParty("https://alice.github.io/", "https://bob.github.io/a.js")).toBe(false);
  });

  it("treats localhost and IP addresses as first-party only for the same host", () => {
    expect(isFirstParty("http://localhost:3000/", "http://localhost:3000/a.js")).toBe(true);
    expect(isFirstParty("http://localhost:3000/", "http://127.0.0.1:3000/a.js")).toBe(false);
    expect(isFirstParty("http://127.0.0.1:3000/", "http://127.0.0.2/a.js")).toBe(false);
    expect(isFirstParty("http://app.localhost/", "http://api.localhost/a.js")).toBe(false);
  });

  it("is never first-party when a URL has no host", () => {
    expect(isFirstParty("not a url", "https://example.com/")).toBe(false);
    expect(isFirstParty(PAGE, "data:text/plain,x")).toBe(false);
  });
});

describe("isThirdPartyBlocked, per resource type", () => {
  const cdn = "https://cdn.tracker.test/x";

  it.each(["script", "fetch", "xhr", "websocket", "eventsource", "media", "beacon", "ping", "manifest", "other", "cspreport", "texttrack"])(
    "aborts a %s request to another site",
    (type) => {
      expect(isThirdPartyBlocked(BLOCK, facts(cdn, type))).toBe(true);
    },
  );

  it.each(["stylesheet", "font", "image"])("never aborts a %s request, from any host", (type) => {
    expect(isThirdPartyBlocked(BLOCK, facts(cdn, type))).toBe(false);
    expect(isThirdPartyBlocked(BLOCK, facts("https://images.cdn-elsewhere.net/p.jpg", type))).toBe(false);
  });

  it("never aborts the page's own navigation to another site", () => {
    expect(isThirdPartyBlocked(BLOCK, facts("https://elsewhere.test/", "document"))).toBe(false);
  });

  it("aborts an iframe document from another site, and keeps one from the same site", () => {
    expect(isThirdPartyBlocked(BLOCK, facts("https://widgets.tracker.test/frame", "document", true))).toBe(true);
    expect(isThirdPartyBlocked(BLOCK, facts("https://shop.example.co.uk/frame", "document", true))).toBe(false);
  });

  it("keeps first-party requests of every type", () => {
    for (const type of ["script", "fetch", "xhr", "websocket", "media", "beacon", "manifest", "other", "document"]) {
      expect(isThirdPartyBlocked(BLOCK, facts("https://static.example.co.uk/a", type, false)), type).toBe(false);
    }
  });

  it("aborts a websocket to another site and keeps one to the same site", () => {
    expect(isThirdPartyBlocked(BLOCK, facts("wss://live.tracker.test/socket", "websocket"))).toBe(true);
    expect(isThirdPartyBlocked(BLOCK, facts("wss://shop.example.co.uk/socket", "websocket"))).toBe(false);
  });

  it("keeps everything when blocking is off", () => {
    for (const type of ["script", "xhr", "websocket", "document"]) {
      expect(isThirdPartyBlocked(ALLOW, facts(cdn, type, true)), type).toBe(false);
    }
  });

  it("keeps a host named in allowHosts, and only that host", () => {
    const policy: ThirdPartyPolicy = { block: true, allowHosts: ["carousel.test"] };
    expect(isThirdPartyBlocked(policy, facts("https://carousel.test/app.js", "script"))).toBe(false);
    expect(isThirdPartyBlocked(policy, facts("https://other.test/app.js", "script"))).toBe(true);
    expect(isThirdPartyBlocked(policy, facts("https://cdn.carousel.test/app.js", "script"))).toBe(true);
  });

  it("never judges a scheme other than http, https, ws or wss", () => {
    expect(isThirdPartyBlocked(BLOCK, facts("data:text/javascript,1", "script"))).toBe(false);
    expect(isThirdPartyBlocked(BLOCK, facts("blob:https://x.test/1", "script"))).toBe(false);
  });
});

describe("parseAllowHosts", () => {
  it("lowercases, trims, drops empty items, de-duplicates and sorts", () => {
    expect(parseAllowHosts(" Carousel.Test, cdn.x.io ,,carousel.test")).toEqual(["carousel.test", "cdn.x.io"]);
    expect(parseAllowHosts("127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  it("refuses an empty list, a URL, a port, a path and an IPv6 literal", () => {
    expect(() => parseAllowHosts(" , ")).toThrow(/at least one host/);
    expect(() => parseAllowHosts("https://cdn.x.io")).toThrow(/host names/);
    expect(() => parseAllowHosts("cdn.x.io:443")).toThrow(/host names/);
    expect(() => parseAllowHosts("cdn.x.io/app.js")).toThrow(/host names/);
    expect(() => parseAllowHosts("::1")).toThrow(/host names/);
    expect(() => parseAllowHosts("-bad.x.io")).toThrow(/host names/);
  });
});

describe("thirdPartyFromFlags", () => {
  it("blocks by default, with no hosts kept", () => {
    expect(thirdPartyFromFlags(false, undefined)).toEqual(DEFAULT_THIRD_PARTY);
  });

  it("turns blocking off with --allow-third-party", () => {
    expect(thirdPartyFromFlags(true, undefined)).toEqual({ block: false, allowHosts: [] });
  });

  it("keeps the named hosts while blocking stays on", () => {
    expect(thirdPartyFromFlags(false, ["a.test"])).toEqual({ block: true, allowHosts: ["a.test"] });
  });

  it("refuses --allow-host together with --allow-third-party, since nothing is blocked", () => {
    expect(() => thirdPartyFromFlags(true, ["a.test"])).toThrow(/has no effect with --allow-third-party/);
  });
});

describe("scan flags", () => {
  const url = "https://shop.example.co.uk/";

  it("blocks third-party requests when no flag is given", () => {
    expect(parseScanArgs([url]).thirdParty).toEqual({ block: true, allowHosts: [] });
  });

  it("reads --allow-third-party", () => {
    expect(parseScanArgs([url, "--allow-third-party"]).thirdParty).toEqual({ block: false, allowHosts: [] });
  });

  it("reads --allow-host as a comma list", () => {
    expect(parseScanArgs([url, "--allow-host", "Carousel.test,cdn.x.io"]).thirdParty).toEqual({
      block: true,
      allowHosts: ["carousel.test", "cdn.x.io"],
    });
  });

  it("refuses --allow-host with --allow-third-party, and a value that is not a host", () => {
    expect(() => parseScanArgs([url, "--allow-third-party", "--allow-host", "a.test"])).toThrow(/has no effect/);
    expect(() => parseScanArgs([url, "--allow-host", "https://a.test"])).toThrow(/host names/);
    expect(() => parseScanArgs([url, "--allow-host"])).toThrow(/needs a value/);
  });

  it("reads the same flags in the recheck, locate-only and sizes-only commands", () => {
    expect(parseRecheckArgs(["--recheck", "a.json"]).thirdParty).toEqual(DEFAULT_THIRD_PARTY);
    expect(parseRecheckArgs(["--recheck", "a.json", "--allow-third-party"]).thirdParty).toEqual({ block: false, allowHosts: [] });
    expect(parseRecheckArgs(["--recheck", "a.json", "--allow-host", "a.test"]).thirdParty).toEqual({ block: true, allowHosts: ["a.test"] });
    expect(parseLocateArgs(["http://localhost:3000/p", "--locate-only", "--from", "a.json", "--allow-host", "a.test"]).thirdParty).toEqual({
      block: true,
      allowHosts: ["a.test"],
    });
    expect(parseSizesArgs(["--recheck", "a.json", "--sizes-only"]).thirdParty).toEqual(DEFAULT_THIRD_PARTY);
    expect(parseSizesArgs(["--recheck", "a.json", "--sizes-only", "--allow-third-party"]).thirdParty).toEqual({ block: false, allowHosts: [] });
  });
});

describe("recorded options", () => {
  const base = { aggressive: false, quality: true, viewports: [...DEFAULT_VIEWPORTS], ignoreRobots: false, storageState: undefined, gpu: undefined };

  it("records blocked by default, and allowed with --allow-third-party", () => {
    expect(recordOptionsOf({ ...base, thirdParty: BLOCK }).thirdParty).toBe("blocked");
    expect(recordOptionsOf({ ...base, thirdParty: ALLOW }).thirdParty).toBe("allowed");
    expect(recordOptionsOf({ ...base }).thirdParty).toBe("blocked");
  });

  it("records the kept hosts, sorted, and only while blocking", () => {
    expect(recordOptionsOf({ ...base, thirdParty: { block: true, allowHosts: ["b.test", "a.test"] } }).allowHosts).toEqual(["a.test", "b.test"]);
    expect(recordOptionsOf({ ...base, thirdParty: BLOCK }).allowHosts).toBeUndefined();
    expect(recordOptionsOf({ ...base, thirdParty: ALLOW }).allowHosts).toBeUndefined();
  });

  it("does not resume a page scanned before third-party blocking existed, nor one with other third-party options", () => {
    const now = recordOptionsOf({ ...base, thirdParty: BLOCK });
    const before: Partial<typeof now> = { ...now };
    delete before.thirdParty;
    expect(sameRecordOptions(before as typeof now, now)).toBe(false);
    expect(sameRecordOptions(recordOptionsOf({ ...base, thirdParty: ALLOW }), now)).toBe(false);
    expect(sameRecordOptions({ ...now, allowHosts: ["a.test"] }, now)).toBe(false);
    expect(sameRecordOptions(now, { ...now })).toBe(true);
  });
});

describe("third-party blocking in a real browser", () => {
  let server: Server;
  let origin: string;
  let dir: string;
  const hits: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-third-party-"));
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      hits.push(url);
      if (url === "/page") {
        // The page is on localhost; 127.0.0.1 is another site for the scan (an IP address is its own site).
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><meta charset="utf-8"><title>t</title>
          <img src="/pic.png" width="320" height="200" alt="">
          <img src="http://127.0.0.1:${(server.address() as AddressInfo).port}/pic-cdn.png" width="320" height="200" alt="">
          <script src="/own.js"></script>
          <script src="http://127.0.0.1:${(server.address() as AddressInfo).port}/tracker.js"></script>`);
      }
      if (url.endsWith(".png")) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("window.__ran = (window.__ran || 0) + 1;");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const scanPage = async (thirdParty?: ThirdPartyPolicy) => {
    hits.length = 0;
    const out = join(dir, `out-${Math.random().toString(36).slice(2)}`);
    const [result] = await runScan([`${origin}/page`], {
      outDir: out,
      cwd: dir,
      aggressive: false,
      quality: false,
      viewports: DEFAULT_VIEWPORTS.slice(0, 1),
      log: () => {},
      thirdParty,
    });
    return { result, requested: [...hits] };
  };

  it("aborts the third-party script, keeps first-party and cross-site images, and counts the abort", async () => {
    const { result, requested } = await scanPage(BLOCK);
    expect(result.status).toBe("ok");
    expect(requested).not.toContain("/tracker.js");
    expect(requested).toContain("/own.js");
    expect(requested).toContain("/pic-cdn.png");
    expect(result.thirdPartyBlocked).toBe(1);
    expect(result.options?.thirdParty).toBe("blocked");
  }, 90_000);

  it("loads the third-party script with blocking off, and records that", async () => {
    const { result, requested } = await scanPage(ALLOW);
    expect(requested).toContain("/tracker.js");
    expect(result.thirdPartyBlocked).toBe(0);
    expect(result.options?.thirdParty).toBe("allowed");
  }, 90_000);

  it("loads a third-party script whose host is named in allowHosts", async () => {
    const { result, requested } = await scanPage({ block: true, allowHosts: ["127.0.0.1"] });
    expect(requested).toContain("/tracker.js");
    expect(result.thirdPartyBlocked).toBe(0);
    expect(result.options?.allowHosts).toEqual(["127.0.0.1"]);
  }, 90_000);
});
