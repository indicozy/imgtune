import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/media/", import.meta.url));
const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

// A hidden copy (display:none at desktop). The first page also loads a script from a name that does not resolve (the scan's
// egress proxy cannot look it up, though a browser might): its hidden copy is unverified. The second page does not.
const page = (script: string, id: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${id}</title>
  ${script}<style>#mobOnly { display: none; }</style></head><body>
  <video id="mobOnly" muted playsinline preload="auto" src="/hidden.mp4?c=${id}" width="320" height="180"></video>
</body></html>`;

describe("a page with a name the scan cannot resolve has unverified hidden copies", () => {
  let server: Server | undefined;
  let base = "";
  const pages: Record<string, string> = {
    "/unresolved": page('<script src="http://imgtune-unresolved.invalid/app.js"></script>', "unresolved"),
    "/resolved": page("", "resolved"),
  };

  beforeAll(async () => {
    const file = readFileSync(join(FIXTURES, "hidden.mp4"));
    const started = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        const path = (req.url ?? "").split("?")[0];
        if (pages[path] !== undefined) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(pages[path]);
        }
        if (path === "/hidden.mp4") {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
          if (range) {
            const start = Number(range[1]);
            const end = range[2] === "" ? file.length - 1 : Math.min(Number(range[2]), file.length - 1);
            res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${file.length}`, "content-length": end - start + 1 });
            return res.end(file.subarray(start, end + 1));
          }
          res.writeHead(200, { "content-type": "video/mp4", "content-length": file.length });
          return res.end(file);
        }
        res.writeHead(404);
        res.end();
      });
      s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
    });
    server = started.server;
    base = started.base;
  }, 60_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const scanOne = async (path: string) => {
    const out = mkdtempSync(join(tmpdir(), "imgtune-unresolved-"));
    const [r] = await runScan([`${base}${path}`], { outDir: out, cwd: out, aggressive: false, quality: false, mediaBudget: 0, viewports: [desktop], log: () => {} }, );
    return (r?.videos ?? []).find((v) => v.locator.selector.includes("#mobOnly"));
  };

  it("marks the hidden copy unstable when a name on the page did not resolve", async () => {
    const copy = await scanOne("/unresolved");
    expect(copy?.hidden?.reasons).toEqual(["display"]);
    expect(copy?.hidden?.unstable).toBe("unknown");
  }, 120_000);

  it("leaves the hidden copy verified when every name on the page resolved", async () => {
    const copy = await scanOne("/resolved");
    expect(copy?.hidden?.reasons).toEqual(["display"]);
    expect(copy?.hidden?.unstable).toBeUndefined();
  }, 120_000);
});
