import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  displayedCssWidth,
  neededDevicePixels,
  parseBackgroundImage,
  parseBackgroundSize,
  pickLoaded,
  splitTop,
} from "../src/backgrounds.js";
import type { ImageRecord } from "../src/images.js";
import { runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

describe("splitTop", () => {
  it("splits at top-level commas only", () => {
    expect(splitTop('url("a,b.png"), url(c.png)')).toEqual(['url("a,b.png")', "url(c.png)"]);
    expect(splitTop("cover, 50% auto")).toEqual(["cover", "50% auto"]);
  });
});

describe("parseBackgroundImage", () => {
  it("reads a url() layer and skips a gradient layer, keeping the layer count", () => {
    const layers = parseBackgroundImage('url("https://cdn.example.test/a.png"), linear-gradient(red, blue)');
    expect(layers).toHaveLength(2);
    expect(layers[0]).toEqual({ candidates: [{ url: "https://cdn.example.test/a.png", resolution: 1 }], dataUri: false });
    expect(layers[1]).toEqual({ candidates: [], dataUri: false });
  });

  it("reads each image-set() entry with its density, unprefixed and prefixed", () => {
    const plain = parseBackgroundImage('image-set(url("https://cdn.example.test/a.png") 1x, url("https://cdn.example.test/a@2x.png") 2x)');
    expect(plain[0].candidates).toEqual([
      { url: "https://cdn.example.test/a.png", resolution: 1 },
      { url: "https://cdn.example.test/a@2x.png", resolution: 2 },
    ]);
    const prefixed = parseBackgroundImage('-webkit-image-set(url("https://cdn.example.test/b.webp") 1.5x)');
    expect(prefixed[0].candidates).toEqual([{ url: "https://cdn.example.test/b.webp", resolution: 1.5 }]);
  });

  it("marks a data: layer and keeps no candidate for it; none is an empty layer", () => {
    expect(parseBackgroundImage('url("data:image/png;base64,AAAA")')).toEqual([{ candidates: [], dataUri: true }]);
    expect(parseBackgroundImage("none")).toEqual([{ candidates: [], dataUri: false }]);
  });
});

describe("parseBackgroundSize", () => {
  it("returns one value per layer", () => {
    expect(parseBackgroundSize("cover, 50% auto")).toEqual(["cover", "50% auto"]);
    expect(parseBackgroundSize("")).toEqual(["auto"]);
  });
});

describe("displayedCssWidth", () => {
  const natural = { width: 1600, height: 800 };
  it("cover takes the larger of the box width and the box height scaled by the aspect", () => {
    expect(displayedCssWidth("cover", { width: 400, height: 200 }, natural)).toBe(400);
    expect(displayedCssWidth("cover", { width: 100, height: 300 }, natural)).toBe(600);
  });
  it("contain fits the image inside the box", () => {
    expect(displayedCssWidth("contain", { width: 400, height: 200 }, natural)).toBe(400);
    expect(displayedCssWidth("contain", { width: 400, height: 100 }, natural)).toBe(200);
  });
  it("an explicit length, a percentage, or auto", () => {
    expect(displayedCssWidth("120px", { width: 400, height: 200 }, natural)).toBe(120);
    expect(displayedCssWidth("50%", { width: 400, height: 200 }, natural)).toBe(200);
    expect(displayedCssWidth("auto 100px", { width: 400, height: 50 }, natural)).toBe(200);
    expect(displayedCssWidth("auto", { width: 400, height: 200 }, natural)).toBe(1600);
  });
  it("returns undefined for a unit it does not read", () => {
    expect(displayedCssWidth("2em", { width: 400, height: 200 }, natural)).toBeUndefined();
  });
  it("device pixels round up", () => {
    expect(neededDevicePixels(400.2, 2)).toBe(801);
  });
});

describe("pickLoaded", () => {
  const candidates = [
    { url: "a.png", resolution: 1 },
    { url: "a@2x.png", resolution: 2 },
  ];
  it("prefers the loaded candidate at or above the device pixel ratio", () => {
    expect(pickLoaded(candidates, () => true, 2)?.url).toBe("a@2x.png");
    expect(pickLoaded(candidates, (u) => u === "a.png", 2)?.url).toBe("a.png");
    expect(pickLoaded(candidates, () => false, 2)).toBeUndefined();
  });
});

// A page with a CSS background of each kind, served by a local server; scanned with real Chromium.
describe("scan of CSS background images", () => {
  let base = "";
  let server: Server | undefined;
  const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
  const retina: Viewport = { name: "retina", width: 1280, height: 800, dpr: 2, mobile: false };

  beforeAll(async () => {
    const big = await sharp({ create: { width: 1600, height: 800, channels: 3, background: "#4a7" } }).png().toBuffer();
    const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#a74" } }).png().toBuffer();
    const set1x = await sharp({ create: { width: 300, height: 150, channels: 3, background: "#47a" } }).png().toBuffer();
    const set2x = await sharp({ create: { width: 600, height: 300, channels: 3, background: "#47b" } }).png().toBuffer();
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>bg</title><style>
      #hero { width: 400px; height: 200px; background: url(/big.png) center / cover; }
      #small { width: 300px; height: 300px; background: url(/small.png) center / contain; }
      #tiny { width: 8px; height: 8px; background: url(/big.png) center / cover; }
      #set { width: 300px; height: 150px; background-image: image-set(url(/set1x.png) 1x, url(/set2x.png) 2x); background-size: auto; }
      #grad { width: 300px; height: 100px; background: linear-gradient(red, blue); }
      #hidden { display: none; width: 300px; height: 100px; background: url(/big.png); }
      #data { width: 300px; height: 100px; background: url("data:image/png;base64,iVBORw0KGgo="); }
    </style></head><body>
      <div id="hero"></div><div id="small"></div><div id="tiny"></div><div id="set"></div>
      <div id="grad"></div><div id="hidden"></div><div id="data"></div>
    </body></html>`;
    const started = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? "";
        const png = { "/big.png": big, "/small.png": small, "/set1x.png": set1x, "/set2x.png": set2x }[url];
        if (png) {
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(png);
        }
        if (url === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(page);
        }
        res.writeHead(404);
        res.end();
      });
      s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
    });
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const scanBg = async (viewports: Viewport[]) => {
    const out = mkdtempSync(join(tmpdir(), "imgtune-bg-"));
    const [result] = await runScan([`${base}/`], { outDir: out, cwd: out, aggressive: false, quality: false, viewports, log: () => {} });
    return result;
  };
  const named = (images: ImageRecord[] | undefined, id: string) => (images ?? []).find((r) => r.locator.selector.includes(`#${id}`));

  it("measures each background layer as a css-background record, with the needed pixels and the saving", async () => {
    const result = await scanBg([desktop]);
    expect(result.status).toBe("ok");
    const hero = named(result.images, "hero");
    expect(hero?.kind).toBe("css-background");
    const [p] = hero?.perViewport ?? [];
    expect(p.neededPx).toBe(400);
    expect(p.servedPx).toBe(1600);
    expect(p.undersized).toBe(false);
    expect(hero?.fix.width).toBe(400);
    expect(hero?.fix.bytes.saved).toBeGreaterThan(0);
    expect(hero?.fix.bytes.addedForSharpness).toBe(0);
    expect(hero?.evidence.notes.join("\n")).toMatch(/css background: layer 1, background-size "cover"/);
  }, 120_000);

  it("flags an undersized background: the file has fewer pixels than the layer needs, and saves nothing", async () => {
    const result = await scanBg([desktop]);
    const small = named(result.images, "small");
    const [p] = small?.perViewport ?? [];
    expect(p.servedPx).toBe(64);
    expect(p.neededPx).toBe(300);
    expect(p.undersized).toBe(true);
    expect(small?.fix.bytes.saved).toBe(0);
  }, 120_000);

  it("chooses the image-set() candidate the browser loaded (2x at a device pixel ratio of 2)", async () => {
    const result = await scanBg([retina]);
    const set = named(result.images, "set");
    const [p] = set?.perViewport ?? [];
    expect(set?.current.src).toMatch(/set2x\.png$/);
    expect(p.servedPx).toBe(600);
    expect(p.neededPx).toBe(600);
    expect(p.undersized).toBe(false);
  }, 120_000);

  it("skips tiny, hidden and inline data: backgrounds with the reason, and lists no gradient", async () => {
    const result = await scanBg([desktop]);
    expect(named(result.images, "tiny")?.perViewport[0].skipped).toBe("under 16 px");
    expect(named(result.images, "hidden")?.perViewport[0].skipped).toBe("hidden");
    expect(named(result.images, "data")?.perViewport[0].skipped).toBe("data URI");
    expect(named(result.images, "grad")).toBeUndefined();
  }, 120_000);

  it("keeps the headline img-only: no <img> on the page, so the counts and the groups have none", async () => {
    const result = await scanBg([desktop]);
    expect(result.counts.images).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.page?.exactEstPct ?? 0).toBe(0);
    expect(result.backgrounds?.layers).toBeGreaterThan(0);
    expect(result.perViewport.desktop.backgrounds?.measured).toBeGreaterThan(0);
  }, 120_000);
});
