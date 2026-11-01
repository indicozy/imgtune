// The harness rung (SKILL.md, Evidence ladder): an image that renders only behind a condition is measured on a temporary
// route, /__imgtune/<component>, that renders each state. The fixture is a plain HTML app, with its harness route
// switched on and off as the skill's steps say (add the route, scan it, remove it).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { hintsOf, renderHint } from "../src/hints.js";
import { rungOfPage } from "../src/images.js";
import { renderPage, runScan, type PageResult } from "../src/remote.js";
import type { Viewport } from "../src/types.js";

const desktop: Viewport = { name: "desktop", width: 1280, height: 800, dpr: 1, mobile: false };

describe("rungOfPage", () => {
  it("a harness route is measured-harness; any other page is measured-page", () => {
    expect(rungOfPage("https://shop.example.test/__imgtune/ProductCard?state=member")).toBe("measured-harness");
    expect(rungOfPage("http://localhost:3000/__imgtune/Card")).toBe("measured-harness");
    expect(rungOfPage("https://shop.example.test/shop")).toBe("measured-page");
    expect(rungOfPage("https://shop.example.test/shop/__imgtune")).toBe("measured-page");
  });
});

describe("harness scan of a component whose image renders only in one state", () => {
  let base = "";
  let server: Server | undefined;
  let harnessRoute = true;
  let out = "";

  beforeAll(async () => {
    const hero = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#7a5" } }).jpeg({ quality: 90 }).toBuffer();
    // The page: a product list. The card's image renders only for a member; a guest sees the card without it.
    const shop = `<!doctype html><html><head><meta charset="utf-8"><title>shop</title></head><body>
      <main><h1>Shop</h1><div class="card"><p>Sunglasses</p></div></main></body></html>`;
    const card = (member: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>card</title></head><body>
      <div class="card" data-testid="product-card">${member ? '<img src="/hero.jpg" width="300" height="200" alt="Aviator">' : "<p>Sign in for the member price</p>"}</div>
      </body></html>`;
    const started = await new Promise<{ base: string; server: Server }>((resolve) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        const target = new URL(req.url ?? "/", "http://fixture.invalid");
        const html = (body: string) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(body);
        };
        if (target.pathname === "/hero.jpg") {
          res.writeHead(200, { "content-type": "image/jpeg" });
          return res.end(hero);
        }
        if (target.pathname === "/shop") return html(shop);
        if (target.pathname === "/__imgtune/ProductCard" && harnessRoute) {
          return html(card(target.searchParams.get("state") === "member"));
        }
        res.writeHead(404);
        res.end("not found");
      });
      s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
    });
    server = started.server;
    base = started.base;
    out = mkdtempSync(join(tmpdir(), "imgtune-harness-"));
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const scan = async (path: string): Promise<PageResult> => {
    const [result] = await runScan([`${base}${path}`], { outDir: out, cwd: out, aggressive: false, quality: false, viewports: [desktop], log: () => {} });
    return result;
  };

  it("the page a visitor sees has no image in this state, so a plain scan finds none", async () => {
    const result = await scan("/shop");
    expect(result.status).toBe("ok");
    expect(result.counts.images).toBe(0);
    expect(result.images ?? []).toEqual([]);
  }, 120_000);

  it("the harness route renders the state with the image: records carry the measured-harness rung, not measured-page", async () => {
    const result = await scan("/__imgtune/ProductCard?state=member");
    const records = result.images ?? [];
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.evidence.rung).toBe("measured-harness");
    expect(record.fix.sizes).toMatchObject({ value: "300px", rung: "measured-harness" });
    expect(record.perViewport[0]).toMatchObject({ renderedCssPx: 300, servedPx: 1200, loaded: true });
    expect(record.evidence.notes[0]).toMatch(/^measured in isolation: harness route \/__imgtune\/ProductCard/);
    expect(record.fix.bytes.saved).toBeGreaterThan(0);
  }, 120_000);

  it("hints print the rung, and the page renderer says the figures are the component's", async () => {
    const result = await scan("/__imgtune/ProductCard?state=member");
    const [hint] = hintsOf(result);
    expect(hint.rung).toBe("measured-harness");
    expect(renderHint(hint, 1).join("\n")).toContain("rung measured-harness");
    expect(renderPage(result, false).join("\n")).toContain("measured in isolation (harness route)");
  }, 120_000);

  it("the guest state of the same route has no image, so there is nothing to fix there", async () => {
    const result = await scan("/__imgtune/ProductCard?state=guest");
    expect(result.images ?? []).toEqual([]);
  }, 120_000);

  it("once the route is removed (the skill's last step), the harness URL serves nothing to measure", async () => {
    harnessRoute = false;
    try {
      const result = await scan("/__imgtune/ProductCard?state=member");
      expect(result.images ?? []).toEqual([]);
    } finally {
      harnessRoute = true;
    }
  }, 120_000);
});
