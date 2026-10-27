import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { DEFAULT_VIEWPORTS } from "../src/config.js";
import { measurePages } from "../src/measure.js";

const iphone15 = DEFAULT_VIEWPORTS.find((viewport) => viewport.name === "iphone-15");
const desktop = DEFAULT_VIEWPORTS.find((viewport) => viewport.name === "desktop");
if (!iphone15 || !desktop) throw new Error("default viewports changed: iphone-15 / desktop missing");

const PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>measure fixture</title>
</head>
<body style="margin:0">
  <div style="display:grid;grid-template-columns:1fr 1fr;padding:0 20px">
    <img data-imgtune="a" data-imgtune-src="/o.jpg"
         srcset="/i-375.jpg 375w, /i-640.jpg 640w" sizes="33vw"
         style="width:100%;height:auto;display:block">
  </div>
  <div style="height:3000px"></div>
  <img data-imgtune="lazy" data-imgtune-src="/lazy.jpg" src="/lazy.jpg" loading="lazy"
       style="width:100%;height:auto;display:block">
</body>
</html>`;

interface ServedFile {
  body: Buffer;
  type: string;
}

const files = new Map<string, ServedFile>();
/** Accept headers seen on image requests, in arrival order. */
const imageAccepts: string[] = [];
let server: Server;
let baseUrl: string;

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 60 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

beforeAll(async () => {
  files.set("/page", { body: Buffer.from(PAGE_HTML), type: "text/html; charset=utf-8" });
  files.set("/o.jpg", { body: await makeJpeg(1600, 1200), type: "image/jpeg" });
  files.set("/i-375.jpg", { body: await makeJpeg(375, 281), type: "image/jpeg" });
  files.set("/i-640.jpg", { body: await makeJpeg(640, 480), type: "image/jpeg" });
  files.set("/lazy.jpg", { body: await makeJpeg(800, 600), type: "image/jpeg" });

  server = createServer((req, res) => {
    const path = req.url ?? "";
    const file = files.get(path);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    if (path.endsWith(".jpg")) imageAccepts.push(req.headers.accept ?? "");
    res.writeHead(200, { "content-type": file.type, "content-length": file.body.length });
    res.end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("measurePages", () => {
  it(
    "measures rendered size, bytes and lazy images at iphone-15",
    async () => {
      const observations = await measurePages(baseUrl, ["/page"], [iphone15!]);

      const eager = observations.find((o) => o.usageId === "a");
      expect(eager).toBeDefined();
      expect(eager!.page).toBe("/page");
      expect(eager!.viewport).toBe("iphone-15");
      expect(eager!.viewportWidth).toBe(390);
      expect(eager!.dpr).toBe(3);
      expect(eager!.mobile).toBe(true);
      expect(eager!.accept).toBe("default");
      expect(eager!.renderedWidth).toBeCloseTo((390 - 40) / 2, 0);
      expect(eager!.sizesAttr).toBe("33vw");
      expect(eager!.srcsetWidths).toEqual([375, 640]);
      expect(eager!.originalSrc).toBe("/o.jpg");
      // 33vw of 390px at dpr 3 is ~386 device px, so the 640w candidate is chosen.
      expect(eager!.currentSrc).toBe(`${baseUrl}/i-640.jpg`);
      expect(eager!.bytes).toBe(files.get("/i-640.jpg")!.body.length);
      expect(eager!.contentType).toBe("image/jpeg");

      const lazy = observations.find((o) => o.usageId === "lazy");
      expect(lazy).toBeDefined();
      expect(lazy!.renderedWidth).toBeGreaterThan(0);
      expect(lazy!.originalSrc).toBe("/lazy.jpg");
      expect(lazy!.bytes).toBe(files.get("/lazy.jpg")!.body.length);
    },
    120_000,
  );

  it(
    "adds a webp pass for mobile viewports only when requested",
    async () => {
      imageAccepts.length = 0;
      const observations = await measurePages(baseUrl, ["/page"], [iphone15!, desktop!], {
        webpPass: true,
      });

      const defaults = observations.filter((o) => o.accept === "default" && o.usageId === "a");
      const webp = observations.filter((o) => o.accept === "webp");
      expect(defaults.map((o) => o.viewport).sort()).toEqual(["desktop", "iphone-15"]);
      expect(new Set(webp.map((o) => o.viewport))).toEqual(new Set(["iphone-15"]));
      const webpEager = webp.find((o) => o.usageId === "a");
      expect(webpEager).toBeDefined();
      expect(webpEager!.bytes).toBe(files.get("/i-640.jpg")!.body.length);
      expect(imageAccepts).toContain("image/webp,*/*");
    },
    120_000,
  );
});
