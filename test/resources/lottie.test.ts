import sharp from "sharp";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { analyzer, animationStats, countLayers, parseAnimation, rasterTargetWidth, rasterWorthIt, roundNumbers } from "../../src/resources/lottie.js";
import { readZip } from "../../src/resources/zip.js";
import type { PageContext, ResourceRecord } from "../../src/resources/types.js";

const PAGE = "https://example.test/";

/** The top-level finding of a URL: its id has no suffix (`lottie:<hash>`). */
const mainOf = (out: { id: string }[]) => out.find((f) => f.id.split(":").length === 2);

function ctx(lottie: PageContext["lottie"] = [], dpr = 1): PageContext {
  return {
    url: PAGE,
    viewport: { name: "desktop", width: 1440, height: 900, dpr },
    text: "",
    usedFonts: [],
    fontFaces: [],
    icons: [],
    audio: [],
    lottie,
    models: [],
  };
}

function record(url: string, body: Buffer, contentType = "application/json"): ResourceRecord {
  return {
    url,
    pageUrl: PAGE,
    viewport: "desktop",
    resourceType: "fetch",
    contentType,
    bytes: body.length,
    status: 200,
    thirdParty: false,
    body,
  };
}

/** A real PNG of noise-like content, so it does not compress to nothing. */
async function pngOf(width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed >> 16) & 0xff;
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** An animation whose layers are shapes with long decimal paths, and an optional embedded raster asset. */
function animation(opts: { w?: number; h?: number; raster?: string; decimals?: boolean } = {}): Record<string, unknown> {
  const w = opts.w ?? 400;
  const h = opts.h ?? 400;
  // Seeded pseudo-random keyframes with long decimals, like an exporter's output (not a repeating pattern that brotli eats).
  let seed = 11;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const layers = Array.from({ length: 12 }, (_, i) => ({
    ddd: 0,
    ind: i + 1,
    ty: 4,
    nm: `shape ${i}`,
    ks: {
      o: { a: 0, k: 100 },
      p: { a: 1, k: Array.from({ length: 30 }, (_, f) => ({ t: f, s: [rnd() * 400, rnd() * 400] })) },
    },
    shapes: [{ ty: "sh", ks: { a: 0, k: { c: true, v: [[rnd() * 10, rnd() * 10], [rnd() * 10, rnd() * 10]] } } }],
  }));
  const assets: unknown[] = [];
  if (opts.raster !== undefined) {
    assets.push({ id: "image_0", w: opts.w ?? w, h: opts.h ?? h, u: "", p: opts.raster, e: 1 });
  }
  return { v: "5.7.4", fr: opts.decimals === false ? 30 : 29.97, ip: 0, op: 90, w, h, layers, assets };
}

describe("lottie wants", () => {
  it("takes JSON and .lottie responses of a useful size, and nothing else", () => {
    expect(analyzer.wants({ ...record("https://a.test/x.json", Buffer.alloc(4000)), bytes: 4000 })).toBe(true);
    expect(analyzer.wants({ ...record("https://a.test/x", Buffer.alloc(4000), "application/json"), bytes: 4000 })).toBe(true);
    expect(analyzer.wants({ ...record("https://a.test/anim.lottie", Buffer.alloc(4000), "application/octet-stream"), bytes: 4000 })).toBe(true);
    expect(analyzer.wants({ ...record("https://a.test/x.json", Buffer.alloc(100), "application/json"), bytes: 100 })).toBe(false);
    expect(analyzer.wants({ ...record("https://a.test/x.png", Buffer.alloc(4000), "image/png"), bytes: 4000 })).toBe(false);
  });
});

describe("lottie parsing", () => {
  it("requires v and layers", () => {
    expect(parseAnimation(Buffer.from('{"v":"5.7.0","layers":[]}'))).toBeDefined();
    expect(parseAnimation(Buffer.from('{"layers":[]}'))).toBeUndefined();
    expect(parseAnimation(Buffer.from('{"v":"1","layers":{}}'))).toBeUndefined();
    expect(parseAnimation(Buffer.from("not json"))).toBeUndefined();
  });

  it("counts precomposition layers and reads fps, duration and size", () => {
    const anim = parseAnimation(
      Buffer.from(JSON.stringify({ v: "5", fr: 30, ip: 0, op: 60, w: 100, h: 50, layers: [{}, {}], assets: [{ layers: [{}, {}, {}] }, { p: "x" }] })),
    )!;
    expect(countLayers(anim)).toBe(5);
    expect(animationStats(anim)).toEqual({ fps: 30, seconds: 2, w: 100, h: 50 });
  });

  it("rounds numbers to three decimals and leaves strings alone", () => {
    expect(roundNumbers({ a: 1.23456, b: ["x", 2.0004, { c: -0.00049 }], d: "1.23456" })).toEqual({ a: 1.235, b: ["x", 2, { c: 0 }], d: "1.23456" });
  });

  it("targets the display size, never above the source width", () => {
    const anim = { v: "5", layers: [], w: 1000, h: 1000 } as never;
    expect(rasterTargetWidth(1000, 2000, anim, { w: 250, h: 250 })).toBe(250);
    expect(rasterTargetWidth(1000, 2000, anim, undefined)).toBe(1000);
    expect(rasterTargetWidth(1000, 300, anim, { w: 2000, h: 2000 })).toBe(300);
  });
});

describe("lottie analyzer on JSON", () => {
  it("never throws on garbage", async () => {
    const out = await analyzer.analyze([record(PAGE + "a.json", Buffer.from("\x00\x01garbage"))], ctx());
    expect(out).toEqual([]);
  });

  it("reports the animation with its layers, fps and duration", async () => {
    const body = Buffer.from(JSON.stringify(animation()));
    const out = await analyzer.analyze([record(PAGE + "hero.json", body)], ctx());
    const main = mainOf(out);
    expect(main?.kind).toBe("lottie");
    expect(main?.savedBytes).toBe(0);
    expect(main?.title).toContain("12 layers");
    expect(main?.title).toContain("29.97 fps");
    expect(main?.title).toContain("3.0 s");
  });

  it("finds embedded rasters that are bigger than their display box, and re-encodes them to WebP at the box size", async () => {
    const raster = "data:image/png;base64," + (await pngOf(1000, 1000)).toString("base64");
    const body = Buffer.from(JSON.stringify(animation({ w: 1000, h: 1000, raster })));
    const selector = "#hero";
    const out = await analyzer.analyze(
      [record(PAGE + "hero.json", body)],
      ctx([{ src: PAGE + "hero.json", selector, width: 250, height: 250 }]),
    );
    const r = out.find((f) => f.id.endsWith(":raster"));
    expect(r).toBeDefined();
    expect(r!.estimate).toBe(false);
    expect(r!.savedBytes).toBeGreaterThan(100_000);
    expect(r!.fix.join("\n")).toContain("WebP");
    expect(r!.fix.join("\n")).toContain("width: 250");
    expect(r!.locator).toEqual({ selector });
  });

  it("does not re-encode a WebP or AVIF raster at the same size, or a PNG that would save almost nothing", () => {
    expect(rasterWorthIt("webp", 10_000, 9_500, false)).toBe(false);
    expect(rasterWorthIt("png", 500, 300, false)).toBe(false);
    expect(rasterWorthIt("png", 100_000, 80_000, false)).toBe(true);
    expect(rasterWorthIt("webp", 10_000, 6_000, true)).toBe(true);
    expect(rasterWorthIt("png", 100_000, 120_000, true)).toBe(false);
  });

  it("does not suggest a .lottie repack for a small animation (brotli JSON is already close)", async () => {
    const raster = "data:image/png;base64," + (await pngOf(300, 300)).toString("base64");
    const body = Buffer.from(JSON.stringify(animation({ w: 300, h: 300, raster })));
    const out = await analyzer.analyze([record(PAGE + "hero.json", body)], ctx());
    expect(out.find((f) => f.id.endsWith(":dotlottie"))).toBeUndefined();
  });

  it("suggests a video or animated AVIF when a huge animation is shown small", async () => {
    const body = Buffer.from(JSON.stringify(animation({ w: 2000, h: 2000 })));
    const out = await analyzer.analyze([record(PAGE + "big.json", body)], ctx([{ src: PAGE + "big.json", selector: "div", width: 200, height: 200 }]));
    expect(mainOf(out)?.fix.join("\n")).toContain("animated AVIF");
  });

  it("reports precision trimming when the numbers carry long decimals", async () => {
    const body = Buffer.from(JSON.stringify(animation({ w: 400, h: 400 }), null, 2));
    const out = await analyzer.analyze([record(PAGE + "dec.json", body)], ctx());
    const p = out.find((f) => f.id.endsWith(":precision"));
    expect(p).toBeDefined();
    expect(p!.savedBytes).toBeGreaterThan(1024);
  });

  it("analyses each URL once", async () => {
    const body = Buffer.from(JSON.stringify(animation()));
    const out = await analyzer.analyze([record(PAGE + "a.json", body), record(PAGE + "a.json", body)], ctx());
    expect(out.filter((f) => mainOf([f]))).toHaveLength(1);
  });
});

/** A zip archive with the given entries: `stored` ones are method 0, the rest deflate. */
function makeZip(entries: { name: string; data: Buffer; stored?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.stored ? 0 : 8;
    const comp = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("lottie analyzer on .lottie", () => {
  it("reads the zip entries and reports the animation inside", async () => {
    const json = Buffer.from(JSON.stringify(animation({ w: 400, h: 400 })));
    const zip = makeZip([
      { name: "manifest.json", data: Buffer.from('{"animations":[{"id":"a"}]}') },
      { name: "animations/a.json", data: json, stored: true },
    ]);
    expect(readZip(zip).map((e) => e.name)).toEqual(["manifest.json", "animations/a.json"]);
    expect(readZip(zip)[1]!.data()!.equals(json)).toBe(true);
    const out = await analyzer.analyze([record(PAGE + "anim.lottie", zip, "application/octet-stream")], ctx());
    expect(mainOf(out)?.title).toContain(".lottie");
    expect(out.find((f) => f.id.endsWith(":stored"))?.savedBytes).toBeGreaterThan(1024);
  });

  it("returns nothing for bytes that are not a zip", () => {
    expect(readZip(Buffer.from("definitely not a zip archive"))).toEqual([]);
  });
});
