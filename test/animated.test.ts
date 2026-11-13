import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { animationOf } from "../src/animated.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "media");
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

describe("animationOf", () => {
  it("reads an animated GIF: frames, duration and loop count", () => {
    expect(animationOf(fixture("anim.gif"))).toEqual({ format: "gif", frames: 30, durationMs: 3000, loop: 0 });
  });

  it("reads a two-second screen-recording GIF", () => {
    expect(animationOf(fixture("text.gif"))).toEqual({ format: "gif", frames: 20, durationMs: 2000, loop: 0 });
  });

  it("returns undefined for a single-frame GIF", () => {
    expect(animationOf(fixture("still.gif"))).toBeUndefined();
  });

  it("reads an animated WebP as webp with more than one frame", () => {
    const info = animationOf(fixture("anim.webp"));
    expect(info?.format).toBe("webp");
    expect(info?.frames).toBeGreaterThan(1);
    expect(info?.durationMs).toBeGreaterThan(0);
  });

  it("reads an APNG as apng", () => {
    const info = animationOf(fixture("anim.png"));
    expect(info?.format).toBe("apng");
    expect(info?.frames).toBeGreaterThan(1);
    expect(info?.loop).toBe(0);
  });

  it("returns undefined for a single-frame PNG", () => {
    expect(animationOf(fixture("still.png"))).toBeUndefined();
  });

  it("returns undefined for a GIF header with no frames", () => {
    expect(animationOf(Buffer.from("GIF89a"))).toBeUndefined();
  });

  it("returns undefined for random bytes", () => {
    const junk = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) % 256));
    expect(animationOf(junk)).toBeUndefined();
  });

  it("does not throw on a GIF cut in half", () => {
    const full = fixture("anim.gif");
    const cut = full.subarray(0, Math.floor(full.length / 2));
    expect(() => animationOf(cut)).not.toThrow();
    const info = animationOf(cut);
    expect(info === undefined || info.frames > 0).toBe(true);
  });

  it("does not throw on an empty buffer", () => {
    expect(animationOf(Buffer.alloc(0))).toBeUndefined();
  });
});
