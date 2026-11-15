// A page whose linked stylesheet fails to load is measured without its styles: an image then falls back to its width
// attribute, so every width and sizes verdict on it is wrong. The scan says so instead of measuring on quietly.

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

// A page that links one stylesheet from its own origin (it applies) and one from a second origin that refuses it (a CDN that
// fails for a while): the page is styled, so the failure is a warning and the page keeps its numbers.
const PAGE = (sheet: string) =>
  `<!doctype html><html><head><meta charset="utf-8">${sheet}<style>img{display:block}</style></head>` +
  `<body><img alt="x" width="160" height="160" sizes="33vw" src="/img.svg"></body></html>`;

describe("a stylesheet that did not load", () => {
  const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
  let server: Server | undefined;
  let base = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/broken.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE('<link rel="stylesheet" href="/missing.css">'));
      } else if (req.url === "/sound.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE('<link rel="stylesheet" href="/ok.css">'));
      } else if (req.url === "/partial.html") {
        const other = `http://localhost:${(server?.address() as AddressInfo).port}`;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE(`<link rel="stylesheet" href="${other}/missing.css"><link rel="stylesheet" href="/ok.css">`));
      } else if (req.url === "/ok.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end("body{margin:0}");
      } else if (req.url === "/img.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const scan = async (path: string) => {
    const out = mkdtempSync(join(tmpdir(), "imgtune-sheet-"));
    const logs: string[] = [];
    const [result] = await runScan([`${base}${path}`], {
      outDir: out,
      cwd: out,
      aggressive: false,
      quality: false,
      viewports: [desktop],
      log: (m: string) => logs.push(m),
    });
    return { result, logs };
  };

  it("records a stylesheet the server refused on the page and warns, naming the viewport; the page is broken, with no numbers", async () => {
    const { result, logs } = await scan("/broken.html");
    // A page that is not styled as the app is cannot be measured as the app: it is broken (see broken.ts).
    expect(result.status).toBe("broken");
    expect(result).not.toHaveProperty("page");
    expect(result.broken?.kind).toBe("stylesheet");
    expect(result.stylesheetHosts).toEqual([new URL(base).host]);
    expect(result.stylesheetsFailed).toEqual({ desktop: 1 });
    const warning = logs.find((line) => line.includes("a linked stylesheet did not load"));
    expect(warning?.includes("at desktop;")).toBe(true);
  }, 90_000);

  it("a failed sheet from a second origin beside one that applies is a warning: the page stays ok and keeps its numbers", async () => {
    const { result, logs } = await scan("/partial.html");
    expect(result.status).toBe("ok");
    expect(result).toHaveProperty("page");
    expect(result.broken).toBeUndefined();
    expect(result.stylesheetsFailed).toEqual({ desktop: 1 });
    expect(result.stylesheetsLoaded).toBe(1);
    expect(logs.some((line) => line.includes("a linked stylesheet did not load"))).toBe(true);
  }, 90_000);

  it("keeps a sound page as it was: no stylesheetsFailed key and no warning", async () => {
    const { result, logs } = await scan("/sound.html");
    expect(result.status).toBe("ok");
    expect(result).not.toHaveProperty("stylesheetsFailed");
    expect(logs.some((line) => line.includes("did not load"))).toBe(false);
  }, 90_000);
});
