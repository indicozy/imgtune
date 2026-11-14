// The vector check end to end: a scan with quality on traces its flat logo within the budget, writes the SVG under the
// scan's folder, claims the saving, and says so in the hints. A budget of 0 traces nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runScan, type PageResult, type ScanOptions } from "../src/remote.js";
import { hintsOf, renderHint } from "../src/hints.js";
import type { Viewport } from "../src/types.js";

const desktop: Viewport = { name: "desktop", width: 800, height: 600, dpr: 1, mobile: false };
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">
<rect width="600" height="200" fill="#ffffff"/><circle cx="100" cy="100" r="70" fill="#e4572e"/>
<rect x="200" y="60" width="330" height="80" rx="14" fill="#29335c"/></svg>`;

describe("the vector check in a scan", () => {
  let base = "";
  let server: Server | undefined;
  let cwd = "";

  beforeAll(async () => {
    const logo = await sharp(Buffer.from(LOGO_SVG)).png().toBuffer();
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end('<!doctype html><html><head><meta charset="utf-8"><title>logo</title></head><body><img src="/logo.png" width="600" height="200" alt="Logo"></body></html>');
      }
      if (url === "/logo.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(logo);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    cwd = await mkdtemp(join(tmpdir(), "imgtune-vector-scan-"));
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  });

  const options = (outDir: string, over: Partial<ScanOptions> = {}): ScanOptions => ({
    outDir,
    cwd,
    aggressive: false,
    quality: true,
    viewports: [desktop],
    log: () => undefined,
    ...over,
  });

  it("traces the logo, writes its SVG, claims the saving and hints it", async () => {
    const outDir = join(cwd, "traced");
    const [page] = (await runScan([base], options(outDir, { svgBudget: 5 }))) as PageResult[];
    const logo = (page.images ?? []).find((r) => r.current.src?.endsWith("/logo.png"));
    const vector = logo?.fix.vector;
    expect(vector?.passed).toBe(true);
    expect(vector?.tracedFile).toMatch(/svg[\\/].+\.svg$/);
    expect(vector?.savedPerView).toBeGreaterThan(0);
    expect(logo?.fix.bytes.saved).toBeGreaterThanOrEqual(vector?.savedPerView ?? 0);
    const file = await readFile(join(outDir, "svg", `${logo?.id}.svg`), "utf8");
    expect(file).toMatch(/<svg/);
    const hint = hintsOf(page).find((h) => h.id === logo?.id);
    expect(hint?.vector?.passed).toBe(true);
    expect(renderHint(hint as NonNullable<typeof hint>, 1).join("\n")).toMatch(/vector art: serve SVG, ~[\d.]+ KB \(br\) vs [\d.]+ KB now/);
  });

  it("traces nothing with --svg-budget 0, and the flat logo says why", async () => {
    const outDir = join(cwd, "untraced");
    const [page] = (await runScan([base], options(outDir, { svgBudget: 0 }))) as PageResult[];
    const logo = (page.images ?? []).find((r) => r.current.src?.endsWith("/logo.png"));
    expect(logo?.fix.vector?.notChecked).toBe("svg-budget 0");
    expect(logo?.fix.vector?.passed).toBeUndefined();
  });
});
