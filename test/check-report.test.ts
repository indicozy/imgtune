// The check report (check-report.ts): the merged fixes, the sharpness list, the heavy pages, the route-type table and the
// not-measured section, from fixture pages. No browser.
import { describe, expect, it } from "vitest";
import { buildCheckReport, fixGroupsOf, type CheckReportInput } from "../src/check-report.js";
import { errorLine, stripControls } from "../src/text.js";
import { selectDeepPages } from "../src/deep.js";
import { groupRoutes } from "../src/routes.js";
import type { ImageRecord } from "../src/images.js";
import type { PageResult } from "../src/remote.js";
import { okPage, otherPage } from "./page-fixtures.js";

const SHOP = "https://shop.example";

/** An image record with a fix of `saved` bytes per view (sizes part only), and `sharp` bytes of sharpness. */
function imageOf(id: string, saved: number, sharp = 0, over: { pattern?: string; proposed?: string; file?: string; line?: number } = {}): ImageRecord {
  const record = {
    id,
    page: "",
    locator: {
      component: over.file === undefined ? ["Hero"] : [],
      selector: "img.hero",
      classes: "hero",
      loader: "next-default",
      urlPattern: over.pattern ?? "/_next/image?url=/hero.jpg",
      ...(over.file !== undefined ? { file: over.file, line: over.line ?? 1, verified: true, kind: "image" } : {}),
    },
    tunable: { width: true, quality: false },
    current: { sizes: "100vw", srcsetCandidates: [], format: "jpeg" },
    perViewport: [],
    fix: {
      sizes: { value: over.proposed ?? "50vw", basis: "measured", rung: "measured-page", branches: [] },
      bytes: { saved, addedForSharpness: sharp, sizes: saved, quality: 0 },
    },
    evidence: { rung: "measured-page", notes: [] },
  };
  return record as unknown as ImageRecord;
}

/** A deep page with the given image records (their pages set to the URL). */
function deepOf(url: string, kbPerView: number, exactPct: number, images: ImageRecord[], over: Partial<PageResult> = {}): PageResult {
  const page = okPage(url, kbPerView, exactPct);
  return { ...page, images: images.map((r) => ({ ...r, page: url })) as ImageRecord[], ...over };
}

describe("fixGroupsOf", () => {
  it("merges the same fix across pages: one image pattern with the same proposed sizes", () => {
    const pages = [
      deepOf(`${SHOP}/ae-en/cart`, 300, 30, [imageOf("a1", 20 * 1024)]),
      deepOf(`${SHOP}/sa-ar/cart`, 280, 28, [imageOf("a2", 30 * 1024)]),
      deepOf(`${SHOP}/ae-en/faqs`, 100, 10, [imageOf("a3", 5 * 1024, 0, { proposed: "100vw" })]),
    ];
    const groups = fixGroupsOf(pages);
    expect(groups).toHaveLength(2);
    expect(groups[0].pages).toHaveLength(2);
    expect(groups[0].images).toBe(2);
    expect(groups[0].savedKBSum).toBeCloseTo(50, 5);
    expect(groups[0].savedKBPerPage).toBeCloseTo(25, 5);
    expect(groups[1].pages).toHaveLength(1);
  });

  it("keeps a located fix apart by its file:line and reads its loader", () => {
    const pages = [
      deepOf(`${SHOP}/ae-en/cart`, 300, 30, [imageOf("a1", 10 * 1024, 0, { file: "src/Hero.tsx", line: 12 })]),
      deepOf(`${SHOP}/ae-en/faqs`, 300, 30, [imageOf("a2", 10 * 1024, 0, { file: "src/Hero.tsx", line: 12 })]),
    ];
    const groups = fixGroupsOf(pages);
    expect(groups).toHaveLength(1);
    expect(groups[0].where).toBe("src/Hero.tsx:12");
    expect(groups[0].located).toBe(true);
    expect(groups[0].loader).toBe("next-default");
  });

  it("counts a void quality target as no quality saving, and snaps a target to the allowed qualities", () => {
    const record = imageOf("q1", 4 * 1024);
    (record.current as { quality?: number }).quality = 60;
    (record.fix as { quality?: unknown }).quality = {
      perFormat: { jpeg: 80 },
      groupRule: "max-of-targets",
      group: "Hero",
      samples: 3,
      current: 60,
      qualityAssumed: false,
    };
    (record.fix.bytes as { quality?: number }).quality = 2 * 1024;
    record.fix.bytes.saved = 6 * 1024;
    const groups = fixGroupsOf([deepOf(`${SHOP}/cart`, 200, 20, [record])], [75, 85, 100]);
    expect(groups[0].quality).toMatchObject({ current: 60, target: 85, snapFrom: 80, void: true });
  });
});

describe("buildCheckReport", () => {
  const survey: PageResult[] = [
    okPage(`${SHOP}/ae-en/cart`, 300, 20),
    okPage(`${SHOP}/sa-ar/cart`, 250, 18),
    okPage(`${SHOP}/ae-en/faqs`, 120, 12),
    okPage(`${SHOP}/ae-en/sunglasses/round.html`, 90, 40),
    okPage(`${SHOP}/sa-ar/sunglasses/square.html`, 60, 35),
    okPage(`${SHOP}/ae-en/sunglasses/oval.html`, 70, 30),
    okPage(`${SHOP}/ae-en/sunglasses/cat-eye.html`, 40, 30),
    okPage(`${SHOP}/ae-en/sunglasses/aviator.html`, 50, 30),
    otherPage(`${SHOP}/ae-en/about-us`, "broken", {
      broken: { kind: "document", reason: "the document answered 500", fix: "fix the route" },
    }),
  ];
  const routes = groupRoutes(survey.map((p) => p.url));
  const deep = [
    deepOf(`${SHOP}/ae-en/cart`, 300, 20, [imageOf("c1", 40 * 1024, 2 * 1024, { pattern: "/_next/image?url=/cart.jpg" })], {
      counts: { images: 1, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
    }),
    deepOf(`${SHOP}/ae-en/faqs`, 120, 12, [imageOf("f1", 6 * 1024, 0, { pattern: "/_next/image?url=/faq.jpg" })]),
    deepOf(`${SHOP}/ae-en/heavy-photo`, 900, 1, [imageOf("h1", 0)], { notLoaded: 2 }),
  ];
  const selection = selectDeepPages(survey, routes, 10);
  const input: CheckReportInput = {
    site: "https://shop.example",
    date: "2026-11-02",
    version: "0.1.0",
    survey,
    deep,
    routes,
    selection,
    urls: { listed: 9, surveyed: 9 },
    timings: { survey: 12.3, deep: 45.6 },
    options: {
      surveyViewports: ["iphone-15", "desktop"],
      deepViewports: ["iphone-15", "desktop", "laptop", "tablet", "wide", "other"],
      qualities: [75, 85, 100],
      thirdParty: "allowed",
      quality: true,
    },
  };
  const report = buildCheckReport(input);

  it("opens with the site, the counts and the time per phase", () => {
    expect(report.split("\n")[0]).toBe("# imgtune check: `https://shop.example`");
    expect(report).toMatch(/9 URL\(s\) listed, 9 surveyed, \d+ route type\(s\)/);
    expect(report).toContain("time: survey 12.3 s, deep 45.6 s, total 57.9 s");
  });

  it("gives the survey and deep numbers, with sharpness as its own number", () => {
    expect(report).toMatch(/Survey \(8 page\(s\)/);
    expect(report).toMatch(/exact \+ est\.: .* KB\/view/);
    expect(report).toMatch(/sharpness: \+[\d.]+ KB\/view, a separate number/);
  });

  it("lists the merged fixes, with the sizes, the quality and the pages", () => {
    const fixes = report.split("## Ranked fixes")[1].split("## Heavy")[0];
    expect(fixes).toContain("`/_next/image?url=/cart.jpg`");
    expect(fixes).toMatch(/sizes `100vw` -> `50vw`/);
    expect(fixes).toMatch(/1 page\(s\), 1 image\(s\)/);
  });

  it("lists the heavy pages whose saving is under 2%", () => {
    const heavy = report.split("## Heavy but not wasteful")[1].split("## Too small")[0];
    expect(heavy).toMatch(/`\/ae-en\/heavy-photo`: 900\.0 KB\/view/);
    expect(heavy).not.toMatch(/`\/ae-en\/cart`/);
  });

  it("lists the sharpness images, separately", () => {
    const sharp = report.split("## Too small (adds bytes)")[1].split("## Route types")[0];
    expect(sharp).toMatch(/\+2\.0 KB\/view \(separate\)/);
  });

  it("gives one route-type row per type, with the deep page or the reason it was left out", () => {
    const table = report.split("## Route types (survey)")[1].split("## Broken")[0];
    expect(table).toMatch(/\| `\/cart` \| 2 \|/);
    expect(table).toMatch(/\| `\/sunglasses\/\*\.html` \| 5 \|/);
    expect(table).toMatch(/\| yes \|/);
  });

  it("names the broken survey pages with their reason, and the images still loading", () => {
    const section = report.split("## Broken, not measured, and images still loading")[1].split("## How to read")[0];
    expect(section).toContain("`/ae-en/about-us`: broken, the document answered 500");
    expect(section).toMatch(/Deep: 0 of 3 page\(s\) not measured, 0 failed; 1 page\(s\) with images still loading at settle \(2 image\(s\)\)/);
  });

  it("explains how to read the numbers, from the run", () => {
    const reading = report.split("## How to read")[1];
    expect(reading).toMatch(/exact savings only \(no quality estimate\)/);
    expect(reading).toMatch(/snapped up to the allowed qualities 75, 85, 100/);
    expect(reading).toMatch(/Third-party requests: allowed/);
  });

  it("says so when the survey measured nothing and the deep phase did not run", () => {
    const stopped = buildCheckReport({
      ...input,
      survey: [otherPage(`${SHOP}/a`, "failed", { error: "net::ERR_NAME_NOT_RESOLVED" })],
      deep: [],
      selection: { picks: [], leftOut: [] },
      stop: { reason: "no survey page was measured", fix: "check the URL" },
    });
    expect(stopped).toContain("## Stopped before the deep phase");
    expect(stopped).toContain("no survey page was measured");
    expect(stopped).toMatch(/Deep: no deep page measured/);
  });

  it("writes page-derived text as code, so a Markdown character in a URL stays text", () => {
    const hostile = buildCheckReport({ ...input, site: "https://shop.example/`x`|y" });
    expect(hostile.split("\n")[0]).toBe("# imgtune check: `https://shop.example/ʼxʼ\\|y`");
  });
});

/** The error Playwright gives when a page does not load in time: a first line, then a call log with ANSI colour codes. */
const PLAYWRIGHT_TIMEOUT =
  'page.goto: net::ERR_TIMED_OUT at https://nextjs.org/showcase\nCall log:\n\u001b[2m  - navigating to "https://nextjs.org/showcase", waiting until "domcontentloaded"\u001b[22m\n';

describe("errorLine and stripControls (the first line of a browser error)", () => {
  it("keeps the first line of a Playwright error and drops the call log and its colour codes", () => {
    expect(errorLine(PLAYWRIGHT_TIMEOUT)).toBe("page.goto: net::ERR_TIMED_OUT at https://nextjs.org/showcase");
  });

  it("skips blank lines before the first text line, and keeps no escape sequence", () => {
    expect(errorLine("\n\n  boom  \nmore")).toBe("boom");
    expect(errorLine("a\u001b[31m b\u001b[0m")).toBe("a b");
  });

  it("removes a whole ANSI sequence, parameters included, from page text", () => {
    expect(stripControls("x\u001b[2Jy\u001b[22m z")).toBe("xy z");
  });
});

describe("failed pages and retries in the report", () => {
  const survey: PageResult[] = [okPage(`${SHOP}/cart`, 300, 20), okPage(`${SHOP}/faqs`, 120, 12), otherPage(`${SHOP}/showcase`, "failed", { error: PLAYWRIGHT_TIMEOUT })];
  const routes = groupRoutes(survey.map((p) => p.url));
  const deep: PageResult[] = [deepOf(`${SHOP}/cart`, 300, 20, [imageOf("c1", 40 * 1024, 0, { pattern: "/_next/image?url=/cart.jpg" })])];
  const base: CheckReportInput = {
    site: SHOP,
    date: "2026-11-03",
    version: "0.1.0",
    survey,
    deep,
    routes,
    selection: selectDeepPages(survey, routes, 10),
    urls: { listed: 3, surveyed: 3 },
    timings: { survey: 1, deep: 1 },
    options: { surveyViewports: ["desktop"], deepViewports: ["desktop"], thirdParty: "allowed", quality: true },
  };

  it("counts the failed pages in the survey header, and lists the first line of the error only", () => {
    const report = buildCheckReport(base);
    expect(report).toContain("survey 3 page(s): 2 ok, 0 broken, 1 failed, 0 not measured");
    const section = report.split("## Broken, not measured, and images still loading")[1].split("## How to read")[0];
    expect(section).toMatch(/^  - `\/showcase`: failed, page\.goto&#58; net&#58;&#58;ERR&#95;TIMED&#95;OUT at https&#58;\/\/nextjs\.org\/showcase$/m);
    expect(section).not.toContain("Call log");
    expect(section).not.toContain("&#91;");
    expect(report).not.toContain("\u001b");
  });

  it("names a deep page that failed in the deep line, and the retry that was made in its place", () => {
    const failedDeep = [...deep, otherPage(`${SHOP}/showcase`, "failed", { error: PLAYWRIGHT_TIMEOUT }), okPage(`${SHOP}/faqs`, 120, 12)];
    const report = buildCheckReport({
      ...base,
      deep: failedDeep,
      retries: [{ type: "/showcase", failed: `${SHOP}/showcase`, replacement: `${SHOP}/faqs` }],
    });
    expect(report).toMatch(/deep 3 page\(s\) \(1 retried\): 2 ok, 1 failed, 0 not measured/);
    expect(report).toMatch(/Deep: 1 of 3 page\(s\) not measured, 1 failed;/);
    expect(report).toContain("- retried: `/showcase` failed, so `/faqs` (the next-heaviest page of `/showcase`) was deep-scanned in its place");
  });
});
