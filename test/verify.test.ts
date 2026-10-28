import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { ImageObservation } from "../src/measure.js";
import {
  bytesByViewport,
  formatOfContentType,
  judgeVerification,
  renderVerifyTable,
  sampleVariants,
  scoreVariant,
  selectApplied,
  type VerifySample,
} from "../src/verify.js";
import type { StateEntry } from "../src/state.js";
import type { ImageUsage } from "../src/types.js";
import { gradientNoise, rawToPng } from "./image-fixtures.js";

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

describe("bytesByViewport and renderVerifyTable", () => {
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
        beforeBytes: 8192,
        judgement: { status: "regressed", ssim: { webp: 0.9 }, counts: { webp: { usable: 20, passing: 10 } }, raiseTo: 80 },
      },
      {
        usageId: "b:1:1",
        component: "Hero",
        relFile: "src/b.tsx",
        line: 3,
        bytes: {},
        judgement: { status: "unmeasured", reason: "insufficient webp samples: 1", ssim: {}, counts: {} },
      },
    ]);
    const [, row, unmeasured] = table.split("\n");
    expect(row).toContain("8.0 KB");
    expect(row).toContain("iphone-15 2.0 KB, desktop 4.0 KB");
    expect(unmeasured).toContain("not measured (insufficient webp samples: 1)");
    expect(row).toContain("regressed (raise quality to 80)");
    expect(row).toContain("src/a.tsx:12");
  });
});
