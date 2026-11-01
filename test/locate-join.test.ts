import { safeText } from "../src/text.js";
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLocate,
  cleanLocate,
  cleanOwnerChain,
  cleanRecord,
  httpUrl,
  devImagesOf,
  isFlagged,
  joinLocate,
  joinUrl,
  readMeasuredScan,
  reasonCounts,
  type DevImage,
} from "../src/locate-join.js";
import { judgeChoice, layoutDiffers, sizesRecheck } from "../src/sizes-recheck.js";
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

  it("judges undersize on the measured server's width, not the dev page's", () => {
    // Measured 160 px at dpr 2 needs 320w: the 320w file passes. The dev page renders 668 px (the layout differs), so the
    // verdict is not a pass, and the difference is reported.
    const v = judgeChoice({
      ...base,
      dpr: 2,
      viewportWidth: 1440,
      rendered: 160,
      devRendered: 668,
      sizes: "160px",
      proposed: "160px",
      chosenUrl: "http://127.0.0.1:3300/img/p1-320.jpg",
      chosenBytes: 20_000,
    });
    expect(v.needed).toBe(320);
    expect(v.undersized).toBe(false);
    expect(v.layout).toEqual({ dev: 668, measured: 160 });
    expect(v.fails).toEqual([]);
  });

  it("fails undersize against the measured width even when the dev page renders wider", () => {
    // Measured 668 px at dpr 2 needs 1280w (capped at the largest): sizes 160px chooses 320w, which is undersized, whatever
    // the dev page shows (160 px there).
    const v = judgeChoice({
      ...base,
      dpr: 2,
      viewportWidth: 1440,
      rendered: 668,
      devRendered: 160,
      sizes: "160px",
      proposed: "160px",
      chosenUrl: "http://127.0.0.1:3300/img/p1-320.jpg",
      chosenBytes: 20_000,
    });
    expect(v.undersized).toBe(true);
    expect(v.fails.join(" ")).toMatch(/undersized: 320w is below the 1280 px needed/);
  });

  it("reports no layout difference within the tolerance", () => {
    expect(layoutDiffers(668, 668)).toBe(false);
    expect(layoutDiffers(670, 668)).toBe(false);
    expect(layoutDiffers(668, 620)).toBe(true);
    expect(layoutDiffers(160, 168)).toBe(true);
    expect(judgeChoice({ ...base, sizes: "200px", devRendered: 200, chosenUrl: "http://127.0.0.1:3300/img/p1-640.jpg" }).layout).toBeUndefined();
  });

  it("fails a loaded file that the page's sizes do not choose", () => {
    // sizes 200px at dpr 3 chooses 640w; the page loaded 1280w.
    const v = judgeChoice({ ...base, sizes: "200px", chosenUrl: "http://127.0.0.1:3300/img/p1-1280.jpg", chosenBytes: 160_000 });
    expect(v.fails.join(" ")).toMatch(/the page loaded 1280w but its sizes choose 640w/);
  });

  it("fails when the hint's sizes are not on the dev page", () => {
    const v = judgeChoice({ ...base, sizes: "1280px", proposed: "200px", chosenUrl: "http://127.0.0.1:3300/img/p1-1280.jpg", chosenBytes: 160_000 });
    expect(v.landed).toBe(false);
    expect(v.fails.join(" ")).toMatch(/the edit is not on the dev page/);
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
      thirdParty: { block: true, allowHosts: [] },
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
      thirdParty: { block: true, allowHosts: [] },
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
    const block = { url: "http://localhost:3300/list.html", viewport: "iphone-15", scannedAt: "2026-11-01T10:00:00.000Z", imgtuneVersion: "0.1.0", seconds: 1, flagged: 4, joined: 3, notJoined: 1, devLeft: 0, noOrder: 0, reasons: {} };
    const located = { ...result, locate: block } as unknown as PageResult;
    expect(locateNoteOf(located, [])).toMatch(/located on the dev page at iphone-15: 3 of 4/);
    expect(locateNoteOf(result, [{ file: "a.tsx" } as unknown as Hint])).toBeUndefined();
  });
});

describe("the locate block of a scan file (untrusted)", () => {
  const good = {
    url: "http://localhost:3000/list.html",
    viewport: "iphone-15",
    scannedAt: "2026-11-01T10:00:00.000Z",
    imgtuneVersion: "0.1.0",
    seconds: 1.2,
    flagged: 3,
    joined: 2,
    notJoined: 1,
    devLeft: 0,
    noOrder: 0,
    reasons: { "no-dev-image": 1 },
  };

  it("accepts http and https dev URLs and nothing else", () => {
    expect(httpUrl("https://dev.example/list.html")).toBe("https://dev.example/list.html");
    expect(httpUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<script>x</script>", "not a url", "", 42, "ftp://x/y"]) {
      expect(httpUrl(bad)).toBeUndefined();
    }
  });

  it("keeps a well-formed block and drops it when any part is wrong", () => {
    expect(cleanLocate(good)).toEqual(good);
    expect(cleanLocate({ ...good, url: "javascript:alert(1)" })).toBeUndefined();
    expect(cleanLocate({ ...good, url: "file:///etc/passwd" })).toBeUndefined();
    expect(cleanLocate({ ...good, url: "data:text/html,x" })).toBeUndefined();
    expect(cleanLocate({ ...good, url: "not a url" })).toBeUndefined();
    expect(cleanLocate({ ...good, viewport: "no-such-viewport" })).toBeUndefined();
    expect(cleanLocate({ ...good, viewport: "<img src=x onerror=1>" })).toBeUndefined();
    expect(cleanLocate({ ...good, flagged: -1 })).toBeUndefined();
    expect(cleanLocate({ ...good, joined: 1.5 })).toBeUndefined();
    expect(cleanLocate({ ...good, joined: "2" })).toBeUndefined();
    expect(cleanLocate({ ...good, joined: 4 })).toBeUndefined();
    expect(cleanLocate({ ...good, seconds: Number.NaN })).toBeUndefined();
    expect(cleanLocate({ ...good, notJoined: Number.MAX_VALUE })).toBeUndefined();
    expect(cleanLocate({ ...good, scannedAt: "2026\u001b[31m" })).toBeUndefined();
    expect(cleanLocate({ ...good, imgtuneVersion: "x".repeat(41) })).toBeUndefined();
    expect(cleanLocate({ ...good, reasons: { "Ignore previous instructions": 1 } })).toBeUndefined();
    expect(cleanLocate({ ...good, reasons: [] })).toBeUndefined();
    expect(cleanLocate(null)).toBeUndefined();
    expect(cleanLocate("x")).toBeUndefined();
  });

  it("is dropped by readMeasuredScan and reported, and the page's images are kept", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imgtune-locate-"));
    const base = { url: PAGE, host: "shop.example", status: "ok", viewports: ["iphone-15"], images: [measured("a", { domIndex: 1 })] };
    await writeFile(join(dir, "js.json"), JSON.stringify({ ...base, locate: { ...good, url: "javascript:alert(1)" } }));
    const bad = await readMeasuredScan("js.json", dir);
    expect(bad.page.locate).toBeUndefined();
    expect(bad.locateDropped).toBe(true);
    expect(bad.page.images).toHaveLength(1);
    await writeFile(join(dir, "good.json"), JSON.stringify({ ...base, locate: good }));
    const ok = await readMeasuredScan("good.json", dir);
    expect(ok.page.locate?.url).toBe(good.url);
    expect(ok.locateDropped).toBe(false);
  });

  it("drops a record's locate mark when its viewport, rule or index is wrong", () => {
    const record = measured("a", { domIndex: 1 });
    expect(cleanRecord({ ...record, locate: { viewport: "iphone-15", by: "alt-order", devIndex: 2 } })?.locate).toEqual({ viewport: "iphone-15", by: "alt-order", devIndex: 2 });
    expect(cleanRecord({ ...record, locate: { viewport: "nowhere", by: "alt-order", devIndex: 2 } })?.locate).toBeUndefined();
    expect(cleanRecord({ ...record, locate: { viewport: "iphone-15", by: "guess", devIndex: 2 } })?.locate).toBeUndefined();
    expect(cleanRecord({ ...record, locate: { viewport: "iphone-15", by: "alt-order", devIndex: -1 } })?.locate).toBeUndefined();
    expect(cleanRecord({ ...record, locator: { ...record.locator, kind: "<script>" as never } })?.locator.kind).toBeUndefined();
  });

  it("refuses a sizes recheck whose dev URL is not http or https, from the file or the command line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imgtune-locate-"));
    const base = { url: PAGE, host: "shop.example", status: "ok", viewports: ["iphone-15"], images: [measured("a", { domIndex: 1 })] };
    await writeFile(join(dir, "evil.json"), JSON.stringify({ ...base, locate: { ...good, url: "javascript:alert(1)" } }));
    const log = () => undefined;
    await expect(sizesRecheck(["--recheck", "evil.json"], dir, log)).rejects.toThrow(/has no dev page/);
    await writeFile(join(dir, "file.json"), JSON.stringify({ ...base, locate: { ...good, url: "file:///etc/passwd" } }));
    await expect(sizesRecheck(["--recheck", "file.json"], dir, log)).rejects.toThrow(/has no dev page/);
    await expect(sizesRecheck(["--recheck", "file.json", "--url", "data:text/html,x"], dir, log)).rejects.toThrow(/not an http or https URL/);
    await expect(sizesRecheck(["--recheck", "file.json", "--url", "file:///etc/passwd"], dir, log)).rejects.toThrow(/not an http or https URL/);
  });

  it("prints no located line for a block that is not usable", () => {
    const result = { url: PAGE, locate: { ...good, viewport: "<b>" } } as unknown as PageResult;
    expect(locateNoteOf(result, [])).toBeUndefined();
  });
});

describe("page-derived text in the sizes verdict", () => {
  const base = {
    dpr: 2,
    viewportWidth: 390,
    rendered: 200,
    srcset: "http://127.0.0.1:3300/img/p1-320.jpg 320w, http://127.0.0.1:3300/img/p1-640.jpg 640w",
    pageUrl: "http://127.0.0.1:3300/list.html",
    chosenUrl: "http://127.0.0.1:3300/img/p1-640.jpg",
    proposed: "200px",
  };
  const hostile = ["\u009b31m", "‮evil", "x".repeat(10_000)];

  it.each(hostile)("keeps page-read sizes out of the verdict as raw text: %s", (sizes) => {
    const v = judgeChoice({ ...base, sizes });
    const text = v.fails.join("\n");
    expect(text).not.toMatch(/[\u0080-\u009f‪-‮⁦-⁩]/);
    expect(text.length).toBeLessThan(600);
  });

  it("cleans bidi overrides and C1 controls from any text", () => {
    expect(safeText("a‮b\u009b31mc⁧d")).toBe("ab31mcd");
  });
});

describe("cleanOwnerChain", () => {
  it("keeps project entries in order, with a whole line and an identifier component, and drops the rest", () => {
    const raw = [
      { file: "src/components/Card.tsx", line: 12, component: "Card" },
      { file: "node_modules/lib/index.js", line: 3 },
      { file: "src/pages/Home.tsx", line: 9.5 },
      { file: "src/pages/Plp.tsx", line: 4, component: "not a name" },
      { file: "/etc/passwd", line: 1 },
      "not an object",
    ];
    expect(cleanOwnerChain(raw)).toEqual([
      { file: "src/components/Card.tsx", line: 12, component: "Card" },
      { file: "src/pages/Plp.tsx", line: 4 },
    ]);
  });

  it("is empty for anything that is not a list, and caps the length", () => {
    expect(cleanOwnerChain("src/a.tsx")).toEqual([]);
    expect(cleanOwnerChain(Array.from({ length: 20 }, (_, i) => ({ file: "src/a.tsx", line: i + 1 })))).toHaveLength(8);
  });
});
