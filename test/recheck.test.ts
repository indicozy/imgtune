import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { compareImage, pairRecord, parseRecheckArgs, recheckScan, usableRecords } from "../src/recheck.js";
import type { ImageRecord } from "../src/images.js";

/** A record with one viewport, for the comparison rules. */
function record(overrides: { renderedCssPx?: number; servedBytes?: number; undersized?: boolean; sizes?: string; saved?: number; src?: string } = {}): ImageRecord {
  return {
    id: "abc123",
    page: "https://shop.example/",
    locator: { component: ["Card"], selector: "img", classes: "", loader: "next-default" },
    tunable: { width: true, quality: true },
    current: { src: overrides.src ?? "/_next/image?url=a&w=640", srcsetCandidates: [], format: "avif" },
    perViewport: [
      {
        viewport: "iphone-15",
        dpr: 3,
        renderedCssPx: overrides.renderedCssPx ?? 342,
        neededPx: 1026,
        servedBytes: overrides.servedBytes ?? 100_000,
        undersized: overrides.undersized ?? false,
        loaded: true,
      },
    ],
    fix: {
      sizes: overrides.sizes !== undefined ? { value: overrides.sizes, basis: "layout-formula", rung: "measured-page", branches: [] } : undefined,
      bytes: { saved: overrides.saved ?? 20_000, addedForSharpness: 0 },
    },
    evidence: { rung: "measured-page", notes: [] },
  } as unknown as ImageRecord;
}

describe("parseRecheckArgs", () => {
  it("reads the scan file and the image ids", () => {
    expect(parseRecheckArgs(["--recheck", "scan.json", "--ids", "a1, b2,,"])).toEqual({ file: "scan.json", ids: ["a1", "b2"], ignoreRobots: false });
  });

  it("needs the scan file, and refuses other options", () => {
    expect(() => parseRecheckArgs(["--ids", "a1"])).toThrow(/usage: imgtune scan --recheck/);
    expect(() => parseRecheckArgs(["--recheck", "scan.json", "--out", "x"])).toThrow(/is not an option of --recheck/);
    expect(() => parseRecheckArgs(["--recheck", "scan.json", "--ids", ",,"])).toThrow(/at least one image id/);
  });
});

describe("compareImage", () => {
  it("passes an image whose served bytes fell and that stayed sharp", () => {
    const check = compareImage(record({ servedBytes: 200_000 }), record({ servedBytes: 120_000, sizes: "calc(100vw - 32px)" }), false);
    expect(check.failures).toEqual([]);
    expect(check.lines.join("\n")).toContain("served 195 KB -> 117 KB");
  });

  it("fails an image that became undersized", () => {
    const check = compareImage(record({ undersized: false }), record({ undersized: true }), false);
    expect(check.failures).toEqual(["iphone-15: became undersized"]);
  });

  it("fails bytes that rose without a sharpness fix, and passes them when the image was undersized and is now sharp", () => {
    expect(compareImage(record({ servedBytes: 100_000 }), record({ servedBytes: 150_000 }), false).failures).toHaveLength(1);
    expect(compareImage(record({ servedBytes: 100_000, undersized: true }), record({ servedBytes: 150_000, undersized: false }), false).failures).toEqual([]);
  });

  it("reuses the saving of an image whose src did not change, and says so", () => {
    const check = compareImage(record({ saved: 30_000 }), record({ saved: 0 }), true);
    expect(check.lines.join("\n")).toContain("saves 29 KB -> 29 KB (src unchanged: estimate reused)");
  });

  it("fails an image that is no longer on the page", () => {
    expect(compareImage(record(), undefined, false).failures).toEqual(["gone"]);
  });
});

describe("the scan file is untrusted", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-recheck-"));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("takes --ignore-robots from the command line only", () => {
    expect(parseRecheckArgs(["--recheck", "scan.json", "--ignore-robots"]).ignoreRobots).toBe(true);
    expect(parseRecheckArgs(["--recheck", "scan.json"]).ignoreRobots).toBe(false);
  });

  it("refuses a scan that says it ignored robots.txt, unless the flag is on the command line", async () => {
    const path = join(dir, "robots.json");
    await writeFile(path, JSON.stringify({ url: "https://shop.example/", robotsIgnored: true, images: [] }));
    await expect(recheckScan(["--recheck", path], dir, () => {})).rejects.toThrow("pass --ignore-robots to recheck it too");
  });

  it("refuses a page URL that is not http or https, before any request", async () => {
    const path = join(dir, "ftp.json");
    await writeFile(path, JSON.stringify({ url: "file:///etc/passwd", images: [] }));
    await expect(recheckScan(["--recheck", path], dir, () => {})).rejects.toThrow("not http or https");
    const bad = join(dir, "bad-url.json");
    await writeFile(bad, JSON.stringify({ url: "not a url", images: [] }));
    await expect(recheckScan(["--recheck", bad], dir, () => {})).rejects.toThrow("not a URL");
  });

  it("refuses ids that are not of the expected form on the command line", async () => {
    const path = join(dir, "ids.json");
    await writeFile(path, JSON.stringify({ url: "https://shop.example/", images: [] }));
    await expect(recheckScan(["--recheck", path, "--ids", "a;rm"], dir, () => {})).rejects.toThrow("not an image id");
  });

  it("skips records with an id of the wrong form or a malformed record, with a warning", () => {
    const warnings: string[] = [];
    const good = record();
    const bad = { ...record(), id: "../../etc" };
    const usable = usableRecords([good, bad, { id: "abc", page: 3 }, null], (m) => warnings.push(m));
    expect(usable.map((r) => r.id)).toEqual(["abc123"]);
    expect(warnings).toHaveLength(3);
  });

  it("prints a viewport name from the file only when it is a known one, with control characters removed", () => {
    const before = record();
    const hostile = { ...before, perViewport: [{ ...before.perViewport[0], viewport: "\u001b[2Jevil" }] } as ImageRecord;
    const check = compareImage(hostile, hostile, false);
    expect(check.lines.join("\n")).not.toContain("\u001b");
    expect(check.lines.join("\n")).not.toContain("evil");
    expect(check.failures).toEqual([]);
  });

  it("removes control characters from the page and component names it prints", () => {
    const hostile = { ...record(), page: "https://shop.example/\u001b[31m", locator: { component: ["Card\u0007"], selector: "img", classes: "", loader: "x" } } as unknown as ImageRecord;
    for (const line of compareImage(hostile, hostile, false).lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

/** A record with a source file, a line and a URL pattern, for the pairing rules. */
function located(id: string, file: string, line: number, pattern = "https://cdn.example/a.jpg"): ImageRecord {
  const base = record();
  return {
    ...base,
    id,
    locator: { ...base.locator, component: ["Card"], file, line, urlPattern: pattern },
  } as ImageRecord;
}

describe("pairRecord (an earlier image in a rescan)", () => {
  const card = "app/src/Card.tsx";

  it("pairs by id when the id is the same", () => {
    const before = located("aaa", card, 217);
    const now = new Map([["aaa", located("aaa", card, 217)]]);
    expect(pairRecord(before, now, [...now.values()])).toMatchObject({ by: "id" });
  });

  it("pairs by source file and URL pattern when an edit moved the element and its id changed", () => {
    // The scan had the element at line 217; an edit added a line above it, so it is at 218 and its id is new.
    const before = located("aaa", card, 217);
    const fresh = [located("bbb", card, 218)];
    const pairing = pairRecord(before, new Map(fresh.map((r) => [r.id, r])), fresh);
    expect(pairing).toMatchObject({ by: "source", ambiguous: 0 });
    expect(pairing.after?.id).toBe("bbb");
  });

  it("ignores the width and quality parameters: the pattern is the URL without them", () => {
    // A sizes change picks another w= candidate; the pattern (no w or q) is the same, so the element is still found.
    const before = located("aaa", card, 217, "/_next/image?url=p.jpg");
    const fresh = [located("bbb", card, 217, "/_next/image?url=p.jpg")];
    expect(pairRecord(before, new Map(fresh.map((r) => [r.id, r])), fresh).by).toBe("source");
  });

  it("does not pair across a different file, or a different image", () => {
    const before = located("aaa", card, 217, "https://cdn.example/a.jpg");
    const fresh = [located("bbb", "app/src/Other.tsx", 217), located("ccc", card, 217, "https://cdn.example/b.jpg")];
    expect(pairRecord(before, new Map(fresh.map((r) => [r.id, r])), fresh)).toEqual({ ambiguous: 0 });
  });

  it("takes the candidate on the same line when several match, and refuses when that is not unique", () => {
    const before = located("aaa", card, 217);
    const fresh = [located("bbb", card, 217), located("ccc", card, 230)];
    expect(pairRecord(before, new Map(fresh.map((r) => [r.id, r])), fresh)).toMatchObject({ by: "source" });
    expect(pairRecord(before, new Map(), [located("x", card, 230), located("y", card, 240)])).toEqual({ ambiguous: 2 });
  });
});

describe("compareImage: gone and the predicted-versus-measured line", () => {
  it("says what was looked for and asks for a pristine rescan before calling it gone", () => {
    const check = compareImage(located("aaa", "app/src/Card.tsx", 217), undefined, false, { ambiguous: 0 });
    expect(check.failures).toEqual(["gone"]);
    expect(check.lines.join("\n")).toContain("looked for source app/src/Card.tsx");
    expect(check.lines.join("\n")).toContain("rescan the page unchanged (pristine) and recheck it again");
  });

});
