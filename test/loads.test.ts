// How a page's viewports are grouped and ordered into loads (src/loads.ts): a fresh load per viewport by default, and with
// --shared-loads the two loads per page, in the ascending order that keeps the browser's srcset choice equal to a fresh load's.
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWPORTS } from "../src/config.js";
import { parseScanArgs, recordOptionsOf, sameRecordOptions } from "../src/remote.js";
import { loadGroups } from "../src/loads.js";
import type { Viewport } from "../src/types.js";

const names = (groups: Viewport[][]): string[][] => groups.map((group) => group.map((v) => v.name));

describe("loadGroups", () => {
  it("loads each viewport on its own by default, in the order given", () => {
    expect(names(loadGroups(DEFAULT_VIEWPORTS, false))).toEqual(DEFAULT_VIEWPORTS.map((v) => [v.name]));
  });

  it("with --shared-loads, makes two loads per page: the mobile class and the desktop class", () => {
    expect(names(loadGroups(DEFAULT_VIEWPORTS, true))).toEqual([
      ["iphone-se", "pixel-7", "iphone-15", "iphone-15-pro-max"],
      ["desktop-1280", "desktop"],
    ]);
  });

  it("orders each class by effective pixel width (CSS width x DPR), smallest first", () => {
    const group = loadGroups(DEFAULT_VIEWPORTS, true)[0];
    const widths = group.map((v) => v.width * v.dpr);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    // pixel-7 (412 x 2.625 = 1081.5) comes before iphone-15 (390 x 3 = 1170), though its CSS width is larger.
    expect(group.map((v) => v.name)).toEqual(["iphone-se", "pixel-7", "iphone-15", "iphone-15-pro-max"]);
  });

  it("keeps the order of the groups by their first viewport", () => {
    const desktop = DEFAULT_VIEWPORTS.filter((v) => !v.mobile);
    const mobile = DEFAULT_VIEWPORTS.filter((v) => v.mobile);
    expect(names(loadGroups([...desktop, ...mobile], true))).toEqual([
      ["desktop-1280", "desktop"],
      ["iphone-se", "pixel-7", "iphone-15", "iphone-15-pro-max"],
    ]);
  });

  it("puts a viewport with a different user agent class in a load of its own", () => {
    const plain: Viewport = { name: "plain", width: 400, height: 800, dpr: 2, mobile: true };
    const ua: Viewport = { name: "ua", width: 390, height: 844, dpr: 3, mobile: true, userAgent: "x" };
    expect(names(loadGroups([ua, plain], true))).toEqual([["ua"], ["plain"]]);
  });

  it("reads each viewport exactly once", () => {
    const flat = loadGroups(DEFAULT_VIEWPORTS, true).flat().map((v) => v.name).sort();
    expect(flat).toEqual(DEFAULT_VIEWPORTS.map((v) => v.name).sort());
  });
});

describe("the recorded load mode", () => {
  const base = { aggressive: false, quality: true, viewports: [DEFAULT_VIEWPORTS[4]], ignoreRobots: false, storageState: undefined, gpu: undefined };

  it("records nothing for a default (fresh) scan, and the shared loads of --shared-loads", () => {
    expect(recordOptionsOf(base)).not.toHaveProperty("loads");
    expect(recordOptionsOf({ ...base, sharedLoads: false })).not.toHaveProperty("loads");
    expect(recordOptionsOf({ ...base, sharedLoads: true }).loads).toBe("shared");
  });

  it("never resumes a page loaded the other way: a scan from before the option is fresh", () => {
    const fresh = recordOptionsOf(base);
    const shared = recordOptionsOf({ ...base, sharedLoads: true });
    expect(sameRecordOptions(fresh, recordOptionsOf(base))).toBe(true);
    expect(sameRecordOptions(fresh, shared)).toBe(false);
    expect(sameRecordOptions(shared, recordOptionsOf({ ...base, sharedLoads: true }))).toBe(true);
  });

  it("is parsed from --shared-loads, and is off by default", () => {
    expect(parseScanArgs(["https://a.example/"]).sharedLoads).toBeUndefined();
    expect(parseScanArgs(["https://a.example/", "--shared-loads"]).sharedLoads).toBe(true);
  });
});
