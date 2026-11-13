// Animation detection by byte parsing: GIF, animated WebP and APNG. It needs no decoder and no sharp, so a scan can
// tell an animated file from a still one from the bytes it already downloaded. Only the container structure is read
// (block headers, chunk lengths and the timing fields); pixels are never decoded.

/** What an animated file is: its format, how many frames it has, how long one loop runs and how it repeats. */
export interface AnimationInfo {
  format: "gif" | "webp" | "apng";
  /** Frames in the file (image descriptors for GIF, ANMF chunks for WebP, num_frames for APNG). */
  frames: number;
  /** Duration of one pass through all frames, in milliseconds, from the per-frame delays. */
  durationMs: number;
  /**
   * The loop count stored in the file: 0 means loop forever, n means n plays. A GIF with no NETSCAPE2.0 block
   * plays once, so it reports 1.
   */
  loop: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Returns the animation in a file, or undefined when the file is not animated (one frame, another format, or a
 * format this does not read). A truncated or corrupt file never throws: it reports what was readable before the
 * damage, or undefined. Used by the scan to decide whether an image is a GIF or animated WebP/APNG that a video
 * encode could replace.
 */
export function animationOf(buffer: Buffer): AnimationInfo | undefined {
  try {
    const info = detect(buffer);
    return info && info.frames > 1 ? info : undefined;
  } catch {
    // Every read below is bounds-checked, so this is a last guard for a malformed buffer, not a normal path.
    return undefined;
  }
}

function detect(b: Buffer): AnimationInfo | undefined {
  const head6 = b.toString("latin1", 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return parseGif(b);
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    return parseWebp(b);
  }
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return parseApng(b);
  return undefined;
}

/** Colour-table size in bytes for a packed-flags byte whose table flag is set (3 bytes per entry, 2^(n+1) entries). */
function colourTableBytes(packed: number): number {
  return 3 * 2 ** ((packed & 0x07) + 1);
}

/**
 * Skips a run of GIF data sub-blocks (a size byte, then that many bytes, ending with a zero-size block) starting at
 * p, and returns the offset just after the terminator. A run that runs past the end returns an offset past the end,
 * which the caller's loop treats as the end of the file.
 */
function skipSubBlocks(b: Buffer, p: number): number {
  while (p < b.length) {
    const size = b[p];
    if (size === 0) return p + 1;
    p += size + 1;
  }
  return p;
}

/**
 * Walks GIF blocks. Frames are counted as image descriptors (0x2C); each frame's delay comes from the Graphic
 * Control Extension (0x21 0xF9) just before it, in hundredths of a second. The loop count comes from the NETSCAPE2.0
 * application extension.
 */
function parseGif(b: Buffer): AnimationInfo | undefined {
  if (b.length < 13) return undefined;
  let pos = 13;
  if (b[10] & 0x80) pos += colourTableBytes(b[10]);

  let frames = 0;
  let durationMs = 0;
  let pendingDelayCs = 0;
  let loop: number | undefined;

  while (pos < b.length) {
    const introducer = b[pos];
    if (introducer === 0x3b) break; // trailer: end of the GIF
    if (introducer === 0x21) {
      // Extension: label, then sub-blocks. Application extensions start with an 11-byte identifier sub-block.
      if (pos + 2 > b.length) break;
      const label = b[pos + 1];
      if (label === 0xf9 && pos + 6 <= b.length) {
        pendingDelayCs = b.readUInt16LE(pos + 4);
      } else if (label === 0xff && pos + 3 + 11 <= b.length) {
        const identifier = b.toString("latin1", pos + 3, pos + 14);
        if (identifier === "NETSCAPE2.0" || identifier === "ANIMEXTS1.0") {
          const loopBlock = pos + 14;
          if (loopBlock + 5 <= b.length && b[loopBlock] === 3 && b[loopBlock + 1] === 1) {
            loop = b.readUInt16LE(loopBlock + 2);
          }
        }
      }
      pos = skipSubBlocks(b, pos + 2);
    } else if (introducer === 0x2c) {
      // Image descriptor: separator, 4 x u16 position and size, packed flags, then LZW code size and sub-blocks.
      if (pos + 10 > b.length) break;
      const packed = b[pos + 9];
      let p = pos + 10;
      if (packed & 0x80) p += colourTableBytes(packed);
      p += 1; // LZW minimum code size
      frames += 1;
      durationMs += pendingDelayCs * 10;
      pendingDelayCs = 0;
      pos = skipSubBlocks(b, p);
    } else {
      break; // not a block introducer: the file is corrupt from here on
    }
  }

  return { format: "gif", frames, durationMs, loop: loop ?? 1 };
}

/**
 * Walks RIFF chunks of a WebP. Animation needs the VP8X animation flag (bit 1 of its first byte). ANIM holds the loop
 * count (u16 at data offset 4). Each ANMF chunk is one frame, and its 24-bit duration is at data offset 12.
 */
function parseWebp(b: Buffer): AnimationInfo | undefined {
  let pos = 12;
  let animated = false;
  let loop = 0;
  let frames = 0;
  let durationMs = 0;

  while (pos + 8 <= b.length) {
    const type = b.toString("latin1", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const data = pos + 8;
    if (type === "VP8X" && data + 1 <= b.length) {
      animated = (b[data] & 0x02) !== 0;
    } else if (type === "ANIM" && data + 6 <= b.length) {
      loop = b.readUInt16LE(data + 4);
    } else if (type === "ANMF" && data + 15 <= b.length) {
      frames += 1;
      durationMs += b.readUIntLE(data + 12, 3);
    }
    pos = data + size + (size & 1); // chunks are padded to an even length
  }

  if (!animated) return undefined;
  return { format: "webp", frames, durationMs, loop };
}

/**
 * Walks PNG chunks of an APNG. The acTL chunk must come before the first IDAT; it holds num_frames and num_plays (0
 * means loop forever). Each fcTL chunk is one frame, and its delay is delay_num / delay_den seconds (a zero
 * delay_den means 100).
 */
function parseApng(b: Buffer): AnimationInfo | undefined {
  let pos = 8;
  let frames: number | undefined;
  let loop = 0;
  let durationMs = 0;
  let sawIdat = false;

  while (pos + 8 <= b.length) {
    const length = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    const data = pos + 8;
    if (data + length > b.length) break; // a chunk cut short by truncation

    if (type === "IDAT") {
      sawIdat = true;
    } else if (type === "acTL" && !sawIdat && length >= 8) {
      frames = b.readUInt32BE(data);
      loop = b.readUInt32BE(data + 4);
    } else if (type === "fcTL" && length >= 26) {
      const delayNum = b.readUInt16BE(data + 20);
      const delayDen = b.readUInt16BE(data + 22) || 100;
      durationMs += (delayNum * 1000) / delayDen;
    } else if (type === "IEND") {
      break;
    }
    pos = data + length + 4; // skip the CRC
  }

  if (frames === undefined) return undefined;
  return { format: "apng", frames, durationMs: Math.round(durationMs), loop };
}
