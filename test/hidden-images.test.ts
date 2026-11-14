import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { buildImageRecords, hiddenFixOf, type ImageRecord } from "../src/images.js";
import { hiddenLines, hintsOf } from "../src/hints.js";
import { hiddenPageOf, runScan, type Instance, type ObservedImage } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const VIEWS = { desktop: { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false }, mobile: { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true } } as const;

/** One instance of a fake element at one viewport: a shown one, or a hidden one with its file's bytes. */
function instanceOf(viewport: Viewport, element: number, hidden: boolean, bytes = 10_000): Instance {
  const img = {
    index: element,
    currentSrc: `https://example.test/${element}.png`,
    renderedWidth: hidden ? 0 : 300,
    renderedHeight: hidden ? 0 : 200,
    srcset: "",
    classes: "",
    nextImage: false,
    inFirstViewport: true,
    locator: { selector: `img#e${element}`, owners: [] },
    ...(hidden ? { hidden: "display" as const, inPanel: true as const } : {}),
  } as ObservedImage;
  return {
    viewport,
    element,
    img,
    url: img.currentSrc,
    bytes,
    format: "png",
    pixelWidth: 600,
    renderedWidth: img.renderedWidth,
    needed: hidden ? 0 : 300,
    kind: hidden ? "hidden" : "plain",
    exact: 0,
    est: 0,
    estAggressive: 0,
    growth: 0,
    group: "g",
    loader: "plain-img",
    qualityParam: "no",
  } as unknown as Instance;
}

describe("hiddenFixOf", () => {
  it("is undefined when the element is shown at every viewport", () => {
    expect(hiddenFixOf([instanceOf(VIEWS.desktop, 1, false), instanceOf(VIEWS.mobile, 1, false)], 2)).toBeUndefined();
  });

  it("is a responsive twin when it is shown at some viewports and hidden at others, and bytes are per view", () => {
    const fix = hiddenFixOf([instanceOf(VIEWS.desktop, 1, false, 8000), instanceOf(VIEWS.mobile, 1, true, 12_000)], 2);
    expect(fix?.action).toBe("responsive");
    expect(fix?.widths).toEqual({ desktop: 1280, mobile: 390 });
    expect(fix?.viewports).toEqual(["mobile"]);
    expect(fix?.shownIn).toEqual(["desktop"]);
    expect(fix?.of).toBe(2);
    expect(fix?.perViewBytes).toBe(6000);
  });

  it("is lazy when the copy is in a tab panel or clipped, and removable when it is never shown", () => {
    const panel = hiddenFixOf([instanceOf(VIEWS.desktop, 2, true), instanceOf(VIEWS.mobile, 2, true)], 2);
    expect(panel?.action).toBe("lazy");
    const clipped = hiddenFixOf(
      [{ ...instanceOf(VIEWS.desktop, 3, true), img: { ...instanceOf(VIEWS.desktop, 3, true).img, hidden: "clipped", inPanel: undefined } as ObservedImage }],
      1,
    );
    expect(clipped?.action).toBe("lazy");
    const never = hiddenFixOf(
      [{ ...instanceOf(VIEWS.desktop, 4, true), img: { ...instanceOf(VIEWS.desktop, 4, true).img, hidden: "opacity", inPanel: undefined } as ObservedImage }],
      1,
    );
    expect(never?.action).toBe("remove");
    expect(never?.perViewBytes).toBe(10_000);
  });
});

describe("hiddenPageOf", () => {
  it("counts the elements hidden at a viewport and the bytes per view, once per URL", () => {
    const a = instanceOf(VIEWS.desktop, 1, true, 4000);
    // The same file under a second element: its bytes count once per viewport.
    const b = { ...instanceOf(VIEWS.desktop, 2, true, 4000), url: a.url };
    const m = instanceOf(VIEWS.mobile, 1, false, 9000);
    expect(hiddenPageOf([a, b, m], 2)).toEqual({ images: 2, bytesPerView: 2000 });
    expect(hiddenPageOf([m], 2)).toBeUndefined();
  });
});

describe("buildImageRecords and the hints of a hidden image", () => {
  it("keeps a hidden element out of the sizes and the savings, and prints its bytes apart", () => {
    const desk = instanceOf(VIEWS.desktop, 1, false, 8000);
    const mob = instanceOf(VIEWS.mobile, 1, true, 12_000);
    const observations = [
      { viewport: VIEWS.desktop, responses: new Map(), images: [], load: "fresh", blocked: false, blockedRequests: 0, nextjs: false },
      { viewport: VIEWS.mobile, responses: new Map(), images: [], load: "fresh", blocked: false, blockedRequests: 0, nextjs: false },
    ] as never[];
    const [record] = buildImageRecords({
      pageUrl: "https://example.test/",
      observations,
      instances: [desk, mob],
      refName: "desktop",
      resolved: new Map(),
      currentQuality: () => ({ quality: 75, assumed: true }),
    });
    expect(record.hidden?.action).toBe("responsive");
    expect(record.perViewport.find((p) => p.viewport === "mobile")?.hidden).toBe("display");
    expect(record.perViewport.find((p) => p.viewport === "mobile")?.renderedCssPx).toBe(0);
    // The shown viewport still gets its own sizes; the hidden one adds nothing to the saving.
    expect(record.fix.bytes.saved).toBe(0);
  });

  it("names the fix in its lines, and the media condition of a responsive twin from the viewport widths", () => {
    const twin = { reasons: ["display" as const], inPanel: false, viewports: ["mobile"], shownIn: ["desktop"], of: 2, widths: { mobile: 390, desktop: 1280 }, action: "responsive" as const, perViewBytes: 6000 };
    const text = hiddenLines(twin).join("\n");
    expect(text).toMatch(/loaded but not shown: 6 KB\/view, hidden at 1 of 2 viewport\(s\)/);
    expect(text).toMatch(/media="\(min-width: 1280px\)"/);
    expect(hiddenLines({ ...twin, viewports: ["desktop"], shownIn: ["mobile"], widths: { mobile: 390, desktop: 1280 } }).join("\n")).toMatch(/media="\(max-width: 390px\)"/);
    expect(hiddenLines({ reasons: ["clipped"], inPanel: false, viewports: ["mobile"], shownIn: [], of: 2, widths: { mobile: 390 }, action: "lazy", perViewBytes: 1 }).join("\n")).toMatch(/loading="lazy"/);
    expect(hiddenLines({ reasons: ["opacity"], inPanel: false, viewports: ["mobile", "desktop"], shownIn: [], of: 2, widths: { mobile: 390, desktop: 1280 }, action: "remove", perViewBytes: 1 }).join("\n")).toMatch(/remove the element/);
  });

  it("gives a hidden-only image a hint with no saving and no sizes line", () => {
    const hidden = { reasons: ["opacity"] as const, inPanel: false, viewports: ["desktop"], shownIn: [], of: 1, widths: { desktop: 1280 }, action: "remove" as const, perViewBytes: 10_000 };
    const record = { id: "h1", page: "https://example.test/", locator: { component: [], selector: "img#x", classes: "", loader: "plain-img" }, tunable: { width: true, quality: true }, current: { sizes: undefined, srcsetCandidates: [] }, perViewport: [], fix: { bytes: { saved: 0, addedForSharpness: 0 } }, evidence: { rung: "measured-page", notes: [] }, hidden } as unknown as ImageRecord;
    const [hint] = hintsOf({ url: "https://example.test/", images: [record] } as never);
    expect(hint.hidden?.action).toBe("remove");
    expect(hint.bytes.saved).toBe(0);
    expect(hint.sizes.proposed).toBeUndefined();
  });
});

// A page with each way an image can be loaded but not shown, served by a local server; scanned with real Chromium.
describe("scan of loaded-but-not-shown images", () => {
  let base = "";
  let server: Server | undefined;
  let bodyPage = "";
  const names = ["twinDesk", "twinMob", "slide1", "slide2", "slide3", "tabImg", "opaImg", "visImg", "zeroImg", "shownImg", "tinyImg"];

  beforeAll(async () => {
    const files: Record<string, Buffer> = {};
    for (const [i, name] of names.entries()) {
      files[name] = await sharp({ create: { width: 600 + i, height: 400, channels: 3, background: { r: 40 + i * 9, g: 120, b: 200 - i * 7 } } })
        .png()
        .toBuffer();
    }
    const img = (name: string) => `<img id="${name}" src="/${name}.png" alt="">`;
    bodyPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>body</title><style>
      html, body { overflow: hidden; height: 100px; }
      .below { margin-top: 900px; }
    </style></head><body><div class="below">${img("shownImg")}</div></body></html>`;
    const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>hidden</title><style>
      .desktop-only { width: 600px; height: 400px; }
      .mobile-only { width: 300px; height: 200px; }
      @media (max-width: 600px) { .desktop-only { display: none; } }
      @media (min-width: 601px) { .mobile-only { display: none; } }
      #carousel { width: 300px; height: 200px; overflow: hidden; }
      #track { display: flex; width: 900px; }
      #track img { width: 300px; height: 200px; flex: none; }
      #opaImg { opacity: 0; width: 300px; height: 200px; }
      #visImg { visibility: hidden; width: 300px; height: 200px; }
      #zeroImg { width: 0; height: 0; }
      #shownImg { width: 300px; height: 200px; }
      #tinyImg { width: 8px; height: 8px; }
    </style></head><body>
      ${img("twinDesk").replace("<img", '<img class="desktop-only"')}
      ${img("twinMob").replace("<img", '<img class="mobile-only"')}
      <div id="carousel"><div id="track">${img("slide1")}${img("slide2")}${img("slide3")}</div></div>
      <div role="tabpanel" hidden>${img("tabImg")}</div>
      ${img("opaImg")}${img("visImg")}${img("zeroImg")}${img("shownImg")}${img("tinyImg")}
    </body></html>`;
    const started = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? "";
        const file = /^\/([A-Za-z0-9]+)\.png$/.exec(url)?.[1];
        if (file && files[file]) {
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(files[file]);
        }
        if (url === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(page);
        }
        if (url === "/body") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(bodyPage);
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

  // A page whose body clips to 100 px: its overflow propagates to the viewport, so the content below is scrolled, not clipped.
  const scanBody = async () => {
    const out = mkdtempSync(join(tmpdir(), "imgtune-hidden-"));
    const [result] = await runScan([`${base}/body`], { outDir: out, cwd: out, aggressive: false, quality: false, viewports: [VIEWS.desktop], log: () => {} });
    return result;
  };

  const scan = async () => {
    const out = mkdtempSync(join(tmpdir(), "imgtune-hidden-"));
    const [result] = await runScan([`${base}/`], {
      outDir: out,
      cwd: out,
      aggressive: false,
      quality: false,
      viewports: [VIEWS.desktop, VIEWS.mobile],
      log: () => {},
    });
    return result;
  };
  const named = (images: ImageRecord[] | undefined, id: string) => (images ?? []).find((r) => r.locator.selector.includes(`#${id}`));

  it("finds each hidden copy with its reason, its viewports and the fix for its case", async () => {
    const result = await scan();
    expect(result.status).toBe("ok");
    const twinDesk = named(result.images, "twinDesk");
    expect(twinDesk?.hidden?.action).toBe("responsive");
    expect(twinDesk?.hidden?.viewports).toEqual(["mobile"]);
    expect(twinDesk?.hidden?.shownIn).toEqual(["desktop"]);
    expect(twinDesk?.perViewport.find((p) => p.viewport === "mobile")?.hidden).toBe("display");
    expect(named(result.images, "twinMob")?.hidden?.viewports).toEqual(["desktop"]);
    expect(named(result.images, "slide2")?.hidden?.reasons).toEqual(["clipped"]);
    expect(named(result.images, "slide2")?.hidden?.action).toBe("lazy");
    expect(named(result.images, "slide1")?.hidden).toBeUndefined();
    expect(named(result.images, "tabImg")?.hidden?.action).toBe("lazy");
    expect(named(result.images, "tabImg")?.hidden?.inPanel).toBe(true);
    expect(named(result.images, "opaImg")?.hidden?.reasons).toEqual(["opacity"]);
    expect(named(result.images, "opaImg")?.hidden?.action).toBe("remove");
    expect(named(result.images, "visImg")?.hidden?.reasons).toEqual(["visibility"]);
    expect(named(result.images, "zeroImg")?.hidden?.reasons).toEqual(["zero-size"]);
  }, 180_000);

  it("never calls a shown image hidden, and keeps the tiny visible one as under 16 px", async () => {
    const result = await scan();
    expect(named(result.images, "shownImg")?.hidden).toBeUndefined();
    expect(named(result.images, "shownImg")?.perViewport.every((p) => p.hidden === undefined)).toBe(true);
    expect(named(result.images, "tinyImg")?.hidden).toBeUndefined();
    expect(named(result.images, "tinyImg")?.perViewport[0].skipped).toBe("under 16 px");
  }, 180_000);

  it("does not call an image hidden by a body or html that clips to its own height (the overflow goes to the viewport)", async () => {
    const result = await scanBody();
    expect(result.status).toBe("ok");
    expect(named(result.images, "shownImg")?.hidden).toBeUndefined();
  }, 180_000);

  it("adds the page's hidden bytes apart from the savings, and gives no sizes claim to a hidden copy", async () => {
    const result = await scan();
    expect(result.hidden?.images).toBe(8);
    expect(result.hidden?.bytesPerView).toBeGreaterThan(0);
    expect(named(result.images, "opaImg")?.fix.bytes.saved).toBe(0);
    expect(named(result.images, "opaImg")?.fix.quality).toBeUndefined();
  }, 180_000);
});
