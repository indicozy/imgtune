// Survey ranking (worst.ts): the exact KB per view, and the route types by mean exact KB. No browser.
import { describe, expect, it } from "vitest";
import { candidatesOf, patternRanking, type Candidate } from "../src/worst.js";
import { okPage, otherPage } from "./page-fixtures.js";

const cand = (url: string, pattern: string, exactKB: number): Candidate => ({ url, pattern, exactKB, kbPerView: exactKB * 5 });
const byPath = (url: string) => (url.includes("/p/") ? "/p/*" : "/c/*");

describe("candidatesOf", () => {
  it("ranks measured pages only, by exact KB per view (image bytes times the exact share), typed by the grouping", () => {
    const results = [
      okPage("https://shop.example/p/a-1", 200, 25),
      otherPage("https://shop.example/p/b-2", "blocked"),
      okPage("https://shop.example/c/x", 80, 10),
    ];
    const list = candidatesOf(results, byPath);
    expect(list.map((c) => c.url)).toEqual(["https://shop.example/p/a-1", "https://shop.example/c/x"]);
    expect(list[0].exactKB).toBeCloseTo(50, 5);
    expect(list[0].pattern).toBe("/p/*");
    expect(list[1].exactKB).toBeCloseTo(8, 5);
  });
});

describe("patternRanking", () => {
  it("ranks route types by the mean exact KB per page, so a larger type is not worse for its size", () => {
    const ranks = patternRanking([
      cand("https://s.example/p/1", "/p/*", 10),
      cand("https://s.example/p/2", "/p/*", 30),
      cand("https://s.example/c/1", "/c/*", 25),
    ]);
    expect(ranks.map((r) => r.pattern)).toEqual(["/c/*", "/p/*"]);
    expect(ranks[1].meanExactKB).toBe(20);
    expect(ranks[1].worst.url).toBe("https://s.example/p/2");
    expect(ranks[1].pages).toBe(2);
  });

  it("breaks a tie on the mean by the image KB, then by the type name", () => {
    const tied = [
      { ...cand("https://s.example/a/1", "/a", 10), kbPerView: 50 },
      { ...cand("https://s.example/b/1", "/b", 10), kbPerView: 80 },
    ];
    expect(patternRanking(tied).map((r) => r.pattern)).toEqual(["/b", "/a"]);
  });
});
