// How a page's viewports are grouped and ordered into loads (src/loads.ts): the default two loads per page, the
// ascending order that keeps the browser's srcset choice equal to a fresh load's, and --fresh-loads.
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWPORTS } from "../src/config.js";
import { parseScanArgs, recordOptionsOf, sameRecordOptions } from "../src/remote.js";
import { loadGroups } from "../src/loads.js";
import type { Viewport } from "../src/types.js";

const names = (groups: Viewport[][]): string[][] => groups.map((group) => group.map((v) => v.name));

describe("loadGroups", () => {
  it("loads each viewport on its own with --fresh-loads, in the order given", () => {
    expect(names(loadGroups(DEFAULT_VIEWPORTS, true))).toEqual(DEFAULT_VIEWPORTS.map((v) => [v.name]));
  });

  it("makes two loads per page by default: the mobile class and the desktop class", () => {
    expect(names(loadGroups(DEFAULT_VIEWPORTS, false))).toEqual([
      ["iphone-se", "pixel-7", "iphone-15", "iphone-15-pro-max"],
      ["desktop-1280", "desktop"],
    ]);
  });

  it("orders each class by effective pixel width (CSS width x DPR), smallest first", () => {
    const group = loadGroups(DEFAULT_VIEWPORTS, false)[0];
    const widths = group.map((v) => v.width * v.dpr);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    // pixel-7 (412 x 2.625 = 1081.5) comes before iphone-15 (390 x 3 = 1170), though its CSS width is larger.
    expect(group.map((v) => v.name)).toEqual(["iphone-se", "pixel-7", "iphone-15", "iphone-15-pro-max"]);
  });

  it("keeps the order of the groups by their first viewport", () => {
    const desktop = DEFAULT_VIEWPORTS.filter((v) => !v.mobile);
    const mobile = DEFAULT_VIEWPORTS.filter((v) => v.mobile);
    expect(names(loadGroups([...desktop, ...mobile], false))).toEqual([
      ["desktop-1280", "desktop"],
      ["iphone-se", "pixel-7", "iphone-15", "iphone-15-pro-max"],
    ]);
  });

  it("puts a viewport with a different user agent class in a load of its own", () => {
    const plain: Viewport = { name: "plain", width: 400, height: 800, dpr: 2, mobile: true };
    const ua: Viewport = { name: "ua", width: 390, height: 844, dpr: 3, mobile: true, userAgent: "x" };
    expect(names(loadGroups([ua, plain], false))).toEqual([["ua"], ["plain"]]);
  });

  it("reads each viewport exactly once", () => {
    const flat = loadGroups(DEFAULT_VIEWPORTS, false).flat().map((v) => v.name).sort();
    expect(flat).toEqual(DEFAULT_VIEWPORTS.map((v) => v.name).sort());
  });
});

describe("the recorded load mode", () => {
  const base = { aggressive: false, quality: true, viewports: [DEFAULT_VIEWPORTS[4]], ignoreRobots: false, storageState: undefined, gpu: undefined };

  it("records the shared loads of a default scan, and nothing for --fresh-loads (so scans from before still match it)", () => {
    expect(recordOptionsOf(base).loads).toBe("shared");
    expect(recordOptionsOf({ ...base, freshLoads: false }).loads).toBe("shared");
    expect(recordOptionsOf({ ...base, freshLoads: true })).not.toHaveProperty("loads");
  });

  it("never resumes a page loaded the other way: a scan from before the option is fresh", () => {
    const before = recordOptionsOf({ ...base, freshLoads: true });
    const shared = recordOptionsOf(base);
    expect(sameRecordOptions(before, recordOptionsOf({ ...base, freshLoads: true }))).toBe(true);
    expect(sameRecordOptions(before, shared)).toBe(false);
    expect(sameRecordOptions(shared, recordOptionsOf(base))).toBe(true);
  });

  it("is parsed from --fresh-loads", () => {
    expect(parseScanArgs(["https://a.example/"]).freshLoads).toBeUndefined();
    expect(parseScanArgs(["https://a.example/", "--fresh-loads"]).freshLoads).toBe(true);
  });
});
