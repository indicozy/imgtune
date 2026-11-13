import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { animationOf } from "../src/animated.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "media");
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

/**
 * Byte offsets of the image descriptors of a GIF, walked block by block: a reference walker for the tests, written apart from
 * the parser so the parser's frame count is checked against it.
 */
function gifFrameOffsets(gif: Buffer): number[] {
  const colourBytes = (flags: number): number => (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0);
  const skipSubBlocks = (p: number): number => {
    let at = p;
    while (gif[at] !== 0) at += gif[at] + 1;
    return at + 1;
  };
  const offsets: number[] = [];
  let pos = 13 + colourBytes(gif[10]);
  while (pos < gif.length && gif[pos] !== 0x3b) {
    if (gif[pos] === 0x21) {
      pos = skipSubBlocks(pos + 2);
    } else if (gif[pos] === 0x2c) {
      offsets.push(pos);
      pos = skipSubBlocks(pos + 10 + colourBytes(gif[pos + 9]) + 1);
    } else {
      throw new Error(`not a GIF block at ${pos}`);
    }
  }
  return offsets;
}

describe("animationOf", () => {
  it("reads an animated GIF: frames, duration and loop count", () => {
    expect(animationOf(fixture("anim.gif"))).toEqual({ format: "gif", frames: 30, durationMs: 3000, loop: 0 });
  });

  it("reads a two-second screen-recording GIF", () => {
    expect(animationOf(fixture("text.gif"))).toEqual({ format: "gif", frames: 20, durationMs: 2000, loop: 0 });
  });

  it("shows a frame delay of 0 or 1 cs as 100 ms, as browsers do, so the length is not understated", () => {
    // A minimal 1x1 GIF with one frame per delay: a graphic control block with the delay, then an image of one byte.
    const gif = (delays: number[]): Buffer => {
      const parts = [Buffer.from("GIF89a"), Buffer.from([1, 0, 1, 0, 0, 0, 0])];
      for (const d of delays) {
        parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, d & 0xff, d >> 8, 0x00, 0x00]));
        parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x01, 0x44, 0x00]));
      }
      parts.push(Buffer.from([0x3b]));
      return Buffer.concat(parts);
    };
    expect(animationOf(gif([0, 1, 5]))?.durationMs).toBe(100 + 100 + 50);
    expect(animationOf(gif([0, 0]))?.durationMs).toBe(200);
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
  });

  it("counts exactly the frames whose image descriptor is whole in a GIF cut in half", () => {
    const full = fixture("anim.gif");
    const starts = gifFrameOffsets(full);
    expect(starts).toHaveLength(30);
    const cut = full.subarray(0, Math.floor(full.length / 2));
    // A frame counts when its descriptor (10 bytes) is within the cut: its data may be cut short, its descriptor may not.
    const whole = starts.filter((start) => start + 10 <= cut.length).length;
    expect(whole).toBeGreaterThan(1);
    expect(whole).toBeLessThan(30);
    expect(animationOf(cut)?.frames).toBe(whole);
  });

  it("does not throw on an empty buffer", () => {
    expect(animationOf(Buffer.alloc(0))).toBeUndefined();
  });
});
