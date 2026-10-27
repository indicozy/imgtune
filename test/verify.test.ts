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

const samples = (format: "avif" | "webp", values: (number | undefined)[]): VerifySample[] =>
  values.map((ssim) => ({ format, ssim }));

describe("judgeVerification", () => {
  const applied = { sizes: "33vw", quality: 70 };
  const before = { sizes: "100vw", quality: 90 };

  it("verifies when at least 95% of the usable samples pass in every judged format", () => {
    const passing = Array.from({ length: 19 }, () => 0.99);
    const verdict = judgeVerification([...samples("webp", [...passing, 0.9])], 0.975, 5, applied, before);
    expect(verdict.status).toBe("verified");
    expect(verdict.ssim.webp).toBeCloseTo(0.99, 5);
    expect(verdict.ssim.avif).toBeUndefined();
  });

  it("regresses when fewer than 95% of the usable samples reach the threshold", () => {
    const values = [...Array.from({ length: 18 }, () => 0.99), 0.9, 0.9];
    const verdict = judgeVerification(samples("webp", values), 0.975, 5, applied, before);
    expect(verdict.status).toBe("regressed");
    expect(verdict.raiseTo).toBe(75);
  });

  it("requires both formats when both are judged", () => {
    const good = samples("avif", [0.99, 0.99, 0.99]);
    const badWebp = samples("webp", [0.5, 0.5]);
    const verdict = judgeVerification([...good, ...badWebp], 0.975, 5, applied, before);
    expect(verdict.status).toBe("regressed");
    expect(verdict.ssim.avif).toBeCloseTo(0.99, 5);
    expect(verdict.ssim.webp).toBeCloseTo(0.5, 5);
  });

  it("leaves unusable samples out of the share and the medians", () => {
    const verdict = judgeVerification(
      [...samples("webp", [0.99, undefined, undefined, 0.98])],
      0.975,
      5,
      applied,
      before,
    );
    expect(verdict.status).toBe("verified");
    expect(verdict.ssim.webp).toBeCloseTo(0.985, 5);
  });

  it("is unmeasured when no sample is usable", () => {
    const verdict = judgeVerification(samples("webp", [undefined]), 0.975, 5, applied, before);
    expect(verdict).toEqual({ status: "unmeasured", ssim: {} });
  });

  it("caps the raise at the pre-apply quality", () => {
    const verdict = judgeVerification(samples("avif", [0.5]), 0.975, 5, { quality: 80 }, { quality: 82 });
    expect(verdict.raiseTo).toBe(82);
  });

  it("assumes 100 as the cap when the pre-apply quality is absent", () => {
    const verdict = judgeVerification(samples("avif", [0.5]), 0.975, 5, { quality: 80 }, undefined);
    expect(verdict.raiseTo).toBe(85);
  });

  it("gives no raise when the applied quality is absent or already at the cap", () => {
    expect(judgeVerification(samples("avif", [0.5]), 0.975, 5, { sizes: "50vw" }, before).raiseTo).toBeUndefined();
    expect(judgeVerification(samples("avif", [0.5]), 0.975, 5, { quality: 90 }, { quality: 90 }).raiseTo).toBeUndefined();
  });

  it("does not raise when the cap is below the applied quality", () => {
    expect(judgeVerification(samples("avif", [0.5]), 0.975, 5, { quality: 80 }, { quality: 60 }).raiseTo).toBeUndefined();
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
        judgement: { status: "regressed", ssim: { webp: 0.9 }, raiseTo: 80 },
      },
    ]);
    const [, row] = table.split("\n");
    expect(row).toContain("iphone-15 2.0 KB, desktop 4.0 KB");
    expect(row).toContain("regressed (raise quality to 80)");
    expect(row).toContain("src/a.tsx:12");
  });
});
