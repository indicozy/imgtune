// Fonts: per font file, the format, glyph coverage and variation axes, and three checks:
//   1. not WOFF2: the WOFF2 size, measured with wawoff2 (brotli);
//   2. subsetting: the characters the page's scripts need, measured with subset-font (harfbuzz) as WOFF2;
//   3. unused faces: a downloaded face that no rendered text uses (informational: several static weights of one
//      family that could be one variable font).
// Subsetting is by Unicode block (the scripts the page's text uses), not to the exact text, because text changes.
import { createHash } from "node:crypto";
import subsetFont from "subset-font";
import * as wawoff2 from "wawoff2";
import { digestOf, heavyValue } from "./cache.js";
import type { PageContext, ResourceAnalyzer, ResourceFinding, ResourceRecord } from "./types.js";
import { countRanges, detectFormat, intersectRanges, inRanges, parseSfnt, toSfnt, type FontFormat, type FontInfo } from "./sfnt.js";

/** Fonts above this size are not subsetted or re-encoded within the per-resource budget. */
const MEASURE_MAX_BYTES = 12 * 1024 * 1024;
/**
 * The subset is cut in WASM (harfbuzz) only up to this size: a big CJK face takes seconds to subset, and the scaled estimate
 * (the share of code points kept, of the WOFF2 size) agrees with a measured subset on the census fonts (within 10%).
 */
const SUBSET_MEASURE_MAX_BYTES = 1024 * 1024;
/**
 * WOFF2 is measured (brotli 11 in WASM, about 3 s for 0.6 MB, about 1 s for 0.25 MB) only up to this size. Above it the
 * size is estimated from the ratio of a typical WOFF2. On the census fonts a sfnt compresses to 0.37–0.56 of its size.
 */
const WOFF2_MEASURE_MAX_BYTES = 256 * 1024;
const WOFF2_RATIO_ESTIMATE = 0.45;
/** Savings below this are not worth an agent's edit: at least 1 KB and 10% of the file. */
const MIN_SAVING_BYTES = 1024;
const MIN_SAVING_SHARE = 0.1;
/** Text shorter than this says too little about the scripts in use. */
const MIN_TEXT_CHARS = 20;

interface UnicodeBlock {
  start: number;
  end: number;
  name: string;
}

/** Blocks the subset always keeps: basic Latin, Latin-1, general punctuation and currency. */
const ALWAYS_BLOCKS: UnicodeBlock[] = [
  { start: 0x0000, end: 0x007f, name: "Basic Latin" },
  { start: 0x0080, end: 0x00ff, name: "Latin-1 Supplement" },
  { start: 0x2000, end: 0x206f, name: "General Punctuation" },
  { start: 0x20a0, end: 0x20cf, name: "Currency Symbols" },
];

/** Blocks a page's text can switch on. Latin Extended Additional holds Vietnamese. */
const SCRIPT_BLOCKS: UnicodeBlock[] = [
  { start: 0x0100, end: 0x017f, name: "Latin Extended-A" },
  { start: 0x0180, end: 0x024f, name: "Latin Extended-B" },
  { start: 0x0250, end: 0x02af, name: "IPA Extensions" },
  { start: 0x02b0, end: 0x02ff, name: "Spacing Modifier Letters" },
  { start: 0x0300, end: 0x036f, name: "Combining Diacritical Marks" },
  { start: 0x0370, end: 0x03ff, name: "Greek and Coptic" },
  { start: 0x0400, end: 0x04ff, name: "Cyrillic" },
  { start: 0x0500, end: 0x052f, name: "Cyrillic Supplement" },
  { start: 0x0530, end: 0x058f, name: "Armenian" },
  { start: 0x0590, end: 0x05ff, name: "Hebrew" },
  { start: 0x0600, end: 0x06ff, name: "Arabic" },
  { start: 0x0900, end: 0x097f, name: "Devanagari" },
  { start: 0x0e00, end: 0x0e7f, name: "Thai" },
  { start: 0x10a0, end: 0x10ff, name: "Georgian" },
  { start: 0x1100, end: 0x11ff, name: "Hangul Jamo" },
  { start: 0x1e00, end: 0x1eff, name: "Latin Extended Additional" },
  { start: 0x1f00, end: 0x1fff, name: "Greek Extended" },
  { start: 0x2100, end: 0x214f, name: "Letterlike Symbols" },
  { start: 0x2190, end: 0x21ff, name: "Arrows" },
  { start: 0x2200, end: 0x22ff, name: "Mathematical Operators" },
  { start: 0x2500, end: 0x257f, name: "Box Drawing" },
  { start: 0x25a0, end: 0x25ff, name: "Geometric Shapes" },
  { start: 0x2600, end: 0x26ff, name: "Miscellaneous Symbols" },
  { start: 0x2700, end: 0x27bf, name: "Dingbats" },
  { start: 0x3000, end: 0x303f, name: "CJK Symbols and Punctuation" },
  { start: 0x3040, end: 0x309f, name: "Hiragana" },
  { start: 0x30a0, end: 0x30ff, name: "Katakana" },
  { start: 0xac00, end: 0xd7af, name: "Hangul Syllables" },
  { start: 0x4e00, end: 0x9fff, name: "CJK Unified Ideographs" },
  { start: 0xff00, end: 0xffef, name: "Halfwidth and Fullwidth Forms" },
];

interface MatchedFace {
  family: string;
  weight: string;
  style: string;
  status: string;
  unicodeRange?: string;
}

interface Inspected {
  record: ResourceRecord;
  format: FontFormat;
  /** Human label for titles: WOFF2, WOFF, TTF, OTF or EOT. */
  label: string;
  info: FontInfo;
  face?: MatchedFace;
  /** WOFF2 bytes of the whole font (the fetched bytes when it already is WOFF2). */
  woff2Bytes?: number;
  woff2Estimate?: boolean;
  subset?: { bytes: number; estimate: boolean; keptCodepoints: number; blocks: UnicodeBlock[] };
  /** Distinct characters of the page's text that the font maps to a glyph. */
  textCodepoints: number;
  /** Mostly private-use code points: an icon font, whose glyphs are not text. */
  iconic: boolean;
  /** The face's own unicode-range is narrower than all of Unicode: a slice, already split by the site. */
  sliced: boolean;
  /** Why the face is unused on this page, when it is. */
  unused?: string;
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
const hashOf = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 12);
const norm = (family: string): string => family.replace(/["']/g, "").trim().toLowerCase();
const isFullRange = (range: string | undefined): boolean => !range || /^U\+0{1,4}-10FFFF$/i.test(range.replace(/\s+/g, ""));

/** Font names and file names come from the page. Keep printable ASCII and cap the length. */
const printable = (text: string, limit: number): string => text.replace(/[^\x20-\x7e]/g, "?").slice(0, limit);
const fileSafe = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);

function isFontResponse(r: ResourceRecord): boolean {
  if (r.resourceType === "font") return true;
  const type = r.contentType;
  if (type.startsWith("font/") || /font-|x-font|woff|opentype|truetype|vnd\.ms-fontobject/.test(type)) return true;
  return /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(r.url);
}

function fileName(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return fileSafe(last) || "font";
  } catch {
    return "font";
  }
}

function formatLabel(format: FontFormat, body: Buffer): string {
  if (format === "woff2") return "WOFF2";
  if (format === "woff") return "WOFF";
  if (format === "eot") return "EOT";
  return body.toString("latin1", 0, 4) === "OTTO" ? "OTF" : "TTF";
}

/** Unicode block indices the text uses. */
function blocksUsed(codepoints: Set<number>): Set<UnicodeBlock> {
  const used = new Set<UnicodeBlock>();
  for (const cp of codepoints) {
    const block = SCRIPT_BLOCKS.find((b) => cp >= b.start && cp <= b.end);
    if (block) used.add(block);
  }
  return used;
}

const coversBasicAscii = (ranges: [number, number][]): boolean => countRanges(intersectRanges(ranges, [[0x21, 0x7e]])) === 94;

const toRanges = (blocks: UnicodeBlock[]): [number, number][] => blocks.map((b): [number, number] => [b.start, b.end]);

/** A `pyftsubset --unicodes` value: U+XXXX-YYYY ranges. */
const unicodesArg = (blocks: UnicodeBlock[]): string =>
  blocks.map((b) => `U+${b.start.toString(16).toUpperCase().padStart(4, "0")}-${b.end.toString(16).toUpperCase().padStart(4, "0")}`).join(",");

async function inspect(r: ResourceRecord, ctx: PageContext, codepoints: Set<number>): Promise<Inspected | null> {
  const body = r.body;
  if (!body) return null;
  const format = detectFormat(body);
  const sfnt = await toSfnt(body, format);
  if (!sfnt) return null;
  const info = parseSfnt(sfnt);
  if (!info || info.codepoints === 0) return null;

  let textCodepoints = 0;
  for (const cp of codepoints) if (inRanges(info.ranges, cp)) textCodepoints++;
  const privateUse = intersectRanges(info.ranges, [
    [0xe000, 0xf8ff],
    [0xf0000, 0x10ffff],
  ]);
  const iconic = countRanges(privateUse) > info.codepoints / 2;

  const face = ctx.fontFaces.find((f) => f.url !== undefined && f.url === r.url);
  const item: Inspected = {
    record: r,
    format,
    label: formatLabel(format, body),
    info,
    face: face
      ? { family: face.family, weight: face.weight, style: face.style, status: face.status, unicodeRange: face.unicodeRange }
      : undefined,
    textCodepoints,
    iconic,
    // A slice: the site's own unicode-range narrows it, or (no face URL to tell) it is a partial script without basic
    // Latin, such as one unicode-range file of a family.
    sliced: !isFullRange(face?.unicodeRange) || (info.codepoints < 1000 && !coversBasicAscii(info.ranges)),
  };

  // WOFF2 size of the whole font. Brotli 11 in WASM is slow (about 3 s for 0.6 MB), so it is measured only for small
  // fonts; a larger font gets the ratio of a typical WOFF2 (estimate). A WOFF2 input is its own size.
  const woff2Ratio = format === "woff2" ? r.bytes / sfnt.length : WOFF2_RATIO_ESTIMATE;
  if (format === "woff2") item.woff2Bytes = r.bytes;
  else if (sfnt.length <= WOFF2_MEASURE_MAX_BYTES) {
    try {
      // The WOFF2 encode is heavy: once per run by content; over the run's budget the size is estimated instead.
      const woff2 = await heavyValue(`font:woff2:${digestOf(sfnt)}`, async () => (await wawoff2.compress(sfnt)).length);
      if (woff2 !== undefined) item.woff2Bytes = woff2;
      else {
        item.woff2Bytes = Math.round(sfnt.length * woff2Ratio);
        item.woff2Estimate = true;
      }
    } catch {
      /* no WOFF2 figure: the check is skipped for this font */
    }
  } else if (sfnt.length <= MEASURE_MAX_BYTES) {
    item.woff2Bytes = Math.round(sfnt.length * woff2Ratio);
    item.woff2Estimate = true;
  }

  // An unused face is reported as wasted bytes; no subset is needed for it.
  item.unused = unusedReason(item, ctx);
  // Subsetting: keep the blocks the page's scripts use. Skipped for icon fonts, for slices the site already split by
  // unicode-range, for unused faces, and for pages with too little text to say which scripts they use.
  if (!item.unused && !iconic && !item.sliced && ctx.text.length >= MIN_TEXT_CHARS) {
    const blocks = [...new Set([...ALWAYS_BLOCKS, ...blocksUsed(codepoints)])].sort((a, b) => a.start - b.start);
    const keep = intersectRanges(info.ranges, toRanges(blocks));
    const kept = countRanges(keep);
    if (kept > 0 && kept < info.codepoints) {
      if (sfnt.length <= SUBSET_MEASURE_MAX_BYTES) {
        // The sfnt subset is fast; only its WOFF2 encode is slow, so that is measured for small subsets only.
        let text = "";
        for (const [a, b] of keep) for (let cp = a; cp <= b; cp++) text += String.fromCodePoint(cp);
        const subsetSfnt = Buffer.from(await subsetFont(sfnt, text, { targetFormat: "sfnt" }));
        if (subsetSfnt.length <= WOFF2_MEASURE_MAX_BYTES) {
          const subsetWoff2 = await wawoff2.compress(subsetSfnt);
          item.subset = { bytes: subsetWoff2.length, estimate: false, keptCodepoints: kept, blocks };
        } else {
          item.subset = { bytes: Math.round(subsetSfnt.length * woff2Ratio), estimate: true, keptCodepoints: kept, blocks };
        }
      } else if (item.woff2Bytes !== undefined) {
        // Too big to subset within budget: scale the WOFF2 size by the share of characters kept.
        item.subset = {
          bytes: Math.round((item.woff2Bytes * kept) / info.codepoints),
          estimate: true,
          keptCodepoints: kept,
          blocks,
        };
      }
    }
  }
  return item;
}

/** Why a downloaded face is unused, or undefined when it may be used. Needs the face's URL match and page text. */
function unusedReason(item: Inspected, ctx: PageContext): string | undefined {
  const face = item.face;
  if (!face || item.iconic || ctx.usedFonts.length === 0 || ctx.text.length < MIN_TEXT_CHARS) return undefined;
  // "loaded" means the browser rendered some text with this face (also as a fallback), so it is used.
  if (face.status === "loaded") return undefined;
  const family = norm(face.family);
  const sameFamily = ctx.usedFonts.filter((u) => norm(u.family) === family);
  if (sameFamily.length === 0) {
    return `face status ${printable(face.status, 20)}; no rendered text uses the family ${printable(face.family, 60)}`;
  }
  const [lo, hi] = weightRange(face.weight, item.info);
  const styleOk = (faceStyle: string, usedStyle: string): boolean =>
    faceStyle.startsWith("normal") ? usedStyle.startsWith("normal") : !usedStyle.startsWith("normal");
  if (!sameFamily.some((u) => u.weight >= lo && u.weight <= hi && styleOk(face.style, u.style))) {
    return `face status ${printable(face.status, 20)}; no rendered text uses this weight and style (${printable(face.weight, 20)} ${printable(face.style, 20)})`;
  }
  return undefined;
}

function weightRange(weight: string, info: FontInfo): [number, number] {
  const w = weight.trim();
  if (w === "normal") return [400, 400];
  if (w === "bold") return [700, 700];
  const parts = w.split(/\s+/).map(Number);
  if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) return [parts[0], parts[1]];
  if (parts.length === 1 && Number.isFinite(parts[0])) return [parts[0], parts[0]];
  const wght = info.axes.find((a) => a.tag === "wght");
  if (wght) return [wght.min, wght.max];
  const fallback = info.weightClass ?? 400;
  return [fallback, fallback];
}

function findingsOf(items: Inspected[], ctx: PageContext): ResourceFinding[] {
  const out: ResourceFinding[] = [];
  for (const item of items) {
    const { record: r, info, format, label } = item;
    const name = fileName(r.url);
    const displayFamily = printable(item.face?.family ?? info.families[0] ?? name, 60);
    const bytes = r.bytes;
    const id = `font:${hashOf(r.url)}`;
    const common = {
      kind: "font" as const,
      url: r.url,
      bytes,
      details: {
        format,
        numGlyphs: info.numGlyphs,
        codepoints: info.codepoints,
        textCodepoints: item.textCodepoints,
        families: info.families.map((f) => printable(f, 60)),
        weightClass: info.weightClass,
        italic: info.italic,
        variable: info.axes.length > 0,
        axes: info.axes.map((a) => ({ tag: a.tag, min: a.min, max: a.max })),
        woff2Bytes: item.woff2Bytes,
        woff2Estimate: item.woff2Estimate,
        subsetBytes: item.subset?.bytes,
        subsetCodepoints: item.subset?.keptCodepoints,
        iconic: item.iconic,
      },
    };

    const reason = item.unused;
    if (reason) {
      out.push({
        ...common,
        id,
        savedBytes: bytes,
        estimate: false,
        title: `font ${name}: ${label}, ${kb(bytes)}, not used (${reason})`,
        fix: [
          `Remove the @font-face and any <link rel="preload"> for ${displayFamily} (${name}), or stop requesting this weight and style.`,
          "Check before removing: the face may be used after an interaction or on another page, which one scan does not see.",
        ],
      });
      continue;
    }

    const candidates: { bytes: number; estimate: boolean; what: "woff2" | "subset" }[] = [];
    if (item.woff2Bytes !== undefined && format !== "woff2") {
      candidates.push({ bytes: item.woff2Bytes, estimate: item.woff2Estimate === true, what: "woff2" });
    }
    if (item.subset) candidates.push({ bytes: item.subset.bytes, estimate: item.subset.estimate, what: "subset" });
    if (candidates.length === 0) continue;
    const best = candidates.reduce((a, b) => (b.bytes < a.bytes ? b : a));
    const savedBytes = bytes - best.bytes;
    if (savedBytes >= MIN_SAVING_BYTES && savedBytes >= bytes * MIN_SAVING_SHARE) {
      const parts: string[] = [];
      if (item.woff2Bytes !== undefined && format !== "woff2") {
        parts.push(`WOFF2 ${kb(item.woff2Bytes)}${item.woff2Estimate ? " (estimate)" : ""}`);
      }
      if (item.subset) {
        parts.push(`subset to the page's scripts ${kb(item.subset.bytes)}${item.subset.estimate ? " (estimate)" : ""}`);
      }
      const fix: string[] = [];
      const stem = name.replace(/\.(woff2?|ttf|otf|eot)$/i, "");
      if (item.woff2Bytes !== undefined && format !== "woff2") {
        fix.push(
          `Serve WOFF2 instead of ${label}: \`woff2_compress ${name}\` (expected ${kb(item.woff2Bytes)} per view${item.woff2Estimate ? ", estimate" : ""}).`,
        );
      }
      if (item.subset) {
        const blocks = item.subset.blocks;
        fix.push(
          `Subset to the scripts the page uses (${blocks.map((b) => b.name).join(", ")}): ` +
            `\`pyftsubset ${name} --unicodes=${unicodesArg(blocks)} --flavor=woff2 --output-file=${stem}.subset.woff2\` ` +
            `(expected ${kb(item.subset.bytes)} per view${item.subset.estimate ? ", estimate" : ""}).`,
        );
        fix.push(
          "Framework: next/font subsets: ['latin'] (or the scripts above); Google Fonts css2 &subset=latin; @fontsource import the latin.css file. " +
            "Or split the family with unicode-range so each page fetches only the ranges it renders.",
        );
      }
      out.push({
        ...common,
        id,
        savedBytes,
        estimate: best.estimate,
        title: `font ${name}: ${label}, ${kb(bytes)}; ${parts.join("; ")}`,
        fix,
      });
    }
  }
  out.push(...familyFindings(items));
  return out;
}

function duplicateFinding(r: ResourceRecord, first: ResourceRecord): ResourceFinding {
  const name = fileName(r.url);
  return {
    id: `font:${hashOf(r.url)}-dup`,
    kind: "font",
    url: r.url,
    bytes: r.bytes,
    savedBytes: r.bytes,
    estimate: false,
    title: `font ${name}: same bytes as ${fileName(first.url)}, downloaded again (${kb(r.bytes)})`,
    fix: [
      `Load ${fileName(first.url)} from one URL only: keep one @font-face src for it and drop the other copy and any preload that fetches it.`,
    ],
    details: { duplicateOf: printable(first.url, 300) },
  };
}

/** Several static files of one family: informational, one variable font would replace them. */
function familyFindings(items: Inspected[]): ResourceFinding[] {
  const groups = new Map<string, Inspected[]>();
  for (const item of items) {
    // Variable files and slices of one weight (unicode-range splits) are not a family of static weights.
    if (item.info.axes.length > 0 || item.sliced) continue;
    const family = norm(item.face?.family ?? item.info.families[0] ?? "");
    if (!family) continue;
    groups.set(family, [...(groups.get(family) ?? []), item]);
  }
  const out: ResourceFinding[] = [];
  for (const [family, group] of groups) {
    // One face is a weight and a style: count distinct weight classes and italics, not files.
    const faces = new Map<string, number>();
    for (const g of group) {
      const weight = g.info.weightClass ?? (g.face ? Number(g.face.weight) : NaN);
      if (Number.isFinite(weight)) faces.set(`${weight}|${g.info.italic ? "i" : "n"}`, weight);
    }
    if (faces.size < 3) continue;
    const weights = [...faces.values()].sort((a, b) => a - b);
    const first = group[0].record;
    const bytes = group.reduce((sum, g) => sum + g.record.bytes, 0);
    out.push({
      id: `font:${hashOf(first.url)}-family`,
      kind: "font",
      url: first.url,
      bytes,
      savedBytes: 0,
      estimate: false,
      title: `font family ${printable(family, 60)}: ${faces.size} static faces in ${group.length} files (weights ${weights[0]}–${weights[weights.length - 1]}) could be one variable font`,
      fix: [
        `Serve one variable font with the wght axis (weights ${weights[0]}–${weights[weights.length - 1]}) instead of ${faces.size} static faces, then drop the static @font-face rules.`,
      ],
      details: { files: group.map((g) => g.record.url), faces: faces.size, weights },
    });
  }
  return out;
}

export const analyzer: ResourceAnalyzer = {
  kind: "font",
  wants(r: ResourceRecord): boolean {
    return isFontResponse(r);
  },
  async analyze(records: ResourceRecord[], ctx: PageContext): Promise<ResourceFinding[]> {
    try {
      const unique = new Map<string, ResourceRecord>();
      for (const r of records) if (r.body && isFontResponse(r) && !unique.has(r.url)) unique.set(r.url, r);
      if (unique.size === 0) return [];
      const codepoints = new Set<number>();
      for (const ch of ctx.text) codepoints.add(ch.codePointAt(0) ?? 0);
      const items: Inspected[] = [];
      const duplicates: ResourceFinding[] = [];
      // The same font bytes under two URLs (a copy on a CDN and a local one) are one font, downloaded twice: the first
      // URL is analysed and each later copy is a finding of its own.
      const firstByDigest = new Map<string, ResourceRecord>();
      for (const r of unique.values()) {
        try {
          const digest = createHash("sha1").update(r.body ?? "").digest("hex");
          const first = firstByDigest.get(digest);
          if (first) {
            duplicates.push(duplicateFinding(r, first));
            continue;
          }
          firstByDigest.set(digest, r);
          const item = await inspect(r, ctx, codepoints);
          if (item) items.push(item);
        } catch {
          /* one unreadable font does not stop the others */
        }
      }
      return [...findingsOf(items, ctx), ...duplicates];
    } catch {
      return [];
    }
  },
};
