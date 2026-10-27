import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedSince,
  confirmPlan,
  makeConfirm,
  makeFetchOriginal,
  pagesFor,
  pendingUsages,
  resolveScopeUrls,
  type ConfirmDeps,
} from "../src/audit.js";
import { sha1 } from "../src/atomic.js";
import type { StateEntry } from "../src/state.js";
import type { ImageUsage } from "../src/types.js";
import type { ResolvedUrls } from "../src/urls.js";

const emptyDir = () => mkdtempSync(join(tmpdir(), "imgtune-audit-"));

const usage = (id: string, file: string): ImageUsage => ({ id, file, relFile: file, line: 1, col: 1 }) as unknown as ImageUsage;

const entry = (usageId: string, fileHash: string): StateEntry => ({
  usageId,
  relFile: "src/a.tsx",
  component: "Card",
  fileHash,
  applied: { sizes: "33vw", quality: 70 },
  at: "2026-10-28T00:00:00.000Z",
});

describe("pendingUsages", () => {
  const usages = [usage("a:1:1", "/p/a.tsx"), usage("b:1:1", "/p/b.tsx")];
  const hashOf = (file: string) => (file === "/p/a.tsx" ? "hash-a-now" : "hash-b-now");

  it("drops usages whose state entry matches the current file hash", () => {
    const state = [entry("a:1:1", "hash-a-now"), entry("b:1:1", "hash-b-old")];
    expect(pendingUsages(usages, state, hashOf, false).map((u) => u.id)).toEqual(["b:1:1"]);
  });

  it("keeps everything when includeDone is set", () => {
    const state = [entry("a:1:1", "hash-a-now")];
    expect(pendingUsages(usages, state, hashOf, true)).toHaveLength(2);
  });

  it("keeps usages with no state entry", () => {
    expect(pendingUsages(usages, [], hashOf, false)).toHaveLength(2);
  });
});

describe("pagesFor", () => {
  it("unions the resolved paths of the given patterns without duplicates, in first-seen order", () => {
    const resolved = new Map<string, ResolvedUrls>([
      ["/[store]/[...slug]", { paths: ["/ae-en/eyeglasses", "/ae-en/sunglasses"], source: "sitemap" }],
      ["/[store]", { paths: ["/ae-en/eyeglasses"], source: "sitemap" }],
      ["/about", { paths: ["/about"], source: "static" }],
    ]);
    expect(pagesFor(["/[store]/[...slug]", "/[store]", "/about"], resolved)).toEqual([
      "/ae-en/eyeglasses",
      "/ae-en/sunglasses",
      "/about",
    ]);
  });

  it("ignores patterns with no resolution", () => {
    expect(pagesFor(["/missing"], new Map())).toEqual([]);
  });
});

describe("confirmPlan", () => {
  it("confirms directly when next.config lists the quality", () => {
    expect(confirmPlan(60, { qualities: [60, 75] }, true)).toBe("direct");
    expect(confirmPlan(60, { qualities: [60, 75] }, false)).toBe("direct");
  });

  it("treats 75 as listed when no qualities array is set", () => {
    expect(confirmPlan(75, {}, false)).toBe("direct");
  });

  it("edits next.config only for a server the tool started", () => {
    expect(confirmPlan(70, { qualities: [75] }, true)).toBe("edit-config");
    expect(confirmPlan(70, {}, true)).toBe("edit-config");
  });

  it("skips an unlisted quality when the server is not the tool's", () => {
    expect(confirmPlan(70, { qualities: [75] }, false)).toBe("skip");
    expect(confirmPlan(70, {}, false)).toBe("skip");
  });
});

describe("makeConfirm", () => {
  const samples = [{ src: "/img/p1.jpg", ref: {} as never, width: 320 }];
  const outcome = {
    confirmed: true,
    ssim: { webp: 0.991 },
    bytes: { webp: 4200 },
    failures: {},
    errors: {},
  } as never;

  const stubs = (): ConfirmDeps & {
    confirmNextDefault: ReturnType<typeof vi.fn>;
    withConfigQuality: ReturnType<typeof vi.fn>;
  } => ({
    confirmNextDefault: vi.fn(async () => outcome),
    withConfigQuality: vi.fn(async (_q, _probe, body) => body()),
  }) as never;

  const ctx = (overrides: Partial<Parameters<typeof makeConfirm>[0]> = {}) => ({
    baseUrl: "http://localhost:3999",
    threshold: 0.975,
    imageConfig: { qualities: [75], file: "/p/next.config.ts" },
    serverOwned: true,
    ...overrides,
  });

  it("confirms a listed quality directly, with the formats and threshold, and maps the result", async () => {
    const deps = stubs();
    const confirm = makeConfirm(ctx(), deps);
    const result = await confirm(samples, 75, ["webp"]);
    expect(deps.withConfigQuality).not.toHaveBeenCalled();
    expect(deps.confirmNextDefault).toHaveBeenCalledWith("http://localhost:3999", samples, 75, 0.975, {
      formats: ["webp"],
    });
    expect(result).toEqual({ confirmed: true, ssim: { webp: 0.991 }, bytes: { webp: 4200 } });
  });

  it("writes an unlisted quality into next.config for the tool's own server, then confirms", async () => {
    const deps = stubs();
    const confirm = makeConfirm(ctx(), deps);
    await confirm(samples, 70, ["webp"]);
    expect(deps.withConfigQuality).toHaveBeenCalledWith(70, { src: "/img/p1.jpg", width: 320 }, expect.any(Function));
    expect(deps.confirmNextDefault).toHaveBeenCalledWith("http://localhost:3999", samples, 70, 0.975, {
      formats: ["webp"],
    });
  });

  it("returns undefined without touching next.config when the server is not the tool's", async () => {
    const deps = stubs();
    const confirm = makeConfirm(ctx({ serverOwned: false }), deps);
    expect(await confirm(samples, 70, ["webp"])).toBeUndefined();
    expect(deps.withConfigQuality).not.toHaveBeenCalled();
    expect(deps.confirmNextDefault).not.toHaveBeenCalled();
  });

  it("returns undefined when next.config cannot take the quality", async () => {
    const deps = stubs();
    deps.withConfigQuality.mockResolvedValueOnce(undefined);
    const confirm = makeConfirm(ctx(), deps);
    expect(await confirm(samples, 70, ["webp"])).toBeUndefined();
    expect(deps.confirmNextDefault).not.toHaveBeenCalled();
  });

  it("returns undefined when there is no next.config file to edit", async () => {
    const deps = stubs();
    const confirm = makeConfirm(ctx({ imageConfig: { file: "" } }), deps);
    expect(await confirm(samples, 70, ["webp"])).toBeUndefined();
    expect(deps.withConfigQuality).not.toHaveBeenCalled();
  });

  it("returns undefined without samples", async () => {
    const deps = stubs();
    const confirm = makeConfirm(ctx(), deps);
    expect(await confirm([], 75, ["webp"])).toBeUndefined();
    expect(deps.confirmNextDefault).not.toHaveBeenCalled();
  });
});

describe("makeFetchOriginal", () => {
  it("downloads once, then serves the cached bytes", async () => {
    const dir = emptyDir();
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("original-bytes"), { status: 200 }));
    const fetchOriginal = makeFetchOriginal(dir, fetchImpl as unknown as typeof fetch);

    const first = await fetchOriginal("http://localhost:3999/img/p1.jpg");
    const second = await fetchOriginal("http://localhost:3999/img/p1.jpg");

    expect(first.toString()).toBe("original-bytes");
    expect(second.toString()).toBe("original-bytes");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const cached = join(dir, ".imgtune", "cache", "originals", sha1("http://localhost:3999/img/p1.jpg"));
    expect(existsSync(cached)).toBe(true);
  });

  it("writes the self-ignoring .gitignore for the tool directory", async () => {
    const dir = emptyDir();
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("x"), { status: 200 }));
    await makeFetchOriginal(dir, fetchImpl as unknown as typeof fetch)("http://localhost:3999/a.jpg");
    expect(readFileText(join(dir, ".imgtune", ".gitignore"))).toBe("*\n");
  });

  it("throws on a non-2xx response and caches nothing", async () => {
    const dir = emptyDir();
    const fetchImpl = vi.fn(async () => new Response("missing", { status: 404 }));
    const fetchOriginal = makeFetchOriginal(dir, fetchImpl as unknown as typeof fetch);
    await expect(fetchOriginal("http://localhost:3999/gone.jpg")).rejects.toThrow(/HTTP 404/);
    expect(existsSync(join(dir, ".imgtune", "cache", "originals"))).toBe(false);
  });
});

describe("resolveScopeUrls", () => {
  const config = (sitemapUrl?: string) => ({
    projectDir: emptyDir(),
    sitemapUrl,
    urls: {},
    market: "ae-en",
    maxPagesPerPattern: 2,
  });
  const baseUrl = "http://localhost:3999";

  it("never reads a sitemap for a static-only scope", async () => {
    const fetchSitemap = vi.fn(async () => ["/ae-en/eyeglasses"]);
    const out = await resolveScopeUrls(config(), ["/about"], ["/about"], baseUrl, () => {}, fetchSitemap);
    expect(fetchSitemap).not.toHaveBeenCalled();
    expect(out.sitemapSource).toBe("none");
    expect(out.resolved.get("/about")?.source).toBe("static");
  });

  it("takes the first sitemap that resolves an in-scope dynamic pattern and records its URL", async () => {
    const messages: string[] = [];

    const fetchSitemap = vi.fn(async (url: string) => {
      if (url.includes("broken")) throw new Error("HTTP 500");
      return ["/ae-en/eyeglasses", "/ae-en/sunglasses"];
    });
    const out = await resolveScopeUrls(
      config("https://broken.example/sitemap.xml"),
      ["/[store]/[...slug]"],
      ["/[store]/[...slug]"],
      baseUrl,
      (m) => messages.push(m),
      fetchSitemap,
    );
    expect(out.sitemapSource).toBe(`${baseUrl}/sitemap.xml`);
    expect(fetchSitemap).toHaveBeenCalledTimes(2);
    expect(out.resolved.get("/[store]/[...slug]")).toEqual({
      paths: ["/ae-en/eyeglasses", "/ae-en/sunglasses"],
      source: "sitemap",
    });
    expect(messages.join("\n")).toMatch(/broken\.example\/sitemap\.xml unusable: HTTP 500/);
  });

  it("reports none when no candidate resolves the scope", async () => {
    const out = await resolveScopeUrls(
      config(),
      ["/[store]/[...slug]"],
      ["/[store]/[...slug]"],
      baseUrl,
      () => {},
      async () => ["/unrelated"],
    );
    expect(out.sitemapSource).toBe("none");
    expect(out.resolved.get("/[store]/[...slug]")?.source).toBe("none");
  });
});

describe("changedSince", () => {
  it("lists files whose content differs from the audit hash, including missing ones", async () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "same.tsx"), "same");
    writeFileSync(join(dir, "edited.tsx"), "after");
    const changed = await changedSince(dir, {
      "same.tsx": sha1("same"),
      "edited.tsx": sha1("before"),
      "gone.tsx": sha1("gone"),
    });
    expect(changed).toEqual(["edited.tsx", "gone.tsx"]);
  });
});

function readFileText(path: string): string {
  return readFileSync(path, "utf8");
}
