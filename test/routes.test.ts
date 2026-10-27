import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRouteIndex, findRoutesForFiles } from "../src/routes.js";

const PROJECT = resolve(import.meta.dirname, "fixtures/app-project");
const src = (rel: string) => resolve(PROJECT, "src", rel);

const PLP = {
  pattern: "/[store]/[...plpPath]",
  pageFile: src("app/[store]/(mobile)/[...plpPath]/page.tsx"),
};
const ABOUT = { pattern: "/[store]/about", pageFile: src("app/[store]/about/page.tsx") };
const FAQ = { pattern: "/[store]/faq", pageFile: src("app/[store]/@sidebar/faq/page.tsx") };
const HOME = { pattern: "/", pageFile: src("app/page.tsx") };
const BUILD = { pattern: "/build", pageFile: src("app/build/page.tsx") };

const byPageFile = <T extends { pageFile: string }>(a: T, b: T) =>
  a.pageFile.localeCompare(b.pageFile);

describe("findRoutesForFiles", () => {
  it("maps a component to the page that imports it through the alias chain", async () => {
    const routes = await findRoutesForFiles(PROJECT, [src("components/Card.tsx")]);
    expect(routes).toEqual([PLP]);
  });

  it("keeps a nested build directory under app/ as a route", async () => {
    const routes = await findRoutesForFiles(PROJECT, [src("components/Badge.tsx")]);
    expect(routes).toEqual([BUILD]);
  });

  it("finds a file that is only reached through a next/dynamic import()", async () => {
    const routes = await findRoutesForFiles(PROJECT, [src("components/Lazy.tsx")]);
    expect(routes).toEqual([HOME]);
  });

  it("maps a file imported by a layout to every page under that layout's directory", async () => {
    const routes = await findRoutesForFiles(PROJECT, [src("components/Shell.tsx")]);
    expect([...routes].sort(byPageFile)).toEqual([PLP, ABOUT, FAQ].sort(byPageFile));
  });

  it("maps a layout file itself to every page under its directory", async () => {
    const routes = await findRoutesForFiles(PROJECT, [src("app/[store]/layout.tsx")]);
    expect([...routes].sort(byPageFile)).toEqual([PLP, ABOUT, FAQ].sort(byPageFile));
  });

  it("maps a page file to its own route", async () => {
    const routes = await findRoutesForFiles(PROJECT, [PLP.pageFile]);
    expect(routes).toEqual([PLP]);
  });

  it("returns [] for a file nothing imports", async () => {
    const routes = await findRoutesForFiles(PROJECT, [src("components/Orphan.tsx")]);
    expect(routes).toEqual([]);
  });

  it("returns unique routes across several input files", async () => {
    const routes = await findRoutesForFiles(PROJECT, [
      src("components/Card.tsx"),
      src("components/Grid.tsx"),
      src("components/Shell.tsx"),
    ]);
    expect([...routes].sort(byPageFile)).toEqual([PLP, ABOUT, FAQ].sort(byPageFile));
  });
});

describe("buildRouteIndex", () => {
  it("answers routesFor for a file and returns [] for files outside the project", async () => {
    const index = await buildRouteIndex(PROJECT);
    expect(index.routesFor(src("components/Card.tsx"))).toEqual([PLP]);
    expect(index.routesFor(resolve(PROJECT, "..", "elsewhere.tsx"))).toEqual([]);
    expect(index.routesByFile.get(src("components/Lazy.tsx"))).toEqual([HOME]);
  });
});

describe("malformed tsconfig", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "imgtune-routes-bad-"));
    writeFileSync(join(dir, "tsconfig.json"), `{ "compilerOptions": { "paths": `);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("throws, naming the tsconfig path", async () => {
    await expect(findRoutesForFiles(dir, [])).rejects.toThrow(join(dir, "tsconfig.json"));
  });
});

describe("without a tsconfig", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "imgtune-routes-"));
    mkdirSync(join(dir, "app", "shop"), { recursive: true });
    writeFileSync(join(dir, "app", "shop", "page.tsx"), `import { Tile } from "../tile";\nexport default Tile;\n`);
    writeFileSync(join(dir, "app", "tile.tsx"), `export function Tile() { return null; }\n`);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves relative imports with default Bundler options", async () => {
    const routes = await findRoutesForFiles(dir, [join(dir, "app", "tile.tsx")]);
    expect(routes).toEqual([{ pattern: "/shop", pageFile: join(dir, "app", "shop", "page.tsx") }]);
  });
});
