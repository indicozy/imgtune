import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listSourceFiles, scanFile } from "../src/scan.js";

const PROJECT = resolve(import.meta.dirname, "fixtures/scan");
const fixture = (name: string) => resolve(PROJECT, name);

describe("scanFile", () => {
  it("detects an aliased next/image import", () => {
    const file = fixture("aliased.tsx");
    const usages = scanFile(file, PROJECT);
    expect(usages).toHaveLength(1);
    const [u] = usages;
    const text = readFileSync(file, "utf8");
    expect(u.tag).toBe("Image");
    expect(u.component).toBe("Card");
    expect(u.file).toBe(file);
    expect(u.relFile).toBe("aliased.tsx");
    expect(u.line).toBe(4);
    expect(u.col).toBe(10);
    expect(u.id).toBe("aliased.tsx:4:10");
    expect(u.tagNameEnd).toBe(text.indexOf("<Pic") + "<Pic".length);
    expect(u.props.sizes).toEqual({
      kind: "literal",
      value: "33vw",
      start: text.indexOf('sizes="33vw"'),
      end: text.indexOf('sizes="33vw"') + 'sizes="33vw"'.length,
    });
    expect(u.props.quality).toEqual({ kind: "absent" });
    expect(u.props.width).toEqual({
      kind: "literal",
      value: 160,
      start: text.indexOf("width={160}"),
      end: text.indexOf("width={160}") + "width={160}".length,
    });
    expect(u.props.src.kind).toBe("expression");
    expect(u.srcExpressionText).toBe("p.url");
    expect(u.hasSpread).toBe(false);
  });

  it("reports expression-valued sizes and quality as expression", () => {
    const [u] = scanFile(fixture("expressions.tsx"), PROJECT);
    expect(u.props.sizes.kind).toBe("expression");
    expect(u.props.quality.kind).toBe("expression");
    expect(u.component).toBe("Hero");
    expect(u.props.src).toMatchObject({ kind: "literal", value: "/a.png" });
    expect(u.srcExpressionText).toBe("/a.png");
  });

  it("sets hasSpread for a JSX spread attribute", () => {
    const [u] = scanFile(fixture("spread.tsx"), PROJECT);
    expect(u.hasSpread).toBe(true);
    expect(u.props.sizes).toEqual({ kind: "absent" });
  });

  it("handles fill with a static import and no width", () => {
    const [u] = scanFile(fixture("fill.tsx"), PROJECT);
    expect(u.props.fill.kind).toBe("literal");
    expect(u.props.fill).toMatchObject({ value: true });
    expect(u.props.width).toEqual({ kind: "absent" });
    expect(u.srcExpressionText).toBe("hero");
    expect(u.component).toBe("Banner");
  });

  it("reports plain img elements with tag img", () => {
    const [u] = scanFile(fixture("plain-img.tsx"), PROJECT);
    expect(u.tag).toBe("img");
    expect(u.component).toBe("Plain");
    expect(u.srcExpressionText).toBe("/x.jpg");
  });

  it("ignores an Image imported from a local module", () => {
    expect(scanFile(fixture("other-image.tsx"), PROJECT)).toEqual([]);
  });

  it("catches elements with children, derives component names, skips next/legacy/image", () => {
    const usages = scanFile(fixture("children.tsx"), PROJECT);
    expect(usages.map((u) => [u.component, u.tag, u.srcExpressionText])).toEqual([
      ["Card", "Image", "/a.png"],
      ["Tile", "Image", "/b.png"],
      ["Gallery", "Image", "/c.png"],
    ]);
    const text = readFileSync(fixture("children.tsx"), "utf8");
    expect(usages[0].tagNameEnd).toBe(text.indexOf("<NextImage") + "<NextImage".length);
    expect(usages[1].props.sizes).toMatchObject({ kind: "literal", value: "10vw" });
    expect(usages[1].props.quality).toMatchObject({ kind: "literal", value: 60 });
  });
});

describe("component attribution", () => {
  it("ignores variables that merely hold a JSX-producing call", () => {
    const usages = scanFile(fixture("attribution.tsx"), PROJECT);
    expect(usages.map((u) => [u.component, u.srcExpressionText])).toEqual([
      ["Grid", "i.url"],
      ["Grid", "/m.png"],
      ["Nested", "/n.png"],
      ["Wrapped", "/w.png"],
    ]);
  });
});

describe("script kind", () => {
  it("parses .ts files without JSX, so angle-bracket casts do not throw or match", () => {
    expect(scanFile(fixture("angle-cast.ts"), PROJECT)).toEqual([]);
  });
});

describe("literal prop forms", () => {
  it("reads string, numeric, boolean and template literals inside braces", () => {
    const [first, second] = scanFile(fixture("literal-forms.tsx"), PROJECT);
    expect(first.srcExpressionText).toBe("/a.png");
    expect(first.props.src).toMatchObject({ kind: "literal", value: "/a.png" });
    expect(first.props.sizes).toMatchObject({ kind: "literal", value: "33vw" });
    expect(first.props.quality).toMatchObject({ kind: "literal", value: 85 });
    expect(first.props.fill).toMatchObject({ kind: "literal", value: true });
    expect(second.props.src).toMatchObject({ kind: "literal", value: "/b.png" });
    expect(second.props.sizes).toMatchObject({ kind: "literal", value: "10vw" });
    expect(second.props.width.kind).toBe("expression");
    expect(second.props.height).toMatchObject({ kind: "literal", value: false });
  });
});

describe("listSourceFiles", () => {
  const TREE_FILES = [
    "app/page.tsx",
    "app/page.test.tsx",
    "components/Card.stories.tsx",
    "components/util.ts",
    "lib/helper.jsx",
    "node_modules/pkg/index.tsx",
    ".next/server.js",
    "dist/out.js",
    "build/b.js",
    "storybook-static/x.js",
    ".imgtune/cache.js",
  ];
  let tree: string;

  // Built per run: node_modules/dist/build are git-ignored, so they cannot be fixtures.
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "imgtune-scan-tree-"));
    for (const rel of TREE_FILES) {
      const abs = join(tree, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "export {};\n");
    }
  });

  afterAll(async () => {
    await rm(tree, { recursive: true, force: true });
  });

  it("returns source files and skips build, vendor and test/story files", async () => {
    const files = await listSourceFiles(tree, ["."]);
    expect(files.map((f) => f.slice(tree.length + 1)).sort()).toEqual([
      "app/page.tsx",
      "components/util.ts",
      "lib/helper.jsx",
    ]);
    expect(files.every((f) => f.startsWith(tree))).toBe(true);
  });

  it("accepts absolute paths", async () => {
    const files = await listSourceFiles(tree, [join(tree, "app")]);
    expect(files.map((f) => f.slice(tree.length + 1))).toEqual(["app/page.tsx"]);
  });
});
