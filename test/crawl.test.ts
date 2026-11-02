// The same-origin link crawl of audit (crawl.ts): the links of a page, the levels followed from the home page, the seeds and
// the learned locales, the round robin over first segments, and the origin rule (a redirect off the exact origin is dropped).
import { describe, expect, it } from "vitest";
import { alternatesOf, crawlSite, linksOf, type PageGet } from "../src/crawl.js";
import type { Resolver } from "../src/address.js";

const ORIGIN = "https://shop.example";

/**
 * A fake page source over a map of path to HTML (a missing path answers nothing). `finals` maps a requested path to the URL it
 * redirects to; the body is the redirect target's, as the checked fetcher returns it.
 */
function fakeSite(pages: Record<string, string>, asked: string[] = [], finals: Record<string, string> = {}): PageGet {
  return async (url: string) => {
    asked.push(url);
    const finalUrl = finals[new URL(url).pathname] ?? url;
    const body = pages[new URL(finalUrl).pathname];
    if (body === undefined) return undefined;
    return { body: Buffer.from(body, "utf8"), finalUrl };
  };
}

describe("linksOf", () => {
  it("resolves relative links, drops fragments, other origins, files and non-page schemes, and keeps each link once", () => {
    const html = `
      <a href="/a#top">A</a>
      <a class="x" href='b'>B</a>
      <a href="https://other.example/x">other</a>
      <a href="/logo.png">logo</a>
      <a href="mailto:me@shop.example">mail</a>
      <a href="#only-here">frag</a>
      <a href="/a">again</a>
      <a href=/c>unquoted</a>
    `;
    expect(linksOf(html, `${ORIGIN}/section/`, ORIGIN)).toEqual([`${ORIGIN}/a`, `${ORIGIN}/section/b`, `${ORIGIN}/c`]);
  });
});

describe("alternatesOf", () => {
  it("reads the hreflang alternates of the origin, in either attribute order, and not the stylesheets", () => {
    const head = `
      <link rel="stylesheet" href="/site.css">
      <link rel="alternate" hrefLang="en-AE" href="${ORIGIN}/ae-en">
      <link href="/sa-en" hreflang="en-SA" rel="alternate">
      <link rel="alternate" hrefLang="x-default" href="${ORIGIN}/ae-en#top"/>
      <link rel="alternate" type="application/rss+xml" href="/feed">
    `;
    expect(alternatesOf(head, `${ORIGIN}/ae-en`, ORIGIN, false)).toEqual([`${ORIGIN}/ae-en`, `${ORIGIN}/sa-en`]);
  });

  it("reads an alternate on another origin on this origin only for a local site, keeping its path and query", () => {
    const head = `<link rel="alternate" hrefLang="en-SA" href="https://shop.example/sa-en?x=1">`;
    expect(alternatesOf(head, "http://localhost:3320/ae-en", "http://localhost:3320", true)).toEqual(["http://localhost:3320/sa-en?x=1"]);
    expect(alternatesOf(head, `${ORIGIN}/ae-en`, ORIGIN, false)).toEqual([`${ORIGIN}/sa-en?x=1`]);
    expect(alternatesOf(`<link rel="alternate" hrefLang="en-SA" href="https://other.example/sa-en">`, `${ORIGIN}/ae-en`, ORIGIN, false)).toEqual([]);
  });
});

describe("crawlSite", () => {
  const pages: Record<string, string> = {
    "/": `<!doctype html><a href="/a">a</a><a href="/b#x">b</a><a href="https://other.example/">o</a><a href="/img.png">i</a>`,
    "/a": `<!doctype html><a href="/c">c</a><a href="/">home</a>`,
    "/b": `<!doctype html><a href="/d">d</a>`,
    "/c": `<!doctype html><a href="/deep">deep</a>`,
    "/d": `<!doctype html><title>d</title>`,
    "/deep": `<!doctype html><a href="/deeper">x</a>`,
  };

  it("follows links two levels from the home page, and lists the pages it reached", async () => {
    const asked: string[] = [];
    const found = await crawlSite(ORIGIN, { get: fakeSite(pages, asked) });
    expect(found).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`, `${ORIGIN}/d`]);
    expect(asked).not.toContain(`${ORIGIN}/deep`);
    expect(asked.some((u) => u.startsWith("https://other.example"))).toBe(false);
  });

  it("stops at the page cap", async () => {
    const found = await crawlSite(ORIGIN, { get: fakeSite(pages), max: 2 });
    expect(found).toHaveLength(2);
    expect(found[0]).toBe(`${ORIGIN}/`);
  });

  it("does not list a body that is not an HTML document", async () => {
    const found = await crawlSite(ORIGIN, { get: async () => ({ body: Buffer.from('{"links":["/a"]}', "utf8"), finalUrl: `${ORIGIN}/` }) });
    expect(found).toEqual([]);
  });

  it("refuses a site whose host resolves to a private address, unless the site is local (the checked fetcher)", async () => {
    const privateResolver: Resolver = async () => [{ address: "10.0.0.5", family: 4 }];
    const found = await crawlSite(ORIGIN, { resolver: privateResolver, max: 5 });
    expect(found).toEqual([]);
  });

  it("does not list a page that answers an error", async () => {
    const found = await crawlSite(ORIGIN, { get: fakeSite({ "/": `<!doctype html><a href="/gone">g</a>` }) });
    expect(found).toEqual([`${ORIGIN}/`]);
  });

  it("records the URL a page was finally read from, so a redirect to a locale is the page and its links are followed", async () => {
    const found = await crawlSite(ORIGIN, {
      get: fakeSite({ "/ae-en": `<!doctype html><a href="/ae-en/about">x</a>`, "/ae-en/about": `<!doctype html>` }, [], { "/": `${ORIGIN}/ae-en?utm=1` }),
    });
    expect(found).toEqual([`${ORIGIN}/ae-en?utm=1`, `${ORIGIN}/ae-en/about`]);
  });

  it("drops a page whose final URL leaves the exact origin, even on a sibling subdomain of the same domain", async () => {
    const sibling = "https://eu.shop.example";
    const found = await crawlSite(ORIGIN, {
      get: fakeSite({ "/": `<!doctype html><a href="/sign-in">s</a><a href="/about">a</a>`, "/sign-in": `<!doctype html>`, "/about": `<!doctype html>` }, [], {
        "/sign-in": `${sibling}/sign-in`,
      }),
    });
    expect(found).toEqual([`${ORIGIN}/`, `${ORIGIN}/about`]);
  });

  it("crawls from the seeds next to the home page, and off-origin seeds are dropped", async () => {
    const asked: string[] = [];
    const found = await crawlSite(ORIGIN, {
      seeds: [`${ORIGIN}/hidden`, "https://other.example/x"],
      get: fakeSite({ "/": `<!doctype html>`, "/hidden": `<!doctype html><a href="/hidden/child">c</a>`, "/hidden/child": `<!doctype html>` }, asked),
    });
    expect(found).toEqual([`${ORIGIN}/`, `${ORIGIN}/hidden`, `${ORIGIN}/hidden/child`]);
    expect(asked.some((u) => u.startsWith("https://other.example"))).toBe(false);
  });

  it("gives the home page's final URL and links to seedsAfterHome, and crawls the seeds it returns", async () => {
    let seenByCallback: string[] = [];
    const found = await crawlSite(ORIGIN, {
      get: fakeSite({ "/ae-en": `<!doctype html><a href="/el-seed">e</a>`, "/ae-en/about": `<!doctype html>`, "/el-seed": `<!doctype html>`, "/el-seed/about": `<!doctype html>` }, [], {
        "/": `${ORIGIN}/ae-en`,
      }),
      seedsAfterHome: (seen) => {
        seenByCallback = seen;
        return [`${ORIGIN}/ae-en/about`, `${ORIGIN}/el-seed/about`];
      },
    });
    expect(seenByCallback).toEqual([`${ORIGIN}/ae-en`, `${ORIGIN}/el-seed`]);
    expect(found).toEqual([`${ORIGIN}/ae-en`, `${ORIGIN}/el-seed`, `${ORIGIN}/ae-en/about`, `${ORIGIN}/el-seed/about`]);
  });

  it("takes the groups of first segments in turn, so a large group cannot use up the budget before a small one", async () => {
    const big = Array.from({ length: 20 }, (_, i) => `<a href="/ae-en/p${i}">p</a>`).join("");
    const leaves = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/ae-en/p${i}`, `<!doctype html>`]));
    const site = fakeSite({
      "/": `<!doctype html><a href="/ae-en/start">s</a><a href="/el-seed/start">e</a>`,
      "/ae-en/start": `<!doctype html>${big}`,
      "/el-seed/start": `<!doctype html><a href="/el-seed/one">1</a><a href="/el-seed/two">2</a>`,
      "/el-seed/one": `<!doctype html>`,
      "/el-seed/two": `<!doctype html>`,
      ...leaves,
    });
    const found = await crawlSite(ORIGIN, { get: site, max: 8 });
    expect(found.some((u) => u.startsWith(`${ORIGIN}/el-seed/`))).toBe(true);
    expect(found.filter((u) => u.startsWith(`${ORIGIN}/ae-en/p`)).length).toBeGreaterThan(0);
    expect(found).toHaveLength(8);
  });
});

describe("crawlSite and the hreflang alternates of a locale", () => {
  it("crawls the other locales a page names as alternates, so a locale that no link reaches is still a page", async () => {
    const home = `<!doctype html><link rel="alternate" hrefLang="en-SA" href="${ORIGIN}/sa-en"><a href="/ae-en/x">x</a>`;
    const found = await crawlSite(ORIGIN, {
      get: fakeSite({ "/": home, "/sa-en": `<!doctype html>`, "/ae-en/x": `<!doctype html>` }),
    });
    expect(found).toEqual([`${ORIGIN}/`, `${ORIGIN}/ae-en/x`, `${ORIGIN}/sa-en`]);
  });
});

