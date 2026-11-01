// Worst-page selection for run: the exact KB per view, the route patterns, and the deep set. No browser.
import { describe, expect, it } from "vitest";
import { candidatesOf, patternRanking, selectDeep, type Candidate } from "../src/worst.js";
import { okPage, otherPage } from "./page-fixtures.js";

const cand = (url: string, pattern: string, exactKB: number): Candidate => ({ url, pattern, exactKB, kbPerView: exactKB * 5 });

describe("candidatesOf", () => {
  it("ranks measured pages only, by exact KB per view (image bytes times the exact share)", () => {
    const results = [
      okPage("https://shop.example/p/a-1", 200, 25),
      otherPage("https://shop.example/p/b-2", "blocked"),
      okPage("https://shop.example/c/x", 80, 10),
    ];
    const list = candidatesOf(results);
    expect(list.map((c) => c.url)).toEqual(["https://shop.example/p/a-1", "https://shop.example/c/x"]);
    expect(list[0].exactKB).toBeCloseTo(50, 5);
    expect(list[0].pattern).toBe("/p/*");
    expect(list[1].exactKB).toBeCloseTo(8, 5);
  });
});

describe("patternRanking", () => {
  it("ranks patterns by the mean exact KB per page, so a larger pattern is not worse for its size", () => {
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
});

describe("selectDeep", () => {
  const list: Candidate[] = [
    cand("https://s.example/p/hot-1", "/p/*", 90),
    cand("https://s.example/p/mid-2", "/p/*", 40),
    cand("https://s.example/c/a", "/c/*", 20),
    cand("https://s.example/c/b", "/c/*", 15),
    cand("https://s.example/x/y", "/x/*", 5),
  ];

  it("takes the worst page of each worst pattern before a second page of any pattern", () => {
    // Two patterns covered with two pages: /p/* (mean 65) and /c/* (mean 17.5), and not the second /p/* page.
    expect(selectDeep(list, 2)).toEqual(["https://s.example/p/hot-1", "https://s.example/c/a"]);
  });

  it("fills the rest with the worst pages overall, worst first", () => {
    // After one page per pattern (hot-1, c/a, x/y), the next worst page overall is mid-2 (40 KB), not c/b (15 KB).
    expect(selectDeep(list, 4)).toEqual([
      "https://s.example/p/hot-1",
      "https://s.example/p/mid-2",
      "https://s.example/c/a",
      "https://s.example/x/y",
    ]);
  });

  it("covers the worst patterns with one page each when the count is smaller than the pattern count", () => {
    expect(selectDeep(list, 1)).toEqual(["https://s.example/p/hot-1"]);
    expect(selectDeep(list, 3)).toEqual(["https://s.example/p/hot-1", "https://s.example/c/a", "https://s.example/x/y"]);
  });

  it("returns every page when there are fewer than the count, and nothing for a count below one", () => {
    expect(selectDeep(list, 50)).toHaveLength(5);
    expect(selectDeep(list, 0)).toEqual([]);
    expect(selectDeep([], 5)).toEqual([]);
  });

  it("is the same on every call: ties are broken by URL", () => {
    const tied = [cand("https://s.example/p/b", "/p/*", 10), cand("https://s.example/p/a", "/p/*", 10)];
    expect(selectDeep(tied, 1)).toEqual(["https://s.example/p/a"]);
  });
});
