import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLocate,
  cleanRecord,
  devImagesOf,
  isFlagged,
  joinLocate,
  joinUrl,
  readMeasuredScan,
  reasonCounts,
  type DevImage,
} from "../src/locate-join.js";
import { judgeChoice } from "../src/sizes-recheck.js";
import { parseLocateArgs, defaultLocateOut } from "../src/locate-only.js";
import { parseSizesArgs } from "../src/sizes-recheck.js";
import { locateNoteOf, type Hint } from "../src/hints.js";
import type { ImageRecord } from "../src/images.js";
import type { PageResult, ViewportObservation } from "../src/remote.js";

const PAGE = "https://shop.example/list.html";

/** A measured record at one viewport, flagged by default (a saving). */
function measured(id: string, overrides: { url?: string; alt?: string; domIndex?: number; saved?: number; viewport?: string; file?: string } = {}): ImageRecord {
  const pattern = overrides.url ?? "/img/p1-1280.jpg";
  const perViewport: Record<string, unknown>[] = [
    {
      viewport: overrides.viewport ?? "iphone-15",
      dpr: 3,
      renderedCssPx: 200,
      neededPx: 600,
      servedBytes: 200_000,
      undersized: false,
      loaded: true,
      ...(overrides.domIndex === undefined ? {} : { domIndex: overrides.domIndex }),
    },
  ];
  return {
    id,
    page: PAGE,
    locator: {
      component: [],
      selector: "img",
      classes: "",
      loader: "plain-img",
      urlPattern: `https://shop.example${pattern}`,
      alt: overrides.alt ?? "P1",
      ...(overrides.file ? { file: overrides.file, line: 12, kind: "image", verified: true } : {}),
    },
    tunable: { width: true, quality: true },
    current: { src: `https://shop.example${pattern}`, srcsetCandidates: [], format: "jpeg" },
    perViewport,
    fix: { sizes: { value: "200px", basis: "layout-formula", rung: "measured-page", branches: [] }, bytes: { saved: overrides.saved ?? 40_000, addedForSharpness: 0 } },
    evidence: { rung: "measured-page", notes: ["sizes: layout-formula"] },
  } as unknown as ImageRecord;
}

function dev(index: number, opts: { pattern?: string; alt?: string; file?: string; line?: number } = {}): DevImage {
  return {
    index,
    pattern: opts.pattern ?? "/img/p1-1280.jpg",
    alt: opts.alt ?? "P1",
    renderedCssPx: 200,
    currentSrc: `https://shop.example${opts.pattern ?? "/img/p1-1280.jpg"}`,
    srcset: "",
    component: opts.file ? ["ProductCard"] : [],
    file: opts.file,
    line: opts.line,
    kind: opts.file ? "image" : undefined,
  };
}

const always = () => true;

describe("joinUrl and the record's join key", () => {
  it("takes the page's own origin out, so a built and a dev server give the same pattern", () => {
    expect(joinUrl("http://localhost:3310/_next/image?url=x", "http://localhost:3310/a")).toBe("/_next/image?url=x");
    expect(joinUrl("https://cdn.example/a.jpg", "http://localhost:3310/a")).toBe("https://cdn.example/a.jpg");
  });
});

describe("joinLocate", () => {
  it("joins elements of one URL and alt in document order, not in record order", () => {
    // Records are listed in the order the scan first met them, which need not be the document order.
    const records = [measured("r-second", { domIndex: 7 }), measured("r-first", { domIndex: 3 })];
    const join = joinLocate(records, "iphone-15", [dev(3, { file: "src/A.tsx", line: 4 }), dev(7, { file: "src/B.tsx", line: 9 })], always);
    expect(join.pairs.get(records[1])?.dev.index).toBe(3);
    expect(join.pairs.get(records[0])?.dev.index).toBe(7);
    expect(join.pairs.get(records[0])?.by).toBe("alt-order");
  });

  it("joins nothing when the counts differ for a URL and alt, and says why", () => {
    const records = [measured("a", { domIndex: 1 }), measured("b", { domIndex: 2 })];
    const join = joinLocate(records, "iphone-15", [dev(1)], always);
    expect(join.pairs.size).toBe(0);
    expect(join.reasons.get(records[0])?.code).toBe("count-differs");
    expect(join.devLeft).toHaveLength(1);
    expect(reasonCounts(join)).toEqual({ "count-differs": 2 });
  });

  it("joins a URL that is unique on both sides even when the alt text differs", () => {
    const records = [measured("a", { domIndex: 1, alt: "Old" })];
    const join = joinLocate(records, "iphone-15", [dev(4, { alt: "New", file: "src/C.tsx", line: 2 })], always);
    expect(join.pairs.get(records[0])?.by).toBe("url-unique");
  });

  it("does not join a URL that repeats on the dev side with a different alt", () => {
    const records = [measured("a", { domIndex: 1, alt: "Old" })];
    const join = joinLocate(records, "iphone-15", [dev(4, { alt: "New" }), dev(5, { alt: "Other" })], always);
    expect(join.pairs.size).toBe(0);
    expect(join.reasons.get(records[0])?.code).toBe("alt-differs");
  });

  it("reports a flagged image that is not on the dev page at the viewport, and an element with no order", () => {
    const records = [measured("gone", { domIndex: 1, url: "/img/other.jpg" }), measured("old", { domIndex: undefined })];
    const join = joinLocate(records, "iphone-15", [dev(1)], always);
    expect(join.reasons.get(records[0])?.code).toBe("no-dev-image");
    expect(join.noOrder).toBe(1);
  });

  it("only pairs flagged records, but counts every measured element in the groups", () => {
    const records = [measured("unflagged", { domIndex: 1, saved: 0 }), measured("flagged", { domIndex: 2 })];
    const join = joinLocate(records, "iphone-15", [dev(1), dev(2, { file: "src/D.tsx", line: 7 })], (r) => isFlagged(r));
    // Two measured and two on the dev page: the group pairs in order, so the flagged one (second) takes the second dev image.
    expect(join.pairs.has(records[0])).toBe(false);
    expect(join.pairs.get(records[1])?.dev.index).toBe(2);
  });
});

describe("applyLocate", () => {
  it("writes the dev source onto the joined record and leaves the measured bytes alone", () => {
    const records = [measured("a", { domIndex: 1, saved: 40_000 })];
    const join = joinLocate(records, "iphone-15", [dev(1, { file: "src/components/Card.tsx", line: 12 })], always);
    const [out] = applyLocate(records, join, "iphone-15");
    expect(out.locator.file).toBe("src/components/Card.tsx");
    expect(out.locator.line).toBe(12);
    expect(out.locator.verified).toBe(true);
    expect(out.locator.component).toEqual(["ProductCard"]);
    expect(out.fix.bytes.saved).toBe(40_000);
    expect(out.locate).toEqual({ viewport: "iphone-15", by: "alt-order", devIndex: 1 });
    expect(out.evidence.notes.join("\n")).toContain("source: src/components/Card.tsx:12");
  });

  it("leaves unjoined records as they were", () => {
    const records = [measured("a", { domIndex: 1, url: "/img/x.jpg" })];
    const join = joinLocate(records, "iphone-15", [], always);
    expect(applyLocate(records, join, "iphone-15")[0]).toBe(records[0]);
  });
});

describe("devImagesOf", () => {
  it("reads the URL pattern, alt and resolved source of each observed element", () => {
    const observation = {
      viewport: { name: "iphone-15", width: 390, height: 844, dpr: 3, mobile: true },
      images: [
        { index: 0, currentSrc: "http://127.0.0.1:3300/img/p1-1280.jpg", renderedWidth: 200, renderedHeight: 100, srcset: "", classes: "", nextImage: false, inFirstViewport: true, locator: { selector: "img", alt: "P1", owners: [] } },
      ],
      responses: new Map(),
      nextjs: false,
      blocked: false,
      blockedRequests: 0,
    } as unknown as ViewportObservation;
    const resolved = new Map([[observation.images[0], { file: "src/a.tsx", line: 3, component: ["Card"], check: "image" as const }]]);
    const [d] = devImagesOf(observation, "http://127.0.0.1:3300/list.html", resolved);
    expect(d).toMatchObject({ index: 0, pattern: "/img/p1-1280.jpg", alt: "P1", file: "src/a.tsx", line: 3, kind: "image" });
  });
});

describe("cleanRecord and readMeasuredScan (the scan file is untrusted)", () => {
  it("keeps a project path and drops a source that is not one", () => {
    const good = cleanRecord({ ...measured("a", { domIndex: 1 }), locator: { ...measured("a").locator, file: "src/a.tsx", line: 3 } });
    expect(good?.locator.file).toBe("src/a.tsx");
    const bad = cleanRecord({ ...measured("a", { domIndex: 1 }), locator: { ...measured("a").locator, file: "../../etc/x.tsx", line: 3 } });
    expect(bad?.locator.file).toBeUndefined();
    expect(bad?.locator.line).toBeUndefined();
  });

  it("drops a record with a bad id, and keeps the element order only when it is an integer", () => {
    expect(cleanRecord({ ...measured("a"), id: "../x" })).toBeUndefined();
    const record = cleanRecord({ ...measured("a"), perViewport: [{ viewport: "iphone-15", renderedCssPx: 1, servedBytes: 1, domIndex: 2.5 }] });
    expect(record?.perViewport[0].domIndex).toBeUndefined();
  });

  it("refuses a file that is not a finished page scan, and drops the records that are not usable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imgtune-locate-"));
    const base = { url: PAGE, host: "shop.example", status: "ok", viewports: ["iphone-15"], images: [measured("a", { domIndex: 1 }), { id: "bad" }] };
    await writeFile(join(dir, "ok.json"), JSON.stringify(base));
    const { page, dropped } = await readMeasuredScan("ok.json", dir);
    expect(page.images).toHaveLength(1);
    expect(dropped).toBe(1);
    await writeFile(join(dir, "failed.json"), JSON.stringify({ ...base, status: "blocked" }));
    await expect(readMeasuredScan("failed.json", dir)).rejects.toThrow(/status blocked/);
    await writeFile(join(dir, "scheme.json"), JSON.stringify({ ...base, url: "file:///etc/passwd" }));
    await expect(readMeasuredScan("scheme.json", dir)).rejects.toThrow(/not an http or https URL/);
    await writeFile(join(dir, "none.json"), JSON.stringify({ url: PAGE }));
    await expect(readMeasuredScan("none.json", dir)).rejects.toThrow(/no image records/);
  });
});

describe("judgeChoice", () => {
  const base = {
    dpr: 3,
    viewportWidth: 390,
    rendered: 200,
    srcset: "http://127.0.0.1:3300/img/p1-320.jpg 320w, http://127.0.0.1:3300/img/p1-640.jpg 640w, http://127.0.0.1:3300/img/p1-1280.jpg 1280w",
    pageUrl: "http://127.0.0.1:3300/list.html",
    proposed: "200px",
  };

  it("passes the candidate the hint's sizes choose", () => {
    const v = judgeChoice({ ...base, sizes: "200px", chosenUrl: "http://127.0.0.1:3300/img/p1-640.jpg", chosenBytes: 40_000 });
    expect(v.chosenWidth).toBe(640);
    expect(v.targetWidth).toBe(640);
    expect(v.fails).toEqual([]);
  });

  it("fails a choice bigger than the hint needs", () => {
    const v = judgeChoice({ ...base, sizes: "1280px", chosenUrl: "http://127.0.0.1:3300/img/p1-1280.jpg", chosenBytes: 160_000, before: { servedBytes: 160_000, undersized: false } });
    expect(v.fails.join(" ")).toMatch(/bigger than the hint needs: 1280w, the hint's sizes choose 640w/);
  });

  it("fails an undersized choice", () => {
    const v = judgeChoice({ ...base, sizes: "50px", chosenUrl: "http://127.0.0.1:3300/img/p1-320.jpg", chosenBytes: 10_000 });
    expect(v.undersized).toBe(true);
    expect(v.fails.join(" ")).toMatch(/undersized/);
  });

  it("fails bytes that rose without a sharpness fix, and passes them when the image was undersized before", () => {
    const up = judgeChoice({ ...base, sizes: "200px", chosenUrl: "http://127.0.0.1:3300/img/p1-640.jpg", chosenBytes: 90_000, before: { servedBytes: 50_000, undersized: false } });
    expect(up.fails.join(" ")).toMatch(/bytes rose 49 KB -> 88 KB/);
    const fixed = judgeChoice({ ...base, sizes: "200px", chosenUrl: "http://127.0.0.1:3300/img/p1-640.jpg", chosenBytes: 90_000, before: { servedBytes: 50_000, undersized: true } });
    expect(fixed.fails).toEqual([]);
  });

  it("has no verdict for a plain image or a file that is not a candidate", () => {
    expect(judgeChoice({ ...base, srcset: "", sizes: "200px", chosenUrl: "http://127.0.0.1:3300/img/p.jpg" }).note).toMatch(/no srcset/);
    expect(judgeChoice({ ...base, sizes: "200px", chosenUrl: "http://127.0.0.1:3300/img/other.jpg" }).note).toMatch(/not one of the srcset/);
  });
});

describe("argument parsing", () => {
  it("reads the locate arguments and refuses the wrong ones", () => {
    expect(parseLocateArgs(["http://localhost:3300/a.html", "--locate-only", "--from", "m.json"])).toEqual({
      url: "http://localhost:3300/a.html",
      from: "m.json",
      viewport: undefined,
      out: undefined,
      ignoreRobots: false,
    });
    expect(() => parseLocateArgs(["--locate-only", "--from", "m.json"])).toThrow(/usage: imgtune scan <dev-url>/);
    expect(() => parseLocateArgs(["http://localhost/a", "--locate-only"])).toThrow(/needs --from/);
    expect(() => parseLocateArgs(["http://localhost/a", "--from", "m.json", "--viewports", "iphone-15,pixel-7"])).toThrow(/one viewport name/);
    expect(() => parseLocateArgs(["file:///a", "--from", "m.json"])).toThrow(/not an http or https URL/);
    expect(() => parseLocateArgs(["http://localhost/a", "--from", "m.json", "--out", "x"])).toThrow(/not an option of --locate-only/);
    expect(defaultLocateOut("out/scan.json")).toBe("out/scan.located.json");
  });

  it("reads the sizes-only arguments", () => {
    expect(parseSizesArgs(["--recheck", "s.json", "--sizes-only", "--ids", "ab1,cd2", "--url", "http://localhost:3300/a"])).toEqual({
      file: "s.json",
      ids: ["ab1", "cd2"],
      url: "http://localhost:3300/a",
      ignoreRobots: false,
    });
    expect(() => parseSizesArgs(["--recheck", "s.json", "--sizes-only", "--ids", "../x"])).toThrow(/not an image id/);
    expect(() => parseSizesArgs(["--recheck", "s.json", "--sizes-only", "--gpu"])).toThrow(/not an option of --sizes-only/);
  });
});

describe("the hints note", () => {
  it("says where the sources came from, and asks for a locate when hinted images have none", () => {
    const result = { url: PAGE, images: [] } as unknown as PageResult;
    const hint = { file: undefined } as unknown as Hint;
    expect(locateNoteOf(result, [hint, hint])).toMatch(/2 of 2 image\(s\) have no file:line/);
    const located = { ...result, locate: { url: "http://localhost:3300/list.html", viewport: "iphone-15", joined: 3, flagged: 4 } } as unknown as PageResult;
    expect(locateNoteOf(located, [])).toMatch(/located on the dev page at iphone-15: 3 of 4/);
    expect(locateNoteOf(result, [{ file: "a.tsx" } as unknown as Hint])).toBeUndefined();
  });
});
