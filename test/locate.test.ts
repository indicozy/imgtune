import { describe, expect, it } from "vitest";
import {
  decodeMappings,
  loaderName,
  originalPosition,
  parseSourceMap,
  projectPath,
  resolveOwners,
  urlPattern,
  type OwnerTrace,
  type SourceMapData,
} from "../src/locate.js";

/** Encodes one VLQ value (the inverse of the decoder), for building test maps. */
function vlq(value: number): string {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

describe("decodeMappings", () => {
  it("decodes the standard example mapping", () => {
    // "AAAA;AACA" : line 1 one segment at column 0 -> source 0 line 0 col 0; line 2 col 0 -> source line 1.
    expect(decodeMappings("AAAA;AACA")).toEqual([
      [[0, 0, 0, 0]],
      [[0, 0, 1, 0]],
    ]);
  });

  it("carries the source fields across lines and resets the generated column per line", () => {
    const mappings = [
      [vlq(0), vlq(0), vlq(4), vlq(2)].join(""),
      [vlq(3), vlq(0), vlq(1), vlq(-1)].join(""),
    ].join(";");
    const lines = decodeMappings(mappings);
    expect(lines[0]).toEqual([[0, 0, 4, 2]]);
    expect(lines[1]).toEqual([[3, 0, 5, 1]]);
  });

  it("decodes multi-digit values (continuation bits)", () => {
    const lines = decodeMappings([vlq(200), vlq(0), vlq(300), vlq(40)].join(""));
    expect(lines[0]).toEqual([[200, 0, 300, 40]]);
  });

  it("rejects a character outside the base64 alphabet", () => {
    expect(() => decodeMappings("A!AA")).toThrow(/invalid source map character/);
  });
});

describe("originalPosition", () => {
  const map: SourceMapData = {
    sources: ["webpack://app/./components/Card.tsx"],
    lines: [[[0, 0, 9, 0], [10, 0, 11, 4]]],
  };

  it("takes the last segment at or before the column", () => {
    expect(originalPosition(map, 1, 1)).toEqual({ source: "webpack://app/./components/Card.tsx", line: 10 });
    expect(originalPosition(map, 1, 15)).toEqual({ source: "webpack://app/./components/Card.tsx", line: 12 });
  });

  it("is undefined for a line with no mapping", () => {
    expect(originalPosition(map, 2, 1)).toBeUndefined();
  });

  it("parses a map's JSON text", () => {
    const parsed = parseSourceMap(JSON.stringify({ sources: ["a.tsx"], mappings: "AAAA" }));
    expect(parsed?.sources).toEqual(["a.tsx"]);
    expect(parseSourceMap("not json")).toBeUndefined();
    expect(parseSourceMap(JSON.stringify({ sources: [] }))).toBeUndefined();
  });
});

describe("projectPath", () => {
  it("strips the bundler prefixes of webpack, turbopack and file names", () => {
    expect(projectPath("webpack://fixture/./components/Card.tsx")).toBe("components/Card.tsx");
    expect(projectPath("turbopack:///[project]/app/page.tsx")).toBe("app/page.tsx");
    expect(projectPath("webpack-internal:///(app-pages-browser)/./components/Card.tsx")).toBe("components/Card.tsx");
    expect(projectPath("file:///home/someone/work/shop/app/components/Hero.tsx")).toBe("app/components/Hero.tsx");
  });

  it("refuses dependencies, runtime modules and non-script files", () => {
    expect(projectPath("turbopack:///[project]/node_modules/next/dist/client/image.js")).toBeUndefined();
    expect(projectPath("webpack://x/./node_modules/react/index.js")).toBeUndefined();
    expect(projectPath("turbopack:///[turbopack]/runtime.js")).toBeUndefined();
    expect(projectPath("webpack://x/./styles/site.css")).toBeUndefined();
  });
});

describe("urlPattern and loaderName", () => {
  const page = "https://shop.example/products";

  it("strips w and q from a next/image URL and keeps the source URL", () => {
    const src = "https://shop.example/_next/image?url=%2Fhero.jpg&w=640&q=75";
    expect(urlPattern(src, page)).toBe("https://shop.example/_next/image?url=%2Fhero.jpg");
    expect(loaderName(src, page)).toBe("next-default");
  });

  it("replaces a Cloudflare options segment and a Cloudinary transform with a star", () => {
    expect(urlPattern("https://shop.example/cdn-cgi/image/width=640,quality=80/img/a.jpg", page)).toBe(
      "https://shop.example/cdn-cgi/image/*/img/a.jpg",
    );
    expect(urlPattern("https://res.cloudinary.com/demo/image/upload/w_400,q_80/sample.jpg", page)).toBe(
      "https://res.cloudinary.com/demo/image/upload/*/sample.jpg",
    );
  });

  it("names a same-origin file plain-img, and another host cdn:<host>", () => {
    expect(loaderName("/images/a.png", page)).toBe("plain-img");
    expect(loaderName("https://media.example.net/a.png", page)).toBe("cdn:media.example.net");
  });

  it("names a known CDN by its adapter", () => {
    expect(loaderName("https://images.ctfassets.net/s/e/hero.jpg?w=400", page)).toBe("contentful");
  });
});

describe("resolveOwners", () => {
  const map: SourceMapData = {
    sources: ["webpack://app/./components/Card.tsx"],
    lines: [[[0, 0, 41, 0]]],
  };
  const noMaps = async () => undefined;

  it("takes the React 18 source of the nearest owner that has one", async () => {
    const owners: OwnerTrace[] = [{ name: "Card", source: { file: "file:///w/app/components/Card.tsx", line: 7 }, frames: [] }];
    expect(await resolveOwners(owners, noMaps)).toEqual({ file: "app/components/Card.tsx", line: 7 });
  });

  it("resolves a stack frame through its chunk's map, skipping owners whose frames are dependencies", async () => {
    const owners: OwnerTrace[] = [
      { frames: [{ url: "http://localhost:3000/_next/static/chunks/node_modules_next.js?dpl=1", line: 1, col: 5 }] },
      { name: "Card", frames: [{ url: "http://localhost:3000/_next/static/chunks/_components_Card.js?dpl=1", line: 1, col: 3 }] },
    ];
    const seen: string[] = [];
    const loadMap = async (chunk: string) => {
      seen.push(chunk);
      return chunk.endsWith("node_modules_next.js") ? { sources: ["turbopack:///[project]/node_modules/next/x.js"], lines: [[[0, 0, 1, 0]]] } : map;
    };
    expect(await resolveOwners(owners, loadMap)).toEqual({ file: "components/Card.tsx", line: 42 });
    expect(seen).toEqual([
      "http://localhost:3000/_next/static/chunks/node_modules_next.js",
      "http://localhost:3000/_next/static/chunks/_components_Card.js",
    ]);
  });

  it("is undefined when no owner resolves (a production build)", async () => {
    expect(await resolveOwners([{ frames: [] }], noMaps)).toBeUndefined();
  });
});
