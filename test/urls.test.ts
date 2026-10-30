import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchSitemapUrls,
  MAX_SITEMAP_BYTES,
  sitemapMayBeFetched,
  patternToRegExp,
  resolveUrls,
  sitemapCandidates,
  specificity,
} from "../src/urls.js";

const CONFIG = { urls: {}, market: "ae-en", maxPagesPerPattern: 2 };

const urlset = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join("")}</urlset>`;

const sitemapIndex = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
    .join("")}</sitemapindex>`;

/** fetch stub: `pages` maps a URL to its body; anything else answers 404. */
function stubFetch(pages: Record<string, string>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = pages[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("patternToRegExp", () => {
  it("matches a dynamic catch-all only with at least one segment", () => {
    const re = patternToRegExp("/[store]/[...plpPath]");
    expect(re.test("/ae-en/eyeglasses")).toBe(true);
    expect(re.test("/ae-en/eyeglasses/ray-ban/aviator")).toBe(true);
    expect(re.test("/ae-en")).toBe(false);
  });

  it("matches a single dynamic segment only", () => {
    const re = patternToRegExp("/[store]/about/[id]");
    expect(re.test("/ae-en/about/42")).toBe(true);
    expect(re.test("/ae-en/about/42/extra")).toBe(false);
    expect(re.test("/ae-en/about")).toBe(false);
  });

  it("lets an optional catch-all match the parent path too", () => {
    const re = patternToRegExp("/docs/[[...slug]]");
    expect(re.test("/docs")).toBe(true);
    expect(re.test("/docs/a")).toBe(true);
    expect(re.test("/docs/a/b")).toBe(true);
    expect(re.test("/guide")).toBe(false);
  });

  it("ignores a trailing slash and a query string", () => {
    const re = patternToRegExp("/[store]/about");
    expect(re.test("/ae-en/about/")).toBe(true);
    expect(re.test("/ae-en/about?utm=1")).toBe(true);
  });

  it("matches the root pattern only at the root", () => {
    const re = patternToRegExp("/");
    expect(re.test("/")).toBe(true);
    expect(re.test("/ae-en")).toBe(false);
  });

  it("matches intercepting and static segments literally", () => {
    const re = patternToRegExp("/[store]/(.)photo/[id]");
    expect(re.test("/ae-en/(.)photo/7")).toBe(true);
    expect(re.test("/ae-en/xphoto/7")).toBe(false);
  });
});

describe("specificity", () => {
  it("counts static segments", () => {
    expect(specificity("/[store]/stores/[city]")).toBe(1);
    expect(specificity("/[store]/[...plpPath]")).toBe(0);
    expect(specificity("/about/team")).toBe(2);
    expect(specificity("/")).toBe(0);
  });
});

describe("resolveUrls", () => {
  it("gives a static pattern its own path", () => {
    const result = resolveUrls(["/", "/build"], [], CONFIG);
    expect(result.get("/")).toEqual({ paths: ["/"], source: "static" });
    expect(result.get("/build")).toEqual({ paths: ["/build"], source: "static" });
  });

  it("assigns a sitemap path only to the most specific matching pattern", () => {
    const result = resolveUrls(
      ["/[store]/[...plpPath]", "/[store]/stores/[city]"],
      ["/ae-en/stores/dubai", "/ae-en/eyeglasses"],
      CONFIG,
    );
    expect(result.get("/[store]/stores/[city]")).toEqual({
      paths: ["/ae-en/stores/dubai"],
      source: "sitemap",
    });
    expect(result.get("/[store]/[...plpPath]")).toEqual({
      paths: ["/ae-en/eyeglasses"],
      source: "sitemap",
    });
  });

  it("prefers the configured market and keeps sitemap order otherwise", () => {
    const result = resolveUrls(
      ["/[store]/[...plpPath]"],
      ["/sa-ar/eyeglasses", "/ae-en/sunglasses", "/sa-ar/watches", "/ae-en/eyeglasses"],
      { ...CONFIG, maxPagesPerPattern: 3 },
    );
    expect(result.get("/[store]/[...plpPath]")?.paths).toEqual([
      "/ae-en/sunglasses",
      "/ae-en/eyeglasses",
      "/sa-ar/eyeglasses",
    ]);
  });

  it("takes at most maxPagesPerPattern paths", () => {
    const result = resolveUrls(
      ["/[store]/[...plpPath]"],
      ["/ae-en/a", "/ae-en/b", "/ae-en/c"],
      CONFIG,
    );
    expect(result.get("/[store]/[...plpPath]")?.paths).toEqual(["/ae-en/a", "/ae-en/b"]);
  });

  it("gives a sitemap path to a static pattern over a catch-all that also matches it", () => {
    const result = resolveUrls(
      ["/[...slug]", "/cart"],
      ["/cart", "/ae-en/eyeglasses"],
      CONFIG,
    );
    expect(result.get("/cart")).toEqual({ paths: ["/cart"], source: "static" });
    expect(result.get("/[...slug]")).toEqual({ paths: ["/ae-en/eyeglasses"], source: "sitemap" });
  });

  it("lets config entries win over the sitemap", () => {
    const result = resolveUrls(["/[store]/[...plpPath]"], ["/ae-en/eyeglasses"], {
      ...CONFIG,
      urls: { "/[store]/[...plpPath]": ["/ae-en/watches/rolex"] },
    });
    expect(result.get("/[store]/[...plpPath]")).toEqual({
      paths: ["/ae-en/watches/rolex"],
      source: "config",
    });
  });

  it("reports source none when nothing matches", () => {
    const result = resolveUrls(["/[store]/faq"], ["/ae-en/eyeglasses"], CONFIG);
    expect(result.get("/[store]/faq")).toEqual({ paths: [], source: "none" });
  });
});

describe("fetchSitemapUrls", () => {
  it("returns the pathnames of a plain urlset, dropping origin, query, hash and trailing slash", async () => {
    const { fetchImpl } = stubFetch({
      "https://shop.test/sitemap.xml": urlset(
        "https://shop.test/ae-en/eyeglasses/",
        "https://shop.test/ae-en/sunglasses?page=2",
        "https://shop.test/ae-en/watches#top",
      ),
    });
    await expect(fetchSitemapUrls("https://shop.test/sitemap.xml", fetchImpl)).resolves.toEqual([
      "/ae-en/eyeglasses",
      "/ae-en/sunglasses",
      "/ae-en/watches",
    ]);
  });

  it("follows a sitemap index into its child sitemaps", async () => {
    const { fetchImpl, calls } = stubFetch({
      "https://shop.test/sitemap.xml": sitemapIndex(
        "https://shop.test/sitemap-products.xml",
        "https://shop.test/sitemap-stores.xml",
      ),
      "https://shop.test/sitemap-products.xml": urlset("https://shop.test/ae-en/eyeglasses"),
      "https://shop.test/sitemap-stores.xml": urlset("https://shop.test/ae-en/stores/dubai"),
    });
    await expect(fetchSitemapUrls("https://shop.test/sitemap.xml", fetchImpl)).resolves.toEqual([
      "/ae-en/eyeglasses",
      "/ae-en/stores/dubai",
    ]);
    expect(calls).toContain("https://shop.test/sitemap-stores.xml");
  });

  it("skips child sitemaps that fail to fetch or parse", async () => {
    const { fetchImpl } = stubFetch({
      "https://shop.test/sitemap.xml": sitemapIndex(
        "https://shop.test/missing.xml",
        "https://shop.test/garbage.xml",
        "https://shop.test/sitemap-products.xml",
      ),
      "https://shop.test/garbage.xml": "<html><body>not a sitemap</body></html>",
      "https://shop.test/sitemap-products.xml": urlset("https://shop.test/ae-en/eyeglasses"),
    });
    await expect(fetchSitemapUrls("https://shop.test/sitemap.xml", fetchImpl)).resolves.toEqual([
      "/ae-en/eyeglasses",
    ]);
  });

  it("does not follow sitemap indexes deeper than depth 2", async () => {
    const { fetchImpl } = stubFetch({
      "https://shop.test/sitemap.xml": sitemapIndex("https://shop.test/level1.xml"),
      "https://shop.test/level1.xml": sitemapIndex("https://shop.test/level2.xml"),
      "https://shop.test/level2.xml": sitemapIndex("https://shop.test/level3.xml"),
      "https://shop.test/level3.xml": urlset("https://shop.test/ae-en/too-deep"),
    });
    await expect(fetchSitemapUrls("https://shop.test/sitemap.xml", fetchImpl)).resolves.toEqual([]);
  });

  it("fetches at most 50 child sitemaps", async () => {
    const children = Array.from({ length: 60 }, (_, i) => `https://shop.test/s${i}.xml`);
    const pages: Record<string, string> = {
      "https://shop.test/sitemap.xml": sitemapIndex(...children),
    };
    for (const child of children) pages[child] = urlset(`${child}`.replace(/\.xml$/, ""));
    const { fetchImpl, calls } = stubFetch(pages);
    const paths = await fetchSitemapUrls("https://shop.test/sitemap.xml", fetchImpl);
    expect(calls.length).toBe(1 + 50);
    expect(paths).toHaveLength(50);
  });

  it("keeps at most 4 child sitemap fetches in flight", async () => {
    const children = Array.from({ length: 12 }, (_, i) => `https://shop.test/c${i}.xml`);
    const pages: Record<string, string> = {
      "https://shop.test/sitemap.xml": sitemapIndex(...children),
    };
    for (const child of children) pages[child] = urlset(child.replace(/\.xml$/, ""));
    const { fetchImpl: inner } = stubFetch(pages);
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return inner(input, init);
    }) as unknown as typeof fetch;
    const paths = await fetchSitemapUrls("https://shop.test/sitemap.xml", fetchImpl);
    expect(maxInFlight).toBe(4);
    expect(paths).toEqual(children.map((c) => c.replace(/\.xml$/, "").replace("https://shop.test", "")));
  });

  it("throws when the top-level sitemap is missing", async () => {
    const { fetchImpl } = stubFetch({});
    await expect(fetchSitemapUrls("https://shop.test/sitemap.xml", fetchImpl)).rejects.toThrow();
  });

  it("throws when the top-level sitemap is not an XML sitemap", async () => {
    const { fetchImpl } = stubFetch({
      "https://shop.test/sitemap.xml": "<html><body>Welcome</body></html>",
    });
    await expect(fetchSitemapUrls("https://shop.test/sitemap.xml", fetchImpl)).rejects.toThrow();
  });
});

describe("sitemapCandidates", () => {
  let dir: string;
  let emptyDir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "imgtune-urls-"));
    emptyDir = mkdtempSync(join(tmpdir(), "imgtune-urls-empty-"));
    writeFileSync(
      join(dir, ".env.local"),
      "# local overrides\nexport NEXT_PUBLIC_DOMAIN_BASE_URL=\"https://staging.example.com/\"\n",
    );
    writeFileSync(join(dir, ".env"), "NEXT_PUBLIC_DOMAIN_BASE_URL=https://prod.example.com\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(emptyDir, { recursive: true, force: true });
  });

  it("lists the domain sitemap from .env.local, then the local server", () => {
    expect(sitemapCandidates(dir, {}, "http://localhost:3999")).toEqual([
      "https://staging.example.com/sitemap.xml",
      "http://localhost:3999/sitemap.xml",
    ]);
  });

  it("puts config.sitemapUrl first", () => {
    expect(
      sitemapCandidates(dir, { sitemapUrl: "https://cfg.example.com/custom.xml" }, "http://localhost:3999"),
    ).toEqual([
      "https://cfg.example.com/custom.xml",
      "https://staging.example.com/sitemap.xml",
      "http://localhost:3999/sitemap.xml",
    ]);
  });

  it("ends a quoted env value at its closing quote, ignoring a trailing comment", async () => {
    const quoted = mkdtempSync(join(tmpdir(), "imgtune-urls-quoted-"));
    try {
      writeFileSync(join(quoted, ".env.local"), 'NEXT_PUBLIC_DOMAIN_BASE_URL="https://x.com" # prod\n');
      expect(sitemapCandidates(quoted, {}, "http://localhost:3999")).toEqual([
        "https://x.com/sitemap.xml",
        "http://localhost:3999/sitemap.xml",
      ]);
    } finally {
      await rm(quoted, { recursive: true, force: true });
    }
  });

  it("skips the domain entry when no env file defines it", () => {
    expect(sitemapCandidates(emptyDir, {}, "http://localhost:3999")).toEqual([
      "http://localhost:3999/sitemap.xml",
    ]);
  });
});

describe("sitemap fetches are guarded (sameSite, connect-time check, size cap)", () => {
  let base = "";
  let server: import("node:http").Server | undefined;
  const gzipBody = Buffer.from("H4sIAAAAAAAAA0tMzEsBAOJ6n2cIAAAA", "base64"); // gzip of a short string, not a sitemap

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    const started = await new Promise<{ server: import("node:http").Server; port: number }>((resolve) => {
      const s = createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/sitemap.xml") {
          res.writeHead(200, { "content-type": "application/xml" });
          return res.end(sitemapIndex(`${base}/child.xml`, `${base}/big.xml`, `${base}/gz.xml.gz`, `${base}/redirect.xml`, "http://169.254.169.254/latest.xml"));
        }
        if (url === "/child.xml") {
          res.writeHead(200, { "content-type": "application/xml" });
          return res.end(urlset("https://shop.test/ae-en/from-child"));
        }
        if (url === "/big.xml") {
          res.writeHead(200, { "content-type": "application/xml" });
          return res.end(Buffer.alloc(MAX_SITEMAP_BYTES + 1024, 0x20));
        }
        if (url === "/gz.xml.gz") {
          res.writeHead(200, { "content-type": "application/gzip" });
          return res.end(gzipBody);
        }
        if (url === "/redirect.xml") {
          res.writeHead(302, { location: "http://other.test/elsewhere.xml" });
          return res.end();
        }
        res.writeHead(404);
        res.end();
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: s, port: (s.address() as import("node:net").AddressInfo).port }));
    });
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("reads a local sitemap index: follows its same-site child, and skips the over-cap body, the gzip file, the redirect off-site and the metadata address", async () => {
    const paths = await fetchSitemapUrls(`${base}/sitemap.xml`);
    expect(paths).toEqual(["/ae-en/from-child"]);
  });

  it("refuses a top sitemap on a metadata address, with no request", async () => {
    await expect(fetchSitemapUrls("http://169.254.169.254/latest/sitemap.xml")).rejects.toThrow();
  });

  it("does not fetch a child sitemap on another site, whatever the top sitemap is", () => {
    expect(sitemapMayBeFetched("https://shop.test/a.xml", "https://shop.test/sitemap.xml")).toBe(true);
    expect(sitemapMayBeFetched("https://www.shop.test/a.xml", "https://shop.test/sitemap.xml")).toBe(true);
    expect(sitemapMayBeFetched("https://evil.test/a.xml", "https://shop.test/sitemap.xml")).toBe(false);
    expect(sitemapMayBeFetched("http://169.254.169.254/a.xml", "https://shop.test/sitemap.xml")).toBe(false);
    expect(sitemapMayBeFetched("file:///etc/passwd", "https://shop.test/sitemap.xml")).toBe(false);
    expect(sitemapMayBeFetched("not a url", "https://shop.test/sitemap.xml")).toBe(false);
  });

  it("does not fetch a child on another site through the injected fetch either", async () => {
    const { fetchImpl, calls } = stubFetch({
      "https://shop.test/sitemap.xml": sitemapIndex("https://evil.test/a.xml", "https://shop.test/ok.xml"),
      "https://shop.test/ok.xml": urlset("https://shop.test/ae-en/ok"),
    });
    await expect(fetchSitemapUrls("https://shop.test/sitemap.xml", fetchImpl)).resolves.toEqual(["/ae-en/ok"]);
    expect(calls).not.toContain("https://evil.test/a.xml");
  });

  it("does not read a gzip sitemap as XML: compressed .xml.gz is not supported, so the top one throws", async () => {
    await expect(fetchSitemapUrls(`${base}/gz.xml.gz`)).rejects.toThrow();
  });
});
