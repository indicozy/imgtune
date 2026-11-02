// The same-origin link crawl of audit (crawl.ts): the links of a page, and the levels followed from the home page.
import { describe, expect, it } from "vitest";
import { crawlSite, linksOf } from "../src/crawl.js";

const ORIGIN = "https://shop.example";

/** A fake fetch over a map of path to HTML (a missing path answers 404). Records each URL asked for. */
function fakeSite(pages: Record<string, string>, asked: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    const path = new URL(url).pathname;
    const body = pages[path];
    if (body === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as unknown as typeof fetch;
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
    "/d": ``,
    "/deep": `<a href="/deeper">x</a>`,
  };

  it("follows links two levels from the home page, and lists the pages it reached", async () => {
    const asked: string[] = [];
    const found = await crawlSite(ORIGIN, { fetchImpl: fakeSite(pages, asked) });
    expect(found).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`, `${ORIGIN}/d`]);
    expect(asked).not.toContain(`${ORIGIN}/deep`);
    expect(asked.some((u) => u.startsWith("https://other.example"))).toBe(false);
  });

  it("stops at the page cap", async () => {
    const found = await crawlSite(ORIGIN, { fetchImpl: fakeSite(pages), max: 2 });
    expect(found).toHaveLength(2);
    expect(found[0]).toBe(`${ORIGIN}/`);
  });

  it("does not list a page that answers an error", async () => {
    const found = await crawlSite(ORIGIN, { fetchImpl: fakeSite({ "/": `<a href="/gone">g</a>` }) });
    expect(found).toEqual([`${ORIGIN}/`]);
  });
});
