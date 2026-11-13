import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { gradientNoise } from "./image-fixtures.js";
import { copyFile } from "node:fs/promises";
import { runFfmpeg } from "../src/ffmpeg.js";
import { expandGlob, imageCommand, parseImageArgs, renderFile, type FileResult } from "../src/image-file.js";

const MEDIA = join(import.meta.dirname, "fixtures", "media");

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

  it("reads --min-score and leaves the bar to the default when it is absent", () => {
    expect(parseImageArgs(["a.jpg"]).minScore).toBeUndefined();
    expect(parseImageArgs(["a.jpg", "--min-score", "85.5"]).minScore).toBe(85.5);
  });

  it("refuses no input, a bad width, an unknown format and an unknown option", () => {
    expect(() => parseImageArgs(["--width", "400"])).toThrow(/usage: imgtune image/);
    expect(() => parseImageArgs(["a.jpg", "--width", "0"])).toThrow(/above 0/);
    expect(() => parseImageArgs(["a.jpg", "--formats", "gif"])).toThrow(/avif, webp or jpeg/);
    expect(() => parseImageArgs(["a.jpg", "--depth", "2"])).toThrow(/Unknown option/);
  });

  it("refuses a --min-score outside above 0 and at most 100", () => {
    expect(() => parseImageArgs(["a.jpg", "--min-score", "0"])).toThrow(/--min-score needs a number above 0 and at most 100/);
    expect(() => parseImageArgs(["a.jpg", "--min-score", "101"])).toThrow(/at most 100/);
    expect(() => parseImageArgs(["a.jpg", "--min-score", "high"])).toThrow(/not high/);
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
      bar: { ssimulacra2: 90, basis: "default" },
      sizes: [],
      error: "svg is not measured",
    } as FileResult;
    expect(renderFile(result)).toBe("logo.svg  svg 0x0  2 KB now\n  svg is not measured\n");
  });

  it("prints the bar the file had to meet, and where it came from", () => {
    const base: FileResult = {
      label: "hero.jpg",
      evidence: "file-mode",
      imgtuneVersion: "0.1.0",
      current: { format: "jpeg", width: 320, height: 200, bytes: 4096 },
      width: { source: "file" },
      bar: { ssimulacra2: 90, basis: "default" },
      sizes: [],
    };
    expect(renderFile(base)).toContain(
      "bar SSIMULACRA2 90 against the file itself (default, visually lossless; --min-score sets another)",
    );
    expect(renderFile({ ...base, bar: { ssimulacra2: 60, basis: "user" } })).toContain(
      "bar SSIMULACRA2 60 against the file itself (from --min-score)",
    );
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
    expect(file.bar).toEqual({ ssimulacra2: 90, basis: "default" });
    expect(file.sizes).toHaveLength(1);
    // The noisy JPEG fixture is held to 90 against itself: webp either meets that bar at some quality or misses it.
    const webp = file.sizes[0].perFormat.webp;
    expect(webp?.missed === true || (webp?.quality ?? 0) > 0).toBe(true);
  }, 120_000);

  it("--min-score sets the bar that every format must meet, and the output prints it", async () => {
    const { output } = await imageCommand(["hero.jpg", "--min-score", "60", "--formats", "webp", "--format", "json"], dir);
    const [file] = (JSON.parse(output) as { files: FileResult[] }).files;
    expect(file.bar).toEqual({ ssimulacra2: 60, basis: "user" });
    const text = await imageCommand(["hero.jpg", "--min-score", "60", "--formats", "webp"], dir);
    expect(text.output).toContain("bar SSIMULACRA2 60 against the file itself (from --min-score)");
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
    const first = await imageCommand(["hero.jpg", "--formats", "webp", "--min-score", "70", "--write", out], dir);
    expect(first.output).toContain("-> copies/hero.webp");
    const second = await imageCommand(["hero.jpg", "--formats", "webp", "--min-score", "70", "--write", out], dir);
    expect(second.output).toContain("hero.webp: not written (the file exists)");
    expect(await readdir(out)).toEqual(["hero.webp"]);
  }, 120_000);

  it("refuses to write a copy into the folder of the original", async () => {
    const { output } = await imageCommand(["hero.jpg", "--formats", "webp", "--min-score", "70", "--write", "."], dir);
    expect(output).toContain("not written (the copy folder is the file's own folder)");
  }, 120_000);

  it("reports a missing file as an error and exits 1", async () => {
    await writeFile(join(dir, "broken.jpg"), "not an image");
    const { output, exitCode } = await imageCommand(["broken.jpg", "--format", "json"], dir);
    expect(exitCode).toBe(1);
    expect((JSON.parse(output) as { files: FileResult[] }).files[0].error).toBe("not a decodable image");
  }, 60_000);
});

describe("parseImageArgs for media (--reference, the video bars, --json)", () => {
  it("reads --reference, --video-bar, --video-still-bar and --json", () => {
    expect(parseImageArgs(["clip.mp4", "--reference", "orig.mp4", "--video-bar", "90", "--video-still-bar", "60", "--json"])).toMatchObject({
      reference: "orig.mp4",
      videoBar: 90,
      videoStillBar: 60,
      format: "json",
    });
  });

  it("leaves the bars and the reference unset by default", () => {
    const args = parseImageArgs(["a.gif"]);
    expect(args.reference).toBeUndefined();
    expect(args.videoBar).toBeUndefined();
    expect(args.videoStillBar).toBeUndefined();
  });

  it("refuses a bar outside 0 to 100, a URL reference, and a missing reference", () => {
    expect(() => parseImageArgs(["a.mp4", "--reference", "b.mp4", "--video-bar", "101"])).toThrow(/--video-bar needs a number from 0 to 100/);
    expect(() => parseImageArgs(["a.mp4", "--reference", "b.mp4", "--video-still-bar", "-1"])).toThrow(/--video-still-bar needs a number from 0 to 100/);
    expect(() => parseImageArgs(["a.mp4", "--reference", "https://example.com/b.mp4"])).toThrow(/local files only/);
    expect(() => parseImageArgs(["a.mp4", "--reference"])).toThrow(/--reference needs a value/);
  });
});

describe("imageCommand on media (real encodes)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "imgtune-media-file-"));
    await copyFile(join(MEDIA, "clip.mp4"), join(dir, "clip.mp4"));
    await copyFile(join(MEDIA, "anim.gif"), join(dir, "anim.gif"));
    await copyFile(join(MEDIA, "anim.webp"), join(dir, "anim.webp"));
    await copyFile(join(MEDIA, "still.gif"), join(dir, "still.gif"));
    // The candidates: the same clip re-encoded at CRF 51 (far too small) and CRF 23 (a normal build; CRF 28 scores VMAF
    // 91.5 on this clip, below the 93 bar), at the clip's width.
    for (const crf of [51, 23]) {
      const result = await runFfmpeg(
        ["-loglevel", "error", "-i", join(dir, "clip.mp4"), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-y", join(dir, `clip-crf${crf}.mp4`)],
        { timeoutMs: 120_000 },
      );
      expect(result.code).toBe(0);
    }
  }, 180_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("a static GIF is measured like a PNG: a file result with a bar and sizes, not an error", async () => {
    const { output, exitCode } = await imageCommand(["still.gif", "--formats", "webp", "--format", "json", "--no-cache"], dir);
    expect(exitCode).toBe(0);
    const [file] = (JSON.parse(output) as { files: FileResult[] }).files;
    expect(file.error).toBeUndefined();
    expect(file.current.format).toBe("gif");
    expect(file.sizes).toHaveLength(1);
  }, 120_000);

  it("an animated GIF without --reference prints the candidates of the animated codecs", async () => {
    const { output, exitCode } = await imageCommand(["anim.gif", "--no-cache"], dir);
    expect(exitCode).toBe(0);
    expect(output).toMatch(/animated-avif/);
    expect(output).toMatch(/animated-webp/);
    expect(output).toMatch(/av1-mp4/);
  }, 300_000);

  it("an animated WebP without --reference is decoded and searched like a GIF", async () => {
    const { output, exitCode } = await imageCommand(["anim.webp", "--no-cache"], dir);
    expect(exitCode).toBe(0);
    expect(output).toMatch(/animated-avif/);
  }, 300_000);

  it("--reference of a re-encode at CRF 51 fails the bars: exit 1, and the verdict line says fail", async () => {
    const { output, exitCode } = await imageCommand(["clip-crf51.mp4", "--reference", "clip.mp4", "--no-cache"], dir);
    expect(exitCode).toBe(1);
    expect(output).toMatch(/^VMAF \d+\.\d \(bar 93\) still p10 -?\d+\.\d \(bar \d+(\.\d)?\): fail$/m);
  }, 300_000);

  it("--reference of a re-encode at CRF 23 passes the bars: exit 0, and the verdict line says pass", async () => {
    const { output, exitCode } = await imageCommand(["clip-crf23.mp4", "--reference", "clip.mp4", "--no-cache"], dir);
    expect(exitCode).toBe(0);
    expect(output).toMatch(/^VMAF \d+\.\d \(bar 93\) still p10 -?\d+\.\d \(bar \d+(\.\d)?\): pass$/m);
  }, 300_000);

  it("--json of a --reference check has the same fields as the text line", async () => {
    const { output, exitCode } = await imageCommand(["clip-crf23.mp4", "--reference", "clip.mp4", "--json", "--no-cache"], dir);
    expect(exitCode).toBe(0);
    const body = JSON.parse(output) as { evidence: string; vmaf: number; vmafBar: number; still: number; stillBar: number; pass: boolean };
    expect(body.evidence).toBe("media-reference");
    expect(body.vmafBar).toBe(93);
    expect(body.vmaf).toBeGreaterThanOrEqual(93);
    expect(body.still).toBeGreaterThanOrEqual(body.stillBar);
    expect(body.pass).toBe(true);
  }, 300_000);

  it("refuses --reference with a URL candidate before fetching it: exit 1 and the local-files message", async () => {
    const { output, exitCode } = await imageCommand(["https://example.invalid/clip.mp4", "--reference", "clip.mp4", "--no-cache"], dir);
    expect(exitCode).toBe(1);
    expect(output).toMatch(/local files only/);
  });

  it("refuses --reference with more than one candidate", async () => {
    const { output, exitCode } = await imageCommand(["clip-crf23.mp4", "clip-crf51.mp4", "--reference", "clip.mp4", "--no-cache"], dir);
    expect(exitCode).toBe(1);
    expect(output).toMatch(/--reference compares one file/);
  });
});
