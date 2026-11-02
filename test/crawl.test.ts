// The same-origin link crawl of audit (crawl.ts): the links of a page, and the levels followed from the home page.
import { describe, expect, it } from "vitest";
import { crawlSite, linksOf, type PageGet } from "../src/crawl.js";
import type { Resolver } from "../src/address.js";

const ORIGIN = "https://shop.example";

/** A fake page source over a map of path to HTML (a missing path answers nothing). Records each URL asked for. */
function fakeSite(pages: Record<string, string>, asked: string[] = []): PageGet {
  return async (url: string) => {
    asked.push(url);
    const body = pages[new URL(url).pathname];
    return body === undefined ? undefined : Buffer.from(body, "utf8");
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

describe("crawlSite", () => {
  const pages: Record<string, string> = {
    "/": `<a href="/a">a</a><a href="/b#x">b</a><a href="https://other.example/">o</a><a href="/img.png">i</a>`,
    "/a": `<a href="/c">c</a><a href="/">home</a>`,
    "/b": `<a href="/d">d</a>`,
    "/c": `<a href="/deep">deep</a>`,
    "/d": `<!doctype html><title>d</title>`,
    "/deep": `<a href="/deeper">x</a>`,
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
    const found = await crawlSite(ORIGIN, { get: async () => Buffer.from('{"links":["/a"]}', "utf8") });
    expect(found).toEqual([]);
  });

  it("refuses a site whose host resolves to a private address, unless the site is local (the checked fetcher)", async () => {
    const privateResolver: Resolver = async () => [{ address: "10.0.0.5", family: 4 }];
    const found = await crawlSite(ORIGIN, { resolver: privateResolver, max: 5 });
    expect(found).toEqual([]);
  });

  it("does not list a page that answers an error", async () => {
    const found = await crawlSite(ORIGIN, { get: fakeSite({ "/": `<a href="/gone">g</a>` }) });
    expect(found).toEqual([`${ORIGIN}/`]);
  });
});
