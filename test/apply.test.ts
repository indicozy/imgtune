import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ComponentResult } from "../src/analyse.js";
import { applyResults } from "../src/apply.js";
import { scanFile } from "../src/scan.js";
import { sha1 } from "../src/atomic.js";
import { isDone, loadState } from "../src/state.js";
import type { ImageUsage } from "../src/types.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/apply/ProductItem.tsx");

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "imgtune-apply-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function scanAll(dir: string, rels: string[]): ImageUsage[] {
  return rels.flatMap((rel) => scanFile(join(dir, rel), dir));
}

function resultFor(usage: ImageUsage, proposed: Partial<ComponentResult["proposed"]>, currentQuality = 75): ComponentResult {
  return {
    usageId: usage.id,
    component: usage.component,
    relFile: usage.relFile,
    line: usage.line,
    instances: 1,
    current: { sizes: undefined, quality: currentQuality, bytesByViewport: {} },
    proposed: { ...proposed, width: 160 },
    savedBytesTotal: 1024,
    estimated: true,
    servedFormats: ["avif"],
    notes: [],
  };
}

/** Line-by-line diff: indexes of lines that differ, and whether the line count is unchanged. */
function lineDiff(before: string, after: string): { changed: number[]; sameLineCount: boolean } {
  const a = before.split("\n");
  const b = after.split("\n");
  const changed: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push(i);
  return { changed, sameLineCount: a.length === b.length };
}

describe("applyResults", () => {
  it("edits the ProductItem image block in place: sizes replaced, quality inserted, nothing else", async () => {
    const rel = "src/components/ProductItem.tsx";
    const dir = project({
      [rel]: readFileSync(FIXTURE, "utf8"),
      "next.config.mjs": "export default {\n  images: {\n    formats: ['image/avif', 'image/webp'],\n  },\n};\n",
    });
    const before = readFileSync(join(dir, rel), "utf8");
    const usages = scanAll(dir, [rel]);
    const [usage] = usages;
    const sizes = "(max-width: 768px) calc(50vw - 20px), 220px";

    const out = await applyResults(dir, [resultFor(usage, { sizes, quality: 62 })], usages);

    const after = readFileSync(join(dir, rel), "utf8");
    const diff = lineDiff(before, after);
    expect(diff.sameLineCount).toBe(true);
    expect(diff.changed).toHaveLength(2);
    const lines = after.split("\n");
    expect(lines[diff.changed[0]]).toBe("              <Image quality={62}");
    expect(lines[diff.changed[1]]).toBe(`                sizes="${sizes}"`);
    expect(out.skipped).toEqual([]);
    expect(out.edited).toEqual(["next.config.mjs", rel]);
  });

  it("adds the quality to images.qualities when the config has no such array", async () => {
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`,
      "next.config.mjs": "export default {\n  images: {\n    formats: ['image/avif', 'image/webp'],\n  },\n};\n",
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    await applyResults(dir, [resultFor(usages[0], { quality: 60 })], usages);
    expect(readFileSync(join(dir, "next.config.mjs"), "utf8")).toBe(
      "export default {\n  images: {\n    qualities: [75, 60],\n    formats: ['image/avif', 'image/webp'],\n  },\n};\n",
    );
  });

  it("merges a new quality into an existing images.qualities array, with and without a loaderFile", async () => {
    for (const extra of ["", "    loaderFile: './loader.ts',\n"]) {
      const dir = project({
        "src/A.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`,
        "next.config.mjs": `export default {\n  images: {\n    qualities: [75, 85, 100],\n${extra}  },\n};\n`,
      });
      const usages = scanAll(dir, ["src/A.tsx"]);
      await applyResults(dir, [resultFor(usages[0], { quality: 60 })], usages);
      expect(readFileSync(join(dir, "next.config.mjs"), "utf8")).toContain("qualities: [60, 75, 85, 100]");
    }
  });

  it("does not touch next.config when no quality changes", async () => {
    const config = "export default {\n  images: {\n    formats: ['image/webp'],\n  },\n};\n";
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`,
      "next.config.mjs": config,
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    const out = await applyResults(dir, [resultFor(usages[0], { sizes: "50vw" })], usages);
    expect(readFileSync(join(dir, "next.config.mjs"), "utf8")).toBe(config);
    expect(out.edited).toEqual(["src/A.tsx"]);
  });

  it("skips a quality when next.config is missing, leaving the source untouched", async () => {
    const source = `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`;
    const dir = project({ "src/A.tsx": source });
    const usages = scanAll(dir, ["src/A.tsx"]);
    const out = await applyResults(dir, [resultFor(usages[0], { quality: 62 })], usages);
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toBe(source);
    expect(out.skipped).toEqual([
      { usageId: usages[0].id, reason: "manual change needed: add 62 to images.qualities in next.config" },
    ]);
  });

  it("skips an expression sizes and leaves the file untouched", async () => {
    const source = `import Image from "next/image";\nexport function Hero({ mobile }) {\n  return <Image src="/a.png" width={100} height={100} sizes={mobile ? "50vw" : "20vw"} />;\n}\n`;
    const dir = project({ "src/Hero.tsx": source });
    const usages = scanAll(dir, ["src/Hero.tsx"]);
    const out = await applyResults(dir, [resultFor(usages[0], { sizes: "10vw" })], usages);
    expect(readFileSync(join(dir, "src/Hero.tsx"), "utf8")).toBe(source);
    expect(out.edited).toEqual([]);
    expect(out.skipped).toEqual([{ usageId: usages[0].id, reason: "manual change needed: sizes is an expression" }]);
  });

  it("skips sizes and quality that come from a spread", async () => {
    const source = `import Image from "next/image";\nexport function Logo(rest) {\n  return <Image {...rest} src="/a.png" width={1} height={1} alt="" />;\n}\n`;
    const dir = project({ "src/Logo.tsx": source });
    const usages = scanAll(dir, ["src/Logo.tsx"]);
    const out = await applyResults(dir, [resultFor(usages[0], { sizes: "10vw", quality: 60 })], usages);
    expect(readFileSync(join(dir, "src/Logo.tsx"), "utf8")).toBe(source);
    expect(out.skipped.map((s) => s.reason)).toEqual([
      "manual change needed: sizes is an expression",
      "manual change needed: quality is an expression",
    ]);
  });

  it("never edits a plain <img>", async () => {
    const source = `export function Plain() {\n  return <img src="/x.jpg" />;\n}\n`;
    const dir = project({ "src/Plain.tsx": source });
    const usages = scanAll(dir, ["src/Plain.tsx"]);
    const out = await applyResults(dir, [resultFor(usages[0], { sizes: "10vw" })], usages);
    expect(readFileSync(join(dir, "src/Plain.tsx"), "utf8")).toBe(source);
    expect(out.skipped).toEqual([{ usageId: usages[0].id, reason: "plain <img> is report-only" }]);
  });

  it("skips a usage whose file changed since the audit", async () => {
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`,
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    writeFileSync(
      join(dir, "src/A.tsx"),
      `import Image from "next/image";\n\n\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`,
    );
    const out = await applyResults(dir, [resultFor(usages[0], { sizes: "50vw" })], usages);
    expect(out.skipped).toEqual([{ usageId: usages[0].id, reason: "file changed since audit" }]);
    expect(out.edited).toEqual([]);
  });

  it("edits two usages in one file from one read of the text", async () => {
    const source = [
      'import Image from "next/image";',
      "export const A = () => (",
      "  <div>",
      `    <Image src="/a.png" width={1} height={1} sizes='33vw' />`,
      `    <Image src="/b.png" width={1} height={1} />`,
      "  </div>",
      ");",
      "",
    ].join("\n");
    const dir = project({
      "src/A.tsx": source,
      "next.config.mjs": "export default {\n  images: {\n    formats: ['image/webp'],\n  },\n};\n",
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    const out = await applyResults(
      dir,
      [resultFor(usages[0], { sizes: "50vw" }), resultFor(usages[1], { quality: 60 })],
      usages,
    );
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toBe(
      source
        .replace(`sizes='33vw'`, `sizes="50vw"`)
        .replace(`<Image src="/b.png"`, `<Image quality={60} src="/b.png"`),
    );
    expect(readFileSync(join(dir, "next.config.mjs"), "utf8")).toContain("qualities: [75, 60],");
    expect(out.skipped).toEqual([]);
    expect(out.edited).toEqual(["next.config.mjs", "src/A.tsx"]);
  });

  it("skips a file whose content differs from the audit hash", async () => {
    const source = `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`;
    const dir = project({ "src/A.tsx": source });
    const usages = scanAll(dir, ["src/A.tsx"]);
    const out = await applyResults(dir, [resultFor(usages[0], { sizes: "50vw" })], usages, {
      expectedHashes: { "src/A.tsx": "0".repeat(40) },
    });
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toBe(source);
    expect(out.edited).toEqual([]);
    expect(out.skipped).toEqual([
      { usageId: usages[0].id, reason: "file changed since audit; re-run imgtune audit" },
    ]);
  });

  it("does not edit next.config when its hash differs from the audit; quality is skipped with that reason", async () => {
    const config = "export default {\n  images: {\n    formats: ['image/webp'],\n  },\n};\n";
    const source = `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} sizes='33vw' />;\n`;
    const dir = project({ "src/A.tsx": source, "next.config.mjs": config });
    const usages = scanAll(dir, ["src/A.tsx"]);
    const out = await applyResults(dir, [resultFor(usages[0], { sizes: "50vw", quality: 60 })], usages, {
      expectedHashes: { "src/A.tsx": sha1(source), "next.config.mjs": "0".repeat(40) },
    });
    expect(readFileSync(join(dir, "next.config.mjs"), "utf8")).toBe(config);
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain('sizes="50vw"');
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).not.toContain("quality={60}");
    expect(out.skipped).toEqual([
      { usageId: usages[0].id, reason: "file changed since audit; re-run imgtune audit" },
    ]);
    expect(out.edited).toEqual(["src/A.tsx"]);
  });

  // Needs a non-root user: root ignores the directory mode, so the second write would not fail.
  it.skipIf(process.getuid?.() === 0)("keeps the state for files already written when a later write fails", async () => {
    const first = `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`;
    const second = `import Image from "next/image";\nexport const B = () => <Image src="/b.png" width={1} height={1} />;\n`;
    const dir = project({ "src/A.tsx": first, "src/locked/B.tsx": second });
    const usages = scanAll(dir, ["src/A.tsx", "src/locked/B.tsx"]);
    chmodSync(join(dir, "src/locked"), 0o555);
    try {
      await expect(
        applyResults(dir, [resultFor(usages[0], { sizes: "50vw" }), resultFor(usages[1], { sizes: "50vw" })], usages),
      ).rejects.toThrow();
    } finally {
      chmodSync(join(dir, "src/locked"), 0o755);
    }
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain('sizes="50vw"');
    const entries = await loadState(dir);
    expect(entries.map((e) => e.usageId)).toEqual([usages[0].id]);
  });

  it("records a state entry whose hash matches the edited file", async () => {
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} sizes='33vw' />;\n`,
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    await applyResults(dir, [resultFor(usages[0], { sizes: "50vw" })], usages);

    const [entry] = await loadState(dir);
    const text = readFileSync(join(dir, "src/A.tsx"), "utf8");
    expect(entry.usageId).toBe(usages[0].id);
    expect(entry.applied).toEqual({ sizes: "50vw" });
    expect(entry.before?.quality).toBe(75);
    expect(entry.fileHash).toBe(sha1(text));
    expect(isDone(entry, sha1(text))).toBe(true);

    writeFileSync(join(dir, "src/A.tsx"), text + "\n");
    expect(isDone(entry, sha1(readFileSync(join(dir, "src/A.tsx"), "utf8")))).toBe(false);
  });

  it("escapes double quotes in a sizes value", async () => {
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`,
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    await applyResults(dir, [resultFor(usages[0], { sizes: 'a "b" c' })], usages);
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain('sizes="a &quot;b&quot; c"');
  });
});
