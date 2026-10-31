import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { gradientNoise } from "./image-fixtures.js";
import { expandGlob, imageCommand, parseImageArgs, renderFile, type FileResult } from "../src/image-file.js";

describe("parseImageArgs", () => {
  it("takes the inputs and the defaults", () => {
    expect(parseImageArgs(["a.jpg"])).toEqual({ inputs: ["a.jpg"], dprs: [1, 2], formats: ["avif", "webp", "jpeg"], format: "text" });
  });

  it("reads --width, --dpr, --formats, --write and --format", () => {
    expect(parseImageArgs(["a.jpg", "--width", "400", "--dpr", "1,3", "--formats", "webp,avif", "--write", "out", "--format", "json"])).toMatchObject({
      width: 400,
      dprs: [1, 3],
      formats: ["webp", "avif"],
      write: "out",
      format: "json",
    });
  });

  it("refuses no input, a bad width, an unknown format and an unknown option", () => {
    expect(() => parseImageArgs(["--width", "400"])).toThrow(/usage: imgtune image/);
    expect(() => parseImageArgs(["a.jpg", "--width", "0"])).toThrow(/above 0/);
    expect(() => parseImageArgs(["a.jpg", "--formats", "gif"])).toThrow(/avif, webp or jpeg/);
    expect(() => parseImageArgs(["a.jpg", "--depth", "2"])).toThrow(/Unknown option/);
  });
});

describe("expandGlob", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-glob-"));
    await mkdir(join(dir, "public/img/deep"), { recursive: true });
    await mkdir(join(dir, "public/node_modules/pkg"), { recursive: true });
    await writeFile(join(dir, "public/img/a.jpg"), "x");
    await writeFile(join(dir, "public/img/deep/b.png"), "x");
    await writeFile(join(dir, "public/img/c.gif"), "x");
    await writeFile(join(dir, "public/node_modules/pkg/d.jpg"), "x");
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("matches ** across folders, the braces, and skips node_modules", async () => {
    const found = await expandGlob("public/**/*.{jpg,png}", dir);
    expect(found.map((f) => f.slice(dir.length + 1))).toEqual(["public/img/a.jpg", "public/img/deep/b.png"]);
  });

  it("returns a plain path as it is", async () => {
    expect(await expandGlob("public/img/a.jpg", dir)).toEqual([join(dir, "public/img/a.jpg")]);
  });
});

describe("renderFile", () => {
  it("says what went wrong for a file it could not measure", () => {
    const result = {
      label: "logo.svg",
      evidence: "file-mode",
      imgtuneVersion: "0.1.0",
      current: { format: "svg", width: 0, height: 0, bytes: 2048 },
      width: { source: "file" },
      bar: { ssimulacra2: 70, basis: "floor" },
      sizes: [],
      error: "svg is not measured",
    } as FileResult;
    expect(renderFile(result)).toBe("logo.svg  svg 0x0  2 KB now\n  svg is not measured\n");
  });
});

describe("imageCommand (real encodes on generated images)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-image-"));
    const raw = gradientNoise(320, 200, 6, 3);
    await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), { raw: { width: 320, height: 200, channels: 4 } })
      .jpeg({ quality: 60 })
      .toFile(join(dir, "hero.jpg"));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("measures a file at its own size with evidence file-mode and the bar it had to meet", async () => {
    const { output, exitCode } = await imageCommand(["hero.jpg", "--format", "json", "--formats", "webp"], dir);
    expect(exitCode).toBe(0);
    const body = JSON.parse(output) as { evidence: string; files: FileResult[] };
    expect(body.evidence).toBe("file-mode");
    const [file] = body.files;
    expect(file.width).toEqual({ source: "file" });
    expect(file.bar.ssimulacra2).toBeGreaterThanOrEqual(70);
    expect(file.sizes).toHaveLength(1);
    expect(file.sizes[0].perFormat.webp?.quality).toBeGreaterThan(0);
  }, 120_000);

  it("with --width measures the needed width at each dpr and labels the width as the user's", async () => {
    const { output } = await imageCommand(["hero.jpg", "--width", "100", "--dpr", "1,2", "--formats", "webp", "--format", "json"], dir);
    const [file] = (JSON.parse(output) as { files: FileResult[] }).files;
    expect(file.width).toEqual({ source: "user", css: 100 });
    expect(file.sizes.map((s) => s.px)).toEqual([100, 200]);
    expect(file.sizes.map((s) => s.dpr)).toEqual([1, 2]);
    expect(renderFile(file)).toContain("from --width: the user's");
  }, 120_000);

  it("never overwrites: a second --write of the same copy is refused for the existing file", async () => {
    const out = join(dir, "copies");
    const first = await imageCommand(["hero.jpg", "--formats", "webp", "--write", out], dir);
    expect(first.output).toContain("-> copies/hero.webp");
    const second = await imageCommand(["hero.jpg", "--formats", "webp", "--write", out], dir);
    expect(second.output).toContain("hero.webp: not written (the file exists)");
    expect(await readdir(out)).toEqual(["hero.webp"]);
  }, 120_000);

  it("refuses to write a copy into the folder of the original", async () => {
    const { output } = await imageCommand(["hero.jpg", "--formats", "webp", "--write", "."], dir);
    expect(output).toContain("not written (the copy folder is the file's own folder)");
  }, 120_000);

  it("reports a missing file as an error and exits 1", async () => {
    await writeFile(join(dir, "broken.jpg"), "not an image");
    const { output, exitCode } = await imageCommand(["broken.jpg", "--format", "json"], dir);
    expect(exitCode).toBe(1);
    expect((JSON.parse(output) as { files: FileResult[] }).files[0].error).toBe("not a decodable image");
  }, 60_000);
});
