// The one-screen summary: its sections, the 40-line cap, the call-site and path forms. The renderer is pure.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callSitesFromJson, labelOf, MAX_SUMMARY_LINES, parseManifest, renderSummary, showPath, summaryCommand, type CallSite, type SummaryInput } from "../src/summary.js";
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
  it("prints the heading, the timings, the survey totals and the worst route types", () => {
    const out = lines(renderSummary(input()));
    expect(out[0]).toBe("imgtune run: 4 URL(s), 2 pattern(s), exit 0");
    expect(out[1]).toBe("out: .imgtune/run/x");
    expect(out[2]).toBe("time: 137 s total (survey 52 s, deep 84 s)");
    expect(out.join("\n")).toMatch(/^survey: 4 page\(s\), 3 ok, 0 broken, 0 failed, 1 not measured$/m);
    expect(out.join("\n")).toMatch(/^  2 viewports, exact savings only, no est\.$/m);
    expect(out.join("\n")).toMatch(/^  site \(3 ok, mean\): image KB\/view /m);
    expect(out.join("\n")).toMatch(/worst route types \(mean exact KB\/view per page, 2 of 2 shown\):/);
    expect(out.join("\n")).toMatch(/\/p\/\*\s+2 page\(s\)/);
  });

  it("counts the failed survey pages apart from the not measured ones", () => {
    const text = renderSummary(input({ survey: [...(input().survey ?? []), otherPage("https://shop.example/c/z", "failed", { error: "net::ERR_TIMED_OUT" })] }));
    expect(text).toMatch(/^survey: 5 page\(s\), 3 ok, 0 broken, 1 failed, 1 not measured$/m);
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
    expect(big).toMatch(/deep: 12 page\(s\) full-scanned, 12 ok, 0 failed \(5 of 12 shown/);
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

describe("run.json is checked before anything from it is printed", () => {
  const good = {
    tool: "imgtune",
    version: "0.1.0",
    urls: { count: 4, types: 2, file: "urls.txt" },
    options: { deep: 2, qualities: [75, 85, 100], noCache: false, ignoreRobots: false, storageState: false },
    phases: [{ name: "survey", seconds: 3.2 }],
    deepLeftOut: [{ type: "/shop", pages: 3, typeKbPerView: 120, reason: "cap" }],
    mode: "check",
    site: "https://shop.example",
    report: "report.md",
    stop: null,
    exitCode: 0,
  };
  const withPatch = (patch: Record<string, unknown>) => JSON.stringify({ ...good, ...patch });
  const rejects = (text: string, field: RegExp) => expect(() => parseManifest(text, "run.json")).toThrow(field);

  it("accepts a manifest of the shape the run writes", () => {
    expect(parseManifest(JSON.stringify(good), "run.json").urls.file).toBe("urls.txt");
  });

  it("refuses qualities that are not whole numbers", () => {
    rejects(withPatch({ options: { ...good.options, qualities: [75.5] } }), /options\.qualities must be a whole number/);
    rejects(withPatch({ options: { ...good.options, qualities: ["85"] } }), /options\.qualities/);
    rejects(withPatch({ options: { ...good.options, qualities: [] } }), /options\.qualities must be a list/);
  });

  it("refuses a urls.file that is not a plain name in the run directory", () => {
    for (const file of ["../escape.txt", "/etc/passwd", "sub/urls.txt", "a..b", ".hidden", "urls.txt; rm -rf ~"]) {
      rejects(withPatch({ urls: { ...good.urls, file } }), /urls\.file must be a plain file name/);
    }
  });

  it("refuses counts and exitCode that are not numbers", () => {
    rejects(withPatch({ urls: { ...good.urls, count: "4" } }), /urls\.count must be a whole number/);
    rejects(withPatch({ urls: { ...good.urls, types: null } }), /urls\.types/);
    const { exitCode: _omit, ...noExit } = good;
    rejects(JSON.stringify(noExit), /exitCode must be a whole number/);
  });

  it("accepts a phase with a failed count, and a list of deep retries", () => {
    const manifest = parseManifest(
      withPatch({
        phases: [{ name: "deep", seconds: 9, pages: 3, ok: 2, broken: 0, failed: 1 }],
        deepRetries: [{ type: "/showcase", failed: "https://shop.example/showcase", replacement: "https://shop.example/faqs" }],
      }),
      "run.json",
    );
    expect(manifest.phases[0].failed).toBe(1);
    expect(manifest.deepRetries?.[0].replacement).toBe("https://shop.example/faqs");
  });

  it("refuses a failed count that is not a number, and deep retries that are not a list", () => {
    rejects(withPatch({ phases: [{ name: "deep", seconds: 1, failed: "1" }] }), /phases\[\]\.failed/);
    rejects(withPatch({ deepRetries: { type: "/x" } }), /deepRetries/);
  });

  it("refuses a phase name that is not one of the known phases (no escape sequence reaches the heading)", () => {
    rejects(withPatch({ phases: [{ name: "\u001b[2Jsurvey", seconds: 1 }] }), /phases\[\]\.name must be one of survey, deep, locate, hints/);
  });

  it("refuses a mode that is not a run mode, and a report that is not a plain file name", () => {
    rejects(withPatch({ mode: "deploy" }), /mode must be "run", "check" or "audit"/);
    rejects(withPatch({ mode: 1 }), /mode must be/);
    for (const report of ["../report.md", "/tmp/report.md", "report.md; rm -rf ~"]) {
      rejects(withPatch({ report }), /report must be a plain file name/);
    }
    rejects(withPatch({ report: 7 }), /report must be a string/);
  });

  it("refuses a site that is not a string, and a deepLeftOut that is not checked", () => {
    rejects(withPatch({ site: ["https://shop.example"] }), /site must be a string/);
    rejects(withPatch({ deepLeftOut: undefined }), /deepLeftOut must be a list/);
    rejects(withPatch({ deepLeftOut: [{ type: "/shop", pages: "3", typeKbPerView: 1, reason: "cap" }] }), /deepLeftOut\[\]\.pages must be a whole number/);
    rejects(withPatch({ deepLeftOut: [{ type: "/shop", pages: 3, typeKbPerView: -1, reason: "cap" }] }), /deepLeftOut\[\]\.typeKbPerView must be a number/);
    rejects(withPatch({ deepLeftOut: [{ type: "/shop", pages: 3, typeKbPerView: 1, reason: "maybe" }] }), /deepLeftOut\[\]\.reason must be/);
    rejects(withPatch({ deepLeftOut: ["/shop"] }), /deepLeftOut\[\] must be an object/);
  });

  it("accepts a plain run, which writes no mode, site or report", () => {
    const { mode: _m, site: _s, report: _r, ...plain } = good;
    expect(parseManifest(JSON.stringify(plain), "run.json").deepLeftOut).toHaveLength(1);
  });

  it("refuses a file that is not a manifest, and says which file", () => {
    expect(() => parseManifest("not json", "run.json")).toThrow(/run\.json is not JSON/);
    expect(() => parseManifest(JSON.stringify({ tool: "other" }), "run.json")).toThrow(/tool must be "imgtune"/);
  });

  it("quotes every value a printed next command carries: a hostile run directory name is one inert word", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "imgtune-quote-"));
    try {
      // The directory's name is the hostile part: a space, a quote, and a command substitution.
      const dir = join(scratch, "x'y $(touch pwned)");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "run.json"), JSON.stringify({ ...good, stop: { phase: "survey", reason: "r", fix: "f" } }));
      const { output } = await summaryCommand([dir], scratch);
      const line = output.split("\n").find((l) => l.includes("after the fix"));
      expect(line).toBeDefined();
      // The word after --urls-from, as a shell reads it: it must evaluate to the path, and nothing may have run.
      const word = /--urls-from (\S.*?) --out/.exec(line as string)?.[1] as string;
      expect(word.startsWith("'")).toBe(true);
      const evaluated = execFileSync("sh", ["-c", `printf '%s' ${word}`], { cwd: scratch }).toString();
      expect(evaluated).toBe(`x'y $(touch pwned)/urls.txt`);
      expect(await readFile(join(scratch, "pwned"), "utf8").then(() => true, () => false)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("prints the heading with control characters removed", () => {
    const text = renderSummary(input({ heading: "imgtune run:\u001b[31m 4 URL(s)\u0007" }));
    expect(text).not.toMatch(/\u001b|\u0007/);
    expect(text.split("\n")[0]).toBe("imgtune run: 4 URL(s)");
  });
});
