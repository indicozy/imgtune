import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ComponentResult } from "../src/analyse.js";
import { applyResults, raiseQuality, renderApplyChanges } from "../src/apply.js";
import { scanFile } from "../src/scan.js";
import { sha1 } from "../src/atomic.js";
import { isDone, loadState, saveState, type StateEntry } from "../src/state.js";
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

describe("applyResults", () => {
  it("edits the ProductItem image block in place: sizes replaced, quality on its own line, nothing else", async () => {
    const rel = "src/components/ProductItem.tsx";
    const fixture = readFileSync(FIXTURE, "utf8");
    const dir = project({
      [rel]: fixture,
      "next.config.mjs": "export default {\n  images: {\n    formats: ['image/avif', 'image/webp'],\n  },\n};\n",
    });
    const usages = scanAll(dir, [rel]);
    const [usage] = usages;
    const sizes = "(max-width: 768px) 280px, 280px";

    const out = await applyResults(dir, [resultFor(usage, { sizes, quality: 62 })], usages);

    // The fixture's attributes sit on their own lines: quality goes on a new line at the first attribute's indent,
    // and the single-quoted sizes literal keeps its quotes.
    expect(readFileSync(join(dir, rel), "utf8")).toBe(
      fixture
        .replace("<Image\n", "<Image\n                quality={62}\n")
        .replace("sizes='33vw'", `sizes='${sizes}'`),
    );
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
        .replace(`sizes='33vw'`, `sizes='50vw'`)
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
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain("sizes='50vw'");
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

  it("copies the usage calibration into its state entry, so verify can judge without the audit report", async () => {
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`,
      "next.config.mjs": "export default {\n  images: {\n    formats: ['image/avif', 'image/webp'],\n  },\n};\n",
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    await applyResults(dir, [{ ...resultFor(usages[0], { quality: 62 }), calibration: { avif: 4, webp: 3 } }], usages);

    const [entry] = await loadState(dir);
    expect(entry.calibration).toEqual({ avif: 4, webp: 3 });
  });

  it("escapes double quotes in a sizes value", async () => {
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} />;\n`,
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    await applyResults(dir, [resultFor(usages[0], { sizes: 'a "b" c' })], usages);
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain('sizes="a &quot;b&quot; c"');
  });

  it("falls back to double quotes for a single-quoted sizes literal when the new value contains a single quote", async () => {
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} sizes='33vw' />;\n`,
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    await applyResults(dir, [resultFor(usages[0], { sizes: "a 'b' c" })], usages);
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain(`sizes="a 'b' c"`);
  });

  it("inserts a new sizes in the file's dominant JSX quote style", async () => {
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <div><Image src='/a.png' alt='x' width={1} height={1} /><Image src='/b.png' alt='y' width={1} height={1} /></div>;\n`,
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    await applyResults(dir, [resultFor(usages[0], { sizes: "300px" })], usages);
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain("sizes='300px'");
  });

  it("inserts a new sizes in double quotes when single and double quoted attributes tie", async () => {
    const dir = project({
      "src/A.tsx": `import Image from "next/image";\nexport const A = () => <div><Image src='/a.png' width={1} height={1} /><Image src="/b.png" width={1} height={1} /></div>;\n`,
    });
    const usages = scanAll(dir, ["src/A.tsx"]);
    await applyResults(dir, [resultFor(usages[0], { sizes: "300px" })], usages);
    expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain('sizes="300px"');
  });

  describe("sizes proposal and the full correction", () => {
    const source = `import Image from "next/image";\nexport const A = () => <Image src="/a.png" width={1} height={1} sizes='33vw' />;\n`;
    const config = "export default {\n  images: {\n    formats: ['image/webp'],\n  },\n};\n";
    const split = {
      sizes: "(max-width: 768px) 33vw, 280px",
      sizesFull: "(max-width: 768px) 280px, 280px",
      quality: 60,
      qualityFull: 45,
    };

    it("applies the branch-merged proposal by default and the quality with it", async () => {
      const dir = project({ "src/A.tsx": source, "next.config.mjs": config });
      const usages = scanAll(dir, ["src/A.tsx"]);
      const out = await applyResults(dir, [resultFor(usages[0], split)], usages);
      const after = readFileSync(join(dir, "src/A.tsx"), "utf8");
      expect(after).toContain("sizes='(max-width: 768px) 33vw, 280px'");
      expect(after).not.toContain("280px, 280px");
      expect(after).toContain("quality={60}");
      expect(after).not.toContain("quality={45}");
      expect(out.skipped).toEqual([]);
      expect(out.edited).toEqual(["next.config.mjs", "src/A.tsx"]);
    });

    it("applies the full correction with allowGrowth, with the quality searched for it (qualityFull)", async () => {
      const dir = project({ "src/A.tsx": source, "next.config.mjs": config });
      const usages = scanAll(dir, ["src/A.tsx"]);
      const out = await applyResults(dir, [resultFor(usages[0], split)], usages, { allowGrowth: true });
      const after = readFileSync(join(dir, "src/A.tsx"), "utf8");
      expect(after).toContain("sizes='(max-width: 768px) 280px, 280px'");
      expect(after).toContain("quality={45}");
      expect(after).not.toContain("quality={60}");
      expect(out.skipped).toEqual([]);
    });

    it("applies the full correction with allowGrowth even when every branch kept its current sizes", async () => {
      const dir = project({ "src/A.tsx": source, "next.config.mjs": config });
      const usages = scanAll(dir, ["src/A.tsx"]);
      const kept = { sizes: undefined, sizesFull: "(max-width: 768px) 280px, 280px", quality: undefined, qualityFull: undefined };
      const plain = await applyResults(dir, [resultFor(usages[0], kept)], usages);
      expect(plain.edited).toEqual([]);
      expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain("sizes='33vw'");

      const full = await applyResults(dir, [resultFor(usages[0], kept)], usages, { allowGrowth: true });
      expect(readFileSync(join(dir, "src/A.tsx"), "utf8")).toContain("sizes='(max-width: 768px) 280px, 280px'");
      expect(full.edited).toEqual(["src/A.tsx"]);
    });

    it("makes no sizes edit when the proposed value is already in place", async () => {
      const dir = project({ "src/A.tsx": source, "next.config.mjs": config });
      const usages = scanAll(dir, ["src/A.tsx"]);
      const out = await applyResults(dir, [resultFor(usages[0], { sizes: "33vw", sizesFull: "33vw" })], usages);
      expect(out.skipped).toEqual([]);
      expect(out.edited).toEqual([]);
    });
  });
});

describe("apply reports each change", () => {
  const HERO_SOURCE =
    'import Image from "next/image";\nexport const Hero = () => <Image src="/a.png" width={480} height={320} quality={70} />;\n';
  const CONFIG_70 = "export default {\n  images: {\n    qualities: [70],\n  },\n};\n";

  it("lists every written change with its old and new value", async () => {
    const rel = "src/components/ProductItem.tsx";
    const dir = project({
      [rel]: readFileSync(FIXTURE, "utf8"),
      "next.config.mjs": "export default {\n  images: {\n    formats: ['image/avif', 'image/webp'],\n  },\n};\n",
    });
    const usages = scanAll(dir, [rel]);
    const sizes = "(max-width: 768px) 280px, 280px";

    const out = await applyResults(dir, [resultFor(usages[0], { sizes, quality: 62 })], usages);

    expect(out.changes).toEqual([
      { usageId: usages[0].id, component: usages[0].component, field: "sizes", from: "33vw", to: sizes, lowersApplied: false },
      { usageId: usages[0].id, component: usages[0].component, field: "quality", to: 62, lowersApplied: false },
    ]);
  });

  it("warns when a change lowers a quality that an earlier apply recorded", async () => {
    const dir = project({ "next.config.mjs": CONFIG_70, "src/Hero.tsx": HERO_SOURCE });
    const usage = scanAll(dir, ["src/Hero.tsx"])[0];
    await saveState(dir, [
      {
        usageId: usage.id,
        relFile: "src/Hero.tsx",
        component: "Hero",
        fileHash: sha1(HERO_SOURCE),
        applied: { quality: 70 },
        at: "2026-10-29T00:00:00.000Z",
      },
    ]);

    const out = await applyResults(dir, [resultFor(usage, { quality: 65 }, 70)], [usage]);

    expect(out.changes).toEqual([
      expect.objectContaining({ component: "Hero", field: "quality", from: 70, to: 65, lowersApplied: true }),
    ]);
    expect(renderApplyChanges(out.changes)).toContain(
      "warning: Hero quality was set to 70 by an earlier apply or --raise; lowering it to 65\n",
    );
  });

  it("does not warn when the quality goes up, or when the source held a value no apply recorded", async () => {
    const dir = project({ "next.config.mjs": CONFIG_70, "src/Hero.tsx": HERO_SOURCE });
    const usage = scanAll(dir, ["src/Hero.tsx"])[0];

    const out = await applyResults(dir, [resultFor(usage, { quality: 75 }, 70)], [usage]);

    expect(out.changes).toEqual([expect.objectContaining({ field: "quality", from: 70, to: 75, lowersApplied: false })]);
    expect(renderApplyChanges(out.changes)).not.toContain("warning");
  });

  it("renders one line per change, with quoted sizes and (none) for an attribute that was absent", () => {
    const text = renderApplyChanges([
      { usageId: "a", component: "IndexPage", field: "sizes", from: "100vw", to: "(max-width: 768px) 100vw, 50vw", lowersApplied: false },
      { usageId: "a", component: "IndexPage", field: "quality", from: 70, to: 65, lowersApplied: false },
      { usageId: "b", component: "Card", field: "quality", to: 60, lowersApplied: false },
    ]);
    expect(text).toBe(
      'IndexPage sizes "100vw" → "(max-width: 768px) 100vw, 50vw"\nIndexPage quality 70 → 65\nCard quality (none) → 60\n',
    );
  });
});

describe("raiseQuality (apply --raise)", () => {
  const CONFIG = "export default {\n  images: {\n    qualities: [70],\n  },\n};\n";
  const HERO = 'import Image from "next/image";\nexport const Hero = () => <Image src="/a.png" width={480} height={320} quality={70} />;\n';
  const OTHER = 'import Image from "next/image";\nexport const Other = () => <Image src="/b.png" width={480} height={320} quality={70} />;\n';
  const TWO = `${HERO}${OTHER.split("\n").slice(1).join("\n")}`;

  /** The state entry apply would have written for the `component` usage of `rel`, applied at `quality`. */
  function appliedEntry(dir: string, rel: string, component: string, quality: number): StateEntry {
    const usage = scanFile(join(dir, rel), dir).find((u) => u.component === component);
    if (!usage) throw new Error(`no ${component} in ${rel}`);
    return {
      usageId: usage.id,
      relFile: rel,
      component,
      fileHash: sha1(readFileSync(join(dir, rel))),
      applied: { quality },
      before: { quality: 90 },
      at: "2026-10-28T00:00:00.000Z",
    };
  }

  it("rewrites the usage's quality, lists it in images.qualities, and records the new file and quality in the state", async () => {
    const dir = project({ "next.config.mjs": CONFIG, "src/Hero.tsx": HERO });
    await saveState(dir, [appliedEntry(dir, "src/Hero.tsx", "Hero", 70)]);

    const result = await raiseQuality(dir, [{ component: "Hero", quality: 75 }]);

    expect(readFileSync(join(dir, "src/Hero.tsx"), "utf8")).toContain("quality={75}");
    expect(readFileSync(join(dir, "next.config.mjs"), "utf8")).toContain("qualities: [70, 75]");
    expect(result.edited).toEqual(["next.config.mjs", "src/Hero.tsx"]);
    expect(result.raised).toEqual([expect.objectContaining({ component: "Hero", from: 70, to: 75 })]);
    const [saved] = await loadState(dir);
    expect(saved.applied.quality).toBe(75);
    expect(saved.before).toEqual({ quality: 90 });
    expect(saved.fileHash).toBe(sha1(readFileSync(join(dir, "src/Hero.tsx"))));
  });

  it("refuses a quality that is not above the applied one, and writes nothing", async () => {
    const dir = project({ "next.config.mjs": CONFIG, "src/Hero.tsx": HERO });
    await saveState(dir, [appliedEntry(dir, "src/Hero.tsx", "Hero", 70)]);

    await expect(raiseQuality(dir, [{ component: "Hero", quality: 70 }])).rejects.toThrow("70 is not above the applied quality 70");
    expect(readFileSync(join(dir, "src/Hero.tsx"), "utf8")).toBe(HERO);
    expect((await loadState(dir))[0].applied.quality).toBe(70);
  });

  it("refuses a usage whose quality is an expression, with the change to make by hand", async () => {
    const dir = project({
      "next.config.mjs": CONFIG,
      "src/Hero.tsx": HERO.replace("quality={70}", "quality={q}"),
    });
    await saveState(dir, [appliedEntry(dir, "src/Hero.tsx", "Hero", 70)]);

    await expect(raiseQuality(dir, [{ component: "Hero", quality: 75 }])).rejects.toThrow("quality is an expression");
    expect(readFileSync(join(dir, "next.config.mjs"), "utf8")).toBe(CONFIG);
  });

  it("refuses a component with no applied usage, and one that matches more than one", async () => {
    const dir = project({ "next.config.mjs": CONFIG, "src/Hero.tsx": HERO, "src/Hero2.tsx": HERO });
    await saveState(dir, [appliedEntry(dir, "src/Hero.tsx", "Hero", 70)]);
    await expect(raiseQuality(dir, [{ component: "Missing", quality: 75 }])).rejects.toThrow("no applied quality");

    await saveState(dir, [appliedEntry(dir, "src/Hero2.tsx", "Hero", 70)]);
    await expect(raiseQuality(dir, [{ component: "Hero", quality: 75 }])).rejects.toThrow("must be unique");
  });

  it("keeps the other usages of the same file measurable: their state follows the new file hash", async () => {
    const dir = project({ "next.config.mjs": CONFIG, "src/Both.tsx": TWO });
    await saveState(dir, [
      appliedEntry(dir, "src/Both.tsx", "Hero", 70),
      appliedEntry(dir, "src/Both.tsx", "Other", 70),
    ]);

    await raiseQuality(dir, [{ component: "Hero", quality: 75 }]);

    const saved = await loadState(dir);
    const newHash = sha1(readFileSync(join(dir, "src/Both.tsx")));
    expect(saved.find((e) => e.component === "Hero")?.fileHash).toBe(newHash);
    expect(saved.find((e) => e.component === "Other")?.fileHash).toBe(newHash);
    expect(saved.find((e) => e.component === "Other")?.applied.quality).toBe(70);
  });

  it("takes the value the user already wrote by hand (quality 75 in the file) and records it without rewriting the file", async () => {
    const dir = project({ "next.config.mjs": CONFIG, "src/Hero.tsx": HERO.replace("quality={70}", "quality={75}") });
    await saveState(dir, [appliedEntry(dir, "src/Hero.tsx", "Hero", 70)]);

    const result = await raiseQuality(dir, [{ component: "Hero", quality: 75 }]);

    expect(result.edited).toEqual(["next.config.mjs"]);
    expect((await loadState(dir))[0].applied.quality).toBe(75);
  });

  it("adds [75, q] when the project has no allowlist and q is not Next's default of 75", async () => {
    const config = "export default {\n  images: {\n    remotePatterns: [],\n  },\n};\n";
    const dir = project({ "next.config.mjs": config, "src/Hero.tsx": HERO });
    await saveState(dir, [appliedEntry(dir, "src/Hero.tsx", "Hero", 70)]);

    await raiseQuality(dir, [{ component: "Hero", quality: 80 }]);

    expect(readFileSync(join(dir, "next.config.mjs"), "utf8")).toContain("qualities: [75, 80]");
  });
});
