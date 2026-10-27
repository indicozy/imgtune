import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readImageConfig } from "../src/nextconfig.js";

const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);

describe("readImageConfig", () => {
  it("reads the shop config: custom loader, qualities, 18 device sizes", () => {
    const dir = fixture("next-config-shop");
    const config = readImageConfig(dir);
    const text = readFileSync(resolve(dir, "next.config.ts"), "utf8");

    expect(config.file).toBe(resolve(dir, "next.config.ts"));
    expect(config.loaderFile).toBe("./src/lib/imageLoader.ts");
    expect(config.qualities).toEqual([75, 85, 100]);
    expect(config.deviceSizes).toHaveLength(18);
    expect(config.deviceSizes[0]).toBe(320);
    expect(config.imageSizes).toEqual([16, 32, 48, 64, 96, 128, 144, 192, 256, 384]);
    expect(config.formats).toEqual(["image/webp"]);
    expect(config.warnings).toEqual([]);
    expect(config.qualitiesRange).toBeDefined();
    expect(text.slice(config.qualitiesRange!.start, config.qualitiesRange!.end)).toBe("[75, 85, 100]");
  });

  it("falls back to Next defaults when there is no images property", () => {
    const config = readImageConfig(fixture("next-config-none"));
    expect(config.file).toBe(resolve(fixture("next-config-none"), "next.config.mjs"));
    expect(config.loaderFile).toBeUndefined();
    expect(config.qualities).toBeUndefined();
    expect(config.qualitiesRange).toBeUndefined();
    expect(config.deviceSizes).toEqual([640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
    expect(config.imageSizes).toEqual([32, 48, 64, 96, 128, 256, 384]);
    expect(config.formats).toEqual(["image/webp"]);
    expect(config.warnings).toEqual([]);
  });

  it("finds images inside a wrapper call, reads literal arrays and treats a variable as absent with a warning", () => {
    const config = readImageConfig(fixture("next-config-dynamic"));
    expect(config.deviceSizes).toEqual([640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
    expect(config.warnings).toEqual(["images.deviceSizes is not a literal list; treated as absent"]);
    expect(config.imageSizes).toEqual([16, 48]);
    expect(config.formats).toEqual(["image/avif", "image/webp"]);
    expect(config.qualities).toEqual([60, 90]);
  });
});
