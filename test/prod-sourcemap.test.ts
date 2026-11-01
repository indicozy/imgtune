// `scan --locate-only` on a production build: the owner component's function location, mapped through the chunk's source
// map, gives the component's file:line (locator.via "prod-sourcemap"). The fixture is a committed Vite build of a tiny app
// with a fake React fiber chain (test/fixtures/prod-sourcemap). The dist is a minified Vite build of src/app.js, with a v3
// source map whose sources are renamed to webpack:// names, as Next.js writes them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { locateCommand } from "../src/locate-only.js";
import { runScan, type PageResult } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/prod-sourcemap");
const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

describe("locate on a production build (prod-sourcemap)", () => {
  let base = "";
  let server: Server | undefined;
  let project = "";
  let hero: Buffer;

  beforeAll(async () => {
    hero = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#7a5" } }).jpeg({ quality: 90 }).toBuffer();
    const dist = join(FIXTURE, "dist");
    const started = await new Promise<{ base: string; server: Server }>((resolveStart) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        const path = (req.url ?? "/").split("?")[0];
        if (path === "/hero.jpg") {
          res.writeHead(200, { "content-type": "image/jpeg" });
          return res.end(hero);
        }
        const file = path === "/" ? "index.html" : path.slice(1);
        const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".map") ? "application/json" : "text/html; charset=utf-8";
        try {
          const body = readFileSync(join(dist, file));
          res.writeHead(200, { "content-type": type });
          return res.end(body);
        } catch {
          res.writeHead(404);
          return res.end();
        }
      });
      s.listen(0, "127.0.0.1", () => resolveStart({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
    });
    server = started.server;
    base = started.base;
    // The project the locate reads: the app's source, at the path the source map names (src/app.js).
    project = await mkdtemp(join(tmpdir(), "imgtune-prodmap-"));
    await writeFile(join(project, "package.json"), '{"name":"fixture","private":true}\n');
    mkdirSync(join(project, "src"));
    copyFileSync(join(FIXTURE, "src/app.js"), join(project, "src/app.js"));
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolveStop) => server?.close(() => resolveStop()));
  });

  it("locates the owner components of a flagged image at their definitions, without a dev server", async () => {
    const out = join(project, ".imgtune");
    const [measured]: PageResult[] = await runScan([`${base}/`], {
      outDir: out,
      cwd: project,
      aggressive: false,
      quality: false,
      viewports: [desktop],
      log: () => {},
    });
    expect(measured.status).toBe("ok");
    const flagged = (measured.images ?? []).filter((r) => r.fix.bytes.saved > 0);
    expect(flagged).toHaveLength(1);
    const measuredPath = join(out, "measured.json");
    await writeFile(measuredPath, `${JSON.stringify(measured)}\n`);

    const { output, exitCode } = await locateCommand([`${base}/`, "--locate-only", "--from", measuredPath], project, () => {});
    expect(exitCode).toBe(0);
    expect(output).toMatch(/located: 1/);
    const located = JSON.parse(await readFile(join(out, "measured.located.json"), "utf8")) as PageResult;
    const [record] = located.images ?? [];
    // Line 3 is `function ProductCard(props) {`, the nearest owner's definition (the image is inside it).
    expect(record.locator.file).toBe("src/app.js");
    expect(record.locator.line).toBe(3);
    expect(record.locator.via).toBe("prod-sourcemap");
    expect(record.locator.kind).toBe("owner");
    expect(record.locator.verified).toBe(false);
    // Production names are minified, and the source map's name is not read: the component name stays empty (the file:line is the definition).
    expect(record.locator.component).toEqual([]);
    expect(record.evidence.notes.join("\n")).toMatch(/located on the built page.s source map at desktop/);
    expect(record.locate?.viewport).toBe("desktop");
  }, 180_000);
});
