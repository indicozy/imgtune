// Route types (routes.ts): the locale and variant are dimensions, the variable segments collapse, the route map overrides.
// The URL sets are synthetic: a storefront with locales, a docs site, a blog and a sitemap of a marketing site.
import { describe, expect, it } from "vitest";
import { groupRoutes, parseRouteMap, restrictRoutes, type RouteMapRule } from "../src/routes.js";

const SHOP = "https://shop.example";
const LOCALES = ["ae-en", "sa-ar", "qa-en", "eg-ar"];

/** A storefront of about 300 URLs over four locales: listings, products, store pages, CMS pages, search, variants. */
function storefrontUrls(): string[] {
  const urls: string[] = [];
  for (const loc of LOCALES) {
    urls.push(`${SHOP}/${loc}`, `${SHOP}/${loc}/category`);
    for (const page of ["sunglasses.html", "glasses.html", "accessories.html", "brand-a.html", "brand-b.html", "promo-x.html", "promo-y.html", "promo-z.html"]) {
      urls.push(`${SHOP}/${loc}/${page}`);
    }
    for (const shape of ["round", "square", "aviator", "oval", "cat-eye"]) urls.push(`${SHOP}/${loc}/sunglasses/${shape}.html`);
    for (let i = 0; i < 36; i++) urls.push(`${SHOP}/${loc}/brand-model-${i}-spc-00${100 + i}-0101-glasses.html`);
    urls.push(`${SHOP}/${loc}/stores`);
    for (let i = 0; i < 8; i++) urls.push(`${SHOP}/${loc}/stores/store-${i}-city-${100 + i}`);
    for (const page of ["about-us", "contact-us", "faqs", "return-policy", "cart", "search-page", "sign-in", "checkout"]) urls.push(`${SHOP}/${loc}/${page}`);
    for (let i = 0; i < 3; i++) urls.push(`${SHOP}/${loc}/search?q=term${i}&utm_source=mail`);
    urls.push(`${SHOP}/${loc}/mobile/faqs`, `${SHOP}/${loc}/desktop/sunglasses.html`, `${SHOP}/${loc}/customer/wishlist`, `${SHOP}/${loc}/customer/account`);
  }
  return urls;
}

describe("groupRoutes on a storefront with locales", () => {
  const urls = storefrontUrls();
  const grouping = groupRoutes(urls);
  const typeOf = (path: string) => grouping.typeOf(`${SHOP}${path}`);

  it("collapses about 300 URLs into a few tens of route types, not one per URL", () => {
    expect(urls.length).toBeGreaterThan(280);
    expect(grouping.types.length).toBeGreaterThanOrEqual(15);
    expect(grouping.types.length).toBeLessThanOrEqual(45);
  });

  it("strips the locale into a dimension, so the same template is one type across locales", () => {
    expect(typeOf("/ae-en/cart")).toBe("/cart");
    expect(typeOf("/eg-ar/cart")).toBe("/cart");
    const cart = grouping.types.find((t) => t.type === "/cart");
    expect(cart?.urls).toHaveLength(4);
    expect(cart?.locales).toEqual(["ae-en", "eg-ar", "qa-en", "sa-ar"]);
  });

  it("keeps the device variant as a dimension and merges it with the same page", () => {
    expect(typeOf("/ae-en/mobile/faqs")).toBe("/faqs");
    expect(typeOf("/ae-en/faqs")).toBe("/faqs");
    expect(typeOf("/ae-en/desktop/sunglasses.html")).toBe("/*.html");
    const faqs = grouping.types.find((t) => t.type === "/faqs");
    expect(faqs?.variants).toEqual(["mobile"]);
  });

  it("collapses product slugs with SKUs into one product type, apart from the listings", () => {
    expect(typeOf("/ae-en/brand-model-3-spc-00103-0101-glasses.html")).toBe("/*");
    expect(typeOf("/ae-en/brand-model-3-spc-00103-0101-glasses.html")).not.toBe(typeOf("/ae-en/brand-a.html"));
    expect(typeOf("/ae-en/brand-a.html")).toBe("/*.html");
  });

  it("collapses store detail pages and keeps the store locator as a fixed word", () => {
    expect(typeOf("/ae-en/stores/store-2-city-102")).toBe("/stores/*");
    expect(typeOf("/ae-en/stores")).toBe("/stores");
  });

  it("folds the search query into its parameter names and drops tracking parameters", () => {
    expect(typeOf("/ae-en/search?q=term1&utm_source=mail")).toBe("/search?q=*");
    expect(typeOf("/sa-ar/search?q=term1&utm_source=mail")).toBe("/search?q=*");
  });

  it("keeps listing families as one type and each shape of a sub-listing family apart from products", () => {
    expect(typeOf("/ae-en/sunglasses/round.html")).toBe("/sunglasses/*.html");
    expect(typeOf("/ae-en/sunglasses/cat-eye.html")).toBe("/sunglasses/*.html");
  });

  it("gives each CMS and root page its own type (a route word, not a variable)", () => {
    expect(typeOf("/ae-en/about-us")).toBe("/about-us");
    expect(typeOf("/ae-en/return-policy")).toBe("/return-policy");
  });

  it("keeps the locale in the URL when the set has only one locale-shaped prefix", () => {
    const single = groupRoutes([`${SHOP}/en/cart`, `${SHOP}/en/faqs`, `${SHOP}/en/about`]);
    expect(single.typeOf(`${SHOP}/en/cart`)).toBe("/en/cart");
    expect(single.types.every((t) => t.locales.length === 0)).toBe(true);
  });

  it("does not read a two-letter word with a hyphen (ui-kit) as a locale", () => {
    const docs = groupRoutes([`${SHOP}/ui-kit/buttons`, `${SHOP}/ae-en/cart`, `${SHOP}/sa-ar/cart`]);
    expect(docs.typeOf(`${SHOP}/ui-kit/buttons`)).toBe("/ui-kit/buttons");
  });
});

describe("groupRoutes on a docs site, a blog and a marketing sitemap", () => {
  it("groups a docs site by section, with its leaf pages under one type", () => {
    const urls: string[] = [];
    for (const section of ["getting-started", "guides", "api-reference"]) for (let i = 0; i < 8; i++) urls.push(`https://docs.example/docs/${section}/topic-${i}`);
    for (const page of ["routing", "data", "styling", "config"]) urls.push(`https://docs.example/docs/app/${page}`);
    const grouping = groupRoutes(urls);
    expect(grouping.types.map((t) => t.type).sort()).toEqual(["/docs/api-reference/*", "/docs/app/*", "/docs/getting-started/*", "/docs/guides/*"]);
    expect(grouping.types.find((t) => t.type === "/docs/app/*")?.urls).toHaveLength(4);
  });

  it("groups a blog's dated posts into one type per depth", () => {
    const urls = Array.from({ length: 40 }, (_, i) => `https://blog.example/blog/2024/${String((i % 12) + 1).padStart(2, "0")}/a-long-title-number-${i}`);
    expect(groupRoutes(urls).types.map((t) => [t.type, t.urls.length])).toEqual([["/blog/*/*/*", 40]]);
  });

  it("groups a marketing sitemap: showcase and lessons as families, the root pages each on their own", () => {
    const base = "https://site.example";
    const urls: string[] = [];
    for (let i = 0; i < 12; i++) urls.push(`${base}/showcase/site-name-${i}`);
    for (let i = 0; i < 6; i++) urls.push(`${base}/learn/lesson-${i}`);
    for (const page of ["about", "pricing", "contact", "login"]) urls.push(`${base}/${page}`);
    urls.push(`${base}/`, `${base}/search?q=next&utm_source=x`, `${base}/search?q=react`);
    const grouping = groupRoutes(urls);
    expect(grouping.typeOf(`${base}/showcase/site-name-3`)).toBe("/showcase/*");
    expect(grouping.typeOf(`${base}/learn/lesson-5`)).toBe("/learn/*");
    expect(grouping.typeOf(`${base}/pricing`)).toBe("/pricing");
    expect(grouping.typeOf(`${base}/`)).toBe("/");
    expect(grouping.types.find((t) => t.type === "/search?q=*")?.urls).toHaveLength(2);
  });

  it("keeps a URL that is not a URL as its own type", () => {
    const grouping = groupRoutes(["not a url"]);
    expect(grouping.typeOf("not a url")).toBe("not a url");
  });
});

describe("route maps", () => {
  it("reads lines of pattern => type, with comments and blank lines", () => {
    const rules = parseRouteMap("# products\n/*  => product\n\n/stores/* => store detail # the locator's pages\n");
    expect(rules.map((r) => [r.pattern, r.type])).toEqual([
      ["/*", "product"],
      ["/stores/*", "store detail"],
    ]);
  });

  it("reads a JSON object of pattern to type", () => {
    expect(parseRouteMap('{ "/about-us": "cms", "/search?q=*": "search" }').map((r) => r.type)).toEqual(["cms", "search"]);
  });

  it("refuses a bad line, a pattern without a leading slash, and ** that is not the last segment", () => {
    expect(() => parseRouteMap("cart cms")).toThrow(/line 1/);
    expect(() => parseRouteMap("cart => cms")).toThrow(/must start with \//);
    expect(() => parseRouteMap("/a/**/b => x")).toThrow(/last segment/);
    expect(() => parseRouteMap("{ not json")).toThrow(/not valid JSON/);
  });

  it("names the URLs its patterns match, ahead of the computed grouping", () => {
    const rules: RouteMapRule[] = parseRouteMap("/sunglasses/*.html => listing\n/stores/** => stores\n/search?q=* => search");
    const urls = [
      `${SHOP}/ae-en/sunglasses/round.html`,
      `${SHOP}/ae-en/sunglasses/square.html`,
      `${SHOP}/ae-en/stores/a/b`,
      `${SHOP}/ae-en/search?q=x`,
      `${SHOP}/ae-en/cart`,
      `${SHOP}/sa-ar/cart`,
    ];
    const grouping = groupRoutes(urls, { routeMap: rules });
    expect(grouping.typeOf(urls[0])).toBe("listing");
    expect(grouping.typeOf(urls[2])).toBe("stores");
    expect(grouping.typeOf(urls[3])).toBe("search");
    expect(grouping.routes.find((r) => r.url === urls[4])?.mapped).toBe(false);
    expect(grouping.types.find((t) => t.type === "listing")?.mapped).toBe(true);
  });
});

describe("restrictRoutes", () => {
  it("keeps the types of the whole set and counts only the sampled URLs", () => {
    const urls = ["https://shop.example/c/a", "https://shop.example/c/b", "https://shop.example/c/c", "https://shop.example/about"];
    const full = groupRoutes(urls);
    const sample = restrictRoutes(full, ["https://shop.example/c/a", "https://shop.example/about"]);
    expect(sample.routes.map((r) => r.url)).toEqual(["https://shop.example/c/a", "https://shop.example/about"]);
    expect(sample.typeOf("https://shop.example/c/a")).toBe(full.typeOf("https://shop.example/c/a"));
    expect(sample.types.reduce((n, t) => n + t.urls.length, 0)).toBe(2);
  });
});

describe("version segments after the first segment (docs sites)", () => {
  const DOCS = "https://docs.example";
  const PAGES = ["routing", "data", "styling", "config"];

  it("merges a versioned section with the unversioned one: /docs/15/app/x and /docs/app/x are one type", () => {
    const urls = [...PAGES.map((p) => `${DOCS}/docs/app/${p}`), ...PAGES.map((p) => `${DOCS}/docs/15/app/${p}`)];
    const grouping = groupRoutes(urls);
    expect(grouping.types.map((t) => [t.type, t.urls.length, t.versions])).toEqual([["/docs/app/*", 8, ["15"]]]);
    expect(grouping.typeOf(`${DOCS}/docs/15/app/routing`)).toBe(grouping.typeOf(`${DOCS}/docs/app/routing`));
  });

  it("reads v-prefixed, dotted and .x versions the same way, and merges all the versions of one section", () => {
    const urls = [...PAGES.map((p) => `${DOCS}/docs/app/${p}`), ...PAGES.map((p) => `${DOCS}/docs/v2.3/app/${p}`), ...PAGES.map((p) => `${DOCS}/docs/15.x/app/${p}`)];
    const grouping = groupRoutes(urls);
    expect(grouping.types.map((t) => t.type)).toEqual(["/docs/app/*"]);
    expect(grouping.types[0].urls).toHaveLength(12);
    expect(grouping.types[0].versions).toEqual(["15.x", "v2.3"]);
  });

  it("does not split a family in two: the versioned copies of its pages count as the pages they copy", () => {
    // Plain words, not slugs: a slug collapses to `*` by its shape, which would hide the single-page count.
    const words = ["routing", "data", "styling", "config", "layouts", "images"];
    const section = (version?: string) => words.map((word) => `${DOCS}/docs/${version === undefined ? "" : `${version}/`}app/${word}`);
    const plain = groupRoutes(section());
    const versioned = groupRoutes([...section(), ...section("15")]);
    expect(plain.types.map((t) => t.type)).toEqual(["/docs/app/*"]);
    expect(versioned.types.map((t) => t.type)).toEqual(["/docs/app/*"]);
    expect(versioned.types[0].urls).toHaveLength(12);
  });

  it("keeps the version in the route map's view of the URL: a version is a dimension, not part of the type", () => {
    const grouping = groupRoutes([...PAGES.map((p) => `${DOCS}/docs/app/${p}`), `${DOCS}/docs/15/app/data`]);
    expect(grouping.routes.find((r) => r.url === `${DOCS}/docs/15/app/data`)?.version).toBe("15");
    expect(grouping.routes.find((r) => r.url === `${DOCS}/docs/app/data`)?.version).toBeUndefined();
  });

  it("does not strip latest: it is a word a site may use as a section name, so it stays its own type", () => {
    const grouping = groupRoutes([...PAGES.map((p) => `${DOCS}/docs/app/${p}`), ...PAGES.map((p) => `${DOCS}/docs/latest/app/${p}`)]);
    expect(grouping.typeOf(`${DOCS}/docs/latest/app/data`)).not.toBe(grouping.typeOf(`${DOCS}/docs/app/data`));
    expect(grouping.types.find((t) => t.type === "/docs/app/*")?.urls).toHaveLength(4);
  });

  it("does not strip a version with nothing under it (/docs/15 stays the section page)", () => {
    const grouping = groupRoutes([...PAGES.map((p) => `${DOCS}/docs/app/${p}`), `${DOCS}/docs/15`]);
    expect(grouping.routes.find((r) => r.url === `${DOCS}/docs/15`)?.version).toBeUndefined();
    expect(grouping.typeOf(`${DOCS}/docs/15`)).toBe("/docs/*");
  });

  it("does not read a numeric id as a version when its section has no unversioned pages (/product/123/x)", () => {
    const urls = [`${DOCS}/product/123/aviator`, `${DOCS}/product/456/bob`, `${DOCS}/product/789/cara`];
    const grouping = groupRoutes(urls);
    expect(grouping.routes.every((r) => r.version === undefined)).toBe(true);
    expect(grouping.typeOf(`${DOCS}/product/123/aviator`)).toBe("/product/*/aviator");
  });

  it("keeps a product id with no page under it as the product type (/product/123 is /product/*)", () => {
    const grouping = groupRoutes([`${DOCS}/product/123`, `${DOCS}/product/456`, `${DOCS}/product/789`, `${DOCS}/product/aviator-1234`]);
    expect(grouping.typeOf(`${DOCS}/product/123`)).toBe("/product/*");
  });

  it("keeps dated blog archives apart from the blog home and from each other's templates", () => {
    const urls = [`${DOCS}/blog`, `${DOCS}/blog/2024`, `${DOCS}/blog/2023`, `${DOCS}/blog/2024/05/a-long-title-one`, `${DOCS}/blog/2023/01/a-long-title-two`];
    const grouping = groupRoutes(urls);
    expect(grouping.typeOf(`${DOCS}/blog/2024`)).toBe("/blog/*");
    expect(grouping.typeOf(`${DOCS}/blog`)).toBe("/blog");
    expect(grouping.typeOf(`${DOCS}/blog/2024/05/a-long-title-one`)).toBe(grouping.typeOf(`${DOCS}/blog/2023/01/a-long-title-two`));
    expect(grouping.routes.every((r) => r.version === undefined)).toBe(true);
  });
});
