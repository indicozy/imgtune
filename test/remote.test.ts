import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import {
  analysePage,
  currentQuality,
  decodeRaw,
  estimateQuality,
  qualityHintFor,
  groupKey,
  isChallenge,
  isUndersized,
  clampWidth,
  guardedLookup,
  ipv6Bytes,
  isBlockedAddress,
  duplicatesOf,
  groupReports,
  makeFetcher,
  netSavings,
  neededWidth,
  openImage,
  ruleMatches,
  pageFileName,
  pageNumbers,
  FAIL_OVER_EXIT,
  mdCode,
  mdText,
  pagesOverBudget,
  parseScanArgs,
  parseSrcset,
  pixelSize,
  referenceUrl,
  renderMarkdown,
  resizedEstimate,
  rightCandidate,
  renderPage,
  robotsAllows,
  safeText,
  siteNumbers,
  summaryOf,
  viewportTotals,
  type AnalysisContext,
  type Instance,
  type ImageFinding,
  type ObservedImage,
  type PageResult,
  type ViewportObservation,
} from "../src/remote.js";
import type { encode } from "../src/encode.js";
import { ssim, type RawImage } from "../src/ssim.js";
import type { Viewport } from "../src/types.js";
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

  it("splits candidates on a comma with no space after its descriptor, as the HTML srcset algorithm does", () => {
    expect(parseSrcset("a.jpg 400w,b.jpg 800w", "https://shop.example/")).toEqual([
      { url: "https://shop.example/a.jpg", width: 400 },
      { url: "https://shop.example/b.jpg", width: 800 },
    ]);
  });

  it("keeps the commas inside a URL, as Cloudinary transforms have them, while splitting the candidates", () => {
    const srcset =
      "https://res.cloudinary.com/demo/image/upload/w_400,q_80/a.jpg 400w,https://res.cloudinary.com/demo/image/upload/w_800,q_80/a.jpg 800w";
    expect(parseSrcset(srcset, "https://shop.example/")).toEqual([
      { url: "https://res.cloudinary.com/demo/image/upload/w_400,q_80/a.jpg", width: 400 },
      { url: "https://res.cloudinary.com/demo/image/upload/w_800,q_80/a.jpg", width: 800 },
    ]);
  });

  it("drops a candidate with no descriptor, with two descriptors, or with a trailing comma and no width", () => {
    expect(parseSrcset("a.jpg, b.jpg 800w 2x, c.jpg, d.jpg 900w", "https://shop.example/")).toEqual([
      { url: "https://shop.example/d.jpg", width: 900 },
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

  it("unwraps a next/image loader around another loader, as originalFor does", () => {
    const shopify = encodeURIComponent("https://cdn.shopify.com/s/files/1/0001/products/shirt_600x600.jpg?v=3");
    expect(referenceUrl(`/_next/image?url=${shopify}&w=640&q=75`, page)).toBe("https://cdn.shopify.com/s/files/1/0001/products/shirt.jpg?v=3");
    const cloudinary = encodeURIComponent("https://res.cloudinary.com/demo/image/upload/w_800,q_80/v1/a.jpg");
    expect(referenceUrl(`/_next/image?url=${cloudinary}&w=640&q=75`, page)).toBe("https://res.cloudinary.com/demo/image/upload/v1/a.jpg");
  });

  it("reads the current quality from q= or quality=, else assumes 75", () => {
    expect(currentQuality("https://shop.example/_next/image?url=x&w=640&q=90")).toEqual({ quality: 90, assumed: false });
    expect(currentQuality("https://shop.example/cdn-cgi/image/width=640,quality=82,format=auto/x.jpg")).toEqual({
      quality: 82,
      assumed: false,
    });
    expect(currentQuality("https://shop.example/img/p1.jpg")).toEqual({ quality: 75, assumed: true });
  });

  it("takes a documented loader default when the URL has no quality, and assumes 75 otherwise", () => {
    expect(currentQuality("https://shop.example/_next/image?url=x&w=640")).toEqual({ quality: 75, assumed: false });
    expect(currentQuality("https://shop.example/cdn-cgi/image/width=640,format=auto/x.jpg")).toEqual({ quality: 85, assumed: false });
    expect(currentQuality("https://images.ctfassets.net/s/e/abc/hero.jpg")).toEqual({ quality: 75, assumed: true });
    expect(currentQuality("https://cdn.shopify.com/s/files/1/0001/x.jpg")).toEqual({ quality: 75, assumed: true });
  });

  it("reads the quality and the original of loaders beyond next and cdn-cgi", () => {
    expect(currentQuality("https://images.ctfassets.net/s/e/abc/hero.jpg?w=400&q=70")).toEqual({ quality: 70, assumed: false });
    expect(currentQuality("https://res.cloudinary.com/demo/image/upload/w_400,q_60/a.jpg")).toEqual({ quality: 60, assumed: false });
    expect(referenceUrl("https://images.ctfassets.net/s/e/abc/hero.jpg?w=400&q=70", page)).toBe(
      "https://images.ctfassets.net/s/e/abc/hero.jpg",
    );
    expect(referenceUrl("https://cdn.shopify.com/s/files/1/0001/products/shirt_600x600.jpg?width=600", page)).toBe(
      "https://cdn.shopify.com/s/files/1/0001/products/shirt_600x600.jpg",
    );
    expect(referenceUrl("https://res.cloudinary.com/demo/image/upload/c_fill,w_300/v1/a.jpg", page)).toBe(
      "https://res.cloudinary.com/demo/image/upload/v1/a.jpg",
    );
  });

  it("gives a Cloudinary auto quality no number", () => {
    expect(currentQuality("https://res.cloudinary.com/demo/image/upload/q_auto/a.jpg")).toEqual({ quality: 75, assumed: true });
  });
});

describe("qualityHintFor", () => {
  it("says how to get the saving for a loader that cannot take a quality", () => {
    expect(qualityHintFor("shopify", "none", 60)).toBe("shopify: no quality parameter — re-export sources at lower quality");
    expect(qualityHintFor("cloudinary", "auto", undefined)).toBe("cloudinary: q_auto in use — set an explicit q_<N>");
  });

  it("names the quality for a tunable loader only once a quality is estimated", () => {
    expect(qualityHintFor("contentful", "yes", 62)).toBe("contentful: set quality=62");
    expect(qualityHintFor("contentful", "yes", undefined)).toBeUndefined();
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


describe("parseScanArgs for the CI outputs", () => {
  it("reads --markdown, --fail-over and --summary-json", () => {
    expect(
      parseScanArgs(["https://a.example/", "--markdown", "out/pr.md", "--fail-over", "2.5", "--summary-json", "s.json"]),
    ).toMatchObject({ markdown: "out/pr.md", failOver: 2.5, summaryJson: "s.json" });
  });

  it("reads --fail-over 0 as a limit, and leaves it unset by default", () => {
    expect(parseScanArgs(["https://a.example/", "--fail-over", "0"]).failOver).toBe(0);
    expect(parseScanArgs(["https://a.example/"]).failOver).toBeUndefined();
  });

  it("rejects a missing or malformed --fail-over, and a missing --markdown value", () => {
    expect(() => parseScanArgs(["https://a.example/", "--fail-over"])).toThrow(/--fail-over needs a value/);
    expect(() => parseScanArgs(["https://a.example/", "--fail-over", "-1"])).toThrow(/from 0 to 100/);
    expect(() => parseScanArgs(["https://a.example/", "--fail-over", "101"])).toThrow(/from 0 to 100/);
    expect(() => parseScanArgs(["https://a.example/", "--fail-over", "1e2"])).toThrow(/from 0 to 100/);
    expect(() => parseScanArgs(["https://a.example/", "--markdown", "--out"])).toThrow(/--markdown needs a value/);
  });
});

/** A measured page with the given numbers; everything else is empty. */
function pageResult(over: Partial<PageResult> = {}): PageResult {
  return {
    url: "https://shop.example/",
    host: "shop.example",
    scannedAt: "",
    imgtuneVersion: "0",
    metric: "ssimulacra2",
    delta: 2,
    viewports: ["iphone-15", "desktop"],
    status: "ok",
    nextjs: false,
    perViewport: {},
    groups: [],
    counts: { images: 1, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
    page: { meanImageBytes: 3235 * 1024, exactPct: 0, exactEstPct: 33.04, fixablePct: 40, sharpnessKB: 2 },
    ...over,
  };
}

describe("mdText, mdCode and the Markdown summary", () => {
  it("escapes plain text: no mention, link, heading, math, strike or HTML survives", () => {
    const out = mdText("a|b `c` @user <!-- x --> [l](u) *b* _i_ \\ & #1 ~s~ $x$");
    expect(out.replace(/&#?\w+;/g, "")).not.toMatch(/[|`@<[\]*_\\#~$]/);
    expect(out).toContain("&#64;user");
    expect(out).toContain("&#35;1");
    expect(out).toContain("&#126;s&#126;");
    expect(out).toContain("&#36;x&#36;");
    expect(mdText("line\nbreak\u001b[2J")).toBe("linebreak&#91;2J");
  });

  it("puts page text in code spans, which do not autolink, mention or format", () => {
    expect(mdCode("#1 https://evil.example www.x.y @user $x$ ~a~")).toBe("`#1 https://evil.example www.x.y @user $x$ ~a~`");
    expect(mdCode("33vw `@x` | 50vw")).toBe("`33vw \u02bc@x\u02bc \\| 50vw`");
    expect(mdCode("a<!--b")).toBe("`a\u2039!--b`");
    expect(mdCode("")).toBe("`-`");
  });

  it("renders one row per page, the page as a code span of host and path, and keeps rows the same width", () => {
    const md = renderMarkdown(
      [pageResult(), pageResult({ url: "https://shop.example/b", status: "blocked", error: "challenge at desktop", page: undefined })],
      false,
    );
    const rows = md.split("\n").filter((line) => line.startsWith("| `shop.example/"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^\| `shop\.example\/` \| ok \| 3235 \| 0\.0% \| 33\.0% \| \+2\.0 KB \|/);
    expect(rows[1]).toContain("`challenge at desktop`");
    for (const row of rows) expect(row.split("|").length - 1).toBe(7);
    expect(md).toContain("Viewports: `iphone-15`, `desktop`.");
  });

  it("lists the top five groups as code spans, with hostile sizes escaped", () => {
    const groups = Array.from({ length: 6 }, (_, i) => ({
      key: `k${i}`,
      sizes: i === 0 ? "33vw | 50vw `@x` <!-- m -->" : undefined,
      suggestedSizes: "280px",
      savedBytes: 2048 * (6 - i),
      members: 1,
      samples: [],
      loader: "next/image",
      hint: i === 0 ? 'set sizes="280px"' : undefined,
      qualityHint: i === 1 ? "lower quality" : undefined,
    }));
    const md = renderMarkdown([pageResult({ groups })], false);
    expect(md).not.toContain("<!--");
    expect(md).not.toContain("`@x`");
    expect(md).toContain("| no sizes | `280px` | 10 | `next/image` | `lower quality` |");
    expect(md).toContain('| `33vw \\| 50vw \u02bc@x\u02bc \u2039!-- m -->` | `280px` | 12 | `next/image` | `set sizes="280px"` |');
    expect(md.split("\n").filter((line) => line.startsWith("| ") && line.includes("`next/image`"))).toHaveLength(5);
  });

  it("adds the delta 4 column only with --aggressive", () => {
    const aggressive = pageResult({ page: { meanImageBytes: 1024, exactPct: 1, exactEstPct: 2, fixablePct: 3, sharpnessKB: 0, aggressiveExactEstPct: 4.5 } });
    expect(renderMarkdown([aggressive], true)).toContain("exact + est. at delta 4");
    expect(renderMarkdown([aggressive], true)).toContain("| 4.5% |");
    expect(renderMarkdown([aggressive], false)).not.toContain("delta 4");
  });
});

describe("the CI budget and summary", () => {
  it("exits 3 for a page whose exact + est. share is above the limit, and only for those", () => {
    const over = pageResult({ url: "https://a.example/", page: { meanImageBytes: 1, exactPct: 0, exactEstPct: 5, fixablePct: 0, sharpnessKB: 0 } });
    const under = pageResult({ url: "https://b.example/", page: { meanImageBytes: 1, exactPct: 0, exactEstPct: 1, fixablePct: 0, sharpnessKB: 0 } });
    expect(FAIL_OVER_EXIT).toBe(3);
    expect(pagesOverBudget([over, under], 0).map((p) => p.url)).toEqual(["https://a.example/", "https://b.example/"]);
    expect(pagesOverBudget([over, under], 2).map((p) => p.url)).toEqual(["https://a.example/"]);
    expect(pagesOverBudget([over, under], 5)).toEqual([]);
  });

  it("never counts a page that was not measured", () => {
    const blocked = pageResult({ status: "blocked", page: undefined, error: "challenge at desktop" });
    expect(pagesOverBudget([blocked], 0)).toEqual([]);
  });

  it("writes the status and the numbers of every page, and the error of a page that failed", () => {
    const blocked = pageResult({ url: "https://b.example/", status: "blocked", page: undefined, error: "challenge" });
    const summary = summaryOf([pageResult(), blocked]);
    expect(summary.pages).toHaveLength(2);
    expect(summary.pages[0]).toMatchObject({ url: "https://shop.example/", status: "ok", page: { exactEstPct: 33.04 } });
    expect(summary.pages[1]).toEqual({ url: "https://b.example/", host: "shop.example", status: "blocked", error: "challenge" });
    expect(summary.pages[1]).not.toHaveProperty("page");
  });
});

describe("pixelSize", () => {
  it("names an AVIF file avif, not the heif that sharp reports for it", async () => {
    const raw = gradientNoise(64, 48, 4, 1);
    const avif = await sharp(raw.data, { raw: { width: 64, height: 48, channels: 4 } }).avif({ quality: 50 }).toBuffer();
    expect(await pixelSize(avif)).toMatchObject({ width: 64, height: 48, format: "avif" });
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
  it("bars the candidates by the served file's own score, so an assumed current quality cannot move the bar", async () => {
    const pixels = gradientNoise(160, 120, 4, 7);
    const original = await rawToPng(pixels);
    const served = await sharp(pixels.data, { raw: { width: 160, height: 120, channels: 4 } }).webp({ quality: 60 }).toBuffer();
    const scored: RawImage[] = [];
    const score = (ref: RawImage, test: RawImage) => {
      scored.push(test);
      return ssim(ref, test) * 100;
    };
    // The URL is taken to ask for 90 (or was assumed to): the served bytes are those of quality 60.
    await estimateQuality(
      { original, served, format: "webp", bytes: served.length, width: 160, height: 120, current: 90 },
      [2],
      { score },
    );
    const servedRaw = await decodeRaw(served, { width: 160, height: 120 });
    const isServed = (img: RawImage) => img.width === servedRaw.width && img.data.length === servedRaw.data.length && img.data.every((v, i) => v === servedRaw.data[i]);
    expect(scored.some(isServed)).toBe(true);
  });

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

  it("gives no format saving (ratio 1) when no AVIF quality from the start up to 100 reaches the bar", async () => {
    const pixels = gradientNoise(160, 120, 4, 9);
    const original = await rawToPng(pixels);
    const served = await sharp(pixels.data, { raw: { width: 160, height: 120, channels: 4 } }).jpeg({ quality: 95 }).toBuffer();
    const estimate = await estimateQuality(
      { original, served, format: "jpeg", bytes: 1000, width: 160, height: 120, current: 75 },
      [2],
      { encode: avifStub(), score: fakeAvifScore(undefined) },
    );
    expect(estimate?.format).toBe("avif");
    expect(estimate?.ratio[2]).toBe(1);
  });

  it("takes the AVIF ratio from the first quality above the start that reaches the bar when the start does not", async () => {
    const pixels = gradientNoise(160, 120, 4, 9);
    const original = await rawToPng(pixels);
    const served = await sharp(pixels.data, { raw: { width: 160, height: 120, channels: 4 } }).jpeg({ quality: 95 }).toBuffer();
    const estimate = await estimateQuality(
      { original, served, format: "jpeg", bytes: 1000, width: 160, height: 120, current: 75 },
      [2],
      { encode: avifStub(), score: fakeAvifScore(96) },
    );
    // AVIF at 96 is 96 x 5 = 480 bytes against 1000 served: the start (90, 450 bytes) failed the bar, so it is not used.
    expect(estimate?.ratio[2]).toBeCloseTo(0.48, 10);
  });

  it("keeps the ratio of 1 for WebP when the local encode at the current quality misses the bar", async () => {
    const pixels = gradientNoise(160, 120, 4, 11);
    const original = await rawToPng(pixels);
    const served = await sharp(pixels.data, { raw: { width: 160, height: 120, channels: 4 } }).webp({ quality: 60 }).toBuffer();
    const estimate = await estimateQuality(
      { original, served, format: "webp", bytes: served.length, width: 160, height: 120, current: 60 },
      [2],
      { score: () => 10 },
    );
    expect(estimate?.ratio[2]).toBe(1);
  });
});

/** A stub AVIF encoder: the decoded image carries the quality, and the bytes are five per quality point. */
function avifStub(): typeof encode {
  return (async (_ref: RawImage, _format: "avif" | "webp", quality: number) => ({
    bytes: quality * 5,
    decoded: { data: Uint8ClampedArray.of(quality), width: 1, height: 1 },
    buffer: Buffer.alloc(0),
  })) as typeof encode;
}

/** Scores the stub's AVIF at 90 from quality `passAt` up and at 10 below it; the served file (many pixels) scores 90. */
function fakeAvifScore(passAt: number | undefined) {
  return (_ref: RawImage, test: RawImage): number => {
    if (test.data.length !== 1) return 90;
    return passAt !== undefined && test.data[0] >= passAt ? 90 : 10;
  };
}

describe("ruleMatches", () => {
  it("matches prefixes, * runs and a $ end anchor", () => {
    expect(ruleMatches("/admin", "/admin/users")).toBe(true);
    expect(ruleMatches("/admin", "/other")).toBe(false);
    expect(ruleMatches("/*.json$", "/a/b.json")).toBe(true);
    expect(ruleMatches("/*.json$", "/a/b.json?x=1")).toBe(false);
    expect(ruleMatches("/a*b*c", "/a-b-x-c")).toBe(true);
    expect(ruleMatches("/a*b*c", "/a-c-b")).toBe(false);
    expect(ruleMatches("/x$", "/x")).toBe(true);
  });

  it("finishes quickly on inputs built to backtrack", () => {
    const started = Date.now();
    expect(ruleMatches("*a*a*a*a*a*a*a*b", "a".repeat(20_000))).toBe(false);
    expect(ruleMatches("/*a*a*a*a*c$", `/${"a".repeat(20_000)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ignores robots rules longer than 1024 characters", () => {
    const long = `/${"x".repeat(1100)}`;
    expect(robotsAllows(`User-agent: *\nDisallow: ${long}`, `https://shop.example${long}`)).toBe(true);
  });
});

describe("resource bounds", () => {
  it("drops srcset candidates above 8192 or not above zero", () => {
    const candidates = parseSrcset("/a.jpg 0w, /b.jpg 9000w, /c.jpg 640w", "https://shop.example/");
    expect(candidates.map((c) => c.width)).toEqual([640]);
  });

  it("clamps target widths to 1..8192", () => {
    expect(clampWidth(20_000)).toBe(8192);
    expect(clampWidth(0)).toBe(1);
    expect(clampWidth(640.7)).toBe(640);
  });

  it("refuses an image above the pixel limit", async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).png().toBuffer();
    await expect(openImage(png, 100).metadata()).rejects.toThrow();
    expect((await openImage(png).metadata()).width).toBe(20);
  });
});

describe("isBlockedAddress", () => {
  it("blocks every IPv4 range of the list", () => {
    for (const address of [
      "0.1.2.3", "10.1.1.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.1",
      "192.0.0.9", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
      "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("blocks every IPv6 range of the list", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "2001:db8::1", "64:ff9b::808:808", "2002:c000:204::1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("unwraps IPv4-mapped and IPv4-compatible addresses in every textual form", () => {
    for (const address of [
      "::ffff:7f00:1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:7f00:1",
      "0000:0000:0000:0000:0000:FFFF:7F00:0001",
      "::127.0.0.1",
      "::ffff:a9fe:a9fe",
      "::ffff:169.254.169.254",
      "::ffff:10.0.0.1",
      "::ffff:192.168.0.1",
      "::ffff:100.64.0.1",
      "::ffff:8.8.8.8",
      "0:0:0:0:0:ffff:0808:0808",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("allows public addresses, including ones next to the blocked ranges", () => {
    for (const address of [
      "93.184.216.34", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "172.15.0.1", "198.20.0.1",
      "2606:4700::1111", "2a00:1450::1",
    ]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("blocks the further special-purpose IPv6 ranges and their embedded IPv4", () => {
    for (const address of ["64:ff9b:1::1", "2001::1", "2001:0:4136:e378::1", "::ffff:0:1", "64:ff9b::808:808", "64:ff9b::a00:1", "64:ff9b::7f00:1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("parses IPv6 in its compressed and expanded forms to the same 16 bytes", () => {
    expect(Buffer.from(ipv6Bytes("::ffff:7f00:1")!).toString("hex")).toBe("00000000000000000000ffff7f000001");
    expect(Buffer.from(ipv6Bytes("0:0:0:0:0:ffff:127.0.0.1")!).toString("hex")).toBe("00000000000000000000ffff7f000001");
    expect(ipv6Bytes("1:2:3")).toBeUndefined();
  });
});

describe("guardedLookup (connect time)", () => {
  const ask = (lookup: ReturnType<typeof guardedLookup>, host: string, all: boolean) =>
    new Promise<unknown[]>((resolve) => (lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(host, { all }, (...args) => resolve(args)));

  it("passes the checked address on when every answer is public", async () => {
    const lookup = guardedLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    expect(await ask(lookup, "shop.example", false)).toEqual([null, "93.184.216.34", 4]);
    expect(await ask(lookup, "shop.example", true)).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });

  it("refuses when any answer is blocked, even with a public one among them", async () => {
    const lookup = guardedLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ]);
    const [err] = await ask(lookup, "rebind.example", false);
    expect(err).toBeInstanceOf(Error);
  });

  it("refuses a resolver failure and an empty answer", async () => {
    expect((await ask(guardedLookup(async () => { throw new Error("nxdomain"); }), "x.example", false))[0]).toBeInstanceOf(Error);
    expect((await ask(guardedLookup(async () => []), "x.example", false))[0]).toBeInstanceOf(Error);
  });
});

/** A local HTTP server on 127.0.0.1 for the fetcher tests. Nothing leaves the machine. */
async function localServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ base: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

describe("makeFetcher over a local server", () => {
  let base = "";
  let server: Server | undefined;
  const hits: string[] = [];
  let inFlight = 0;
  let peak = 0;
  let agent: string | undefined;
  let accept: string | undefined;

  beforeAll(async () => {
    const started = await localServer(async (req, res) => {
      hits.push(req.url ?? "");
      agent = req.headers["user-agent"];
      accept = req.headers.accept;
      inFlight++;
      peak = Math.max(peak, inFlight);
      const finish = (status: number, body: string | null, headers: Record<string, string> = {}) => {
        inFlight--;
        res.writeHead(status, headers);
        res.end(body ?? undefined);
      };
      const url = req.url ?? "";
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (url === "/ok") return finish(200, "abc");
      if (url === "/missing") return finish(404, "nope");
      if (url === "/done") return finish(200, "done");
      if (url.startsWith("/r/")) {
        const n = Number(url.slice(3));
        if (n >= 3) return finish(200, "done");
        return finish(302, null, { location: `/r/${n + 1}` });
      }
      if (url.startsWith("/chain/")) {
        const n = Number(url.slice(7));
        return finish(302, null, { location: `/chain/${n + 1}` });
      }
      if (url === "/file-redirect") return finish(302, null, { location: "file:///etc/passwd" });
      if (url === "/declared") return finish(200, "x", { "content-length": "999" });
      if (url === "/stream") {
        res.writeHead(200);
        res.write(Buffer.alloc(6));
        res.write(Buffer.alloc(6));
        return setTimeout(() => {
          inFlight--;
          res.end();
        }, 10);
      }
      return finish(200, "0123456789");
    });
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("fetches each URL once, however often it is asked for", async () => {
    hits.length = 0;
    const fetcher = makeFetcher({ userAgent: "ua" });
    const [a, b] = await Promise.all([fetcher.get(`${base}/ok`, { allowPrivate: true }), fetcher.get(`${base}/ok`, { allowPrivate: true })]);
    expect(hits.filter((h) => h === "/ok")).toHaveLength(1);
    expect(a?.toString()).toBe("abc");
    expect(b).toBe(a);
  });

  it("runs at most two fetches at once", async () => {
    peak = 0;
    const fetcher = makeFetcher({ userAgent: "ua" });
    await Promise.all(["a", "b", "c", "d", "e"].map((name) => fetcher.get(`${base}/n/${name}`, { allowPrivate: true })));
    expect(peak).toBe(2);
  });

  it("resolves a non-2xx answer to undefined without retrying it", async () => {
    hits.length = 0;
    const fetcher = makeFetcher({ userAgent: "ua" });
    expect(await fetcher.get(`${base}/missing`, { allowPrivate: true })).toBeUndefined();
    expect(await fetcher.get(`${base}/missing`, { allowPrivate: true })).toBeUndefined();
    expect(hits.filter((h) => h === "/missing")).toHaveLength(1);
  });

  it("sends the given user agent", async () => {
    await makeFetcher({ userAgent: "Chrome/125 test" }).get(`${base}/ok`, { allowPrivate: true });
    expect(agent).toBe("Chrome/125 test");
    expect(accept).toContain("image/avif");
  });

  it("refuses non-http schemes", async () => {
    expect(await makeFetcher({ userAgent: "ua" }).get("file:///etc/passwd")).toBeUndefined();
  });

  it("refuses a literal private or loopback host without a request, unless the page is private", async () => {
    hits.length = 0;
    const fetcher = makeFetcher({ userAgent: "ua" });
    expect(await fetcher.get(`${base}/ok`)).toBeUndefined();
    expect(await fetcher.get("http://[::ffff:127.0.0.1]/ok")).toBeUndefined();
    expect(hits).toHaveLength(0);
    expect((await fetcher.get(`${base}/done`, { allowPrivate: true }))?.toString()).toBe("done");
  });

  it("refuses a name whose address is blocked at connect time, with no request", async () => {
    const fetcher = makeFetcher({ userAgent: "ua", resolver: async () => [{ address: "10.0.0.7", family: 4 }] });
    expect(await fetcher.get(`http://internal.test:${new URL(base).port}/ok`)).toBeUndefined();
  });

  it("follows at most three redirects, by hand", async () => {
    hits.length = 0;
    const fetcher = makeFetcher({ userAgent: "ua" });
    expect((await fetcher.get(`${base}/r/0`, { allowPrivate: true }))?.toString()).toBe("done");
    expect(hits).toEqual(["/r/0", "/r/1", "/r/2", "/r/3"]);
    expect(await fetcher.get(`${base}/chain/0`, { allowPrivate: true })).toBeUndefined();
  });

  it("refuses a redirect to a non-http scheme", async () => {
    expect(await makeFetcher({ userAgent: "ua" }).get(`${base}/file-redirect`, { allowPrivate: true })).toBeUndefined();
  });

  it("refuses a body whose declared length is over the limit", async () => {
    expect(await makeFetcher({ userAgent: "ua" }).get(`${base}/declared`, { allowPrivate: true, maxBytes: 10 })).toBeUndefined();
  });

  it("aborts a streamed body once it passes the limit, and returns one under it", async () => {
    const fetcher = makeFetcher({ userAgent: "ua" });
    expect(await fetcher.get(`${base}/stream`, { allowPrivate: true, maxBytes: 10 })).toBeUndefined();
    expect((await fetcher.get(`${base}/ok`, { allowPrivate: true, maxBytes: 10 }))?.length).toBe(3);
  });

  it("reports whether a page host is private", async () => {
    const privateFetcher = makeFetcher({ userAgent: "ua", resolver: async () => [{ address: "127.0.0.1", family: 4 }] });
    expect(await privateFetcher.isPrivateHost("http://localhost:3000/")).toBe(true);
    const publicFetcher = makeFetcher({ userAgent: "ua", resolver: async () => [{ address: "93.184.216.34", family: 4 }] });
    expect(await publicFetcher.isPrivateHost("https://shop.example/")).toBe(false);
    expect(await publicFetcher.isPrivateHost("http://[::1]/")).toBe(true);
  });
});

describe("safeText and terminal output", () => {
  it("strips C0 and C1 control characters, ESC included", () => {
    expect(safeText("a\u001b[2Jb\u0007c\u009bd\u007fe\nf")).toBe("a[2Jbcdef");
    expect(safeText("\u001b]0;title\u0007x")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("caps the length at 200 characters, ending in an ellipsis", () => {
    const long = "x".repeat(500);
    expect(safeText(long)).toBe(`${"x".repeat(197)}...`);
    expect(safeText(long).length).toBe(200);
    expect(safeText("short")).toBe("short");
  });

  it("prints page-derived sizes and hints without any control character", () => {
    const page = {
      url: "https://shop.example/\u001b[31mred",
      host: "shop.example",
      scannedAt: "",
      imgtuneVersion: "0",
      metric: "ssimulacra2" as const,
      delta: 2,
      viewports: ["iphone-15"],
      status: "ok" as const,
      nextjs: false,
      perViewport: {},
      counts: { images: 1, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
      page: { meanImageBytes: 1, exactPct: 1, exactEstPct: 1, fixablePct: 1, sharpnessKB: 0 },
      groups: [
        {
          key: "k",
          sizes: "33vw\u001b[2J",
          suggestedSizes: "280px\u009b",
          savedBytes: 2048,
          members: 1,
          samples: [],
          hint: 'set sizes="280px"\u001b[0m',
        },
      ],
    };
    const lines = renderPage(page, false);
    for (const line of lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(lines.join("\n")).toContain("33vw[2J -> 280px");
  });
});

describe("netSavings", () => {
  it("counts the resolution saving once and the quality saving on the right file", () => {
    // served 30k, right 10k at ratio .7: the page would get 7k, so 23k in total, 20k of it resolution.
    expect(netSavings(30_000, 10_000, 0.7)).toEqual({ exact: 20_000, est: 3_000, total: 23_000 });
  });

  it("saves nothing when the right file is bigger than the served one, whatever the ratio", () => {
    expect(netSavings(10_000, 30_000, 0.7)).toEqual({ exact: 0, est: 0, total: 0 });
    expect(netSavings(10_000, 10_000, 1)).toEqual({ exact: 0, est: 0, total: 0 });
  });

  it("never reports an est below zero", () => {
    for (const [served, right, ratio] of [[1, 2, 0.5], [5, 5, 0.9], [100, 40, 1]]) {
      expect(netSavings(served, right, ratio).est).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("groupReports", () => {
  const phone = (name: string): Viewport => ({ name, width: 390, height: 844, dpr: 3, mobile: true });
  const member = (viewport: Viewport, exact: number): Instance => ({
    viewport,
    element: 0,
    img: { index: 0, currentSrc: "https://shop.example/a.jpg", renderedWidth: 390, renderedHeight: 260, srcset: "", classes: "", nextImage: false, inFirstViewport: true },
    url: "https://shop.example/a.jpg",
    bytes: 0,
    pixelWidth: 0,
    renderedWidth: 390,
    needed: 1170,
    kind: "srcset",
    exact,
    est: 0,
    estAggressive: 0,
    growth: 0,
    group: "card",
    loader: "generic",
    qualityParam: "yes",
  });

  it("divides a group by the page's viewport count, so a mobile-only group saves its share of each page view", () => {
    const shown = ["p1", "p2", "p3", "p4"].map((name) => member(phone(name), 1000));
    const [report] = groupReports(shown, 6);
    // 4000 bytes over 6 viewports: the page's savings stay the sum over viewports, so the groups add up to at most them.
    expect(report.savedBytes).toBeCloseTo(4000 / 6, 10);
  });
});

describe("duplicatesOf", () => {
  it("maps each element of a URL to the one with the largest rendered width, ties to the first", () => {
    const map = duplicatesOf([
      { index: 0, currentSrc: "https://shop.example/a.jpg", renderedWidth: 120 },
      { index: 1, currentSrc: "https://shop.example/a.jpg", renderedWidth: 300 },
      { index: 2, currentSrc: "https://shop.example/a.jpg", renderedWidth: 300 },
      { index: 3, currentSrc: "https://shop.example/b.jpg", renderedWidth: 50 },
    ]);
    expect([...map.entries()]).toEqual([
      [0, 1],
      [2, 1],
    ]);
  });

  it("on a tie in width, measures the element that has a srcset, since only it has a right candidate", () => {
    const map = duplicatesOf([
      { index: 0, currentSrc: "https://shop.example/big.jpg", renderedWidth: 200, srcset: "" },
      { index: 1, currentSrc: "https://shop.example/big.jpg", renderedWidth: 200, srcset: "/small.jpg 400w, /big.jpg 1200w" },
    ]);
    expect([...map.entries()]).toEqual([[0, 1]]);
  });

  it("leaves elements with no URL alone", () => {
    expect(duplicatesOf([{ index: 0, currentSrc: "", renderedWidth: 10 }, { index: 1, currentSrc: "", renderedWidth: 10 }]).size).toBe(0);
  });

  it("the representative's need is the largest need of its URL, so the right candidate covers every slot", () => {
    const candidates = [384, 640, 1080].map((width) => ({ url: `u${width}`, width }));
    const dpr = 2;
    const widths = [100, 300];
    const need = Math.max(...widths.map((w) => neededWidth(w, dpr, 1080)));
    expect(rightCandidate(candidates, need).width).toBe(640);
    expect(rightCandidate(candidates, neededWidth(100, dpr, 1080)).width).toBe(384);
  });
});

describe.each(["webp", "avif"] as const)("analysePage with a Contentful-shaped %s image (fake fetcher, no network)", (format) => {
  const ORIGIN = "https://images.ctfassets.net/space/env/hero.jpg";
  const ctf = (w: number, q?: number) => `${ORIGIN}?w=${w}${q === undefined ? "" : `&q=${q}`}&fm=${format}`;

  it("records the loader, reads the served quality from the URL and judges it against the original", async () => {
    const pixels = gradientNoise(800, 533, 4, 3);
    const original = await rawToPng(pixels);
    const encoded = (w: number) =>
      sharp(Buffer.from(pixels.data.buffer), { raw: { width: 800, height: 533, channels: 4 } }).resize(w).toFormat(format, { quality: 70 }).toBuffer();
    const served400 = await encoded(400);
    const served800 = await encoded(800);
    const gets: string[] = [];
    const fetcher = {
      get: async (url: string) => {
        gets.push(url);
        return url === ORIGIN ? original : undefined;
      },
      isPrivateHost: async () => false,
      hostIsBlocked: async () => false,
    };
    const viewport: Viewport = { name: "iphone-15", width: 390, height: 844, dpr: 3, mobile: true };
    const image: ObservedImage = {
      index: 0,
      currentSrc: ctf(400, 70),
      renderedWidth: 200,
      renderedHeight: 133,
      srcset: `${ctf(400, 70)} 400w, ${ctf(800, 70)} 800w`,
      sizes: "200px",
      classes: "hero",
      nextImage: false,
      inFirstViewport: true,
    };
    // The pixels are what the scan reads from the served file (sharp's own format name, so an AVIF is "heif" to sharp).
    const response = (url: string, buffer: Buffer, pixels: Awaited<ReturnType<typeof pixelSize>>) => ({
      url,
      contentType: `image/${format}`,
      bytes: buffer.length,
      buffer,
      pixels,
    });
    const observation: ViewportObservation = {
      viewport,
      status: 200,
      blocked: false,
      blockedRequests: 0,
      nextjs: false,
      images: [image],
      responses: new Map([
        [ctf(400, 70), response(ctf(400, 70), served400, await pixelSize(served400))],
        [ctf(800, 70), response(ctf(800, 70), served800, await pixelSize(served800))],
      ]),
    };
    const base: PageResult = {
      url: "https://shop.example/",
      host: "shop.example",
      scannedAt: new Date(0).toISOString(),
      imgtuneVersion: "test",
      metric: "ssimulacra2",
      delta: 2,
      viewports: ["iphone-15"],
      status: "ok",
      nextjs: false,
      perViewport: {},
      groups: [],
      counts: { images: 0, qualityNA: 0, skipped: 0, blockedRequests: 0, byLoader: {} },
    };
    const ctx: AnalysisContext = {
      pageUrl: "https://shop.example/",
      fetcher: fetcher as unknown as AnalysisContext["fetcher"],
      allowPrivate: false,
      deps: { score: (ref, test) => ssim(ref, test) * 100 },
      quality: true,
      aggressive: false,
      resized: new Map(),
    };

    const page = await analysePage(ctx, [observation], base);

    expect(gets).toContain(ORIGIN);
    const [report] = page.perViewport["iphone-15"].images;
    expect(report.loader).toBe("contentful");
    expect(report.format).toBe(format);
    expect(report.quality).toMatchObject({ current: 70, qualityAssumed: false, sampled: true });
    expect(page.counts.byLoader).toEqual({ contentful: 1 });
  }, 120_000);
});
