import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchSitemapUrls,
  isSitemapText,
  MAX_SITEMAP_BYTES,
  MAX_SITEMAP_URLS,
  MAX_CHILD_SITEMAPS,
  parseSitemapText,
  parseUrlList,
  patternOf,
  sampleByPattern,
  sitemapMayBeFetched,
  urlsFromSource,
} from "../src/urls.js";

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

describe("parseUrlList", () => {
  it("reads one URL per line, skipping blank lines and # comments, keeping the first of duplicates", () => {
    const text = "# the launch pages\n\nhttps://shop.example/a\nhttps://shop.example/b  # the second\nhttps://shop.example/a\n";
    expect(parseUrlList(text)).toEqual(["https://shop.example/a", "https://shop.example/b"]);
  });

  it("names the line of a line that is not a URL", () => {
    expect(() => parseUrlList("https://shop.example/a\nnot a url\n")).toThrow("line 2 of the URL list is not a URL");
  });

  it("refuses a non-http URL", () => {
    expect(() => parseUrlList("file:///etc/passwd")).toThrow("line 1 of the URL list is not http or https");
  });
});

describe("parseSitemapText", () => {
  it("reads the locs of a urlset, decoding entities and CDATA, and skips image locs and comments", () => {
    const xml = `<?xml version="1.0"?><!-- generated --><urlset><url><loc>https://shop.example/a?x=1&amp;y=2</loc>
      <image:image><image:loc>https://cdn.example/a.jpg</image:loc></image:image></url>
      <url><loc><![CDATA[https://shop.example/b]]></loc></url></urlset>`;
    expect(parseSitemapText(xml)).toEqual({
      kind: "urlset",
      locs: ["https://shop.example/a?x=1&y=2", "https://shop.example/b"],
    });
  });

  it("reads a sitemap index as kind index", () => {
    expect(parseSitemapText(sitemapIndex("https://shop.example/s1.xml"))).toEqual({
      kind: "index",
      locs: ["https://shop.example/s1.xml"],
    });
  });

  it("returns undefined for text that is not a sitemap", () => {
    expect(parseSitemapText("<html><body>hello</body></html>")).toBeUndefined();
    expect(isSitemapText("https://shop.example/a\n")).toBe(false);
    expect(isSitemapText(urlset("https://shop.example/a"))).toBe(true);
  });
});

describe("parseSitemapText on hostile input", () => {
  it("finishes well under a second on 100k comment openers with no closer", () => {
    const hostile = `<urlset>${"<!--".repeat(100_000)}<url><loc>https://shop.example/x</loc></url></urlset>`;
    const started = performance.now();
    const parsed = parseSitemapText(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
    // An opener with no closer drops the rest of the text: the locs after it are not read.
    expect(parsed?.locs).toEqual([]);
  });

  it("finishes well under a second on 100k CDATA openers and a comment that never closes", () => {
    const hostile = `<urlset>${"<![CDATA[x".repeat(100_000)}${"<!--".repeat(50_000)}</urlset>`;
    const started = performance.now();
    parseSitemapText(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads the locs around closed comments, and keeps the text inside CDATA", () => {
    const xml = `<urlset><!-- one --><url><loc><![CDATA[https://shop.example/a]]></loc></url><!-- two --></urlset>`;
    expect(parseSitemapText(xml)?.locs).toEqual(["https://shop.example/a"]);
  });

  it("refuses a parse that runs past its time budget", () => {
    const many = `<urlset>${"<url><loc>https://shop.example/p</loc></url>".repeat(20_000)}</urlset>`;
    expect(parseSitemapText(many, -1)).toBeUndefined();
  });

  it("caps the locs read from one sitemap", () => {
    const many = `<urlset>${"<url><loc>https://shop.example/p</loc></url>".repeat(MAX_SITEMAP_URLS + 5)}</urlset>`;
    expect(parseSitemapText(many)?.locs).toHaveLength(MAX_SITEMAP_URLS);
  });
});

describe("fetchSitemapUrls", () => {
  it("returns the page URLs of a plain urlset", async () => {
    const { fetchImpl } = stubFetch({
      "https://shop.example/sitemap.xml": urlset("https://shop.example/ae-en/a", "https://shop.example/ae-en/b"),
    });
    await expect(fetchSitemapUrls("https://shop.example/sitemap.xml", fetchImpl)).resolves.toEqual([
      "https://shop.example/ae-en/a",
      "https://shop.example/ae-en/b",
    ]);
  });

  it("follows a sitemap index into its child sitemaps", async () => {
    const { fetchImpl } = stubFetch({
      "https://shop.example/sitemap.xml": sitemapIndex("https://shop.example/s1.xml"),
      "https://shop.example/s1.xml": urlset("https://shop.example/from-child"),
    });
    await expect(fetchSitemapUrls("https://shop.example/sitemap.xml", fetchImpl)).resolves.toEqual(["https://shop.example/from-child"]);
  });

  it("does not fetch a child sitemap on another registrable domain", async () => {
    const { fetchImpl, calls } = stubFetch({
      "https://shop.example/sitemap.xml": sitemapIndex("https://evil.test/a.xml", "https://shop.example/ok.xml"),
      "https://shop.example/ok.xml": urlset("https://shop.example/ok"),
    });
    await expect(fetchSitemapUrls("https://shop.example/sitemap.xml", fetchImpl)).resolves.toEqual(["https://shop.example/ok"]);
    expect(calls).not.toContain("https://evil.test/a.xml");
  });

  it("drops page URLs on another registrable domain", async () => {
    const { fetchImpl } = stubFetch({
      "https://shop.example/sitemap.xml": urlset("https://evil.test/x", "https://shop.example/y"),
    });
    await expect(fetchSitemapUrls("https://shop.example/sitemap.xml", fetchImpl)).resolves.toEqual(["https://shop.example/y"]);
  });

  it("does not follow a sitemap index deeper than depth 2", async () => {
    const { fetchImpl, calls } = stubFetch({
      "https://shop.example/sitemap.xml": sitemapIndex("https://shop.example/l1.xml"),
      "https://shop.example/l1.xml": sitemapIndex("https://shop.example/l2.xml"),
      "https://shop.example/l2.xml": sitemapIndex("https://shop.example/l3.xml"),
      "https://shop.example/l3.xml": urlset("https://shop.example/deep"),
    });
    await expect(fetchSitemapUrls("https://shop.example/sitemap.xml", fetchImpl)).resolves.toEqual([]);
    expect(calls).not.toContain("https://shop.example/l3.xml");
  });

  it("fetches at most 50 child sitemaps", async () => {
    const children = Array.from({ length: MAX_CHILD_SITEMAPS + 10 }, (_, i) => `https://shop.example/c${i}.xml`);
    const pages: Record<string, string> = { "https://shop.example/sitemap.xml": sitemapIndex(...children) };
    for (const child of children) pages[child] = urlset(`${child}#page`);
    const { fetchImpl, calls } = stubFetch(pages);
    const found = await fetchSitemapUrls("https://shop.example/sitemap.xml", fetchImpl);
    expect(found).toHaveLength(MAX_CHILD_SITEMAPS);
    expect(calls.filter((c) => c.includes("/c")).length).toBe(MAX_CHILD_SITEMAPS);
  });

  it("skips a child that fails to fetch and keeps the others", async () => {
    const { fetchImpl } = stubFetch({
      "https://shop.example/sitemap.xml": sitemapIndex("https://shop.example/missing.xml", "https://shop.example/ok.xml"),
      "https://shop.example/ok.xml": urlset("https://shop.example/ok"),
    });
    await expect(fetchSitemapUrls("https://shop.example/sitemap.xml", fetchImpl)).resolves.toEqual(["https://shop.example/ok"]);
  });

  it("throws when the top sitemap is missing or is not a sitemap", async () => {
    const { fetchImpl } = stubFetch({ "https://shop.example/sitemap.xml": "<html></html>" });
    await expect(fetchSitemapUrls("https://shop.example/missing.xml", fetchImpl)).rejects.toThrow("is not an XML sitemap");
    await expect(fetchSitemapUrls("https://shop.example/sitemap.xml", fetchImpl)).rejects.toThrow("is not an XML sitemap");
  });
});

describe("sitemap fetches are guarded (sameSite, connect-time check, size cap)", () => {
  let base = "";
  let server: Server | undefined;

  beforeAll(async () => {
    const started = await new Promise<{ server: Server; port: number }>((resolve) => {
      const s = createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/sitemap.xml") {
          res.writeHead(200, { "content-type": "application/xml" });
          return res.end(sitemapIndex(`${base}/child.xml`, `${base}/big.xml`, `${base}/redirect.xml`, "http://169.254.169.254/latest.xml"));
        }
        if (url === "/child.xml") {
          res.writeHead(200, { "content-type": "application/xml" });
          return res.end(urlset(`${base}/ae-en/from-child`));
        }
        if (url === "/big.xml") {
          res.writeHead(200, { "content-type": "application/xml" });
          return res.end(Buffer.alloc(MAX_SITEMAP_BYTES + 1024, 0x20));
        }
        if (url === "/redirect.xml") {
          res.writeHead(302, { location: "http://other.test/elsewhere.xml" });
          return res.end();
        }
        res.writeHead(404);
        res.end();
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: s, port: (s.address() as AddressInfo).port }));
    });
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("reads a local sitemap index: follows its child, skips the over-cap body, the redirect off-site and the metadata address", async () => {
    await expect(fetchSitemapUrls(`${base}/sitemap.xml`)).resolves.toEqual([`${base}/ae-en/from-child`]);
  });

  it("refuses a top sitemap on a metadata address, with no request", async () => {
    await expect(fetchSitemapUrls("http://169.254.169.254/latest/sitemap.xml")).rejects.toThrow();
  });

  it("only a child on the same registrable domain may be fetched", () => {
    expect(sitemapMayBeFetched("https://shop.example/a.xml", "https://shop.example/sitemap.xml")).toBe(true);
    expect(sitemapMayBeFetched("https://www.shop.example/a.xml", "https://shop.example/sitemap.xml")).toBe(true);
    expect(sitemapMayBeFetched("https://evil.test/a.xml", "https://shop.example/sitemap.xml")).toBe(false);
    expect(sitemapMayBeFetched("http://169.254.169.254/a.xml", "https://shop.example/sitemap.xml")).toBe(false);
    expect(sitemapMayBeFetched("file:///etc/passwd", "https://shop.example/sitemap.xml")).toBe(false);
    expect(sitemapMayBeFetched("not a url", "https://shop.example/sitemap.xml")).toBe(false);
  });
});

describe("urlsFromSource", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-urls-"));
    await writeFile(join(dir, "pages.txt"), "# two pages\nhttps://shop.example/ae-en/a\nhttps://shop.example/ae-en/b\n");
    await writeFile(
      join(dir, "sitemap.xml"),
      urlset("https://shop.example/ae-en/p/1", "https://shop.example/ae-en/p/2", "https://evil.test/other"),
    );
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads a text list", async () => {
    const result = await urlsFromSource("pages.txt", dir);
    expect(result).toEqual({ urls: ["https://shop.example/ae-en/a", "https://shop.example/ae-en/b"], source: "list", dropped: 0 });
  });

  it("reads a local sitemap file and counts the URLs of another domain it dropped", async () => {
    const result = await urlsFromSource("sitemap.xml", dir);
    expect(result.source).toBe("local-sitemap");
    expect(result.urls).toEqual(["https://shop.example/ae-en/p/1", "https://shop.example/ae-en/p/2"]);
    expect(result.dropped).toBe(1);
  });

  it("says when the file is not there", async () => {
    await expect(urlsFromSource("missing.txt", dir)).rejects.toThrow();
  });
});

describe("patternOf and sampleByPattern", () => {
  it("names a route pattern by its first segment after a locale, with a wildcard for the rest", () => {
    expect(patternOf("https://shop.example/ae-en/p/ray-ban-aviator-1234")).toBe("/ae-en/p/*");
    expect(patternOf("https://shop.example/c/bags/totes")).toBe("/c/*");
    expect(patternOf("https://shop.example/about")).toBe("/about");
    expect(patternOf("https://shop.example/")).toBe("/");
    expect(patternOf("https://shop.example/ae-en/c")).toBe("/ae-en/c");
  });

  it("takes N URLs of each pattern, spread over the pattern, and keeps a small pattern whole", () => {
    const products = Array.from({ length: 10 }, (_, i) => `https://shop.example/p/item-${i}`);
    const categories = ["https://shop.example/c/bags", "https://shop.example/c/shoes"];
    const { urls, patterns } = sampleByPattern([...products, ...categories, "https://shop.example/about"], 3);
    expect(patterns).toBe(3);
    expect(urls.filter((u) => u.includes("/p/"))).toEqual([
      "https://shop.example/p/item-0",
      "https://shop.example/p/item-5",
      "https://shop.example/p/item-9",
    ]);
    expect(urls.filter((u) => u.includes("/c/"))).toEqual(categories);
    expect(urls).toContain("https://shop.example/about");
  });

  it("with N = 1 takes the first URL of each pattern", () => {
    const { urls } = sampleByPattern(["https://shop.example/p/a", "https://shop.example/p/b"], 1);
    expect(urls).toEqual(["https://shop.example/p/a"]);
  });
});
