// Broken pages: the detection on a page result, the status it gets, and the stop rule of `run`. No browser.
import { describe, expect, it } from "vitest";
import { BROKEN_EXIT, brokenOf, surveyStop, withBroken } from "../src/broken.js";
import { okPage, otherPage } from "./page-fixtures.js";

const URL_A = "https://shop.example/p/one";

describe("brokenOf", () => {
  it("leaves a sound ok page alone", () => {
    expect(brokenOf(okPage(URL_A, 100, 20))).toBeUndefined();
  });

  it("only an ok page can be broken: a blocked or failed page has its own status", () => {
    const failed = otherPage(URL_A, "failed", { documentStatus: { desktop: 500 } });
    expect(brokenOf(failed)).toBeUndefined();
  });

  it("names an HTTP error on the document, with the fix", () => {
    const info = brokenOf(okPage(URL_A, 0, 0, { documentStatus: { desktop: 404 } }));
    expect(info).toMatchObject({ kind: "document" });
    expect(info?.reason).toMatch(/HTTP 404 at desktop/);
    expect(info?.fix).toMatch(/does not serve this page/);
  });

  it("names the failed stylesheet hosts, and the host to check", () => {
    const info = brokenOf(
      okPage(URL_A, 0, 0, {
        stylesheetsFailed: { desktop: 2 },
        stylesheetHosts: ["cdn.unreachable.example"],
      }),
    );
    expect(info).toMatchObject({ kind: "stylesheet" });
    expect(info?.reason).toMatch(/2 linked stylesheet\(s\) from "cdn\.unreachable\.example" did not load/);
    expect(info?.fix).toMatch(/"cdn\.unreachable\.example" is unreachable/);
  });

  it("gives the asset-prefix fix when the failed stylesheets have no host on record", () => {
    const info = brokenOf(okPage(URL_A, 0, 0, { stylesheetsFailed: { desktop: 1 } }));
    expect(info?.fix).toMatch(/asset prefix/);
  });

  it("is broken when a full scan finds no images where the survey found some, and only then", () => {
    const empty = okPage(URL_A, 0, 0, { counts: { images: 0, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} } });
    expect(brokenOf(empty, 4)).toMatchObject({ kind: "images" });
    expect(brokenOf(empty, 0)).toBeUndefined();
    expect(brokenOf(empty)).toBeUndefined();
    expect(brokenOf(okPage(URL_A, 10, 5), 4)).toBeUndefined();
  });
});

describe("withBroken", () => {
  it("returns the page unchanged when it is not broken", () => {
    const page = okPage(URL_A, 10, 5);
    expect(withBroken(page)).toBe(page);
  });

  it("gives a broken page its status, reason and fix, and removes its page numbers and groups", () => {
    const page = okPage(URL_A, 10, 5, { documentStatus: { desktop: 404 } });
    const kept = withBroken(page);
    expect(kept.status).toBe("broken");
    expect(kept.error).toMatch(/HTTP 404/);
    expect(kept.broken?.kind).toBe("document");
    expect(kept).not.toHaveProperty("page");
    expect(kept.groups).toEqual([]);
    // The image records and counts stay, for a reader who wants to see what was measured.
    expect(kept.counts.images).toBe(3);
  });
});

describe("surveyStop: the fail-fast rule of run", () => {
  const ok = (n: number) => Array.from({ length: n }, (_, i) => okPage(`https://shop.example/p/${i}`, 10, 5));
  const broken = (n: number) =>
    Array.from({ length: n }, (_, i) => withBroken(okPage(`https://shop.example/b/${i}`, 0, 0, { stylesheetsFailed: { desktop: 1 }, stylesheetHosts: ["cdn.x.example"] })));

  it("does not stop when half or fewer of the survey pages are broken", () => {
    expect(surveyStop([...ok(2), ...broken(2)]).stop).toBe(false);
  });

  it("stops when more than half are broken, naming the count, the most common reason and its fix", () => {
    const result = surveyStop([...ok(2), ...broken(3)]);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe('3 of 5 survey pages are broken; most: 1 linked stylesheet(s) from "cdn.x.example" did not load: the page is not styled as the app is');
    expect(result.fix).toMatch(/"cdn\.x\.example"/);
  });

  it("stops when no survey page was measured at all", () => {
    const result = surveyStop([otherPage("https://shop.example/a", "blocked"), otherPage("https://shop.example/b", "failed")]);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe("no survey page was measured (1 blocked, 1 failed)");
  });

  it("uses the broken exit code 4 for the CLI", () => {
    expect(BROKEN_EXIT).toBe(4);
  });
});
