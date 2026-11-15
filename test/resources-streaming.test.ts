// A response still streaming when the scan settles keeps its size (Content-Length) and its compression finding: the record is
// not dropped for bytes it has not yet read (the regression: 14 JSON files of a site lost their finding to the settle).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "../src/remote.js";
import { readResourceBody } from "../src/resources/capture.js";
import type { ResourceRecord } from "../src/resources/types.js";
import type { Viewport } from "../src/types.js";

const DESKTOP: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

describe("a response still streaming at the settle", () => {
  let server: Server | undefined;
  let base = "";
  const body = JSON.stringify({ items: Array.from({ length: 6000 }, (_, i) => ({ id: i, label: `item ${i}`, tags: ["a", "b", "c"] })) });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/data.json") {
        res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
        res.write(body.slice(0, 1000));
        // The rest arrives after the network-idle cap (10 s) and the resource settle (1.5 s): the record is unfinished when read.
        setTimeout(() => res.end(body.slice(1000)), 12_000);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><html><head><title>stream</title></head><body><script>fetch("/data.json").then((r) => r.text());</script><p>text</p></body></html>');
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it("keeps the JSON's compression finding, estimated or measured, and never a zero-byte record", async () => {
    const out = mkdtempSync(join(tmpdir(), "imgtune-stream-"));
    const [result] = await runScan([base], { outDir: out, cwd: out, aggressive: false, quality: false, viewports: [DESKTOP], log: () => {} });
    expect(result.status).toBe("ok");
    const finding = (result.resources ?? []).find((f) => f.kind === "compression" && f.url.endsWith("/data.json"));
    expect(finding).toBeDefined();
    expect(finding?.savedBytes ?? 0).toBeGreaterThan(0);
  }, 180_000);
});

describe("the body of a captured response (readResourceBody)", () => {
  // A response as far as readResourceBody reads it: its headers, its finish, its wire size and its body.
  const fakeResponse = (body: Buffer, wire: number) =>
    ({
      finished: async () => null,
      request: () => ({ sizes: async () => ({ responseBodySize: wire }) }),
      headers: () => ({}),
      body: async () => body,
    }) as never;
  const blank = (): ResourceRecord => ({
    url: "https://site.example/a.json",
    pageUrl: "https://site.example/",
    viewport: "desktop",
    resourceType: "fetch",
    contentType: "application/json",
    bytes: 0,
    status: 200,
    thirdParty: false,
  });

  it("keeps an uncompressed response uncompressed when its reported wire size is close to the body", async () => {
    const body = Buffer.alloc(260_470, 0x7b);
    const record = blank();
    await readResourceBody(record, fakeResponse(body, 260_000));
    expect(record.contentEncoding).toBeUndefined();
    expect(record.body?.length).toBe(260_470);
  });

  it("marks a response compressed on the wire (wire under half the body) as unknown-encoded", async () => {
    const body = Buffer.alloc(260_470, 0x7b);
    const record = blank();
    await readResourceBody(record, fakeResponse(body, 40_000));
    expect(record.contentEncoding).toBe("unknown");
  });
});
