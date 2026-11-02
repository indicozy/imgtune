// The allowed qualities of an app, read statically from next.config (next-config.ts): js, mjs and ts, missing, multiline.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextQualities, qualitiesOfConfig, stripComments } from "../src/next-config.js";

describe("stripComments", () => {
  it("removes line and block comments, and keeps a URL inside a string", () => {
    const text = 'const u = "https://cdn.example/x"; // trailing\n/* block\nqualities: [1] */ const v = 2;';
    const stripped = stripComments(text);
    expect(stripped).toContain('"https://cdn.example/x"');
    expect(stripped).not.toContain("trailing");
    expect(stripped).not.toContain("qualities");
    expect(stripped).toContain("const v = 2;");
  });
});

describe("qualitiesOfConfig", () => {
  it("reads a one-line list, sorted and without repeats", () => {
    expect(qualitiesOfConfig("export default { images: { qualities: [100, 75, 75] } };")).toEqual({ kind: "found", qualities: [75, 100] });
  });

  it("reads a multiline list with trailing commas and comments on the entries", () => {
    const source = `
const nextConfig = {
  images: {
    qualities: [
      75, // the default
      85,
      100,
    ],
  },
};
export default nextConfig;
`;
    expect(qualitiesOfConfig(source)).toEqual({ kind: "found", qualities: [75, 85, 100] });
  });

  it("ignores a commented-out qualities list", () => {
    expect(qualitiesOfConfig("// qualities: [50]\nexport default { images: { qualities: [75] } };")).toEqual({ kind: "found", qualities: [75] });
    expect(qualitiesOfConfig("/* qualities: [1] */ export default {};")).toEqual({ kind: "missing" });
  });

  it("reports a missing list", () => {
    expect(qualitiesOfConfig("export default { images: { formats: ['image/avif'] } };")).toEqual({ kind: "missing" });
  });

  it("refuses a list that is not plain numbers, an empty one, or one out of range", () => {
    expect(qualitiesOfConfig("qualities: [75, q]").kind).toBe("unreadable");
    expect(qualitiesOfConfig("qualities: []").kind).toBe("unreadable");
    expect(qualitiesOfConfig("qualities: [0]").kind).toBe("unreadable");
    expect(qualitiesOfConfig("qualities: [101]").kind).toBe("unreadable");
  });
});

describe("nextQualities", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-next-config-"));
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function appWith(name: string, text: string): Promise<string> {
    const app = await mkdtemp(join(dir, "app-"));
    await writeFile(join(app, name), text);
    return app;
  }

  it("reads next.config.js", async () => {
    const app = await appWith("next.config.js", "module.exports = { images: { qualities: [75, 90] } };");
    expect(await nextQualities(app)).toEqual({ qualities: [75, 90], note: "images.qualities [75, 90] from next.config.js" });
  });

  it("reads next.config.mjs with a multiline list", async () => {
    const app = await appWith("next.config.mjs", "export default {\n  images: {\n    qualities: [\n      60,\n      100,\n    ],\n  },\n};\n");
    expect((await nextQualities(app)).qualities).toEqual([60, 100]);
  });

  it("reads next.config.ts", async () => {
    const app = await appWith("next.config.ts", "const config: NextConfig = { images: { qualities: [85] } };\nexport default config;\n");
    expect((await nextQualities(app)).qualities).toEqual([85]);
  });

  it("assumes Next's default [75] and says so when the config has no list", async () => {
    const app = await appWith("next.config.mjs", "export default { reactStrictMode: true };");
    const result = await nextQualities(app);
    expect(result.qualities).toEqual([75]);
    expect(result.note).toMatch(/no images\.qualities in next\.config\.mjs.*\[75\] assumed/);
  });

  it("assumes Next's default [75] and says so when there is no config at all", async () => {
    const app = join(dir, "bare");
    await mkdir(app, { recursive: true });
    const result = await nextQualities(app);
    expect(result.qualities).toEqual([75]);
    expect(result.note).toMatch(/no next\.config/);
  });
});
