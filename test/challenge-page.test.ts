// A WAF challenge page is blocked, not measured: it can carry a few images (a captcha's own), so the image count does not
// clear it. A normal page that mentions a captcha in its text, with its images, stays ok.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const STILL = readFileSync(fileURLToPath(new URL("./fixtures/media/still.png", import.meta.url)));
const IMAGES = `<img src="/still.png?a" width="120" height="80" alt=""><img src="/still.png?b" width="120" height="80" alt="">`;
const CHALLENGE = `<!doctype html><html><head><meta charset="utf-8"><title>Please wait</title></head><body>
  <p>Type the characters you see below to continue (captcha).</p>${IMAGES}</body></html>`;
const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>Captchas explained</title></head><body>
  <p>This article is about captcha design and how a captcha is solved by people.</p>${IMAGES}</body></html>`;

describe("a challenge page is blocked, a normal page that mentions captchas is ok", () => {
  const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
  let server: Server | undefined;
  let base = "";

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/waf") {
        res.writeHead(202, { "content-type": "text/html; charset=utf-8", "x-amzn-waf-action": "challenge" });
        return res.end(CHALLENGE);
      }
      if (path === "/article") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(ARTICLE);
      }
      if (path === "/still.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": STILL.length });
        return res.end(STILL);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const scan = (path: string) =>
    runScan([`${base}${path}`], {
      outDir: mkdtempSync(join(tmpdir(), "imgtune-waf-")),
      cwd: mkdtempSync(join(tmpdir(), "imgtune-waf-cwd-")),
      aggressive: false,
      quality: false,
      mediaBudget: 0,
      viewports: [desktop],
      log: () => {},
    }).then(([result]) => result);

  it("a document the WAF marks as a challenge is blocked, even with a few images", async () => {
    const result = await scan("/waf");
    expect(result?.status).toBe("blocked");
    expect(result).not.toHaveProperty("page");
  }, 120_000);

  it("a normal page with its images stays ok, though its text mentions a captcha", async () => {
    const result = await scan("/article");
    expect(result?.status).toBe("ok");
    expect(result).toHaveProperty("page");
  }, 120_000);
});
