import { describe, expect, it } from "vitest";
import { adapterFor, originalFor } from "../src/loaders.js";

const PAGE = "https://shop.example/ae-en/bags";
const BASE = "http://localhost:3999";

/** The adapter name and the original, quality and quality parameter a URL resolves to. */
function read(src: string, page = PAGE) {
  const { adapter, url } = adapterFor(src, page);
  return {
    name: adapter.name,
    original: adapter.original(url),
    quality: adapter.quality(url),
    qualityParam: adapter.qualityParam,
    defaultQuality: adapter.defaultQuality,
  };
}

describe("next", () => {
  it("unwraps /_next/image?url=X against the page, with q as the quality", () => {
    expect(read("/_next/image?url=%2Fimg%2Fp1.jpg&w=640&q=90")).toEqual({
      name: "next",
      original: "https://shop.example/img/p1.jpg",
      quality: 90,
      qualityParam: "yes",
      defaultQuality: 75,
    });
  });

  it("takes an absolute original and has no quality without q", () => {
    const got = read("https://shop.example/_next/image?url=https%3A%2F%2Fcdn.example%2Fp1.jpg&w=640");
    expect(got.original).toBe("https://cdn.example/p1.jpg");
    expect(got.quality).toBeUndefined();
    expect(got.defaultQuality).toBe(75);
  });

  it("has no original without url=, or when the original is not http(s)", () => {
    expect(read("/_next/image?w=640&q=75").original).toBeUndefined();
    expect(read("/_next/image?url=javascript%3Aalert(1)&w=640").original).toBeUndefined();
  });
});

describe("cloudflare", () => {
  it("takes the path after the options as the original, quality from quality=", () => {
    expect(read("https://shop.example/cdn-cgi/image/width=640,quality=82,format=auto/img/p1.jpg")).toEqual({
      name: "cloudflare",
      original: "https://shop.example/img/p1.jpg",
      quality: 82,
      qualityParam: "yes",
      defaultQuality: 85,
    });
  });

  it("takes an absolute original and keeps its query", () => {
    const got = read("https://shop.example/cdn-cgi/image/width=640,format=auto/https://cdn.example/a.jpg?v=2");
    expect(got.original).toBe("https://cdn.example/a.jpg?v=2");
    expect(got.quality).toBeUndefined();
  });

  it("resolves a relative original against the variant's origin, also for an unusual host", () => {
    expect(read("https://staging.example/cdn-cgi/image/quality=60/media/x.png").original).toBe("https://staging.example/media/x.png");
    expect(read(`https://staging.example/cdn-cgi/image/width=1/${BASE}/media/y.jpg`).original).toBe(`${BASE}/media/y.jpg`);
  });
});

describe("contentful", () => {
  it("strips the query from images.ctfassets.net and reads q", () => {
    expect(read("https://images.ctfassets.net/abc123/4xYz/hero.jpg?w=400&q=70&fm=webp")).toEqual({
      name: "contentful",
      original: "https://images.ctfassets.net/abc123/4xYz/hero.jpg",
      quality: 70,
      qualityParam: "yes",
      defaultQuality: undefined,
    });
  });

  it("serves downloads.ctfassets.net too, with no quality when q is absent", () => {
    const got = read("https://downloads.ctfassets.net/abc123/4xYz/file.jpg");
    expect(got.name).toBe("contentful");
    expect(got.original).toBe("https://downloads.ctfassets.net/abc123/4xYz/file.jpg");
    expect(got.quality).toBeUndefined();
  });

  it("does not match a look-alike host", () => {
    expect(read("https://images.ctfassets.net.example/abc/x.jpg?q=70").name).toBe("generic");
  });
});

describe("sanity", () => {
  it("strips the query from cdn.sanity.io/images and reads q, default 75", () => {
    expect(read("https://cdn.sanity.io/images/proj1/production/abc-1200x800.jpg?w=600&h=400&q=80&auto=format")).toEqual({
      name: "sanity",
      original: "https://cdn.sanity.io/images/proj1/production/abc-1200x800.jpg",
      quality: 80,
      qualityParam: "yes",
      defaultQuality: 75,
    });
  });

  it("has no quality in a bare asset URL", () => {
    const got = read("https://cdn.sanity.io/images/proj1/production/abc.png");
    expect(got.original).toBe("https://cdn.sanity.io/images/proj1/production/abc.png");
    expect(got.quality).toBeUndefined();
  });

  it("leaves other paths on that host to the generic fallback", () => {
    expect(read("https://cdn.sanity.io/files/proj1/production/abc.pdf").name).toBe("generic");
  });

  it("matches a Sanity asset path on a custom media domain, by its path shape", () => {
    const src = "https://media.shop.example/images/proj1/production/0123456789abcdef0123-2400x1350.png?w=1200&q=100&fit=clip&auto=format";
    expect(read(src)).toEqual({
      name: "sanity",
      original: "https://media.shop.example/images/proj1/production/0123456789abcdef0123-2400x1350.png",
      quality: 100,
      qualityParam: "yes",
      defaultQuality: 75,
    });
  });

  it("does not take look-alike paths on other hosts for Sanity", () => {
    expect(read("https://media.shop.example/images/logo.png").name).toBe("generic");
    expect(read("https://media.shop.example/images/proj1/production/short-2400x1350.png").name).toBe("generic");
    expect(read("https://media.shop.example/images/proj1/production/0123456789abcdef0123-2400x1350.pdf").name).toBe("generic");
    expect(read("https://media.shop.example/files/proj1/production/0123456789abcdef0123-2400x1350.png").name).toBe("generic");
  });
});

describe("shopify", () => {
  it("drops width, height, crop, quality and format, and keeps the version", () => {
    expect(read("https://cdn.shopify.com/s/files/1/0001/0002/products/shirt_600x600.jpg?v=1700000000&width=600")).toEqual({
      name: "shopify",
      original: "https://cdn.shopify.com/s/files/1/0001/0002/products/shirt.jpg?v=1700000000",
      quality: undefined,
      qualityParam: "yes",
      defaultQuality: undefined,
    });
  });

  it("reads quality= from a live CDN URL and takes the original without it", () => {
    const src = "https://cdn.shopify.com/s/files/1/0001/0002/products/shirt.jpg?v=1700000000&width=640&quality=75&format=webp";
    expect(read(src)).toMatchObject({
      name: "shopify",
      original: "https://cdn.shopify.com/s/files/1/0001/0002/products/shirt.jpg?v=1700000000",
      quality: 75,
      qualityParam: "yes",
    });
  });

  it("has no quality when the URL carries none, and a non-numeric quality is not one", () => {
    expect(read("https://cdn.shopify.com/s/files/1/0001/0002/files/hat.png?width=300").quality).toBeUndefined();
    expect(read("https://cdn.shopify.com/s/files/1/0001/0002/files/hat.png?quality=auto").quality).toBeUndefined();
  });

  it("drops height and crop params and leaves no stray ?", () => {
    expect(read("https://cdn.shopify.com/s/files/1/0001/0002/files/hat.png?height=300&crop=center&width=300").original).toBe(
      "https://cdn.shopify.com/s/files/1/0001/0002/files/hat.png",
    );
  });

  it("removes a legacy _{w}x suffix on a shop domain under /cdn/shop/", () => {
    expect(read("https://shop.example/cdn/shop/products/bag_400x.webp?v=3")).toMatchObject({
      name: "shopify",
      original: "https://shop.example/cdn/shop/products/bag.webp?v=3",
      qualityParam: "yes",
    });
  });

  it("keeps a filename suffix that is not a size", () => {
    expect(read("https://cdn.shopify.com/s/files/1/0001/0002/products/photo_2.jpg").original).toBe(
      "https://cdn.shopify.com/s/files/1/0001/0002/products/photo_2.jpg",
    );
  });
});

describe("cloudinary", () => {
  it("drops the transformation segments, keeps the version and the public id, and reads q_N", () => {
    expect(read("https://res.cloudinary.com/demo/image/upload/w_400,q_80,f_auto/v1690000000/samples/sheep.jpg")).toEqual({
      name: "cloudinary",
      original: "https://res.cloudinary.com/demo/image/upload/v1690000000/samples/sheep.jpg",
      quality: 80,
      qualityParam: "yes",
      defaultQuality: undefined,
    });
  });

  it("q_auto is a CDN auto quality: no number, qualityParam auto", () => {
    const { adapter, url } = adapterFor("https://res.cloudinary.com/demo/image/upload/c_fill,w_300,h_200/q_auto:good/sample.png", PAGE);
    expect(adapter.original(url)).toBe("https://res.cloudinary.com/demo/image/upload/sample.png");
    expect(adapter.quality(url)).toBeUndefined();
    expect(adapter.qualityParam).toBe("auto");
  });

  it("a plain upload has no transformation, no quality and qualityParam yes", () => {
    expect(read("https://res.cloudinary.com/demo/image/upload/sample.jpg")).toMatchObject({
      name: "cloudinary",
      original: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
      quality: undefined,
      qualityParam: "yes",
    });
  });

  it("keeps a public-id folder whose name is not a transformation", () => {
    expect(read("https://res.cloudinary.com/demo/image/upload/w_400/q_60/folder_name/pic.jpg")).toMatchObject({
      original: "https://res.cloudinary.com/demo/image/upload/folder_name/pic.jpg",
      quality: 60,
    });
  });
});

describe("cloudinary behind a custom domain or a CDN", () => {
  it("takes the transformation segments at the root of any host as transforms, with the public id kept", () => {
    expect(read("https://d1abc.cloudfront.net/f_auto,c_limit,w_1280,q_auto:best:sensitive/v1787769317/folder/file.png")).toEqual({
      name: "cloudinary",
      original: "https://d1abc.cloudfront.net/v1787769317/folder/file.png",
      quality: undefined,
      qualityParam: "auto",
      defaultQuality: undefined,
    });
  });

  it("drops every transform segment of a chained transformation", () => {
    const src = "https://img.cdn.example/c_crop,x_485,y_0,w_3112,h_2730/f_auto,c_limit,w_1280,q_auto/v1634615055/folder/file.jpg";
    expect(read(src)).toMatchObject({
      name: "cloudinary",
      original: "https://img.cdn.example/v1634615055/folder/file.jpg",
      quality: undefined,
      qualityParam: "auto",
    });
  });

  it("reads q_N from the transforms on a custom host", () => {
    expect(read("https://img.shop.example/w_400,q_70/shoes/a.jpg")).toMatchObject({
      name: "cloudinary",
      original: "https://img.shop.example/shoes/a.jpg",
      quality: 70,
      qualityParam: "yes",
    });
  });

  it("does not take a path that has no transform, or a transform that is not leading", () => {
    expect(read("https://img.shop.example/logo_x/foo.png").name).toBe("generic");
    expect(read("https://img.shop.example/a_1/foo.png").name).toBe("generic");
    expect(read("https://img.shop.example/products/w_400/a.jpg").name).toBe("generic");
    expect(read("https://img.shop.example/w_400.jpg").name).toBe("generic");
  });
});

describe("imgix and imgix-based hosts", () => {
  it("strips the query from *.imgix.net and reads q, default 75", () => {
    expect(read("https://assets.imgix.net/examples/bridge.jpg?w=400&q=60&auto=format")).toEqual({
      name: "imgix",
      original: "https://assets.imgix.net/examples/bridge.jpg",
      quality: 60,
      qualityParam: "yes",
      defaultQuality: 75,
    });
  });

  it("covers DatoCMS and Prismic, which serve through imgix", () => {
    const dato = read("https://www.datocms-assets.com/12345/1700-photo.jpg?auto=format&w=800");
    expect(dato).toMatchObject({ name: "imgix", original: "https://www.datocms-assets.com/12345/1700-photo.jpg", quality: undefined });
    const prismic = read("https://images.prismic.io/repo/abc/photo.jpg?auto=compress,format&w=800&q=80");
    expect(prismic).toMatchObject({ name: "imgix", original: "https://images.prismic.io/repo/abc/photo.jpg", quality: 80 });
  });
});

describe("generic fallback", () => {
  it("has no original for an unknown host and reads q= or quality=", () => {
    expect(read("https://shop.example/img/p1.jpg?q=70")).toMatchObject({ name: "generic", original: undefined, quality: 70, qualityParam: "yes" });
    expect(read("https://shop.example/img/p1.jpg?quality=55")).toMatchObject({ quality: 55 });
    expect(read("https://shop.example/img/p1.jpg")).toMatchObject({ name: "generic", quality: undefined, defaultQuality: undefined });
  });

  it("has no original for a data URI", () => {
    expect(read("data:image/png;base64,AAAA")).toMatchObject({ name: "generic", original: undefined });
  });
});

describe("adapterFor", () => {
  it("resolves a relative src against the page and returns the URL it parsed", () => {
    const { url } = adapterFor("/_next/image?url=x.jpg&q=75", PAGE);
    expect(url.href).toBe("https://shop.example/_next/image?url=x.jpg&q=75");
  });

  it("routes cdn-cgi on any host to cloudflare, and imgix before generic", () => {
    expect(adapterFor("https://anything.example/cdn-cgi/image/w=1/a.jpg", PAGE).adapter.name).toBe("cloudflare");
    expect(adapterFor("https://assets.imgix.net/a.jpg", PAGE).adapter.name).toBe("imgix");
  });
});

describe("originalFor (the observed currentSrc decides, the src prop is kept when it agrees)", () => {
  const cdnCurrent = `https://shop-cdn.example.com/cdn-cgi/image/width=1200,quality=85,format=auto/${BASE}/media/p0.jpg`;

  it("keeps an absolute src the adapter does not contradict", () => {
    expect(originalFor(cdnCurrent, `${BASE}/media/p0.jpg`, BASE)).toBe(`${BASE}/media/p0.jpg`);
    expect(originalFor("https://res.cloudinary.com/demo/image/upload/w_9/a.jpg", "https://res.cloudinary.com/demo/image/upload/a.jpg", BASE)).toBe(
      "https://res.cloudinary.com/demo/image/upload/a.jpg",
    );
  });

  it("uses the adapter's original when the src prop contradicts it", () => {
    expect(originalFor(cdnCurrent, "https://other.example/x.jpg", BASE)).toBe(`${BASE}/media/p0.jpg`);
  });

  it("uses an absolute src when the adapter has no original", () => {
    expect(originalFor("https://shop.example/img/p1.jpg?v=3", `${BASE}/media/p1.jpg`, BASE)).toBe(`${BASE}/media/p1.jpg`);
  });

  it("resolves a relative src through the adapter, else against baseUrl", () => {
    expect(originalFor(cdnCurrent, "/media/p0.jpg", BASE)).toBe(`${BASE}/media/p0.jpg`);
    expect(originalFor("https://shop.example/img/p1.jpg", "/media/p1.jpg", BASE)).toBe(`${BASE}/media/p1.jpg`);
  });

  it("unwraps a src prop that is itself a transformed URL", () => {
    expect(originalFor("https://shop.example/img/p1.jpg", `https://cdn.example/cdn-cgi/image/w=1/${BASE}/media/p1.jpg`, BASE)).toBe(
      `${BASE}/media/p1.jpg`,
    );
  });
});
