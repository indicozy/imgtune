import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hasNoStore, makeFetcher } from "../src/fetch.js";

// The run-wide fetch memo: the key, in-flight sharing, and what is not kept (a failure, a no-store body).

let base = "";
let server: Server;
const hits: string[] = [];
let flakyCalls = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    hits.push(url);
    // A short delay, so concurrent callers are still waiting when the answer comes.
    setTimeout(() => {
      if (url === "/ok") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end("abc");
      } else if (url === "/private") {
        res.writeHead(200, { "cache-control": "public, no-store" });
        res.end("secret");
      } else if (url === "/flaky") {
        flakyCalls++;
        if (flakyCalls === 1) {
          res.writeHead(500);
          res.end("try again");
        } else {
          res.writeHead(200);
          res.end("back");
        }
      } else {
        res.writeHead(404);
        res.end("nope");
      }
    }, 30);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("hasNoStore", () => {
  it("reads the no-store directive in a Cache-Control value", () => {
    expect(hasNoStore("no-store")).toBe(true);
    expect(hasNoStore("public, no-store")).toBe(true);
    expect(hasNoStore("max-age=0, NO-STORE , must-revalidate")).toBe(true);
    expect(hasNoStore("no-storex")).toBe(false);
    expect(hasNoStore("public, max-age=14400, must-revalidate")).toBe(false);
    expect(hasNoStore(undefined)).toBe(false);
  });
});

describe("makeFetcher run memo", () => {
  it("shares one request among callers asking for the same URL and options, while in flight", async () => {
    hits.length = 0;
    const fetcher = makeFetcher({ userAgent: "ua" });
    const answers = await Promise.all([1, 2, 3].map(() => fetcher.get(`${base}/ok`, { allowPrivate: true })));
    expect(hits.filter((h) => h === "/ok")).toHaveLength(1);
    expect(answers[0]?.toString()).toBe("abc");
    expect(answers[1]).toBe(answers[0]);
    expect(answers[2]).toBe(answers[0]);
  });

  it("keys on the options: a different limit or site asks again, the same options do not", async () => {
    hits.length = 0;
    const fetcher = makeFetcher({ userAgent: "ua" });
    await fetcher.get(`${base}/ok`, { allowPrivate: true });
    await fetcher.get(`${base}/ok`, { allowPrivate: true });
    expect(hits.filter((h) => h === "/ok")).toHaveLength(1);
    await fetcher.get(`${base}/ok`, { allowPrivate: true, maxBytes: 1024 });
    expect(hits.filter((h) => h === "/ok")).toHaveLength(2);
    await fetcher.get(`${base}/ok`, { allowPrivate: true, sameSiteAs: base });
    expect(hits.filter((h) => h === "/ok")).toHaveLength(3);
  });

  it("does not keep a failure: a later call asks again and gets the body", async () => {
    hits.length = 0;
    flakyCalls = 0;
    const fetcher = makeFetcher({ userAgent: "ua" });
    const [first, second] = await Promise.all([fetcher.get(`${base}/flaky`, { allowPrivate: true }), fetcher.get(`${base}/flaky`, { allowPrivate: true })]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(hits.filter((h) => h === "/flaky")).toHaveLength(1);
    expect((await fetcher.get(`${base}/flaky`, { allowPrivate: true }))?.toString()).toBe("back");
    expect(hits.filter((h) => h === "/flaky")).toHaveLength(2);
  });

  it("shares a no-store body while it is in flight, but asks again once it has settled", async () => {
    hits.length = 0;
    const fetcher = makeFetcher({ userAgent: "ua" });
    const [a, b] = await Promise.all([fetcher.get(`${base}/private`, { allowPrivate: true }), fetcher.get(`${base}/private`, { allowPrivate: true })]);
    expect(hits.filter((h) => h === "/private")).toHaveLength(1);
    expect(a?.toString()).toBe("secret");
    expect(b).toBe(a);
    await fetcher.get(`${base}/private`, { allowPrivate: true });
    expect(hits.filter((h) => h === "/private")).toHaveLength(2);
  });
});
