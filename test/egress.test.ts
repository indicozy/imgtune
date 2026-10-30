import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.js";
import { runScan } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

/** Public test name shop.test resolves to this address; connectAddress maps it onto the loopback test server. */
const PUBLIC = "93.184.216.34";
const publicResolver = async (host: string) => (host === "shop.test" ? [{ address: PUBLIC, family: 4 }] : []);
const mapToLoopback = (address: string) => (address === PUBLIC ? "127.0.0.1" : address);

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

/** One absolute-form request through the proxy, as the browser sends it. Resolves with the status, or "dropped". */
function viaProxy(proxy: EgressProxy, target: string, host: string): Promise<{ status?: number; location?: string; body: string }> {
  const p = new URL(proxy.url);
  return new Promise((resolve) => {
    const req = httpRequest({ host: p.hostname, port: Number(p.port), method: "GET", path: target, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on("error", () => resolve({ body: "dropped" }));
    req.end();
  });
}

/** A CONNECT tunnel to `authority`; resolves with the status line, or "dropped" when the proxy drops it. */
function connectTunnel(proxy: EgressProxy, authority: string): Promise<string> {
  const p = new URL(proxy.url);
  return new Promise((resolve) => {
    const socket = netConnect({ host: p.hostname, port: Number(p.port) });
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk.toString();
      if (head.includes("\r\n\r\n")) {
        resolve(head.split("\r\n")[0]);
        socket.destroy();
      }
    });
    socket.on("close", () => resolve("dropped"));
    socket.on("error", () => resolve("dropped"));
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe("egress proxy: every hop of the browser is checked", () => {
  let page = 0;
  let secretHits = 0;
  const hops: string[] = [];
  let pub: Server;
  let secret: Server;
  let secretPort = 0;
  let proxy: EgressProxy;

  beforeAll(async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#6a8" } }).png().toBuffer();
    const sec = await listen((req, res) => {
      secretHits++;
      if (req.url?.startsWith("/secret.png")) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png);
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>SECRET</body></html>");
    });
    secret = sec.server;
    secretPort = sec.port;
    const pubs = await listen((req, res) => {
      const url = req.url ?? "";
      hops.push(url);
      if (url === "/start") {
        res.writeHead(302, { location: `http://127.0.0.1:${secretPort}/secret` });
        return res.end();
      }
      if (url === "/ok") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("hello");
      }
      res.writeHead(404);
      res.end();
    });
    pub = pubs.server;
    page = pubs.port;
    proxy = await startEgressProxy({ resolver: publicResolver, allowPrivate: false, connectAddress: mapToLoopback });
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => pub.close(() => resolve()));
    await new Promise<void>((resolve) => secret.close(() => resolve()));
  });

  it("passes a public redirect through, but drops the hop to a loopback address with no request", async () => {
    secretHits = 0;
    const first = await viaProxy(proxy, `http://shop.test:${page}/start`, `shop.test:${page}`);
    expect(first.status).toBe(302);
    expect(first.location).toBe(`http://127.0.0.1:${secretPort}/secret`);
    const hop = await viaProxy(proxy, `http://127.0.0.1:${secretPort}/secret`, `127.0.0.1:${secretPort}`);
    expect(hop.body).toBe("dropped");
    expect(secretHits).toBe(0);
  });

  it("drops a request to a loopback name or a metadata literal, with no request", async () => {
    secretHits = 0;
    const result = await viaProxy(proxy, "http://169.254.169.254/latest/meta-data/", "169.254.169.254");
    expect(result.body).toBe("dropped");
    expect(await viaProxy(proxy, `http://2130706433:${secretPort}/secret`, `2130706433:${secretPort}`)).toEqual({ body: "dropped" });
    expect(secretHits).toBe(0);
  });

  it("tunnels a public CONNECT, and drops a CONNECT to a loopback address", async () => {
    expect(await connectTunnel(proxy, `shop.test:${page}`)).toBe("HTTP/1.1 200 Connection Established");
    expect(await connectTunnel(proxy, `127.0.0.1:${secretPort}`)).toBe("dropped");
    expect(await connectTunnel(proxy, "[::ffff:169.254.169.254]:443")).toBe("dropped");
    expect(secretHits).toBe(0);
  });

  it("counts each refused hop", async () => {
    let refused = 0;
    const counted = await startEgressProxy({ resolver: publicResolver, allowPrivate: false, connectAddress: mapToLoopback }, () => {
      refused++;
    });
    await viaProxy(counted, `http://127.0.0.1:${secretPort}/secret`, `127.0.0.1:${secretPort}`);
    await connectTunnel(counted, "127.0.0.1:443");
    await counted.close();
    expect(refused).toBe(2);
  });
});

describe("scan: a public page's redirects and subresources stay checked", () => {
  const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };
  let page = 0;
  let secretPort = 0;
  let secretHits = 0;
  let servers: Server[] = [];
  const pageHtml = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

  beforeAll(async () => {
    const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#6a8" } }).png().toBuffer();
    const sec = await listen((req, res) => {
      secretHits++;
      if (req.url?.startsWith("/secret.png")) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(png);
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageHtml("SECRET"));
    });
    servers.push(sec.server);
    secretPort = sec.port;
    const pubs = await listen((req, res) => {
      const url = req.url ?? "";
      if (url === "/start") {
        res.writeHead(302, { location: `http://127.0.0.1:${secretPort}/secret` });
        return res.end();
      }
      if (url === "/image-page") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(pageHtml(`<img src="/img-redirect" width="320" height="200" alt="">`));
      }
      if (url === "/img-redirect") {
        res.writeHead(302, { location: `http://127.0.0.1:${secretPort}/secret.png` });
        return res.end();
      }
      if (url === "/robots.txt") {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(pubs.server);
    page = pubs.port;
  });

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  const scan = async (path: string) => {
    const out = mkdtempSync(join(tmpdir(), "imgtune-egress-"));
    const [result] = await runScan([`http://shop.test:${page}${path}`], {
      outDir: out,
      cwd: out,
      aggressive: false,
      quality: false,
      viewports: [desktop],
      log: () => {},
      loadCapMs: 5_000,
      resolver: publicResolver,
      connectAddress: mapToLoopback,
    });
    return { result, out };
  };

  it("does not follow a document redirect to a loopback address", async () => {
    secretHits = 0;
    const { result } = await scan("/start");
    expect(result.status).not.toBe("ok");
    expect(secretHits).toBe(0);
  }, 60_000);

  it("refuses an image redirect to a loopback address, and counts it as blocked", async () => {
    secretHits = 0;
    const { result } = await scan("/image-page");
    expect(result.status).toBe("ok");
    expect(secretHits).toBe(0);
    expect(result.counts.blockedRequests).toBeGreaterThan(0);
  }, 60_000);
});
