// The split flow on a local server: a measured scan of a built-like page, a locate of the same page on a dev-like page (React
// owner data injected into the DOM, as a dev build has it), and the sizes-only recheck on the dev page before and after an
// edit of the sizes. No browser bytes are judged here beyond what the scan itself reads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { gradientNoise, rawToPng } from "./image-fixtures.js";
import { locateCommand } from "../src/locate-only.js";
import { sizesRecheck } from "../src/sizes-recheck.js";
import { runScan, scanOnce, type PageResult } from "../src/remote.js";
import { DEFAULT_VIEWPORTS } from "../src/config.js";

const quiet = () => {};

/** The page markup. The dev variant adds a React owner (as a dev build's fiber would give) and an extra image when asked. */
function pageHtml(opts: { sizes: string; dev: boolean; extra: boolean }): string {
  const img = (src: string) =>
    `<img class="card" src="${src}" srcset="/img/p1-320.jpg 320w, /img/p1-640.jpg 640w, /img/p1-1280.jpg 1280w" sizes="${opts.sizes}" alt="P1" width="200" height="200" style="width:200px;height:200px">`;
  // Line 12 of the page's project file is the image; the page is line-numbered only through the owner data.
  const extra = opts.extra ? `${img("/img/p1-1280.jpg")}\n` : "";
  const devScript = opts.dev
    ? `<script>document.querySelectorAll("img").forEach(function (el) { el["__reactFiber$test"] = { type: function ProductCard() {}, _debugSource: { fileName: "src/components/ProductCard.tsx", lineNumber: 12 }, _debugOwner: null, return: null }; });</script>`
    : "";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>list</title></head><body><main>\n${extra}${img("/img/p1-1280.jpg")}\n${devScript}</main></body></html>`;
}

describe("the measured, locate and sizes-only flow on a local server", () => {
  let dir = "";
  let built: Server;
  let dev: Server;
  let builtUrl = "";
  let devUrl = "";
  const devState = { sizes: "1280px", extra: false };
  const images = new Map<string, Buffer>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-split-"));
    await mkdir(join(dir, "src/components"), { recursive: true });
    const lines = Array.from({ length: 11 }, (_, i) => `// line ${i + 1}`).join("\n");
    await writeFile(join(dir, "src/components/ProductCard.tsx"), `${lines}\n<img src="/img/p1-1280.jpg" alt="P1" />\n`);
    for (const width of [320, 640, 1280]) {
      const raw = gradientNoise(width, Math.round(width * 0.6), 6, width);
      images.set(`/img/p1-${width}.jpg`, await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).jpeg({ quality: 90 }).toBuffer());
    }
    const handler = (variant: "built" | "dev") => (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "/").split("?")[0];
      const image = images.get(path);
      if (image) {
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": image.length });
        res.end(image);
        return;
      }
      if (path === "/list.html") {
        const html = variant === "dev"
          ? pageHtml({ sizes: devState.sizes, dev: true, extra: devState.extra })
          : pageHtml({ sizes: "1280px", dev: false, extra: false });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      res.writeHead(404).end();
    };
    built = createServer(handler("built"));
    dev = createServer(handler("dev"));
    await new Promise<void>((resolve) => built.listen(0, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve) => dev.listen(0, "127.0.0.1", () => resolve()));
    builtUrl = `http://127.0.0.1:${(built.address() as AddressInfo).port}/list.html`;
    devUrl = `http://127.0.0.1:${(dev.address() as AddressInfo).port}/list.html`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => built?.close(() => resolve()));
    await new Promise<void>((resolve) => dev?.close(() => resolve()));
  });

  it("measures the built page, locates the flagged image on dev, and judges the sizes before and after the edit", async () => {
    const iphone = DEFAULT_VIEWPORTS.filter((v) => v.name === "iphone-15").map((v) => ({ ...v }));
    const measured: PageResult = await scanOnce(builtUrl, { outDir: dir, cwd: dir, aggressive: false, quality: false, viewports: iphone, log: quiet });
    expect(measured.status).toBe("ok");
    const flagged = (measured.images ?? []).filter((r) => r.fix.bytes.saved > 0 || r.fix.bytes.addedForSharpness > 0);
    expect(flagged).toHaveLength(1);
    expect(measured.images?.[0].perViewport[0].domIndex).toBe(0);
    await writeFile(join(dir, "measured.json"), JSON.stringify(measured));
    const id = flagged[0].id;
    const proposed = flagged[0].fix.sizes?.value ?? "200px";

    const located = await locateCommand([devUrl, "--locate-only", "--from", join(dir, "measured.json")], dir, quiet);
    expect(located.exitCode).toBe(0);
    expect(located.output).toMatch(/located: 1/);
    const out = JSON.parse(await readFile(join(dir, "measured.located.json"), "utf8")) as PageResult;
    const joined = out.images?.find((r) => r.id === id);
    expect(joined?.locator.file).toBe("src/components/ProductCard.tsx");
    expect(joined?.locator.line).toBe(12);
    expect(joined?.locator.verified).toBe(true);
    expect(joined?.fix.bytes.saved).toBe(flagged[0].fix.bytes.saved);
    expect(out.locate?.joined).toBe(1);
    expect(out.locate?.url).toBe(devUrl);

    // Before the edit: the dev page still chooses the measured file (1280w), which is bigger than the hint's sizes need.
    const before = await sizesRecheck(["--recheck", join(dir, "measured.located.json"), "--sizes-only", "--ids", id], dir, quiet);
    expect(before.exitCode).toBe(1);
    expect(before.output).toMatch(/bigger than the hint needs/);
    expect(before.output).toMatch(new RegExp(`^${id}  FAIL`, "m"));

    // The edit: the sizes the hint proposes, on the dev page (what an agent writes at the call site).
    try {
      devState.sizes = proposed;
      const after = await sizesRecheck(["--recheck", join(dir, "measured.located.json"), "--sizes-only", "--ids", id], dir, quiet);
      // A passing image is one line; the viewport detail is printed only for an image that did not pass.
      expect(after.output).toMatch(new RegExp(`^${id}  PASS`, "m"));
      expect(after.output).not.toMatch(/chosen 640w/);
      expect(after.output).toMatch(/batch: 1 image\(s\).*1 PASS, 0 FAIL, 0 GONE/);
      expect(after.exitCode).toBe(0);
      expect(after.output).toMatch(/ok: every chosen file is sharp/);
      expect(after.output).toMatch(/sizes only: no body decoded/);
    } finally {
      devState.sizes = "1280px";
    }
  }, 180_000);

  it("never guesses a join: a dev page with a different number of the image joins nothing and exits 1", async () => {
    devState.extra = true;
    try {
      const result = await locateCommand([devUrl, "--locate-only", "--from", join(dir, "measured.json"), "--locate-out", join(dir, "extra.json")], dir, quiet);
      expect(result.exitCode).toBe(1);
      expect(result.output).toMatch(/different number of this URL and alt/);
      const out = JSON.parse(await readFile(join(dir, "extra.json"), "utf8")) as PageResult;
      expect(out.locate?.joined).toBe(0);
      expect(out.locate?.reasons).toEqual({ "count-differs": 1 });
      expect(out.images?.[0].locator.file).toBeUndefined();
    } finally {
      devState.extra = false;
    }
  }, 120_000);

  it("refuses to locate on a dev page at another path, and writes nothing", async () => {
    await expect(
      locateCommand([devUrl.replace("/list.html", "/other.html"), "--locate-only", "--from", join(dir, "measured.json"), "--locate-out", join(dir, "x.json")], dir, quiet),
    ).rejects.toThrow(/is not the measured page's/);
  });

  it("the scan run is still a scan: runScan writes the measured page (no locate fields)", async () => {
    const outDir = join(dir, "scan-out");
    const iphone = DEFAULT_VIEWPORTS.filter((v) => v.name === "iphone-15").map((v) => ({ ...v }));
    const results = await runScan([builtUrl], { outDir, cwd: dir, aggressive: false, quality: false, viewports: iphone, log: quiet });
    expect(results[0].status).toBe("ok");
    expect(results[0].locate).toBeUndefined();
    expect(results[0].images?.[0].perViewport[0].domIndex).toBe(0);
  }, 120_000);
});

void rawToPng;
