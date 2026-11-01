// The one-screen summary: its sections, the 40-line cap, the call-site and path forms. The renderer is pure.
import { describe, expect, it } from "vitest";
import { callSitesFromJson, labelOf, MAX_SUMMARY_LINES, renderSummary, showPath, type CallSite, type SummaryInput } from "../src/summary.js";
import { okPage, otherPage } from "./page-fixtures.js";

const site = (i: number): CallSite => ({
  saved: (100 - i) * 1024,
  file: `src/components/Card${i}.tsx`,
  line: 40 + i,
  component: `Card${i}`,
  count: 2,
  pages: 3,
});

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    heading: "imgtune run: 4 URL(s), 2 pattern(s), exit 0",
    out: ".imgtune/run/x",
    timings: [
      { name: "survey", seconds: 52.4 },
      { name: "deep", seconds: 84.1 },
    ],
    surveyLabel: "survey: 2 viewports, exact savings only, no est.",
    survey: [
      okPage("https://shop.example/p/one-1", 200, 25),
      okPage("https://shop.example/p/two-2", 120, 10),
      okPage("https://shop.example/c/x", 80, 40),
      otherPage("https://shop.example/c/y", "blocked"),
    ],
    deep: [okPage("https://shop.example/p/one-1", 200, 25, { viewports: ["iphone-15", "desktop"] })],
    callSites: [
      { ...site(1), file: undefined, line: undefined, component: undefined, reason: "search ProductTile in src/**/*.tsx" },
      site(2),
    ],
    warnings: [],
    next: ["imgtune hints .imgtune/run/x/located/*.json --limit 10"],
    ...over,
  };
}

const lines = (text: string) => text.replace(/\n$/, "").split("\n");

describe("renderSummary", () => {
  it("prints the heading, the timings, the survey totals and the worst pattern", () => {
    const out = lines(renderSummary(input()));
    expect(out[0]).toBe("imgtune run: 4 URL(s), 2 pattern(s), exit 0");
    expect(out[1]).toBe("out: .imgtune/run/x");
    expect(out[2]).toBe("time: 137 s total (survey 52 s, deep 84 s)");
    expect(out.join("\n")).toMatch(/^survey: 4 page\(s\), 3 ok, 0 broken, 1 not measured$/m);
    expect(out.join("\n")).toMatch(/^  2 viewports, exact savings only, no est\.$/m);
    expect(out.join("\n")).toMatch(/^  site \(3 ok, mean\): image KB\/view /m);
    expect(out.join("\n")).toMatch(/worst patterns \(mean exact KB\/view per page, 2 of 2 shown\):/);
    expect(out.join("\n")).toMatch(/\/p\/\*\s+2 page\(s\)/);
  });

  it("prints the deep table with KB per view, exact, exact + est. and sharpness", () => {
    const text = renderSummary(input());
    expect(text).toMatch(/page\s+KB\/view\s+exact\s+exact\+est\s+sharp KB/);
    expect(text).toMatch(/\/p\/one-1\s+200\.0\s+25\.0%\s+25\.0%\s+\+0\.0/);
  });

  it("prints a call site by its file:line, or as not located with the reason", () => {
    const text = renderSummary(input());
    expect(text).toMatch(/1\. {3}99\.0 KB {2}not located: search ProductTile in src\/\*\*\/\*\.tsx {2}2 img, 3 page\(s\)/);
    expect(text).toMatch(/2\. {3}98\.0 KB {2}src\/components\/Card2\.tsx:42 \(Card2\)/);
  });

  it("names the stop before everything else, and drops the deep phase when the run stopped", () => {
    const text = renderSummary(
      input({
        stop: { reason: "3 of 5 survey pages are broken", fix: "the CSS host is unreachable" },
        deep: [],
        callSites: undefined,
      }),
    );
    expect(text).toMatch(/^imgtune run[^\n]*\n[^\n]*\n[^\n]*\n\nSTOPPED before the deep phase: 3 of 5 survey pages are broken\n  fix: the CSS host is unreachable/);
    expect(text).not.toMatch(/call sites/);
    expect(text).not.toMatch(/^deep:/m);
  });

  it("never prints more than the line cap, however many rows there are, and says what it did not show", () => {
    const survey = Array.from({ length: 40 }, (_, i) => okPage(`https://shop.example/p${i}/item-${i}`, 100 + i, 10 + (i % 7)));
    const deep = Array.from({ length: 12 }, (_, i) => okPage(`https://shop.example/deep/item-${i}`, 100 + i, 10 + i));
    const big = renderSummary(
      input({
        survey,
        deep,
        callSites: Array.from({ length: 25 }, (_, i) => site(i)),
        warnings: Array.from({ length: 9 }, (_, i) => `warning ${i}`),
        next: ["one", "two", "three", "four", "five"],
      }),
    );
    expect(lines(big).length).toBeLessThanOrEqual(MAX_SUMMARY_LINES);
    expect(big).toMatch(/call sites by saving per view \(top 10 of 25\)/);
    expect(big).toMatch(/deep: 12 page\(s\) full-scanned, 12 ok \(5 of 12 shown/);
    expect(big).toMatch(/warnings \(9, first 3 shown\):/);
    expect(big).not.toMatch(/line\(s\) cut/);
  });

  it("fits the worst case in the cap without cutting: every section full", () => {
    const survey = Array.from({ length: 40 }, (_, i) => okPage(`https://shop.example/p${i}/item-${i}`, 100 + i, 10 + (i % 7)));
    const deep = Array.from({ length: 12 }, (_, i) => okPage(`https://shop.example/deep/item-${i}`, 100 + i, 10 + i));
    const text = renderSummary(
      input({
        survey,
        deep,
        callSites: Array.from({ length: 25 }, (_, i) => site(i)),
        warnings: Array.from({ length: 9 }, (_, i) => `warning ${i}`),
        next: ["one", "two", "three", "four", "five"],
      }),
    );
    expect(lines(text).length).toBe(MAX_SUMMARY_LINES);
    expect(text).not.toMatch(/line\(s\) cut/);
  });

  it("cuts a summary that is still too long, and says so on the last line", () => {
    const text = renderSummary(
      input({
        stop: undefined,
        survey: undefined,
        callSites: Array.from({ length: 25 }, (_, i) => site(i)),
        deep: Array.from({ length: 12 }, (_, i) => okPage(`https://shop.example/deep/item-${i}`, 100 + i, 10 + i)),
        warnings: ["one"],
        next: ["a", "b", "c"],
        surveyLabel: "survey: 2 viewports, exact savings only, no est.",
      }),
    );
    expect(lines(text).length).toBeLessThanOrEqual(MAX_SUMMARY_LINES);
  });

  it("prints safe text only: control characters in a page are replaced", () => {
    const text = renderSummary(input({ out: "dir\u001b[31m", next: ["imgtune hints x"] }));
    expect(text).not.toContain("\u001b");
  });
});

describe("helpers", () => {
  it("labels a page by its path and query, and shows a path relative to the cwd when it is inside it", () => {
    expect(labelOf("https://shop.example/p/a?size=2")).toBe("/p/a?size=2");
    expect(showPath("/work/app/.imgtune/run/x", "/work/app")).toBe(".imgtune/run/x");
    expect(showPath("/elsewhere/run", "/work/app")).toBe("/elsewhere/run");
  });

  it("reads the call sites of a hints JSON: a file, or the find clue of a call site with no file", () => {
    const sites = callSitesFromJson(
      JSON.stringify({
        callSites: [
          { key: "k1", file: "src/Card.tsx", line: 42, component: ["Card"], count: 2, pages: ["https://s.example/a"], saved: 2048 },
          { key: "k2", file: null, line: null, component: ["Tile"], count: 1, pages: ["https://s.example/b"], saved: 1024, hints: [{ find: { component: "Tile", glob: "src/**/*.tsx" } }] },
        ],
      }),
    );
    expect(sites[0]).toMatchObject({ file: "src/Card.tsx", line: 42, component: "Card", saved: 2048, pages: 1 });
    expect(sites[1]).toMatchObject({ reason: "search Tile in src/**/*.tsx", component: "Tile" });
    expect(sites[1].file).toBeUndefined();
  });
});
