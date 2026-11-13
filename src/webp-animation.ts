// An animated WebP read one frame at a time. ffmpeg cannot read an animated WebP, and sharp can extract one page only by
// decoding every page before it (its cost grows with the page index), so the frames are read here instead: each ANMF frame is
// split out as a still WebP, decoded alone by sharp, and composited onto a canvas as the WebP spec describes (the frame's
// rectangle, its blend mode, and the previous frame's dispose). Memory is about one canvas and one frame, whatever the length.
//
// Random access is cheap where the file allows it: a frame that covers the whole canvas and either does not blend or is opaque
// does not depend on the canvas before it (a keyframe), so composition restarts there. Between keyframes the frames are
// composed in order, so a sequential read (which is how every caller reads) costs one decode per frame.

import sharp from "sharp";
import { MAX_INPUT_PIXELS_FFMPEG, PixelsTooLarge } from "./media-limits.js";
import type { RawImage } from "./ssim.js";

/** The shortest frame a browser shows: a frame of 0 ms is shown for 10 ms. */
const MIN_FRAME_MS = 10;

/** One frame of the animation, as the container gives it. */
interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
  durationMs: number;
  /** The frame's blend mode is "do not blend" (overwrite its rectangle). */
  noBlend: boolean;
  /** The frame's dispose is "to background" (its rectangle is cleared before the next frame). */
  dispose: boolean;
  /** The frame covers the canvas and does not depend on what was on it before (see the file's header). */
  keyframe: boolean;
  /** A standalone WebP of the frame's pixels (VP8X, ALPH and VP8, or a VP8L chunk). */
  still: Buffer;
}

/** The ticks of a constant-rate timeline: at least one, the frame on screen at each tick (see cfrIndices). */
export function ticksOf(delaysMs: number[], fps: number): number {
  const total = delaysMs.reduce((acc, d) => acc + d, 0);
  return Math.max(1, Math.round((total * fps) / 1000));
}

/**
 * The indices of the frames on screen at each constant-rate tick. Frame i covers [start, start + delay) in ms, and tick k is
 * at k × 1000 / fps. A frame that lasts several ticks repeats; the last frame holds to the end.
 */
export function cfrIndices(delaysMs: number[], fps: number, ticks: number): number[] {
  const out: number[] = [];
  let frame = 0;
  let start = 0;
  for (let k = 0; k < ticks; k++) {
    const at = (k * 1000) / fps;
    while (frame < delaysMs.length - 1 && start + delaysMs[frame] <= at) {
      start += delaysMs[frame];
      frame++;
    }
    out.push(frame);
  }
  return out;
}

/** A RIFF chunk: its four-character type and its payload (the padding byte is not in the payload). */
function chunksOf(bytes: Buffer, start: number, end: number): { type: string; data: Buffer }[] {
  const out: { type: string; data: Buffer }[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const type = bytes.toString("latin1", pos, pos + 4);
    const size = bytes.readUInt32LE(pos + 4);
    const dataEnd = Math.min(pos + 8 + size, end);
    out.push({ type, data: bytes.subarray(pos + 8, dataEnd) });
    pos = pos + 8 + size + (size & 1);
  }
  return out;
}

/** A RIFF file of the given chunks, as a WebP. */
function riffWebp(chunks: { type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const head = Buffer.alloc(8);
    head.write(chunk.type, 0, "latin1");
    head.writeUInt32LE(chunk.data.length, 4);
    parts.push(head, chunk.data);
    if (chunk.data.length & 1) parts.push(Buffer.alloc(1));
  }
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...parts]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** The VP8X chunk of a still with alpha, on a canvas of the frame's size. */
function vp8xChunk(width: number, height: number, alpha: boolean): { type: string; data: Buffer } {
  const data = Buffer.alloc(10);
  data[0] = alpha ? 0x10 : 0;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return { type: "VP8X", data };
}

/** The frames of an animated WebP as the container gives them (see parseWebpAnimation). */
export interface WebpFrames {
  canvasWidth: number;
  canvasHeight: number;
  frames: Frame[];
}

/**
 * The size of a still WebP from its bitstream header (VP8 or VP8L), or undefined when it has neither.
 */
function stillSizeOf(top: { type: string; data: Buffer }[]): { width: number; height: number } | undefined {
  const vp8 = top.find((c) => c.type === "VP8 ");
  if (vp8 !== undefined && vp8.data.length >= 10 && vp8.data[3] === 0x9d && vp8.data[4] === 0x01 && vp8.data[5] === 0x2a) {
    return { width: vp8.data.readUInt16LE(6) & 0x3fff, height: vp8.data.readUInt16LE(8) & 0x3fff };
  }
  const vp8l = top.find((c) => c.type === "VP8L");
  if (vp8l !== undefined && vp8l.data.length >= 5 && vp8l.data[0] === 0x2f) {
    const bits = vp8l.data.readUInt32LE(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/**
 * Splits an animated WebP into its frames. A still WebP (one image, which an encoder writes when its frames are all alike) is
 * one frame held for `stillMs` (at least MIN_FRAME_MS): that is how a candidate of a sample is read. Throws when the file is not
 * a WebP, or has no image. The pixels are not decoded here; each frame's standalone still is kept for decoding when it is needed.
 */
export function parseWebpAnimation(bytes: Buffer, stillMs = 0): WebpFrames {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") {
    throw new Error("not a WebP file");
  }
  const top = chunksOf(bytes, 12, bytes.length);
  const canvas = top.find((c) => c.type === "VP8X");
  if (canvas === undefined || canvas.data.length < 10 || (canvas.data[0] & 0x02) === 0) {
    const size = stillSizeOf(top);
    const image = top.find((c) => c.type === "VP8 " || c.type === "VP8L");
    if (size === undefined || image === undefined) throw new Error("not an animated WebP");
    const still = riffWebp([image]);
    const frame: Frame = {
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      durationMs: Math.max(MIN_FRAME_MS, stillMs),
      noBlend: true,
      dispose: false,
      keyframe: true,
      still,
    };
    return { canvasWidth: size.width, canvasHeight: size.height, frames: [frame] };
  }
  const canvasWidth = 1 + canvas.data.readUIntLE(4, 3);
  const canvasHeight = 1 + canvas.data.readUIntLE(7, 3);
  const raw = top.filter((c) => c.type === "ANMF");
  if (raw.length === 0) throw new Error("the animated WebP has no frame");

  const frames: Frame[] = raw.map((anmf, index) => {
    const d = anmf.data;
    if (d.length < 16) throw new Error(`frame ${index} is truncated`);
    const x = 2 * d.readUIntLE(0, 3);
    const y = 2 * d.readUIntLE(3, 3);
    const width = 1 + d.readUIntLE(6, 3);
    const height = 1 + d.readUIntLE(9, 3);
    const durationMs = Math.max(MIN_FRAME_MS, d.readUIntLE(12, 3));
    const flags = d[15];
    const parts = chunksOf(d, 16, d.length);
    const alph = parts.find((c) => c.type === "ALPH");
    const vp8 = parts.find((c) => c.type === "VP8 ");
    const vp8l = parts.find((c) => c.type === "VP8L");
    let still: Buffer;
    let opaque: boolean;
    if (vp8l !== undefined) {
      still = riffWebp([vp8l]);
      opaque = false;
    } else if (vp8 !== undefined) {
      const chunks = alph !== undefined ? [vp8xChunk(width, height, true), alph, vp8] : [vp8xChunk(width, height, false), vp8];
      still = riffWebp(chunks);
      opaque = alph === undefined;
    } else {
      throw new Error(`frame ${index} has no image data`);
    }
    const noBlend = (flags & 0x02) !== 0;
    const covers = x === 0 && y === 0 && width === canvasWidth && height === canvasHeight;
    return { x, y, width, height, durationMs, noBlend, dispose: (flags & 0x01) !== 0, keyframe: covers && (noBlend || opaque), still };
  });
  return { canvasWidth, canvasHeight, frames };
}

/**
 * An animated WebP, read frame by frame at the constant-rate timeline of `fps`. The frames are composed in order and decoded
 * on demand: `page(i)` returns the canvas as it stands at frame i (a copy, so the caller may keep it). The per-frame pixel limit
 * is checked from the header, before any frame is decoded.
 */
export class WebpAnimation {
  readonly width: number;
  readonly height: number;
  /** The frames of the animation. */
  readonly pages: number;
  /** The duration of each frame, in ms (at least MIN_FRAME_MS). */
  readonly delaysMs: number[];
  /** The frame on screen at each constant-rate tick (see cfrIndices). */
  readonly tickPages: number[];
  /** The whole animation's length, in ms. */
  readonly durationMs: number;
  /** The constant rate the ticks are taken at. */
  readonly fps: number;
  private readonly frames: Frame[];
  private readonly prevKeyframe: number[];
  private readonly framePixelLimit: number;
  private canvas: Uint8ClampedArray;
  /** The frame the canvas holds, or -1 before the first frame. */
  private index = -1;

  constructor(bytes: Buffer, fps: number, framePixelLimit = MAX_INPUT_PIXELS_FFMPEG, stillMs = 0) {
    this.fps = fps;
    const parsed = parseWebpAnimation(bytes, stillMs);
    if (parsed.canvasWidth * parsed.canvasHeight > framePixelLimit) {
      throw new PixelsTooLarge(parsed.canvasWidth, parsed.canvasHeight, framePixelLimit);
    }
    this.width = parsed.canvasWidth;
    this.height = parsed.canvasHeight;
    this.frames = parsed.frames;
    this.pages = parsed.frames.length;
    this.delaysMs = parsed.frames.map((f) => f.durationMs);
    this.durationMs = this.delaysMs.reduce((acc, d) => acc + d, 0);
    this.tickPages = cfrIndices(this.delaysMs, fps, ticksOf(this.delaysMs, fps));
    this.prevKeyframe = [];
    let last = -1;
    parsed.frames.forEach((f, i) => {
      if (f.keyframe) last = i;
      this.prevKeyframe.push(last);
    });
    this.canvas = new Uint8ClampedArray(this.width * this.height * 4);
    this.framePixelLimit = framePixelLimit;
  }

  /** The canvas at frame `index`, as a copy. Frames are read in order; going back restarts at the last keyframe before. */
  async page(index: number): Promise<RawImage> {
    if (index < 0 || index >= this.pages) throw new Error(`frame ${index} is out of range`);
    if (index < this.index || this.prevKeyframe[index] > this.index) {
      const key = this.prevKeyframe[index];
      this.canvas.fill(0);
      this.index = -1;
      if (key >= 0) {
        await this.compose(key);
        this.index = key;
      }
    }
    while (this.index < index) {
      const next = this.index + 1;
      if (next > 0 && this.frames[next - 1].dispose) this.clear(this.frames[next - 1]);
      await this.compose(next);
      this.index = next;
    }
    return { data: new Uint8ClampedArray(this.canvas), width: this.width, height: this.height };
  }

  /** The canvas of the ticks [from, to), one frame copy per tick, for a raw video stream (see the sample cut). */
  async *ticks(from: number, to: number): AsyncGenerator<Uint8Array> {
    for (let k = from; k < to; k++) {
      const frame = await this.page(this.tickPages[Math.min(k, this.tickPages.length - 1)]);
      yield Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    }
  }

  /** Decodes frame `index` alone and draws it onto the canvas. */
  private async compose(index: number): Promise<void> {
    const frame = this.frames[index];
    const { data, info } = await sharp(frame.still, { limitInputPixels: this.framePixelLimit })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== frame.width || info.height !== frame.height) throw new Error(`frame ${index} decoded at the wrong size`);
    const src = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    const cw = this.width;
    const dst = this.canvas;
    for (let row = 0; row < frame.height; row++) {
      for (let col = 0; col < frame.width; col++) {
        const s = (row * frame.width + col) * 4;
        const d = ((frame.y + row) * cw + frame.x + col) * 4;
        const sa = src[s + 3];
        if (frame.noBlend || sa === 255) {
          dst[d] = src[s];
          dst[d + 1] = src[s + 1];
          dst[d + 2] = src[s + 2];
          dst[d + 3] = sa;
        } else if (sa !== 0) {
          // Source-over blending of non-premultiplied colour (the WebP "alpha-blend" mode).
          const a = sa / 255;
          const da = dst[d + 3] / 255;
          const outA = a + da * (1 - a);
          if (outA > 0) {
            for (let c = 0; c < 3; c++) dst[d + c] = (src[s + c] * a + dst[d + c] * da * (1 - a)) / outA;
          }
          dst[d + 3] = outA * 255;
        }
      }
    }
  }

  /** Clears a frame's rectangle to transparent (its dispose). */
  private clear(frame: Frame): void {
    for (let row = 0; row < frame.height; row++) {
      const start = ((frame.y + row) * this.width + frame.x) * 4;
      this.canvas.fill(0, start, start + frame.width * 4);
    }
  }
}
