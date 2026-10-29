import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import sharp from "sharp";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha1 } from "../src/atomic.js";
import { ssim } from "../src/ssim.js";
import type { ImageObservation } from "../src/measure.js";
import {
  bytesByViewport,
  cdnDrop,
  formatOfContentType,
  judgeSample,
  judgeVerification,
  offsetFor,
  renderVerifyTable,
  sampleVariants,
  undersizedFile,
  scoreVariant,
  selectApplied,
  raiseCommandHint,
  verify,
  type VerifySample,
} from "../src/verify.js";
import { listSourceFiles, scanFile } from "../src/scan.js";
import type { measureUsages } from "../src/audit.js";
import { loadState, saveState, type StateEntry } from "../src/state.js";
import type { ImageUsage, ImgtuneConfig } from "../src/types.js";
import { gradientNoise, rawToPng } from "./image-fixtures.js";


describe("raiseCommandHint", () => {
  it("is the plain npx command when the project is the working directory", () => {
    expect(raiseCommandHint("Card", 75, "/work/app", "/work/app")).toBe("npx imgtune apply --raise Card=75");
  });

  it("names the project when it is another directory, so the command applies to the right tree", () => {
    expect(raiseCommandHint("Card", 75, "/work/app", "/work")).toBe("npx imgtune apply --project /work/app --raise Card=75");
  });

  it("quotes a project path that has spaces", () => {
    expect(raiseCommandHint("Card", 75, "/work/my app", "/work")).toBe(
      "npx imgtune apply --project '/work/my app' --raise Card=75",
    );
  });
});

describe("judgeVerification", () => {
  const applied = { sizes: "33vw", quality: 70 };
  const before = { sizes: "100vw", quality: 90 };
  const judge = (
    list: VerifySample[],
    served: ("avif" | "webp")[],
    overrides: Partial<Parameters<typeof judgeVerification>[0]> = {},
  ) =>
    judgeVerification({
      samples: list,
      served,
      samplesPerComponent: 20,
      threshold: 0.975,
      tolerance: 5,
      applied,
      before,
      ...overrides,
    });
  const passing = (format: "avif" | "webp", count: number, ssim = 0.99) =>
    Array.from({ length: count }, () => ({ format, ssim }));

  it("verifies when at least 95% of the usable samples pass in the served format", () => {
    const verdict = judge([...passing("webp", 19), { format: "webp", ssim: 0.9 }], ["webp"]);
    expect(verdict.status).toBe("verified");
    expect(verdict.ssim.webp).toBeCloseTo(0.99, 5);
    expect(verdict.ssim.avif).toBeUndefined();
    expect(verdict.counts).toEqual({ webp: { usable: 20, passing: 19 } });
  });

  it("regresses when fewer than 95% of the usable samples reach the threshold", () => {
    const verdict = judge([...passing("webp", 18), { format: "webp", ssim: 0.9 }, { format: "webp", ssim: 0.9 }], ["webp"]);
    expect(verdict.status).toBe("regressed");
    expect(verdict.raiseTo).toBe(75);
    expect(verdict.counts.webp).toEqual({ usable: 20, passing: 18 });
  });

  it("requires every served format to pass", () => {
    const verdict = judge([...passing("avif", 5), ...passing("webp", 5, 0.5)], ["avif", "webp"]);
    expect(verdict.status).toBe("regressed");
    expect(verdict.ssim.avif).toBeCloseTo(0.99, 5);
    expect(verdict.ssim.webp).toBeCloseTo(0.5, 5);
  });

  it("is unmeasured when a served format has fewer than the minimum usable samples", () => {
    const verdict = judge([...passing("webp", 1), { format: "webp" }], ["webp"]);
    expect(verdict.status).toBe("unmeasured");
    expect(verdict.reason).toBe("insufficient webp samples: 1");
  });

  it("verifies a webp-only page with 6 passing samples (minimum is 5)", () => {
    const verdict = judge(passing("webp", 6), ["webp"]);
    expect(verdict.status).toBe("verified");
    expect(verdict.counts.webp).toEqual({ usable: 6, passing: 6 });
  });

  it("is unmeasured when avif is served but has too few usable samples, even if webp is fine", () => {
    const verdict = judge([...passing("webp", 20), ...passing("avif", 2)], ["avif", "webp"]);
    expect(verdict.status).toBe("unmeasured");
    expect(verdict.reason).toBe("insufficient avif samples: 2");
  });

  it("uses the lesser of 5 and samplesPerComponent as the minimum", () => {
    expect(judge(passing("webp", 3), ["webp"], { samplesPerComponent: 3 }).status).toBe("verified");
    expect(judge(passing("webp", 2), ["webp"], { samplesPerComponent: 3 }).reason).toBe("insufficient webp samples: 2");
  });

  it("never verifies a usage with zero samples, even when samplesPerComponent is 0", () => {
    expect(judge([], ["webp"], { samplesPerComponent: 0 }).status).toBe("unmeasured");
    expect(judge([], ["webp"], { samplesPerComponent: 0 }).reason).toBe("insufficient webp samples: 0");
  });

  it("does not count unusable samples toward the minimum", () => {
    const verdict = judge([...passing("webp", 4), { format: "webp" }, { format: "webp" }], ["webp"]);
    expect(verdict.status).toBe("unmeasured");
    expect(verdict.reason).toBe("insufficient webp samples: 4");
  });

  it("judges a usage with 2 distinct images on those 2 and reports n=2 when they pass", () => {
    const verdict = judge(passing("webp", 2), ["webp"], { distinctImages: 2 });
    expect(verdict.status).toBe("verified");
    expect(verdict.sampleSize).toBe(2);
  });

  it("regresses a usage with 2 distinct images when one of them fails", () => {
    const verdict = judge([...passing("webp", 1), { format: "webp", ssim: 0.5 }], ["webp"], { distinctImages: 2 });
    expect(verdict.status).toBe("regressed");
    expect(verdict.sampleSize).toBe(2);
  });

  it("judges a usage with 1 distinct image on that one and reports n=1", () => {
    const verdict = judge(passing("webp", 1), ["webp"], { distinctImages: 1 });
    expect(verdict.status).toBe("verified");
    expect(verdict.sampleSize).toBe(1);
  });

  it("still needs 5 usable samples when the usage has 5 or more distinct images", () => {
    const verdict = judge(passing("webp", 4), ["webp"], { distinctImages: 9 });
    expect(verdict.status).toBe("unmeasured");
    expect(verdict.reason).toBe("insufficient webp samples: 4");
    expect(verdict.sampleSize).toBeUndefined();
  });

  it("is unmeasured when the page served neither avif nor webp", () => {
    expect(judge([], []).status).toBe("unmeasured");
    expect(judge([], []).reason).toBe("no avif or webp image served");
  });

  it("caps the raise at the pre-apply quality", () => {
    const verdict = judge(passing("webp", 5, 0.5), ["webp"], { applied: { quality: 80 }, before: { quality: 82 } });
    expect(verdict.raiseTo).toBe(82);
  });

  it("assumes 100 as the cap when the pre-apply quality is absent", () => {
    const verdict = judge(passing("webp", 5, 0.5), ["webp"], { applied: { quality: 80 }, before: undefined });
    expect(verdict.raiseTo).toBe(85);
  });

  it("gives no raise when the applied quality is absent or already at the cap", () => {
    expect(judge(passing("webp", 5, 0.5), ["webp"], { applied: { sizes: "50vw" } }).raiseTo).toBeUndefined();
    expect(judge(passing("webp", 5, 0.5), ["webp"], { applied: { quality: 90 }, before: { quality: 90 } }).raiseTo).toBeUndefined();
  });

  it("does not raise when the cap is below the applied quality", () => {
    expect(judge(passing("webp", 5, 0.5), ["webp"], { applied: { quality: 80 }, before: { quality: 60 } }).raiseTo).toBeUndefined();
  });
});

describe("formatOfContentType", () => {
  it("maps avif and webp content types and ignores parameters and other types", () => {
    expect(formatOfContentType("image/avif")).toBe("avif");
    expect(formatOfContentType("image/webp; charset=binary")).toBe("webp");
    expect(formatOfContentType("image/png")).toBeUndefined();
    expect(formatOfContentType(undefined)).toBeUndefined();
  });
});

const observation = (overrides: Partial<ImageObservation>): ImageObservation => ({
  usageId: "a.tsx:1:1",
  page: "/ae-en/eyeglasses",
  viewport: "iphone-15",
  viewportWidth: 390,
  dpr: 3,
  mobile: true,
  renderedWidth: 160,
  renderedHeight: 160,
  naturalWidth: 1200,
  currentSrc: "http://localhost/_next/image?url=a&w=384&q=75",
  originalSrc: "/img/a.jpg",
  srcsetWidths: [],
  contentType: "image/webp",
  bytes: 1000,
  accept: "default",
  ...overrides,
});

describe("sampleVariants", () => {
  it("takes distinct served URLs of one format, up to the limit, skipping unrendered images", () => {
    const obs = [
      observation({ currentSrc: "u1" }),
      observation({ currentSrc: "u1", viewport: "desktop" }),
      observation({ currentSrc: "u2", contentType: "image/avif" }),
      observation({ currentSrc: "u3", renderedWidth: 0 }),
      observation({ currentSrc: "u4" }),
      observation({ currentSrc: "u5" }),
    ];
    expect(sampleVariants(obs, "webp", 2).map((o) => o.currentSrc)).toEqual(["u1", "u4"]);
    expect(sampleVariants(obs, "avif", 5).map((o) => o.currentSrc)).toEqual(["u2"]);
  });
});

describe("selectApplied", () => {
  const entry = (usageId: string, relFile: string, fileHash: string, applied: StateEntry["applied"]): StateEntry => ({
    usageId,
    relFile,
    component: "Card",
    fileHash,
    applied,
    at: "2026-10-28T00:00:00.000Z",
  });
  const usage = (id: string) => ({ id }) as unknown as ImageUsage;

  it("keeps applied entries whose file hash still matches and whose usage is found", () => {
    const state = [
      entry("a:1:1", "src/a.tsx", "h-a", { sizes: "33vw" }),
      entry("b:1:1", "src/b.tsx", "h-b-old", { quality: 70 }),
      entry("c:1:1", "src/c.tsx", "h-c", { quality: 70 }),
      entry("d:1:1", "src/d.tsx", "h-d", {}),
      entry("e:1:1", "src/e.tsx", "h-e", { quality: 60 }),
    ];
    const hashes: Record<string, string> = { "src/a.tsx": "h-a", "src/b.tsx": "h-b", "src/c.tsx": "h-c", "src/d.tsx": "h-d" };
    const picked = selectApplied(state, (relFile) => hashes[relFile], (e) => (e.usageId === "e:1:1" ? undefined : usage(e.usageId)));
    expect(picked.map((p) => p.entry.usageId)).toEqual(["a:1:1", "c:1:1"]);
  });
});

describe("scoreVariant", () => {
  const original = (async () => rawToPng(gradientNoise(480, 320, 10, 11)))();

  const served = async (format: "webp" | "avif") => {
    const png = await original;
    return format === "webp" ? sharp(png).webp({ lossless: true }).toBuffer() : sharp(png).avif({ quality: 60 }).toBuffer();
  };

  const fetchReturning = (body: Buffer, contentType: string, status = 200): typeof fetch =>
    (async () =>
      new Response(new Uint8Array(body), { status, headers: { "content-type": contentType } })) as unknown as typeof fetch;

  const fetchOriginal = async () => original;

  it("scores a served webp against the original at the served width (lossless: identical pixels)", async () => {
    const body = await served("webp");
    const score = await scoreVariant(observation({}), "webp", "http://localhost", {
      fetchImpl: fetchReturning(body, "image/webp"),
      fetchOriginal,
    });
    expect("ssim" in score && score.ssim).toBeCloseTo(1, 6);
  });

  it("reports the decoded served width even when the original is narrower than the served file", async () => {
    const servedPng = await sharp(gradientNoise(400, 300, 10, 13).data, { raw: { width: 400, height: 300, channels: 4 } })
      .webp({ lossless: true })
      .toBuffer();
    const narrowOriginal = async () => rawToPng(gradientNoise(200, 150, 10, 14));
    const score = await scoreVariant(observation({}), "webp", "http://localhost", {
      fetchImpl: fetchReturning(servedPng, "image/webp"),
      fetchOriginal: narrowOriginal,
    });
    expect("width" in score && score.width).toBe(400);
  });

  it("treats a response with the wrong content-type as unusable, not as a score", async () => {
    const body = await served("webp");
    const score = await scoreVariant(observation({}), "webp", "http://localhost", {
      fetchImpl: fetchReturning(body, "image/png"),
      fetchOriginal,
    });
    expect(score).toEqual({ unusable: "content-type image/png" });
  });

  it("treats an HTTP error as unusable", async () => {
    const score = await scoreVariant(observation({}), "webp", "http://localhost", {
      fetchImpl: fetchReturning(Buffer.from("nope"), "text/plain", 500),
      fetchOriginal,
    });
    expect(score).toEqual({ unusable: "HTTP 500" });
  });

  it("treats an image without an original source as unusable without fetching", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(Buffer.alloc(0));
    }) as unknown as typeof fetch;
    const score = await scoreVariant(observation({ originalSrc: undefined }), "webp", "http://localhost", {
      fetchImpl,
      fetchOriginal,
    });
    expect("unusable" in score).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("judgeVerification with per-sample bars (R38)", () => {
  const base = {
    served: ["webp" as const],
    samplesPerComponent: 20,
    threshold: 70,
    tolerance: 2,
    applied: { quality: 60 },
    before: { quality: 75 },
  };
  it("passes a sample against its own bar, not the absolute threshold", () => {
    const samples = Array.from({ length: 10 }, () => ({ format: "webp" as const, ssim: 74, minScore: 73 }));
    const verdict = judgeVerification({ ...base, samples, threshold: 88 });
    expect(verdict.status).toBe("verified");
    expect(verdict.counts.webp).toEqual({ usable: 10, passing: 10 });
    expect(verdict.minScore?.webp).toBe(73);
  });

  it("falls back to the threshold for a sample without a bar", () => {
    const samples = Array.from({ length: 10 }, () => ({ format: "webp" as const, ssim: 74 }));
    expect(judgeVerification({ ...base, samples, threshold: 88 }).status).toBe("regressed");
  });
});

describe("bytesByViewport and renderVerifyTable", () => {
  it("shows the bar after each score as min", () => {
    const table = renderVerifyTable(
      [
        {
          usageId: "a:1:1",
          component: "Card",
          relFile: "src/a.tsx",
          line: 1,
          bytes: {},
          judgement: {
            status: "verified",
            ssim: { webp: 72.5 },
            minScore: { webp: 70.25 },
            counts: { webp: { usable: 10, passing: 10 } },
          },
        },
      ],
      "ssimulacra2",
    );
    expect(table).toContain("SSIMU2 webp");
    expect(table).toContain("72.5 min 70.3");
  });
  it("takes the median default-pass bytes per viewport and lists the reference viewport first", () => {
    const obs = [
      observation({ viewport: "desktop", bytes: 4000 }),
      observation({ viewport: "iphone-15", bytes: 1000 }),
      observation({ viewport: "iphone-15", bytes: 3000 }),
      observation({ viewport: "iphone-15", bytes: 9000, accept: "webp" }),
    ];
    expect(bytesByViewport(obs)).toEqual({ desktop: 4000, "iphone-15": 2000 });

    const table = renderVerifyTable([
      {
        usageId: "a:1:1",
        component: "Card",
        relFile: "src/a.tsx",
        line: 12,
        bytes: { desktop: 4096, "iphone-15": 2048 },
        beforeBytes: { "iphone-15": 8192, desktop: 16384 },
        judgement: {
          status: "regressed",
          ssim: { avif: 0.99, webp: 0.9 },
          counts: { avif: { usable: 20, passing: 19 }, webp: { usable: 20, passing: 10 } },
          raiseTo: 80,
        },
      },
      {
        usageId: "b:1:1",
        component: "Hero",
        relFile: "src/b.tsx",
        line: 3,
        bytes: {},
        judgement: { status: "unmeasured", reason: "insufficient webp samples: 1", ssim: {}, counts: {} },
      },
    ], "ssim");
    const [header, row, unmeasured] = table.split("\n");
    expect(header).toContain("bytes before");
    expect(row).toContain("iphone-15 8.0 KB, desktop 16.0 KB");
    expect(row).toContain("8.0 KB");
    expect(row).toContain("iphone-15 2.0 KB, desktop 4.0 KB");
    expect(unmeasured).toContain("not measured (insufficient webp samples: 1)");
    expect(row).toContain("regressed (raise quality to 80) (passing avif 19/20, webp 10/20)");
    expect(row).toContain("src/a.tsx:12");
  });
});

describe("judgeVerification with the cdn rule", () => {
  const base = {
    served: ["webp" as const],
    samplesPerComponent: 20,
    threshold: 0.9,
    tolerance: 2,
    maxDrop: 0.02,
    applied: { sizes: "300px" },
    before: { quality: 85 },
  };
  it("verifies a sizes-only change on the score floor alone, even when the CDN score is below a local bar", () => {
    const samples = Array.from({ length: 10 }, () => ({ format: "webp" as const, ssim: 0.93, drop: 0 }));
    expect(judgeVerification({ ...base, samples }).status).toBe("verified");
  });

  it("regresses when the local quality drop is beyond delta and shows the median drop", () => {
    const samples = Array.from({ length: 10 }, () => ({ format: "webp" as const, ssim: 0.95, drop: 0.05 }));
    const verdict = judgeVerification({ ...base, samples, applied: { quality: 70 } });
    expect(verdict.status).toBe("regressed");
    expect(verdict.drop?.webp).toBeCloseTo(0.05, 6);
    expect(verdict.counts.webp).toEqual({ usable: 10, passing: 0 });
  });

  it("regresses a sample below the score floor even with no drop", () => {
    const samples = Array.from({ length: 10 }, () => ({ format: "webp" as const, ssim: 0.8, drop: 0 }));
    expect(judgeVerification({ ...base, samples }).status).toBe("regressed");
  });

  it("regresses with the undersized reason whatever the scores say", () => {
    const samples = Array.from({ length: 10 }, () => ({
      format: "webp" as const,
      ssim: 0.99,
      drop: 0,
      undersized: { file: 300, needed: 480 },
    }));
    const verdict = judgeVerification({ ...base, samples });
    expect(verdict.status).toBe("regressed");
    expect(verdict.reason).toBe("undersized: 300px for 480px");
  });

  it("renders the median drop in place of the bar", () => {
    const table = renderVerifyTable(
      [
        {
          usageId: "a:1:1",
          component: "Card",
          relFile: "src/a.tsx",
          line: 1,
          bytes: {},
          judgement: {
            status: "regressed",
            reason: "undersized: 300px for 480px",
            ssim: { webp: 0.95 },
            minScore: { webp: 0.9 },
            drop: { webp: 0.05 },
            counts: { webp: { usable: 10, passing: 10 } },
          },
        },
      ],
      "ssim",
    );
    expect(table).toContain("0.950 drop 0.050");
    expect(table).toContain("regressed (undersized: 300px for 480px)");
  });
});

describe("cdnDrop and undersizedFile", () => {
  const originalPromise = (async () => rawToPng(gradientNoise(480, 320, 10, 11)))();

  it("is zero for a sizes-only change without encoding anything", async () => {
    const drop = await cdnDrop(Buffer.alloc(0), "webp", 480, { before: 85, now: 85, offset: 0 }, ssim);
    expect(drop).toBe(0);
  });

  it("is undefined without a calibration offset", async () => {
    const drop = await cdnDrop(await originalPromise, "webp", 480, { before: 85, now: 40 }, ssim);
    expect(drop).toBeUndefined();
  });

  it("is the local score loss when the quality drops, so a large cut exceeds delta", async () => {
    const drop = await cdnDrop(await originalPromise, "webp", 480, { before: 90, now: 30, offset: 0 }, ssim);
    expect(drop).toBeGreaterThan(0.02);
  });

  it("flags a served file narrower than 90% of what the render needs", async () => {
    const original = await originalPromise;
    const small = observation({ renderedWidth: 300, dpr: 2, naturalWidth: 300 });
    expect(await undersizedFile(original, small, 300)).toEqual({ file: 300, needed: 480 });
    expect(await undersizedFile(original, small, 460)).toBeUndefined();
  });
});

describe("judgeSample for next-default with the R38 rule (R41)", () => {
  const original = (async () => rawToPng(gradientNoise(480, 320, 10, 11)))();
  const input = (overrides: Partial<Parameters<typeof judgeSample>[0]> = {}) => ({
    obs: observation({ renderedWidth: 300, dpr: 1, naturalWidth: 400 }),
    format: "webp" as const,
    scored: { ssim: 80, width: 400 },
    before: 85,
    applied: 70,
    profile: "next-default" as const,
    delta: 2,
    threshold: 70,
    baseUrl: "http://localhost",
    ...overrides,
  });
  const deps = (fetchOriginal: (url: string) => Promise<Buffer> = async () => original) => ({
    fetchOriginal,
    score: () => 80,
  });

  it("gives the sample the recomputed bar: max(floor, current score - delta)", async () => {
    const verdict = await judgeSample(input(), deps());
    expect(verdict).toEqual({ sample: { format: "webp", ssim: 80, minScore: 78 } });
  });

  it("makes the sample unusable, with the reason, when the bar cannot be recomputed", async () => {
    const verdict = await judgeSample(
      input(),
      deps(async () => {
        throw new Error("GET original returned HTTP 404");
      }),
    );
    expect(verdict).toEqual({ unusable: "bar not computable: GET original returned HTTP 404" });
  });

  it("makes the sample unusable when no before-quality is recorded, never the threshold", async () => {
    expect(await judgeSample(input({ before: undefined }), deps())).toEqual({
      unusable: "bar not computable: no before quality recorded",
    });
  });

  it("judges against the absolute threshold, with no bar, when delta is absent", async () => {
    const verdict = await judgeSample(input({ delta: undefined, before: undefined }), deps());
    expect(verdict).toEqual({ sample: { format: "webp", ssim: 80 } });
  });
});

describe("judgeSample for cdn with the drop rule (R41)", () => {
  const original = (async () => rawToPng(gradientNoise(480, 320, 10, 11)))();
  const input = (overrides: Partial<Parameters<typeof judgeSample>[0]> = {}) => ({
    obs: observation({ renderedWidth: 300, dpr: 1, naturalWidth: 480 }),
    format: "webp" as const,
    scored: { ssim: 0.95, width: 480 },
    before: 85,
    applied: 60,
    offset: 0,
    profile: "cdn" as const,
    delta: 0.02,
    threshold: 0.9,
    baseUrl: "http://localhost",
    ...overrides,
  });
  const deps = { fetchOriginal: async () => original, score: ssim };

  it("makes a quality change with no calibration offset unusable, not a pass on the floor", async () => {
    expect(await judgeSample(input({ offset: undefined }), deps)).toEqual({
      unusable: "drop not computable: no calibration offset for webp",
    });
  });

  it("makes a quality change with no before quality unusable", async () => {
    expect(await judgeSample(input({ before: undefined }), deps)).toEqual({
      unusable: "drop not computable: no before quality recorded",
    });
  });

  it("judges a sizes-only change with no before quality on its resolution: its drop is zero", async () => {
    const verdict = await judgeSample(input({ before: undefined, applied: undefined }), deps);
    expect(verdict).toEqual({ sample: { format: "webp", ssim: 0.95, drop: 0, undersized: undefined } });
  });

  it("flags a sizes-only change with no before quality whose served file is undersized", async () => {
    const verdict = await judgeSample(
      input({ before: undefined, applied: undefined, obs: observation({ renderedWidth: 300, dpr: 2, naturalWidth: 480 }), scored: { ssim: 0.95, width: 300 } }),
      deps,
    );
    expect(verdict).toMatchObject({ sample: { drop: 0, undersized: { file: 300, needed: 480 } } });
  });

  it("still judges a sizes-only change with no offset, since its drop is zero", async () => {
    const verdict = await judgeSample(input({ offset: undefined, applied: undefined }), deps);
    expect(verdict).toMatchObject({ sample: { format: "webp", ssim: 0.95, drop: 0 } });
  });

  it("makes a sample unusable when its local rescore fails", async () => {
    const verdict = await judgeSample(
      input(),
      { fetchOriginal: async () => { throw new Error("404"); }, score: ssim },
    );
    expect(verdict).toEqual({ unusable: "local rescore failed: 404" });
  });
});

describe("offsetFor", () => {
  const entry = (calibration?: Partial<Record<"avif" | "webp", number>>): StateEntry => ({
    usageId: "src/A.tsx:1:1",
    relFile: "src/A.tsx",
    component: "A",
    fileHash: "h",
    applied: { quality: 60 },
    at: "2026-10-28T00:00:00.000Z",
    ...(calibration === undefined ? {} : { calibration }),
  });

  it("takes the offset the apply recorded in the state entry, with no report needed", () => {
    expect(offsetFor(entry({ webp: 3 }), undefined, "webp")).toBe(3);
  });

  it("prefers the state entry's offset over the audit report's", () => {
    expect(offsetFor(entry({ webp: 3 }), { webp: 9 }, "webp")).toBe(3);
  });

  it("falls back to the audit report for state written before calibration was recorded", () => {
    expect(offsetFor(entry(), { webp: 9 }, "webp")).toBe(9);
  });

  it("is undefined for a format with no offset anywhere", () => {
    expect(offsetFor(entry({ webp: 3 }), { webp: 9 }, "avif")).toBeUndefined();
  });
});

describe("judgeVerification stores no bar for the cdn rule", () => {
  it("keeps the drop and drops the threshold that was never applied as a bar", () => {
    const samples = Array.from({ length: 10 }, () => ({ format: "webp" as const, ssim: 0.95, drop: 0 }));
    const verdict = judgeVerification({
      samples,
      served: ["webp"],
      samplesPerComponent: 20,
      threshold: 0.9,
      tolerance: 2,
      maxDrop: 0.02,
      applied: { sizes: "300px" },
      before: { quality: 85 },
    });
    expect(verdict.status).toBe("verified");
    expect(verdict.minScore).toBeUndefined();
    expect(verdict.drop?.webp).toBe(0);
  });
});

describe("verify with fake measurement, originals and scorer", () => {
  const WIDTH = 480;
  const HEIGHT = 320;
  const IMAGE = `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={${WIDTH}} height={${HEIGHT}} />;\n`;
  const LOADER_CONFIG = "export default {\n  images: {\n    loaderFile: './loader.ts',\n  },\n};\n";

  // verify prints its table to stdout; keep the test output clean.
  let stdout: MockInstance<typeof process.stdout.write>;
  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => stdout.mockRestore());

  const original = (async () => rawToPng(gradientNoise(WIDTH, HEIGHT, 10, 11)))();

  /** A project with a cdn loader config and the given source files, and no audit report. */
  function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "imgtune-verify-"));
    for (const [rel, text] of Object.entries({ "next.config.mjs": LOADER_CONFIG, ...files })) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return dir;
  }

  /** An applied state entry for the one usage in `rel`, as apply would record it (quality 90 cut to 30). */
  function appliedEntry(dir: string, rel: string, extra: Partial<StateEntry> = {}): StateEntry {
    const [usage] = scanFile(join(dir, rel), dir);
    return {
      usageId: usage.id,
      relFile: rel,
      component: usage.component,
      fileHash: sha1(readFileSync(join(dir, rel))),
      applied: { quality: 30 },
      before: { quality: 90 },
      calibration: { webp: 0 },
      at: "2026-10-28T00:00:00.000Z",
      ...extra,
    };
  }

  const config = (projectDir: string, paths = ["."]): ImgtuneConfig => ({
    projectDir,
    paths,
    quality: "relaxed",
    metric: "ssim",
    threshold: 0.9,
    delta: 0.02,
    tolerance: 2,
    market: "",
    port: 0,
    urls: {},
    viewports: [],
    samplesPerComponent: 5,
    maxPagesPerPattern: 1,
    includeDone: false,
  });

  /** Five webp observations of one usage, one per distinct served URL. */
  const observationsFor = (usageId: string): ImageObservation[] =>
    Array.from({ length: 5 }, (_, i) => ({
      usageId,
      page: "/",
      viewport: "iphone-15",
      viewportWidth: 390,
      dpr: 1,
      mobile: false,
      renderedWidth: WIDTH,
      renderedHeight: HEIGHT,
      naturalWidth: WIDTH,
      currentSrc: `http://localhost/_next/image?url=a&w=${WIDTH}&q=30&n=${i}`,
      originalSrc: "/a.png",
      srcsetWidths: [],
      contentType: "image/webp",
      bytes: 1000,
      accept: "default" as const,
    }));

  /** Fakes for the browser and the network: the served variant is the original, losslessly, as webp. */
  async function fakes(measured: (usages: ImageUsage[]) => ImageObservation[]) {
    const served = await sharp(await original).webp({ lossless: true }).toBuffer();
    const seen: ImageUsage[][] = [];
    return {
      seen,
      deps: {
        measure: (async (_config, usages) => {
          seen.push(usages);
          return { observations: measured(usages), baseUrl: "http://localhost", sitemapSource: "none", stop: async () => {} };
        }) as typeof measureUsages,
        fetchImpl: (async () =>
          new Response(served, { headers: { "content-type": "image/webp" } })) as typeof fetch,
        fetchOriginal: async () => original,
        score: ssim,
        log: () => {},
      },
    };
  }

  it("judges a cdn usage from the offset in its state entry, with no audit report, and computes its drop", async () => {
    const dir = project({ "src/A.tsx": IMAGE });
    const entry = appliedEntry(dir, "src/A.tsx");
    await saveState(dir, [entry]);
    const { deps } = await fakes((usages) => observationsFor(usages[0].id));

    await verify(config(dir), deps);

    const [saved] = await loadState(dir);
    // The drop is 90 against 30 at offset 0, well past delta: a computed drop judges the usage regressed. Without the
    // offset every sample would be unusable and the usage would be unmeasured, with no verification at all.
    expect(saved.verification?.status).toBe("regressed");
    expect(saved.verification?.drop?.webp).toBeGreaterThan(0.02);
    expect(saved.verification?.counts.webp?.usable).toBe(5);
  });

  it("judges only the entries under --path and leaves the others' stored verdicts untouched", async () => {
    const dir = project({ "src/in/A.tsx": IMAGE, "src/out/B.tsx": IMAGE });
    const sentinel = { status: "verified" as const, at: "2026-01-01T00:00:00.000Z", bytes: {}, ssim: {}, counts: {} };
    await saveState(dir, [
      appliedEntry(dir, "src/in/A.tsx"),
      appliedEntry(dir, "src/out/B.tsx", { verification: sentinel }),
    ]);
    const { seen, deps } = await fakes((usages) => observationsFor(usages[0].id));

    await verify(config(dir, ["src/in"]), deps);

    expect(seen[0].map((usage) => usage.relFile)).toEqual(["src/in/A.tsx"]);
    const saved = await loadState(dir);
    expect(saved.find((e) => e.relFile === "src/in/A.tsx")?.verification?.at).not.toBe(sentinel.at);
    expect(saved.find((e) => e.relFile === "src/out/B.tsx")?.verification).toEqual(sentinel);
  });

  it("verifies a usage with two distinct images on those two, and shows n=2 in the table", async () => {
    const dir = project({ "src/A.tsx": IMAGE });
    await saveState(dir, [appliedEntry(dir, "src/A.tsx", { applied: { sizes: "50vw" } })]);
    const base = observationsFor("x")[0];
    const twoImages = (usageId: string): ImageObservation[] => [
      { ...base, usageId, originalSrc: "/a.png", currentSrc: `http://localhost/_next/image?url=a&w=${WIDTH}` },
      { ...base, usageId, originalSrc: "/b.png", currentSrc: `http://localhost/_next/image?url=b&w=${WIDTH}` },
    ];
    const { deps } = await fakes((usages) => twoImages(usages[0].id));

    const rows = await verify(config(dir), deps);

    expect(rows[0].judgement.status).toBe("verified");
    expect(rows[0].judgement.sampleSize).toBe(2);
    expect(renderVerifyTable(rows, "ssim")).toContain("verified (n=2)");
    const [saved] = await loadState(dir);
    expect(saved.verification?.status).toBe("verified");
  });

  /** The file as apply leaves it, with `quality={q}` on the usage. */
  const imageWithQuality = (q: string): string =>
    `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={${WIDTH}} height={${HEIGHT}} quality={${q}} />;\n`;

  it("picks up a quality the user wrote after apply: logs it, records it, and measures it", async () => {
    const dir = project({ "src/A.tsx": imageWithQuality("30") });
    await saveState(dir, [appliedEntry(dir, "src/A.tsx", { applied: { quality: 30 } })]);
    writeFileSync(join(dir, "src/A.tsx"), imageWithQuality("40"));
    const { deps, seen } = await fakes((usages) => observationsFor(usages[0].id));
    const logs: string[] = [];

    await verify(config(dir), { ...deps, log: (message: string) => logs.push(message) });

    expect(logs).toContain("A: picked up your edit: quality 30 → 40");
    expect(seen[0]).toHaveLength(1);
    const [saved] = await loadState(dir);
    expect(saved.applied.quality).toBe(40);
    expect(saved.before?.quality).toBe(90);
    expect(saved.fileHash).toBe(sha1(readFileSync(join(dir, "src/A.tsx"))));
    expect(saved.verification).toBeDefined();
  });

  it("leaves a changed file alone when its usage is gone from it", async () => {
    const dir = project({ "src/A.tsx": imageWithQuality("30") });
    await saveState(dir, [appliedEntry(dir, "src/A.tsx", { applied: { quality: 30 } })]);
    // A line above the usage moves it, and its id with it.
    writeFileSync(join(dir, "src/A.tsx"), `// moved\n${imageWithQuality("40")}`);
    const { seen, deps } = await fakes(() => []);

    await verify(config(dir), deps);

    expect(seen).toEqual([]);
    const [saved] = await loadState(dir);
    expect(saved.applied.quality).toBe(30);
    expect(saved.verification).toBeUndefined();
  });

  it("leaves a changed file alone when its quality is no longer a literal", async () => {
    const dir = project({ "src/A.tsx": imageWithQuality("30") });
    await saveState(dir, [appliedEntry(dir, "src/A.tsx", { applied: { quality: 30 } })]);
    writeFileSync(join(dir, "src/A.tsx"), imageWithQuality("someQuality"));
    const { seen, deps } = await fakes(() => []);

    await verify(config(dir), deps);

    expect(seen).toEqual([]);
    expect((await loadState(dir))[0].applied.quality).toBe(30);
  });

  it("prints the exact apply --raise command under a regressed usage that a raise can help", async () => {
    const dir = project({ "src/A.tsx": IMAGE });
    await saveState(dir, [appliedEntry(dir, "src/A.tsx")]);
    const { deps } = await fakes((usages) => observationsFor(usages[0].id));

    await verify(config(dir), deps);

    const printed = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain(`run: npx imgtune apply --project ${dir} --raise A=32\n`);
  });

  it("fails with the audit's error for a --path that does not exist, measuring nothing", async () => {
    const dir = project({ "src/A.tsx": IMAGE });
    await saveState(dir, [appliedEntry(dir, "src/A.tsx")]);
    const { seen, deps } = await fakes(() => []);
    const expected = await listSourceFiles(dir, ["src/nope"]).then(
      () => new Error("audit did not fail"),
      (err: Error) => err,
    );

    await expect(verify(config(dir, ["src/nope"]), deps)).rejects.toThrow(expected.message);
    expect(seen).toEqual([]);
  });
});
