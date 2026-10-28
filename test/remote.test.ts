import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  currentQuality,
  estimateQuality,
  groupKey,
  isChallenge,
  isUndersized,
  makeFetcher,
  neededWidth,
  pageFileName,
  pageNumbers,
  parseScanArgs,
  parseSrcset,
  referenceUrl,
  resizedEstimate,
  rightCandidate,
  robotsAllows,
  siteNumbers,
  viewportTotals,
  type ImageFinding,
} from "../src/remote.js";
import { ssim } from "../src/ssim.js";
import { gradientNoise, rawToPng } from "./image-fixtures.js";

describe("robotsAllows", () => {
  it("allows everything when there is no robots.txt", () => {
    expect(robotsAllows(undefined, "https://shop.example/ae-en/bags")).toBe(true);
  });

  it("applies Disallow rules of the * group by path prefix", () => {
    const robots = "User-agent: *\nDisallow: /admin\nDisallow: /search";
    expect(robotsAllows(robots, "https://shop.example/admin/users")).toBe(false);
    expect(robotsAllows(robots, "https://shop.example/search?q=bag")).toBe(false);
    expect(robotsAllows(robots, "https://shop.example/bags/admin-free")).toBe(true);
  });

  it("ignores groups for other user agents", () => {
    const robots = "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private";
    expect(robotsAllows(robots, "https://shop.example/bags")).toBe(true);
    expect(robotsAllows(robots, "https://shop.example/private/x")).toBe(false);
  });

  it("lets the longer rule win, and Allow win a tie", () => {
    const robots = "User-agent: *\nDisallow: /shop\nAllow: /shop/sale";
    expect(robotsAllows(robots, "https://shop.example/shop/sale/bag")).toBe(true);
    expect(robotsAllows(robots, "https://shop.example/shop/bag")).toBe(false);
    const tie = "User-agent: *\nDisallow: /a\nAllow: /a";
    expect(robotsAllows(tie, "https://shop.example/a")).toBe(true);
  });

  it("supports * wildcards and $ end anchors", () => {
    const robots = "User-agent: *\nDisallow: /*.json$\nDisallow: /tmp*/x";
    expect(robotsAllows(robots, "https://shop.example/data/a.json")).toBe(false);
    expect(robotsAllows(robots, "https://shop.example/data/a.json?v=1")).toBe(true);
    expect(robotsAllows(robots, "https://shop.example/tmp42/x")).toBe(false);
  });

  it("treats an empty Disallow as allow-all and skips comments", () => {
    const robots = "# site rules\nUser-agent: *\nDisallow:\n";
    expect(robotsAllows(robots, "https://shop.example/anything")).toBe(true);
  });

  it("matches the path with its query string", () => {
    const robots = "User-agent: *\nDisallow: /listing?sort=";
    expect(robotsAllows(robots, "https://shop.example/listing?sort=price")).toBe(false);
    expect(robotsAllows(robots, "https://shop.example/listing?page=2")).toBe(true);
  });
});

describe("srcset and right candidate", () => {
  it("parses w-descriptor candidates to absolute URLs and skips x-descriptors", () => {
    const candidates = parseSrcset("/_next/image?w=640 640w, /_next/image?w=1080 1080w, /hero@2x.jpg 2x", "https://shop.example/a");
    expect(candidates).toEqual([
      { url: "https://shop.example/_next/image?w=640", width: 640 },
      { url: "https://shop.example/_next/image?w=1080", width: 1080 },
    ]);
  });

  it("needs ceil(rendered width x dpr), capped at the largest candidate", () => {
    expect(neededWidth(179, 3, 3840)).toBe(537);
    expect(neededWidth(179, 2.5, 384)).toBe(384);
  });

  it("picks the smallest candidate at or above the need, the largest when none is", () => {
    const c = [384, 640, 1080].map((width) => ({ url: `u${width}`, width }));
    expect(rightCandidate(c, 537).width).toBe(640);
    expect(rightCandidate(c, 640).width).toBe(640);
    expect(rightCandidate(c, 2000).width).toBe(1080);
  });

  it("flags an undersized file below 0.9 x need, but not beyond the largest candidate", () => {
    expect(isUndersized(384, 537, 1080)).toBe(true);
    expect(isUndersized(500, 537, 1080)).toBe(false);
    expect(isUndersized(1080, 2000, 1080)).toBe(false);
  });
});

describe("referenceUrl and currentQuality", () => {
  const page = "https://shop.example/ae-en/bags";

  it("resolves the url of /_next/image against the page", () => {
    expect(referenceUrl("https://shop.example/_next/image?url=%2Fimg%2Fp1.jpg&w=640&q=75", page)).toBe(
      "https://shop.example/img/p1.jpg",
    );
    expect(referenceUrl("/_next/image?url=https%3A%2F%2Fcdn.example%2Fp1.jpg&w=640&q=75", page)).toBe(
      "https://cdn.example/p1.jpg",
    );
  });

  it("takes the original of a Cloudflare cdn-cgi image", () => {
    expect(referenceUrl("https://shop.example/cdn-cgi/image/width=640,quality=85,format=auto/img/p1.jpg", page)).toBe(
      "https://shop.example/img/p1.jpg",
    );
  });

  it("has no reference for any other image", () => {
    expect(referenceUrl("https://shop.example/img/p1.jpg", page)).toBeUndefined();
  });

  it("reads the current quality from q= or quality=, else assumes 75", () => {
    expect(currentQuality("https://shop.example/_next/image?url=x&w=640&q=90")).toEqual({ quality: 90, assumed: false });
    expect(currentQuality("https://shop.example/cdn-cgi/image/width=640,quality=82,format=auto/x.jpg")).toEqual({
      quality: 82,
      assumed: false,
    });
    expect(currentQuality("https://shop.example/img/p1.jpg")).toEqual({ quality: 75, assumed: true });
  });
});

describe("aggregation", () => {
  const img = (bytes: number, exact: number, est = 0, growth = 0, estAggressive = est): ImageFinding => ({
    bytes,
    exact,
    est,
    estAggressive,
    growth,
  });

  it("sums per viewport and keeps sharpness out of the savings", () => {
    const totals = viewportTotals([img(1000, 400, 100, 0), img(3000, 0, 0, 500)], 10_000);
    expect(totals).toEqual({ imageBytes: 10_000, exact: 400, est: 100, estAggressive: 100, growth: 500, fixableBytes: 1000 });
  });

  it("page numbers are the mean over viewports of each viewport's share", () => {
    const a = viewportTotals([img(1000, 400)], 2000); // exact 20%
    const b = viewportTotals([img(1000, 200, 200)], 4000); // exact 5%, exact+est 10%
    const page = pageNumbers([a, b]);
    expect(page.meanImageBytes).toBe(3000);
    expect(page.exactPct).toBeCloseTo((20 + 5) / 2, 10);
    expect(page.exactEstPct).toBeCloseTo((20 + 10) / 2, 10);
    expect(page.fixablePct).toBeCloseTo((40 + 40) / 2, 10);
    expect(page.sharpnessKB).toBe(0);
  });

  it("reports sharpness growth separately, as a mean in KB", () => {
    const a = viewportTotals([img(1000, 100, 0, 2048)], 2000);
    const b = viewportTotals([img(1000, 100, 0, 0)], 2000);
    const page = pageNumbers([a, b]);
    expect(page.sharpnessKB).toBe(1);
    expect(page.exactPct).toBe(5);
  });

  it("site numbers are the mean of its pages", () => {
    const p1 = pageNumbers([viewportTotals([img(1000, 300)], 1000)]);
    const p2 = pageNumbers([viewportTotals([img(1000, 100)], 1000)]);
    const site = siteNumbers([p1, p2]);
    expect(site.pages).toBe(2);
    expect(site.exactPct).toBe(20);
  });
});

describe("groupKey", () => {
  it("joins sizes, sorted classes and the width bucketed to 10 px", () => {
    expect(groupKey("33vw", "card  media", 183)).toBe(groupKey("33vw", "media card", 178));
    expect(groupKey("33vw", "card", 183)).not.toBe(groupKey("33vw", "card", 215));
    expect(groupKey("33vw", "card", 183)).not.toBe(groupKey("50vw", "card", 183));
  });

  it("handles a missing sizes attribute and an unrendered image", () => {
    expect(groupKey(undefined, "", undefined)).toBe(groupKey(undefined, "", undefined));
    expect(groupKey(undefined, "", undefined)).not.toBe(groupKey(undefined, "", 100));
  });
});

describe("isChallenge", () => {
  it("is a challenge on 403, 429 and 503 documents", () => {
    expect(isChallenge(403, 10, "<html>")).toBe(true);
    expect(isChallenge(429, 0, "")).toBe(true);
    expect(isChallenge(503, 3, "")).toBe(true);
    expect(isChallenge(200, 10, "<html>")).toBe(false);
  });

  it("is a challenge with no image and a challenge marker in the HTML", () => {
    expect(isChallenge(200, 0, '<div id="cf-chl-widget"></div>')).toBe(true);
    expect(isChallenge(200, 0, "<form>Solve the CAPTCHA</form>")).toBe(true);
    expect(isChallenge(200, 4, "captcha in an article about captchas")).toBe(false);
  });
});

describe("pageFileName", () => {
  it("names the file <host>-<path-slug>.json", () => {
    expect(pageFileName(new URL("https://shop.example/ae-en/bags/"))).toBe("shop.example-ae-en-bags.json");
    expect(pageFileName(new URL("https://shop.example/"))).toBe("shop.example-index.json");
    expect(pageFileName(new URL("http://localhost:3000/en/Bags_1"))).toBe("localhost-3000-en-Bags_1.json");
  });

  it("keeps two pages that differ only by query apart", () => {
    const a = pageFileName(new URL("https://shop.example/bags?sort=price"));
    const b = pageFileName(new URL("https://shop.example/bags?sort=new"));
    expect(a).not.toBe(b);
    expect(a.startsWith("shop.example-bags-")).toBe(true);
  });
});

describe("parseScanArgs", () => {
  it("takes one or more URLs and the defaults", () => {
    expect(parseScanArgs(["https://a.example/", "https://a.example/list"])).toEqual({
      urls: ["https://a.example/", "https://a.example/list"],
      out: ".imgtune/scan",
      aggressive: false,
      quality: true,
      viewports: undefined,
    });
  });

  it("reads --out, --aggressive, --viewports and --no-quality", () => {
    const args = parseScanArgs([
      "https://a.example/",
      "--out",
      "study",
      "--aggressive",
      "--viewports",
      "iphone-15,desktop",
      "--no-quality",
    ]);
    expect(args).toMatchObject({ out: "study", aggressive: true, quality: false, viewports: ["iphone-15", "desktop"] });
  });

  it("rejects a missing URL, a non-http URL, an unknown viewport and an unknown option", () => {
    expect(() => parseScanArgs([])).toThrow(/at least one URL/);
    expect(() => parseScanArgs(["ftp://a.example/"])).toThrow(/http or https/);
    expect(() => parseScanArgs(["https://a.example/", "--viewports", "watch"])).toThrow(/Unknown viewport watch/);
    expect(() => parseScanArgs(["https://a.example/", "--depth", "2"])).toThrow(/Unknown option --depth/);
    expect(() => parseScanArgs(["https://a.example/", "--out"])).toThrow(/--out needs a value/);
  });
});

describe("makeFetcher", () => {
  it("fetches each URL once, however often it is asked for", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(Buffer.from("abc"), { status: 200 });
    }) as typeof fetch;
    const fetcher = makeFetcher({ userAgent: "ua", fetchImpl });
    const [a, b] = await Promise.all([fetcher.get("https://shop.example/a.jpg"), fetcher.get("https://shop.example/a.jpg")]);
    expect(calls).toBe(1);
    expect(a?.toString()).toBe("abc");
    expect(b).toBe(a);
  });

  it("runs at most two fetches at once", async () => {
    let running = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return new Response(Buffer.from("x"), { status: 200 });
    }) as typeof fetch;
    const fetcher = makeFetcher({ userAgent: "ua", fetchImpl });
    await Promise.all(["a", "b", "c", "d", "e"].map((name) => fetcher.get(`https://shop.example/${name}.jpg`)));
    expect(peak).toBe(2);
  });

  it("resolves a failed or non-2xx fetch to undefined without retrying it", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const fetcher = makeFetcher({ userAgent: "ua", fetchImpl });
    expect(await fetcher.get("https://shop.example/missing.jpg")).toBeUndefined();
    expect(await fetcher.get("https://shop.example/missing.jpg")).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("sends the given user agent", async () => {
    let agent: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      agent = new Headers(init?.headers).get("user-agent");
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await makeFetcher({ userAgent: "Chrome/125 test", fetchImpl }).get("https://shop.example/robots.txt");
    expect(agent).toBe("Chrome/125 test");
  });
});

describe("resizedEstimate", () => {
  it("resizes a JPEG to the needed width and estimates fewer bytes than the served file", async () => {
    const served = await sharp(gradientNoise(800, 600, 6, 3).data, { raw: { width: 800, height: 600, channels: 4 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    const out = await resizedEstimate(served, "jpeg", 320);
    expect(out).toBeDefined();
    expect(out!.bytes).toBeLessThan(served.length);
    expect((await sharp(out!.buffer).metadata()).width).toBe(320);
  });

  it("resizes a PNG losslessly and has no estimate for a format it cannot encode", async () => {
    const png = await sharp({ create: { width: 500, height: 400, channels: 3, background: "#336699" } }).png().toBuffer();
    const out = await resizedEstimate(png, "png", 100);
    expect((await sharp(out!.buffer).metadata()).width).toBe(100);
    expect(await resizedEstimate(png, "gif", 100)).toBeUndefined();
  });
});

describe("estimateQuality", () => {
  it("projects the bytes of the right file at the relative bar, never above today's bytes", async () => {
    const pixels = gradientNoise(160, 120, 4, 7);
    const original = await rawToPng(pixels);
    const served = await sharp(pixels.data, { raw: { width: 160, height: 120, channels: 4 } }).webp({ quality: 90 }).toBuffer();
    const estimate = await estimateQuality(
      { original, served, format: "webp", bytes: served.length, width: 160, height: 120, current: 90 },
      [2, 4],
      { score: (ref, test) => ssim(ref, test) * 100 },
    );
    expect(estimate).toBeDefined();
    expect(estimate!.ratio[2]).toBeGreaterThan(0);
    expect(estimate!.ratio[2]).toBeLessThanOrEqual(1);
    expect(estimate!.ratio[4]).toBeLessThanOrEqual(estimate!.ratio[2] + 1e-9);
    expect(estimate!.target).toBeLessThanOrEqual(90);
  });

  it("estimates an AVIF for a JPEG or PNG right file and no quality for other formats", async () => {
    const pixels = gradientNoise(160, 120, 4, 9);
    const original = await rawToPng(pixels);
    const served = await sharp(pixels.data, { raw: { width: 160, height: 120, channels: 4 } }).jpeg({ quality: 95 }).toBuffer();
    const estimate = await estimateQuality(
      { original, served, format: "jpeg", bytes: served.length, width: 160, height: 120, current: 75 },
      [2, 4],
      { score: (ref, test) => ssim(ref, test) * 100 },
    );
    expect(estimate?.format).toBe("avif");
    expect(estimate?.target).toBeUndefined();
    expect(
      await estimateQuality(
        { original, served, format: "gif", bytes: served.length, width: 160, height: 120, current: 75 },
        [2],
        { score: (ref, test) => ssim(ref, test) * 100 },
      ),
    ).toBeUndefined();
  });
});
