// `imgtune hints <scan.json>`: a compact batch of the per-image fix records of one scanned page, for an AI agent to work
// through. Sorted by the bytes a fix saves; each hint is a few short lines so ten of them fit in a small context.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hasFix, OWNER_PLACEHOLDERS, type HiddenAction, type HiddenFix, type ImageRecord } from "./images.js";
import { safeText } from "./text.js";
import type { PageResult } from "./remote.js";
import type { HiddenPage } from "./images.js";
import { cleanLocate } from "./locate-join.js";
import type { OwnerSource } from "./locate.js";
import { DEFAULT_VIEWPORTS } from "./config.js";
import { fitSizes, maxPerWidth, type SizePoint } from "./group-sizes.js";
import { srcsetWidthLabel, srcsetWidthsOf } from "./candidates.js";
import { MAX_MAX_QUALITIES, MIN_MAX_QUALITIES, planQualityCap, qualitiesLine, type QualityCapPlan } from "./qualities-cap.js";
import type { CandidateResult, MediaCodec } from "./media-encode.js";
import { reasonText, type WidthPlan } from "./media-model.js";
import { NEVER_SHOWN } from "./media-phase.js";
import type { AnimatedFix, VideoRecord } from "./video-analysis.js";
import { resourceLinesOf } from "./resources/report.js";
import { VECTOR_BAR, VECTOR_LOOKS_MIN_BYTES, type VectorFix } from "./vector-art.js";
import { perViewBytesOf } from "./vector-phase.js";

export const DEFAULT_HINT_LIMIT = 10;

export interface HintsArgs {
  /** The scan files, one per page. Call sites are grouped across all of them (a shared component is one call site). */
  files: string[];
  /** The first file (kept for the single-file reader). */
  file: string;
  page?: string;
  component?: string;
  limit: number;
  /** True when --limit was passed. JSON output is unlimited without it; text output keeps DEFAULT_HINT_LIMIT. */
  limitGiven: boolean;
  offset: number;
  minKb?: number;
  format: "text" | "json";
  /** One hint per image instead of one entry per file:line (the default groups them). */
  flat: boolean;
  /** The framework's allowed quality values (Next: images.qualities). Targets are snapped up to one of them. */
  qualities?: number[];
  /** `--top N`: the N call sites that save the most per view, one line each (no batch, no offset). */
  top?: number;
  /** `--max-qualities N`: the most values the next/image `images.qualities` list may have (1 to 4; default 2). */
  maxQualities?: number;
}

/** The vector check of one image, as a hint: the record's fix.vector, and its served bytes per view. */
export interface VectorHint extends VectorFix {
  servedPerView: number;
}

/** One hint: an image record reduced to what an agent needs to make the fix. */
export interface Hint {
  id: string;
  page: string;
  /** Component names, nearest first, and the source file and line when they resolved. */
  component: string[];
  file?: string;
  line?: number;
  /** The source check (see LocatorKind): `owner` means the file:line is the call site of the component that renders the image. */
  kind?: string;
  /** False unless the source line was read from a local project and renders an image: printed as unverified. */
  verified?: boolean;
  testid?: string;
  alt?: string;
  classes?: string;
  /** Where to look for the element in the project when no file resolved (see SearchHints). */
  find?: { component: string; glob: string };
  /** A CSS background layer: there is no sizes attribute, so the fix is a file at the width, or image-set(). */
  background?: true;
  /**
   * A plain image with no srcset (see isPlainNoSrcset): serve variants at these device-pixel widths and add a srcset and a
   * sizes. `largest` is the largest device px any viewport needs; `sizes` is the measured value, when one passed the check.
   */
  srcset?: { widths: number[]; largest: number; sizes?: string };
  /** How the file:line was found (see ImageLocator.via). */
  via?: string;
  /** The project owner chain above the element, nearest first; its first entry is file:line (see ImageLocator.ownerChain). */
  ownerChain?: OwnerSource[];
  /** The rendered width range over the viewports the image was measured at, in CSS px. */
  rendered?: { min: number; max: number };
  /** Each measured viewport's width and the rendered width of the image there (the points a group's sizes is fitted to). */
  measured?: SizePoint[];
  selector: string;
  sizes: { current?: string; proposed?: string; basis?: string };
  width?: number;
  quality?: {
    current: number;
    target?: number;
    samples: number;
    group: string;
    /** The target before the images.qualities cap moved it up (see qualities-cap.ts). Set with `approx`. */
    cappedFrom?: number;
    /** The saving is scaled to the capped target, not estimated there. */
    approx?: true;
    /** The target before it was snapped up to an allowed quality (--qualities). */
    snapFrom?: number;
    /** The allowed qualities the target was snapped to. */
    allowed?: number[];
    /** The snap left the quality saving unknown: it was estimated at the unsnapped target, so it is not counted. */
    void?: boolean;
  };
  format?: { current?: string; best?: string };
  /** `saved` = sizes + resize + quality (see ImageFix.bytes). `resize` is set only for a plain image with no srcset. */
  bytes: { saved: number; addedForSharpness: number; sizes?: number; quality?: number; resize?: number };
  /** The element is the page's largest contentful paint at some viewport (`lcpViewports`): sorted first (see lcp.ts). */
  lcp?: true;
  lcpViewports?: string[];
  /** The `sizes="auto, <proposed>"` alternative: a lazy image whose only fix is its sizes (never an LCP or eager image). */
  sizesAuto?: string;
  /** The CDN's auto quality: "quality handled by <loader> (q_auto)", or the explicit quality the CDN leaves out. */
  qualityNote?: string;
  /** The CDN negotiates the format of a jpeg or png: no format change is proposed. */
  formatNote?: string;
  /**
   * The browser loaded the file but the element is not shown at some viewports (see HiddenFix). Its bytes are not in the
   * saving (bytes.saved counts the shown viewports' fixes only).
   */
  hidden?: HiddenFix;
  /** An animated image (GIF, animated WebP or APNG): its animation and encode candidates (see video-analysis.ts). */
  animated?: AnimatedFix;
  /** The image's served URL, named by the animated hint's fallback. Set with `animated`. */
  src?: string;
  /**
   * The vector check of a flat image (see vector-art.ts): a passing SVG is the lead, and a flat image that was not traced
   * gets one note. `servedPerView` is the image's served bytes per view, the figure the SVG is compared with.
   */
  vector?: VectorHint;
  rung: string;
  notes: string[];
}

const usage =
  "usage: imgtune hints <scan.json> [<scan.json> ...] [--page <text>] [--component <name>] [--limit N] [--offset N] [--min-kb N] [--format text|json] [--flat] [--qualities 75,85,100] [--max-qualities N]";

function nonNegativeInteger(name: string, text: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`${name} needs a whole number, not ${safeText(text)}`);
  return Number(text);
}

const OPTIONS: readonly string[] = ["--page", "--component", "--limit", "--offset", "--min-kb", "--format", "--qualities", "--top", "--max-qualities"];

/** A list of allowed quality values: whole numbers 1 to 100, separated by commas. Sorted, without repeats. */
export function parseQualities(text: string): number[] {
  const values = text.split(",").map((v) => v.trim());
  if (values.some((v) => !/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > 100)) {
    throw new Error(`--qualities needs a list of qualities from 1 to 100, like 75,85,100, not ${safeText(text)}`);
  }
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}

/**
 * The allowed quality a target is raised to: the smallest allowed value that is not below it. A target above every
 * allowed value gets the largest (the framework cannot go higher).
 */
export function snapUp(target: number, allowed: number[]): number {
  const sorted = [...allowed].sort((a, b) => a - b);
  return sorted.find((q) => q >= target) ?? sorted[sorted.length - 1];
}

/** The arguments after `hints`: one scan JSON file and the filters. Throws with the message the CLI prints. */
export function parseHintsArgs(argv: string[]): HintsArgs {
  const args: HintsArgs = { files: [], file: "", limit: DEFAULT_HINT_LIMIT, limitGiven: false, offset: 0, format: "text", flat: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args.files.push(arg);
      continue;
    }
    if (arg === "--flat") {
      args.flat = true;
      continue;
    }
    if (!OPTIONS.includes(arg)) throw new Error(`Unknown option ${safeText(arg)} (${usage})`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    i++;
    if (arg === "--page") args.page = value;
    else if (arg === "--component") args.component = value;
    else if (arg === "--limit") {
      args.limit = nonNegativeInteger(arg, value);
      args.limitGiven = true;
      if (args.limit === 0) throw new Error("--limit needs a number of at least 1");
    } else if (arg === "--offset") args.offset = nonNegativeInteger(arg, value);
    else if (arg === "--min-kb") {
      if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`--min-kb needs a number, not ${safeText(value)}`);
      args.minKb = Number(value);
    } else if (arg === "--qualities") {
      args.qualities = parseQualities(value);
    } else if (arg === "--top") {
      args.top = nonNegativeInteger(arg, value);
      if (args.top === 0) throw new Error("--top needs a number of at least 1");
    } else if (arg === "--max-qualities") {
      if (!/^\d+$/.test(value) || Number(value) < MIN_MAX_QUALITIES || Number(value) > MAX_MAX_QUALITIES) {
        throw new Error(`--max-qualities needs a whole number from ${MIN_MAX_QUALITIES} to ${MAX_MAX_QUALITIES}, not ${safeText(value)}`);
      }
      args.maxQualities = Number(value);
    } else if (arg === "--format") {
      if (value !== "text" && value !== "json") throw new Error(`--format is text or json, not ${safeText(value)}`);
      args.format = value;
    }
  }
  if (args.files.length === 0) throw new Error(usage);
  args.file = args.files[0];
  return args;
}

/**
 * The hints of one page: its image records that have a fix, as hints. `plan` is the site's images.qualities cap (see
 * planQualityCap); it applies only when no --qualities list was given (that list is the framework's own).
 */
export function hintsOf(result: PageResult, qualities?: number[], plan?: QualityCapPlan): Hint[] {
  // An animated image is a hint even without a sizes or byte saving: its saving is an encode (see animatedLines). So is a
  // loaded-but-not-shown image: its bytes are the fix's (see hiddenLines).
  return (result.images ?? []).filter((record) => hasFix(record) || record.fix.animated !== undefined || vectorHinted(record) || record.hidden !== undefined).map((record) => {
    const served = record.current.format;
    const rawTarget = served !== undefined ? record.fix.quality?.perFormat[served] : undefined;
    // With the framework's allowed qualities, the target goes up to one of them. The quality saving was estimated at the
    // raw target, so after a snap it is not counted, and the hint says so.
    const snapped = rawTarget !== undefined && qualities !== undefined ? snapUp(rawTarget, qualities) : undefined;
    const snapFrom = snapped !== undefined && snapped !== rawTarget ? rawTarget : undefined;
    // The cap moves the target up to a listed value; its quality saving is scaled to that value (approx).
    const capped = qualities === undefined ? plan?.byRecord.get(record.id) : undefined;
    const target = snapped ?? capped?.to ?? rawTarget;
    const hint: Hint = {
      id: record.id,
      page: record.page,
      // A placeholder name (the app's fallback component) says nothing: it is not printed as the component.
      component: record.locator.component.filter((c) => !OWNER_PLACEHOLDERS.has(c)),
      selector: record.locator.selector,
      sizes: { current: record.current.sizes, proposed: record.fix.sizes?.value, basis: record.fix.sizes?.basis },
      // A raise (the list has no lower value for this usage) adds bytes: its quality saving is then none, not negative.
      bytes:
        capped !== undefined
          ? { ...record.fix.bytes, saved: (record.fix.bytes.sizes ?? 0) + (record.fix.bytes.resize ?? 0) + Math.max(0, capped.saved), quality: Math.max(0, capped.saved) }
          : { ...record.fix.bytes },
      rung: record.evidence.rung,
      notes: record.evidence.notes,
    };
    const lcpViewports = record.lcpViewports ?? [];
    if (lcpViewports.length > 0) {
      hint.lcp = true;
      hint.lcpViewports = lcpViewports;
    }
    // A lazy image's sizes can be "auto" (Chrome, Edge, Firefox 150+; the proposed value elsewhere). Only for an image whose
    // only fix is its sizes: the quality saving and the format change are both none. Never for an eager or LCP image.
    const sizesOnly = (hint.bytes.quality ?? 0) <= 0 && (record.fix.format === undefined || record.fix.format === served);
    if (record.lazy === true && lcpViewports.length === 0 && hint.sizes.proposed !== undefined && record.fix.width === undefined && sizesOnly) {
      hint.sizesAuto = `auto, ${hint.sizes.proposed}`;
    }
    if (record.fix.formatHandled === true) hint.formatNote = `format handled by ${record.locator.loader} (f_auto)`;
    if (record.locator.file !== undefined) {
      hint.file = record.locator.file;
      hint.line = record.locator.line;
      hint.verified = record.locator.verified;
    }
    if (record.locator.kind !== undefined) hint.kind = record.locator.kind;
    if (record.kind === "css-background") hint.background = true;
    if (record.locator.via !== undefined) hint.via = record.locator.via;
    if (record.locator.ownerChain !== undefined) hint.ownerChain = record.locator.ownerChain;
    if (record.locator.testid !== undefined) hint.testid = record.locator.testid;
    if (record.locator.alt !== undefined) hint.alt = record.locator.alt;
    if (record.locator.classes) hint.classes = record.locator.classes;
    const search = record.locator.searchHints;
    if (record.locator.file === undefined && search?.component !== undefined && search.glob !== undefined) {
      hint.find = { component: search.component, glob: search.glob };
    }
    const widths = record.perViewport.map((p) => p.renderedCssPx).filter((w) => w > 0);
    if (widths.length > 0) hint.rendered = { min: Math.min(...widths), max: Math.max(...widths) };
    const measured = record.perViewport.flatMap((p): SizePoint[] => {
      const width = DEFAULT_VIEWPORTS.find((v) => v.name === p.viewport)?.width;
      return width !== undefined && p.renderedCssPx > 0 ? [{ width, rendered: p.renderedCssPx }] : [];
    });
    if (measured.length > 0) hint.measured = measured;
    if (record.fix.width !== undefined) hint.width = record.fix.width;
    if (record.fix.srcset !== undefined) hint.srcset = { ...record.fix.srcset };
    const cdn = record.fix.cdnQuality;
    if (cdn !== undefined) {
      hint.qualityNote = cdn.handled
        ? `quality handled by ${record.locator.loader} (q_auto)`
        : `${record.locator.loader}: q_auto leaves ${kb(cdn.saved)} per view; an explicit q_${target ?? "<N>"} passes SSIMULACRA2`;
    }
    // The cap leaves the usage at its current quality or raises it: no target to print (its saving is none).
    const current = record.current.quality;
    const capKept = capped !== undefined && current !== undefined && capped.to >= current && capped.from < current;
    if (capKept && capped !== undefined && current !== undefined) {
      hint.qualityNote =
        capped.to > current
          ? `quality raised to ${capped.to} by images.qualities: adds bytes, not counted`
          : `quality kept at ${current}: no listed value from ${capped.from} to ${current}`;
    }
    // A CDN-handled quality has no target to print: its saving is not counted.
    if (record.fix.quality !== undefined && current !== undefined && cdn?.handled !== true && !capKept) {
      const quality: NonNullable<Hint["quality"]> = {
        current,
        target,
        samples: record.fix.quality.samples,
        group: record.fix.quality.group,
      };
      if (capped !== undefined && rawTarget !== undefined && capped.to !== rawTarget) {
        quality.cappedFrom = rawTarget;
        quality.approx = true;
      }
      if (qualities !== undefined) quality.allowed = [...new Set(qualities)].sort((a, b) => a - b);
      if (snapFrom !== undefined) {
        quality.snapFrom = snapFrom;
        quality.void = true;
        if (hint.bytes.sizes !== undefined) hint.bytes = { ...hint.bytes, saved: hint.bytes.sizes + (hint.bytes.resize ?? 0), quality: 0 };
      }
      hint.quality = quality;
    }
    if (record.fix.format !== undefined || served !== undefined) hint.format = { current: served, best: record.fix.format };
    if (record.fix.vector !== undefined) hint.vector = { ...record.fix.vector, servedPerView: Math.round(perViewBytesOf(record)) };
    if (record.hidden !== undefined) hint.hidden = record.hidden;
    if (record.fix.animated !== undefined) {
      hint.animated = record.fix.animated;
      if (record.current.src !== undefined) hint.src = record.current.src;
      // The animated saving is the encode's alone (est.): the target is encoded at the needed width, so perViewBytes less the
      // target's bytes already holds the width change. Adding the record's sizes part would count it twice. A real sizes
      // proposal is still printed as information (renderHint), but it adds nothing to the saving.
      const encoded = animatedSavingOf(record.fix.animated);
      hint.bytes = { saved: encoded, addedForSharpness: record.fix.bytes.addedForSharpness, quality: encoded };
    }
    return hint;
  });
}

/**
 * An image gets a vector hint when its SVG passed the check (a claim), or when it is flat, was not traced to a passing SVG,
 * and is big enough to matter (an informational note with no byte claim).
 */
export function vectorHinted(record: ImageRecord): boolean {
  const vector = record.fix.vector;
  if (vector === undefined) return false;
  if (vector.passed === true) return true;
  return perViewBytesOf(record) >= VECTOR_LOOKS_MIN_BYTES;
}

/** The vector check's lines of a hint: the SVG that passed, or the note on a flat image with no passing SVG. */
export function vectorLines(vector: VectorHint): string[] {
  if (vector.passed === true && vector.svgBytes !== undefined && vector.score !== undefined) {
    const traced = vector.tracedFile !== undefined ? `, traced one: ${safeText(vector.tracedFile)}` : "";
    return [
      `   vector art: serve SVG, ~${kb1(vector.svgBytes)} (br) vs ${kb1(vector.servedPerView)} now, sharp at every DPR; fidelity ${Math.round(vector.score)} at half size (bar ${VECTOR_BAR}); prefer your source SVG${traced}`,
    ];
  }
  if (vector.servedPerView >= VECTOR_LOOKS_MIN_BYTES) return ["   looks like vector art (flat colors); if a source SVG exists, serve it"];
  return [];
}

/**
 * The one-line summary of a page's loaded-but-not-shown images: the count, bytes per view and the cases, as the text, Markdown
 * and check outputs all print it. Undefined when there are none.
 */
export function hiddenSummaryLine(hidden: HiddenPage | undefined): string | undefined {
  if (hidden === undefined || hidden.images === 0) return undefined;
  const { responsive, lazy, "never-shown-on-load": never } = hidden.cases;
  return `loaded but not shown: ${hidden.images} image(s), ${kb(hidden.bytesPerView)}/view (responsive ${responsive}, lazy ${lazy}, never shown on load ${never}); not in the savings`;
}

/** The hints an argument set asks for: filtered, sorted by bytes saved (largest first), then offset and limited. */
export function selectHints(hints: Hint[], args: Pick<HintsArgs, "page" | "component" | "minKb" | "limit" | "offset">): Hint[] {
  const page = args.page?.toLowerCase();
  const component = args.component?.toLowerCase();
  return hints
    .filter((h) => page === undefined || h.page.toLowerCase().includes(page))
    .filter((h) => {
      if (component === undefined) return true;
      return h.component.some((c) => c.toLowerCase().includes(component)) || (h.file ?? "").toLowerCase().includes(component);
    })
    .filter((h) => args.minKb === undefined || h.bytes.saved >= args.minKb * 1024)
    .sort((a, b) => Number(b.lcp === true) - Number(a.lcp === true) || b.bytes.saved - a.bytes.saved || a.id.localeCompare(b.id))
    .slice(args.offset, args.offset + args.limit);
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;
const kb1 = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/** The mark after a hint's file:line: an owner call site, or an unverified source. */
export function locationNote(hint: Hint): string {
  if (hint.kind === "owner") return " (owner call site)";
  return hint.verified === false ? " (unverified)" : "";
}

/** The quality target as printed: "-> 85", or "q82 -> 85 (allowed: 75,85,100)" when the target was snapped to an allowed value. */
export function qualityTarget(quality: NonNullable<Hint["quality"]>): string {
  if (quality.target === undefined) return "";
  if (quality.cappedFrom !== undefined) return ` q${quality.cappedFrom} -> ${quality.target} (capped to the listed qualities, approx)`;
  const allowed = quality.allowed !== undefined ? ` (allowed: ${quality.allowed.join(",")})` : "";
  return quality.snapFrom !== undefined ? ` q${quality.snapFrom} -> ${quality.target}${allowed}` : ` -> ${quality.target}${allowed}`;
}

/** The srcset advice of a plain image with no srcset: the variants to serve, and the srcset and sizes to add. */
export function srcsetLineOf(srcset: NonNullable<Hint["srcset"]>): string {
  const candidates = srcset.widths.map((w) => `… ${w}w`).join(", ");
  const sizes = srcset.sizes !== undefined ? safeText(srcset.sizes) : "the rendered CSS width per viewport";
  return `srcset: no srcset today; serve variants at ${srcsetWidthLabel(srcset.widths)} (largest needed ${srcset.largest} px) and add srcset="${candidates}" sizes="${sizes}"`;
}

/**
 * The srcset advice of a call site, when every image in it is a plain image with no srcset: the union of their widths (at
 * most the variant limit), the largest need, and the first measured sizes value. Undefined for any other group.
 */
export function groupSrcsetOf(group: { hints: Hint[] }): NonNullable<Hint["srcset"]> | undefined {
  const all = group.hints.flatMap((h) => (h.srcset !== undefined ? [h.srcset] : []));
  if (all.length === 0 || all.length !== group.hints.length) return undefined;
  const widths = srcsetWidthsOf(all.flatMap((s) => s.widths), undefined);
  const sizes = all.find((s) => s.sizes !== undefined)?.sizes;
  return { widths, largest: Math.max(...all.map((s) => s.largest)), ...(sizes !== undefined ? { sizes } : {}) };
}

/**
 * The saving of one image or one call site, per view, split into its parts when the scan gave them: "saves 15 KB/view =
 * sizes 12 KB + quality 3 KB". A quality part that a snap voided is printed as void, not as a number.
 */
export function savesText(hint: Hint): string {
  const { saved, sizes, quality, resize } = hint.bytes;
  if (resize !== undefined) {
    const parts = [sizes !== undefined && sizes > 0 ? `sizes ${kb(sizes)}` : undefined, `resize ${kb(resize)}`, (quality ?? 0) > 0 ? `quality ${kb(quality ?? 0)}` : undefined];
    return `saves ${kb(saved)}/view = ${parts.filter((p): p is string => p !== undefined).join(" + ")}`;
  }
  if (sizes === undefined) return `saves ${kb(saved)}/view`;
  const qualityPart = hint.quality?.void === true ? "quality void after snap" : `quality ${kb(quality ?? 0)}`;
  return `saves ${kb(saved)}/view = sizes ${kb(sizes)} + ${qualityPart}`;
}

/** The media condition that splits a responsive twin's viewports: a min-width or max-width at the default widths. */
function twinMediaOf(hidden: HiddenFix): string {
  const hiddenAt = hidden.viewports.map((name) => hidden.widths[name]);
  const shownAt = hidden.shownIn.map((name) => hidden.widths[name]);
  if (hiddenAt.some((w) => !(w > 0)) || shownAt.some((w) => !(w > 0))) return "(min-width: <breakpoint>px)";
  // Shown at the wider viewports: the file goes from the breakpoint up, at the narrowest shown width.
  if (Math.max(...hiddenAt) < Math.min(...shownAt)) return `(min-width: ${Math.min(...shownAt)}px)`;
  // Shown at the narrower viewports: the file goes up to the widest shown width.
  if (Math.min(...hiddenAt) > Math.max(...shownAt)) return `(max-width: ${Math.max(...shownAt)}px)`;
  return "(min-width: <breakpoint>px)";
}

/**
 * The lines of a loaded-but-not-shown image: where it is hidden, its bytes per view (kept apart from the saving), and the fix
 * for its case (see HiddenFix.action). Page-derived viewport names are printed as JSON strings.
 */
export function hiddenLines(hidden: HiddenFix): string[] {
  const names = (list: string[]): string => list.map((v) => JSON.stringify(safeText(v))).join(", ");
  const reasons = [
    ...hidden.reasons,
    ...(hidden.inPanel ? ["in a tab panel, a hidden subtree or a closed details"] : []),
    ...(hidden.hover === true ? ["shown on hover"] : []),
  ].join(", ");
  const lines = [
    `   loaded but not shown on load: ${kb(hidden.perViewBytes)}/view, hidden at ${hidden.viewports.length} of ${hidden.of} viewport(s) (${names(hidden.viewports)}): ${safeText(reasons)}; not in the saving`,
  ];
  if (hidden.unstable === "unknown") lines.push("   unstable: unknown (not verified: a name on the page did not resolve, or the candidate cap was reached): the reason is the first read's; check it in a browser");
  if (hidden.action === "responsive") {
    lines.push(
      `   responsive twin, shown on load at ${names(hidden.shownIn)}: serve one file per viewport. Replace the two elements with <picture><source media="${twinMediaOf(hidden)}" srcset="<the file shown there>"><img …></picture>, or delete the hidden copy if the design does not need it.`,
    );
  } else if (hidden.action === "lazy") {
    const what = hidden.hover === true ? "a hover swap" : hidden.inPanel ? "a tab panel, a hidden subtree or a closed details" : "a carousel slide or other clipped box";
    if (hidden.alreadyLazy === true) {
      // loading="lazy" is already there: the browser still loads it because it is inside its lazy-load distance, so adding it again changes nothing.
      lines.push(`   ${what} (${names(hidden.viewports)}): already lazy (loading="lazy") and still loaded, as it is within the browser's lazy-load distance of the viewport. Render it on activation (when the tab, details or hover opens), do not add lazy again.`);
    } else {
      lines.push(`   ${what} (${names(hidden.viewports)}): add loading="lazy", or load it on demand (when the tab, details or hover opens).`);
    }
  } else {
    lines.push(
      `   never shown on load at any of ${hidden.of} viewport(s): remove it, or load it on demand (when the menu, modal or hover opens).`,
    );
  }
  return lines;
}

/**
 * The loaded-but-not-shown lines of one video (see HiddenFix): its bytes per view, the case and the fix. The responsive case
 * names the one element with <source media>; the lazy one preload none, no autoplay until shown; the never-shown one removal
 * or an on-demand load. The bytes are not in the saving, as an image's are not.
 */
export function videoHiddenLines(hidden: HiddenFix): string[] {
  const names = (list: string[]): string => list.map((v) => JSON.stringify(safeText(v))).join(", ");
  const reasons = [
    ...hidden.reasons,
    ...(hidden.inPanel ? ["in a tab panel, a hidden subtree or a closed details"] : []),
    ...(hidden.hover === true ? ["shown on hover"] : []),
  ].join(", ");
  const lines = [
    `   loaded but not shown on load: ${kb(hidden.perViewBytes)}/view, hidden at ${hidden.viewports.length} of ${hidden.of} viewport(s) (${names(hidden.viewports)}): ${safeText(reasons)}; not in the savings`,
  ];
  if (hidden.unstable === "unknown") lines.push("   unstable: unknown (not verified: a name on the page did not resolve, or the candidate cap was reached): the reason is the first read's; check it in a browser");
  if (hidden.action === "responsive") {
    const media = twinMediaOf(hidden);
    lines.push(
      `   responsive twin, shown on load at ${names(hidden.shownIn)}: one <video> for both viewports, not two: <video autoplay muted playsinline poster="<first frame>"> with <source media="${media}" src="<the file shown at ${names(hidden.viewports)}>" type="video/mp4"> first, then <source src="<the file shown at ${names(hidden.shownIn)}>" type="video/mp4"> with no media. Or delete the hidden copy if the design does not need it.`,
    );
    lines.push(
      `     <source media> on video: Chrome and Edge 120+ and Firefox 120+ restored support; Safari has always supported it. A browser that ignores it takes the first source, so the fallback is a script that sets src from matchMedia("${media}") and reloads on change.`,
    );
  } else if (hidden.action === "lazy") {
    const what = hidden.hover === true ? "a hover swap" : hidden.inPanel ? "a tab panel, a hidden subtree or a closed details" : "a carousel slide or other clipped box";
    lines.push(
      `   ${what} (${names(hidden.viewports)}): preload="none", no autoplay until it is shown (an IntersectionObserver, or the tab, details or hover opens), and the poster only.`,
    );
  } else {
    lines.push(`   never shown on load at any of ${hidden.of} viewport(s): remove it, or load it on demand (when the modal, menu or hover opens).`);
  }
  return lines;
}

/** One hint as four short lines: where, sizes, quality and format, bytes and rung. */
export function renderHint(hint: Hint, rank: number): string[] {
  // Page-derived names and attributes are printed as JSON strings, so a newline or an instruction inside them stays data.
  const where =
    hint.file !== undefined
      ? `${JSON.stringify(`${hint.file}:${hint.line ?? 0}`)}${locationNote(hint)}`
      : JSON.stringify(hint.component[0] ?? hint.selector);
  const component = hint.component.length > 0 && hint.file !== undefined ? ` (${JSON.stringify(hint.component[0])})` : "";
  const lcpPrefix = hint.lcp === true ? `LCP image (${(hint.lcpViewports ?? []).map((v) => safeText(v)).join(", ")}): ` : "";
  const lines = [`${rank}. ${lcpPrefix}${hint.id}  ${where}${component}  ${safeText(hint.page)}`];
  const attributes = [
    hint.alt !== undefined ? `alt ${JSON.stringify(hint.alt)}` : undefined,
    hint.testid !== undefined ? `testid ${JSON.stringify(hint.testid)}` : undefined,
    hint.classes !== undefined ? `class ${JSON.stringify(hint.classes)}` : undefined,
  ].filter((a): a is string => a !== undefined);
  if (attributes.length > 0) lines.push(`   ${attributes.join("  ")}`);
  // A vector check that wins leads the hint; otherwise it follows the raster fixes (see below).
  const vector = hint.vector !== undefined ? vectorLines(hint.vector) : [];
  if (hint.vector?.wins === true) lines.push(...vector);
  // The name is an identifier (COMPONENT_NAME), so it prints bare; the glob is built from the same name.
  if (hint.kind === "owner") {
    const name = hint.component[0];
    lines.push(
      name !== undefined
        ? `   owner call site: the image is rendered inside <${name}>; search that component for the <img>`
        : "   owner call site: the image is rendered inside an unnamed component; search the file's imports",
    );
  }
  if (hint.find) lines.push(`   find: ${hint.find.component} in ${hint.find.glob}`);
  if (hint.hidden !== undefined) lines.push(...hiddenLines(hint.hidden));
  // An image never shown has no sizes, quality or format change to print: its fix is the hidden block above.
  if (hint.hidden !== undefined && hint.hidden.shownIn.length === 0) {
    if (hint.file === undefined && hint.find === undefined && hint.kind !== "owner") lines.push("   owner unknown");
    lines.push(`   rung ${hint.rung}`);
    return lines;
  }
  if (hint.width !== undefined) lines.push(`   width ${hint.width}px (device pixels needed)`);
  if (hint.srcset !== undefined) lines.push(`   ${srcsetLineOf(hint.srcset)}`);
  else if (hint.width === undefined && (hint.animated === undefined || hint.sizes.proposed !== undefined)) {
    lines.push(`   sizes ${safeText(hint.sizes.current ?? "none")} -> ${safeText(hint.sizes.proposed ?? "-")} (${hint.sizes.basis ?? "-"})`);
  }
  if (hint.sizesAuto !== undefined) lines.push(`   alternative: sizes="${safeText(hint.sizesAuto)}" (Chrome, Edge, Firefox 150+; Safari falls back to ${safeText(hint.sizes.proposed ?? "-")})`);
  if (hint.via === "prod-sourcemap") {
    lines.push("   located via the production source map: the component's definition; the image is inside it");
  }
  if (hint.background === true) {
    lines.push("   css background: no sizes in CSS; serve a file at that width, or image-set() with the density or width variants");
  } else if (hint.file === undefined && hint.find === undefined && hint.kind !== "owner") lines.push("   owner unknown");
  if (hint.animated !== undefined) lines.push(...animatedLines(hint.animated, hint.src, hint.alt));
  const parts: string[] = [];
  if (hint.quality) parts.push(`quality ${hint.quality.current}${qualityTarget(hint.quality)} (max of ${hint.quality.samples}, ${safeText(hint.quality.group)})`);
  if (hint.format) parts.push(`format ${hint.format.current ?? "?"}${hint.format.best && hint.format.best !== hint.format.current ? ` -> ${hint.format.best}` : ""}${hint.formatNote !== undefined ? ` (${safeText(hint.formatNote)})` : ""}`);
  if (parts.length > 0) lines.push(`   ${parts.join("  ")}`);
  if (hint.qualityNote !== undefined) lines.push(`   ${safeText(hint.qualityNote)}`);
  // An animated hint's saving is an estimate from the sample encodes, and its rung is that estimate, not the image measurement.
  const animated = hint.animated !== undefined;
  lines.push(
    `   ${savesText(hint)}${animated ? " est." : ""}, +${kb(hint.bytes.addedForSharpness)} sharpness (separate)  rung ${animated ? "estimate" : hint.rung}`,
  );
  if (hint.vector !== undefined && hint.vector.wins !== true) lines.push(...vector);
  return lines;
}

/** The hints of one file:line across pages: the grouped view, one entry per call site. */
export interface HintGroup {
  key: string;
  hints: Hint[];
  /** The pages the group's images are on, in the order they were scanned. */
  pages: string[];
  /** Bytes the group saves per page view, summed over its images (each image's own per-view saving). */
  saved: number;
}

/** The group a hint belongs to: its file:line, else its nearest component, else its selector. */
export function groupKeyOf(hint: Hint): string {
  if (hint.file !== undefined) return `file:${hint.file}:${hint.line ?? 0}`;
  return `${hint.component[0] !== undefined ? "component" : "selector"}:${hint.component[0] ?? hint.selector}`;
}

/**
 * A caller of a shared call site: the project owner at one level of the owner chain above the image. `file` is null when
 * that usage has no project owner at this level (the chain is shorter there).
 */
export interface CallerEntry {
  file: string | null;
  line: number | null;
  /** The owner's component name at this level, when it has one. */
  component?: string;
  /** Images of the group whose usage reaches this caller. */
  count: number;
  pages: string[];
  saved: number;
  /** The sizes fitted to this caller's measured widths, or null when its images were not measured. */
  sizes: string | null;
}

/** The caller map of a shared call site: the level of the chain that differs between usages, and its callers. */
export interface CallerMap {
  /** The index in the owner chain (0 is the located source; the map reads from 1 up). */
  level: number;
  callers: CallerEntry[];
}

const CHAIN_KEY = (owner: OwnerSource | undefined): string => (owner ? `${owner.file}:${owner.line}` : "-");

/**
 * The caller map of a group, or undefined when its usages all reach the same callers (the call site is not shared, or
 * the chains say nothing). It reads the owner chain above the located source: the first level, nearest first, at which
 * the usages differ is the level of the map, and each usage is listed under the caller it reaches there.
 */
export function callerMapOf(group: HintGroup): CallerMap | undefined {
  const chains = group.hints.map((h) => h.ownerChain ?? []);
  const longest = Math.max(0, ...chains.map((c) => c.length));
  for (let level = 1; level < longest; level++) {
    if (new Set(chains.map((c) => CHAIN_KEY(c[level]))).size < 2) continue;
    const byKey = new Map<string, { hints: Hint[]; owner?: OwnerSource }>();
    group.hints.forEach((hint, i) => {
      const owner = chains[i][level];
      const key = CHAIN_KEY(owner);
      const entry = byKey.get(key) ?? { hints: [], owner };
      entry.hints.push(hint);
      byKey.set(key, entry);
    });
    const callers: CallerEntry[] = [...byKey.values()].map(({ hints, owner }) => {
      const points = maxPerWidth(hints.flatMap((h) => h.measured ?? []));
      const fit = points.length > 0 ? fitSizes(points) : undefined;
      return {
        file: owner?.file ?? null,
        line: owner?.line ?? null,
        ...(owner?.component !== undefined ? { component: owner.component } : {}),
        count: hints.length,
        pages: [...new Set(hints.map((h) => h.page))],
        saved: hints.reduce((sum, h) => sum + h.bytes.saved, 0),
        sizes: fit?.value ?? null,
      };
    });
    callers.sort((a, b) => b.saved - a.saved || `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
    return { level, callers };
  }
  return undefined;
}

/** Groups hints by call site across pages, largest saving first. The hints keep the order they came in. */
export function groupHints(hints: Hint[]): HintGroup[] {
  const groups = new Map<string, HintGroup>();
  for (const hint of hints) {
    const key = groupKeyOf(hint);
    const group = groups.get(key) ?? { key, hints: [], pages: [], saved: 0 };
    group.hints.push(hint);
    if (!group.pages.includes(hint.page)) group.pages.push(hint.page);
    group.saved += hint.bytes.saved;
    groups.set(key, group);
  }
  const hasLcp = (group: HintGroup): number => Number(group.hints.some((h) => h.lcp === true));
  return [...groups.values()].sort((a, b) => hasLcp(b) - hasLcp(a) || b.saved - a.saved || a.key.localeCompare(b.key));
}

/**
 * A call site's sizes, fitted to its measured widths (group-sizes.ts). `one`: one formula covers every image and page of the
 * call site (the pages need the same widths, or there is one page). `per-caller`: the pages need different widths at the
 * same viewport, so the component is shared and each caller passes its own formula.
 */
export interface GroupSizes {
  mode: "one" | "per-caller";
  /** The formula of `one` mode. */
  value?: string;
  /** Each caller's formula (the page's). In `one` mode they are all the same formula. */
  callers: { page: string; value: string }[];
  /** The distinct viewport widths the formula was checked at. */
  views: number;
  /** The most clauses any of the formulas has. */
  clauses: number;
}

/** Whether the pages need different widths: at a viewport width they all measured, the largest and smallest differ by more than the tolerance. */
function pagesDiffer(perPage: SizePoint[][]): boolean {
  const widths = perPage[0].map((p) => p.width).filter((w) => perPage.every((points) => points.some((p) => p.width === w)));
  return widths.some((w) => {
    const values = perPage.map((points) => points.find((p) => p.width === w)?.rendered ?? 0);
    const top = Math.max(...values);
    return top - Math.min(...values) > Math.max(4, 0.02 * top);
  });
}

/**
 * The fitted sizes of a call site, or undefined when it has no measurement for every image, or when its images propose one
 * value and the pages need the same widths (that value stands, as before). See GroupSizes.
 */
export function groupSizesOf(group: HintGroup): GroupSizes | undefined {
  const proposals = new Set(group.hints.map((h) => h.sizes.proposed).filter((v): v is string => v !== undefined));
  if (group.hints.some((h) => h.measured === undefined || h.measured.length === 0)) return undefined;
  const pointsOf = (hints: Hint[]): SizePoint[] => hints.flatMap((h) => h.measured ?? []);
  const perPage = group.pages.map((page) => ({ page, points: maxPerWidth(pointsOf(group.hints.filter((h) => h.page === page))) }));
  const views = new Set(pointsOf(group.hints).map((p) => p.width)).size;
  const differ = group.pages.length > 1 && pagesDiffer(perPage.map((p) => p.points));
  if (!differ && proposals.size <= 1) return undefined;
  if (differ) {
    const callers: { page: string; value: string; clauses: number }[] = [];
    for (const { page, points } of perPage) {
      const fit = fitSizes(points);
      if (fit === undefined) return undefined;
      callers.push({ page, value: fit.value, clauses: fit.clauses });
    }
    return { mode: "per-caller", callers: callers.map(({ page, value }) => ({ page, value })), views, clauses: Math.max(...callers.map((c) => c.clauses)) };
  }
  const fit = fitSizes(pointsOf(group.hints));
  if (fit === undefined) return undefined;
  return {
    mode: "one",
    value: fit.value,
    callers: perPage.map(({ page }) => ({ page, value: fit.value })),
    views,
    clauses: fit.clauses,
  };
}

/**
 * One sizes value for a group, or the reason there is none. A fitted formula (groupSizesOf) when the images are measured;
 * otherwise the pages' values: when they differ, the component is shared and each caller passes its own sizes.
 */
export function combinedSizes(group: HintGroup): string {
  if (groupSrcsetOf(group) !== undefined) return "no sizes: the images have no srcset (see srcset)";
  const fitted = groupSizesOf(group);
  if (fitted?.mode === "one") {
    return `${fitted.value} (one formula over ${group.hints.length} image(s), checked at ${fitted.views} viewport(s): never below a measured width)`;
  }
  if (fitted?.mode === "per-caller") return "shared component: pass sizes per caller (each caller's formula is listed below)";
  const proposals = [...new Set(group.hints.map((h) => h.sizes.proposed).filter((v): v is string => v !== undefined))];
  if (proposals.length === 0) return "no sizes change";
  if (proposals.length === 1) return `${proposals[0]} (the same on ${group.hints.length} image(s))`;
  if (group.pages.length > 1) return "shared component: pass sizes from each caller (listed below)";
  const widest = Math.max(...group.hints.map((h) => h.rendered?.max ?? 0));
  return `max-safe: ${widest}px, the widest measured width (the images on this page differ; one value covers them all)`;
}

/** The heading of a call site: where, the images and pages, and the bytes it saves per view (split when the scan gave the split). */
export function groupHeadLine(group: HintGroup, rank: number): string {
  const first = group.hints[0];
  const where =
    first.file !== undefined
      ? `${JSON.stringify(`${first.file}:${first.line ?? 0}`)}${locationNote(first)}`
      : JSON.stringify(first.component[0] ?? first.selector);
  const name = first.file !== undefined && first.component[0] !== undefined ? ` (${JSON.stringify(first.component[0])})` : "";
  const sizes = group.hints.every((h) => h.bytes.sizes !== undefined) ? group.hints.reduce((sum, h) => sum + (h.bytes.sizes ?? 0), 0) : undefined;
  const resize = group.hints.every((h) => h.bytes.resize !== undefined) ? group.hints.reduce((sum, h) => sum + (h.bytes.resize ?? 0), 0) : undefined;
  let split = sizes !== undefined ? ` = sizes ${kb(sizes)} + quality ${kb(group.saved - sizes)}` : "";
  if (resize !== undefined) {
    const sized = sizes ?? 0;
    const quality = Math.max(0, group.saved - sized - resize);
    const parts = [sized > 0 ? `sizes ${kb(sized)}` : undefined, `resize ${kb(resize)}`, quality > 0 ? `quality ${kb(quality)}` : undefined];
    split = ` = ${parts.filter((p): p is string => p !== undefined).join(" + ")}`;
  }
  const lcp = group.hints.find((h) => h.lcp === true);
  const lcpPrefix = lcp !== undefined ? `LCP image (${(lcp.lcpViewports ?? []).map((v) => safeText(v)).join(", ")}): ` : "";
  return `${rank}. ${lcpPrefix}${where}${name}  ${group.hints.length} image(s), ${group.pages.length} page(s)  saves ${kb(group.saved)}/view${split}`;
}

/** `--top`: the call sites that save the most per view, one line each. */
export function renderTop(groups: HintGroup[]): string {
  if (groups.length === 0) return "no images with fix hints\n";
  return `${groups.map((group, i) => groupHeadLine(group, i + 1)).join("\n")}\n`;
}

/** The text of a group: its call site, the combined sizes, each page's sizes and rendered widths, the ids, and the quality. */
export function renderGroup(group: HintGroup, rank: number): string[] {
  const first = group.hints[0];
  const lines = [groupHeadLine(group, rank)];
  if (first.kind === "owner") {
    lines.push(
      first.component[0] !== undefined
        ? `   owner call site: the image is rendered inside <${first.component[0]}>; search that component`
        : "   owner call site: the image is rendered inside an unnamed component; search the file's imports",
    );
  }
  const callers = callerMapOf(group);
  if (callers) {
    lines.push(`   callers: ${callers.callers.length} caller(s) above the image (owner level ${callers.level}, the first that differs between usages)`);
    for (const caller of callers.callers) {
      const where = caller.file !== null ? JSON.stringify(safeText(`${caller.file}:${caller.line ?? 0}`)) : "\"no project owner\"";
      const name = caller.component !== undefined ? ` (${JSON.stringify(safeText(caller.component))})` : "";
      const pages = caller.pages.map((p) => JSON.stringify(safeText(pathOf(p)))).join(", ");
      const sizes = caller.sizes !== null ? JSON.stringify(safeText(caller.sizes)) : "not measured";
      lines.push(`     ${where}${name}  ${caller.count} image(s), ${caller.pages.length} page(s) ${pages}  sizes ${sizes}`);
    }
  }
  const fitted = groupSizesOf(group);
  const srcset = groupSrcsetOf(group);
  lines.push(srcset !== undefined ? `   ${srcsetLineOf(srcset)}` : `   sizes: ${safeText(combinedSizes(group))}`);
  for (const page of group.pages) {
    const mine = group.hints.filter((h) => h.page === page);
    const current = [...new Set(mine.map((h) => h.sizes.current ?? "none"))].map((v) => JSON.stringify(safeText(v))).join(", ");
    const caller = fitted?.callers.find((c) => c.page === page)?.value;
    const proposed =
      caller !== undefined
        ? JSON.stringify(safeText(caller))
        : [...new Set(mine.map((h) => h.sizes.proposed ?? "-"))].map((v) => JSON.stringify(safeText(v))).join(", ");
    const widths = mine.flatMap((h) => (h.rendered ? [h.rendered.min, h.rendered.max] : []));
    const rendered = widths.length > 0 ? `${Math.min(...widths)}-${Math.max(...widths)} px` : "not rendered";
    // A srcset group has no sizes change to print: its page line keeps the images and the rendered widths only.
    if (srcset !== undefined) lines.push(`   ${JSON.stringify(pathOf(page))}  ${mine.length} image(s)  rendered ${rendered}`);
    else lines.push(`   ${JSON.stringify(pathOf(page))}  ${mine.length} image(s)  current ${current}  proposed ${proposed}  rendered ${rendered}`);
  }
  const targets = group.hints.flatMap((h) => (h.quality ? [h.quality] : []));
  if (targets.length > 0) {
    const current = Math.max(...targets.map((q) => q.current));
    const withTarget = targets.filter((q) => q.target !== undefined).map((q) => q.target as number);
    // The group's target is the max of the images' targets; when any was snapped, the raw max is shown as the start.
    const snapped = targets.some((q) => q.snapFrom !== undefined);
    const raw = Math.max(...targets.map((q) => q.snapFrom ?? q.target ?? 0));
    const target = withTarget.length > 0 ? qualityTarget({ ...targets[0], current, target: Math.max(...withTarget), snapFrom: snapped ? raw : undefined }) : "";
    lines.push(`   quality ${current}${target} (max of ${targets[0].samples}, ${safeText(targets[0].group)})`);
  }
  const ids = group.hints.map((h) => h.id);
  const shown = ids.slice(0, 8).join(" ");
  lines.push(`   ids ${shown}${ids.length > 8 ? ` (+${ids.length - 8} more; --flat lists each image)` : ""}`);
  // An animated image's hint is its own (its target and bytes are not a sizes or quality change), so it is printed here.
  for (const hint of group.hints) {
    if (hint.animated !== undefined) lines.push(`   ${safeText(hint.id)}`, ...animatedLines(hint.animated, hint.src));
  }
  return lines;
}

/** The text of a grouped selection: a count line, then each group. */
export function renderGroups(groups: HintGroup[], totalGroups: number, totalImages: number, offset: number, page?: string): string {
  if (groups.length === 0) return `no images with fix hints${totalGroups > 0 ? " match the filters" : ""}\n`;
  const head = `${totalGroups} call site(s), ${totalImages} image(s) with fix hints${page ? ` (page ${safeText(page)})` : ""}; showing ${offset + 1}-${offset + groups.length}\n`;
  const body = groups.flatMap((group, i) => renderGroup(group, offset + i + 1));
  return `${head}${body.join("\n")}\n`;
}

/** The text of a selection: a count line, then each hint. */
export function renderHints(hints: Hint[], total: number, offset: number, page?: string): string {
  if (hints.length === 0) return `no images with fix hints${total > 0 ? " match the filters" : ""}\n`;
  const head = `${total} image(s) with fix hints${page ? ` (page ${safeText(page)})` : ""}; showing ${offset + 1}-${offset + hints.length}\n`;
  const body = hints.flatMap((hint, i) => renderHint(hint, offset + i + 1));
  return `${head}${body.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Animated images and `<video>` (Task 8): the text of their hints and of the Video section of a page. Every estimated byte
// figure is marked "est."; a hint names the sample encodes once. Page-derived names and attributes are JSON strings.
// ---------------------------------------------------------------------------------------------------------------------

/** The note that marks a figure as an estimate from the 2-second sample encodes. A hint says it once. */
export const SAMPLE_NOTE = "(estimate from 2 s samples)";
/** The `type` of the two sources a video hint names: AV1 first, H.264 as the fallback. */
const AV1_TYPE = 'video/mp4; codecs=av01.0.08M.08';
const H264_TYPE = 'video/mp4; codecs=avc1.640028';
/** The H.264 fallback recipe an animated GIF's video hint gives. It is not encoded by imgtune (performance first). */
const H264_RECIPE = "libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart -an";
const FORMAT_LABEL: Record<AnimatedFix["info"]["format"], string> = { gif: "GIF", webp: "WebP", apng: "APNG" };

/**
 * The label of a candidate's bytes. An NVENC candidate's bytes are its GPU encode scaled to a CPU encode (÷1.4), so the label
 * says so: performance before precision, but the number is never presented as a measured CPU encode.
 */
export function estLabel(c: CandidateResult): string {
  const base = c.encoder === "nvenc" ? "est. (GPU-encoded, scaled to a CPU encode ÷1.4)" : "est.";
  return c.timeLimited === true ? `${base}, search stopped at the time limit` : base;
}

/**
 * The quality mark of a candidate: an NVENC candidate's cq is read as the CPU CRF (the same number, a fixed offset of 0), so
 * the recipe's CRF is approximate. Empty for a CPU encode.
 */
export function qualityApprox(c: CandidateResult): string {
  return c.encoder === "nvenc" ? " (approx.)" : "";
}

/** The smallest candidate of one codec, or undefined. The first of equal bytes wins. */
export function smallestCandidate(candidates: CandidateResult[] | undefined, codec: MediaCodec): CandidateResult | undefined {
  let best: CandidateResult | undefined;
  for (const c of candidates ?? []) {
    if (c.codec === codec && (best === undefined || c.bytes < best.bytes)) best = c;
  }
  return best;
}

/**
 * The quality evidence of an encode: VMAF with its bar, and the still-frame guard with its bar. A bar the candidate does not
 * carry is said so, not guessed: the run's flag is not in the scan file.
 */
export function evidenceOf(c: CandidateResult & { vmafBar?: number }): string {
  const bar = (value: number | undefined): string => (value === undefined ? "bar not recorded" : `bar ${value}`);
  return `VMAF ${c.vmaf.toFixed(1)} (${bar(c.vmafBar)}), still ${c.still.toFixed(1)} (${bar(c.stillBar)})`;
}

/** The codec as a hint names it: "av1", "h264", or the codec's own name. */
function codecName(codec: MediaCodec): string {
  return codec === "av1-mp4" ? "av1" : codec === "h264-mp4" ? "h264" : codec;
}

/** The encode candidates an animated image offers, and the one its hint leads with (`main`). */
export interface AnimatedTargets {
  avif?: CandidateResult;
  webp?: CandidateResult;
  av1?: CandidateResult;
  h264?: CandidateResult;
  /** True when the hint is the `<video>` replacement (AV1 is the main target). */
  video: boolean;
  /** The main target: the AV1 video, else the AVIF, else the WebP. Undefined when nothing was encoded. */
  main?: CandidateResult;
}

/** The targets of an animated image's encode (see AnimatedTargets). The main one's bytes are the saving's basis. */
export function animatedTargetsOf(animated: AnimatedFix): AnimatedTargets {
  const avif = smallestCandidate(animated.estimate, "animated-avif");
  const webp = smallestCandidate(animated.estimate, "animated-webp");
  const av1 = smallestCandidate(animated.estimate, "av1-mp4");
  const h264 = smallestCandidate(animated.estimate, "h264-mp4");
  const video = av1 !== undefined && (animated.target?.main === "video" || (avif === undefined && webp === undefined));
  return { avif, webp, av1, h264, video, main: video ? av1 : (avif ?? webp) };
}

/** The bytes per view an animated image saves: its bytes per view less the main target's encode, floored at 0 (est.). */
export function animatedSavingOf(animated: AnimatedFix): number {
  const main = animatedTargetsOf(animated).main;
  return main === undefined ? 0 : Math.max(0, animated.perViewBytes - main.bytes);
}

/**
 * The fallback of an image-target hint, built only from the candidates that exist: the `<picture>` with an AVIF source (for
 * AVIF, with or without WebP), a plain `src` swap for WebP alone (WebP animates everywhere it shows an image), and for a CSS
 * background an `image-set()` with the existing types.
 */
function imageFallbackOf(context: AnimatedFix["context"], targets: AnimatedTargets, src: string | undefined): string {
  if (context === "css-background") {
    const types = [
      targets.avif !== undefined ? 'url(<avif>) type("image/avif")' : undefined,
      targets.webp !== undefined ? 'url(<webp>) type("image/webp")' : undefined,
    ].filter((t): t is string => t !== undefined);
    return `fallback: image-set(${types.join(", ")})`;
  }
  if (targets.avif !== undefined) {
    return `fallback: <picture><source type="image/avif" srcset="…"><img src=${JSON.stringify(src ?? "")}></picture>`;
  }
  return "plain src swap to the animated WebP (WebP animates in every browser that shows the image)";
}

/** Browser coverage of each option, as the hint states it (the caniuse data is not in the repo: these are the stated facts). */
const COVERAGE = {
  webp: "animated WebP: all current browsers",
  avif: "animated AVIF: Chrome 85+, Firefox 113+, Safari 16.4+",
  av1: "AV1 video: Chrome, Firefox, Edge; Safari only on devices with AV1 hardware decode, so keep the H.264 fallback",
} as const;

/**
 * The exact encoder settings of a candidate, as an agent runs them: the encoder, its preset and CRF (or q), and the pixel
 * format and container options that follow. An AV1 CRF is a CRF, never a q (see the quality label in animatedLines).
 */
export function encoderRecipe(codec: MediaCodec, c: CandidateResult): string {
  const av1 = c.av1Encoder === "libaom-av1" ? `libaom-av1 -cpu-used 8 -row-mt 1 -crf ${c.quality} -b:v 0` : `libsvtav1 -preset 10 -crf ${c.quality}`;
  switch (codec) {
    case "av1-mp4":
      return `${av1} -pix_fmt yuv420p -movflags +faststart`;
    case "animated-avif":
      return `${av1}, -f avif`;
    case "animated-webp":
      return `libwebp_anim -q:v ${c.quality} -loop 0`;
    case "h264-mp4":
      return `libx264 -preset veryfast -crf ${c.quality} -pix_fmt yuv420p -movflags +faststart -an`;
  }
}

/**
 * The line that says a target is capped at the file's own width: the device width needs more than the file has, so the
 * target is the file's width and a wider one would add bytes, not detail. Undefined when the target is not capped.
 */
export function sourceCapLine(need: number | undefined, sourceWidth: number | undefined, served: number): string | undefined {
  if (need === undefined || sourceWidth === undefined || !(need > sourceWidth) || served !== sourceWidth) return undefined;
  return `   source is ${sourceWidth}px wide; needed ${need}px: serve ${sourceWidth}px (upscaling adds bytes, not detail)`;
}

/**
 * The lines of an animated image's hint. An image target (AVIF and/or WebP, with a fallback built from the candidates that
 * exist) when the encode offers one; the `<video>` replacement with its AV1 source and the H.264 recipe when the target is
 * video. With no encode, the bytes per view and the reason. `src` is the served file's URL, printed as a JSON string; `alt`
 * is the image's alt text, which the `<video>` keeps as its accessible name.
 */
export function animatedLines(animated: AnimatedFix, src?: string, alt?: string): string[] {
  const { info, perViewBytes } = animated;
  const head = `animated ${FORMAT_LABEL[info.format]} ${(info.durationMs / 1000).toFixed(1)} s, ${info.frames} frames`;
  const targets = animatedTargetsOf(animated);
  const { avif, webp, av1, h264, main } = targets;
  if (main === undefined) {
    return [`   ${head}: ${kb(perViewBytes)}/view; not encoded: ${safeText(reasonText(animated.notEncoded ?? "no passing quality"))}`];
  }
  const saves = animatedSavingOf(animated);
  const offered = [
    avif !== undefined ? `animated AVIF CRF ${avif.quality}${qualityApprox(avif)} at ${avif.width}px (${encoderRecipe("animated-avif", avif)}): ${kb(avif.bytes)} ${estLabel(avif)}` : undefined,
    webp !== undefined ? `animated WebP q${webp.quality} at ${webp.width}px (${encoderRecipe("animated-webp", webp)}): ${kb(webp.bytes)} ${estLabel(webp)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const coverage: string[] = [];
  if (avif !== undefined) coverage.push(COVERAGE.avif);
  if (webp !== undefined) coverage.push(COVERAGE.webp);
  const cap = sourceCapLine(animated.need, animated.sourceWidth, main.width);
  if (targets.video && av1 !== undefined) {
    // An empty alt is a decorative image: the <video> is hidden from assistive technology, with no label. Otherwise the alt is
    // kept as the accessible name (role="img", aria-label).
    const decorative = alt !== undefined && alt.trim() === "";
    const altPart = decorative
      ? ' aria-hidden="true"'
      : alt !== undefined
        ? ` role="img" aria-label=${JSON.stringify(safeText(alt))}`
        : "";
    const lines = [`   ${head}: replace with <video autoplay muted loop playsinline poster="<first frame>"${altPart}>`];
    if (decorative) lines.push('     the image is decorative (alt=""): the <video> is aria-hidden, with no label');
    else if (alt !== undefined) lines.push("     the image's alt text is kept as the <video>'s aria-label (role=\"img\"): the accessible name does not change");
    lines.push(`     <source src="…-${av1.width}.av1.mp4" type="${AV1_TYPE}"> AV1 MP4 (${encoderRecipe("av1-mp4", av1)}), CRF ${av1.quality}${qualityApprox(av1)}, ${av1.width}px, ${kb(av1.bytes)} ${estLabel(av1)}`);
    lines.push(
      h264 !== undefined
        ? `     <source src="…-${h264.width}.h264.mp4" type="${H264_TYPE}"> H.264 MP4 (${encoderRecipe("h264-mp4", h264)}), ${h264.width}px, ${kb(h264.bytes)} ${estLabel(h264)}`
        : `     <source src="…-${av1.width}.h264.mp4" type="${H264_TYPE}"> H.264 fallback, not measured: ${H264_RECIPE} at ${av1.width}px wide`,
    );
    if (cap !== undefined) lines.push(cap);
    lines.push(`   evidence: ${evidenceOf(av1)}`);
    lines.push(`   browsers: ${COVERAGE.av1}`);
    if (offered.length > 0) lines.push(`   alternative: ${offered.join(", ")}`);
    if (offered.length > 0) lines.push(...coverage.map((line) => `   browsers: ${line}`));
    lines.push(`   saves ${kb(saves)}/view est. ${SAMPLE_NOTE}`);
    return lines;
  }
  const fallback = imageFallbackOf(animated.context, targets, src);
  const lines = [`   ${head}: serve ${offered.join(", ")}; ${fallback}; saves ${kb(saves)}/view est. ${SAMPLE_NOTE}`];
  if (cap !== undefined) lines.push(cap);
  lines.push(`   evidence: ${evidenceOf(main)}`);
  lines.push(...coverage.map((line) => `   browsers: ${line}`));
  return lines;
}

/** The name a video records by: where it is in the page, a file or component, else its selector. */
export function videoWhere(video: VideoRecord): string {
  if (video.locator.file !== undefined) return `${video.locator.file}:${video.locator.line ?? 0}`;
  return video.locator.component[0] ?? video.locator.selector;
}

/**
 * The bytes a view and a play save, est. The lever steps are per play (the full file less the encode); the view's share is
 * the same fraction of the bytes the page loads per view.
 */
export function videoSavingOf(video: VideoRecord): { view: number; play: number } {
  if (video.steps === undefined || video.estimate === undefined) return { view: 0, play: 0 };
  const { audio, resolution, codec, quality } = video.steps;
  const play = audio + resolution + codec + quality;
  const { perView, perPlay } = video.bytes;
  return { view: perPlay > 0 ? (play * perView) / perPlay : 0, play };
}

/**
 * One record per file of each page: a URL that two `<video>` elements of a page use is one file, fetched once per page view.
 * Of the records sharing a URL, the one with the most bytes per view stands for it (the page's own elements keep their rows).
 */
export function onePerFile(videos: VideoRecord[]): VideoRecord[] {
  const byFile = new Map<string, VideoRecord>();
  for (const video of videos) {
    const key = `${video.page}\n${video.src}`;
    const current = byFile.get(key);
    if (current === undefined || video.bytes.perView > current.bytes.perView) byFile.set(key, video);
  }
  return [...byFile.values()];
}

/**
 * The Video section's totals: bytes per view and per play over the files (each URL once per page, see onePerFile), and the
 * saveable bytes (an estimate, marked when any video has steps). Undefined with no video.
 */
export function videoTotalsLine(videos: VideoRecord[]): string | undefined {
  if (videos.length === 0) return undefined;
  const files = onePerFile(videos);
  const sum = (values: number[]): number => values.reduce((total, v) => total + v, 0);
  const savings = files.map(videoSavingOf);
  const est = files.some((v) => v.steps !== undefined && v.estimate !== undefined) ? " est." : "";
  const hidden = hiddenVideoTotalOf(videos);
  const loaded = hidden === undefined ? "" : `; loaded but not shown ${kb(hidden.bytes)}/view in ${hidden.count} video(s), not in the savings`;
  return `video: ${kb(sum(files.map((v) => v.bytes.perView)))}/view, ${kb(sum(files.map((v) => v.bytes.perPlay)))}/play, saveable ${kb(sum(savings.map((s) => s.view)))}/view (${kb(sum(savings.map((s) => s.play)))}/play)${est}${loaded}`;
}

/** The loaded-but-not-shown total of some videos: the records that have a hidden fix, their count and bytes per view. */
function hiddenVideoTotalOf(videos: VideoRecord[]): { count: number; bytes: number; cases: Record<HiddenAction, number> } | undefined {
  const hidden = videos.flatMap((v) => (v.hidden !== undefined ? [v.hidden] : []));
  if (hidden.length === 0) return undefined;
  const cases: Record<HiddenAction, number> = { responsive: 0, lazy: 0, "never-shown-on-load": 0 };
  for (const fix of hidden) cases[fix.action]++;
  return { count: hidden.length, bytes: hidden.reduce((sum, fix) => sum + fix.perViewBytes, 0), cases };
}

/**
 * The one-line summary of a page's loaded-but-not-shown videos, as the text, Markdown and check outputs print it. Undefined
 * when no video has a hidden fix.
 */
export function hiddenVideoSummaryLine(videos: VideoRecord[]): string | undefined {
  const total = hiddenVideoTotalOf(videos);
  if (total === undefined) return undefined;
  const { responsive, lazy, "never-shown-on-load": never } = total.cases;
  return `loaded but not shown: ${total.count} video(s), ${kb(total.bytes)}/view (responsive ${responsive}, lazy ${lazy}, never shown on load ${never}); not in the savings`;
}

/** The loaded-but-not-shown line of the PR comment for videos: all ok pages together. */
export function hiddenVideoPagesLine(results: PageResult[]): string | undefined {
  return hiddenVideoSummaryLine(results.filter((r) => r.status === "ok").flatMap((r) => r.videos ?? []));
}

/** A video's encode in one phrase: the encode at its width with its bytes, or why it was not encoded. */
export function videoStatusOf(video: VideoRecord): string {
  const e = video.estimate;
  if (e === undefined) return `not encoded: ${safeText(reasonText(video.notEncoded ?? "no passing quality"))}`;
  return `${codecName(e.codec)} CRF ${e.quality}${qualityApprox(e)}, ${e.width}px, ${kb(e.bytes)} ${estLabel(e)}`;
}

/** One video as a row of a page's Video section: its place (quoted by the caller), its bytes, and its encode or reason. */
export function videoRowOf(video: VideoRecord, quote: (text: string) => string): string {
  return `${quote(videoWhere(video))}: ${kb(video.bytes.perView)}/view, ${kb(video.bytes.perPlay)}/play; ${videoStatusOf(video)}`;
}

/** What the bytes per view are, as a hint says it: the autoplay full file, the bytes seen in the scan, or none. */
function viewBasisOf(video: VideoRecord): string {
  const b = video.bytes;
  if (b.perViewBasis === "full-file") return "autoplay: full file";
  if (b.perViewBasis === "none") return "not loaded before play";
  return b.browserDependent ? "preload=auto: browser-dependent, bytes seen in the scan" : "bytes seen in the scan";
}

/**
 * The bytes per view of a width plan (audit), est. (scaled): each viewport's bytes at its width are the encode's bytes times
 * (w / w_encoded)², the pixel ratio, and the per-view share of the file. They are summed over the viewports and divided by
 * their count, the same average the image savings use. Without an encode, "not encoded" and the reason.
 */
function bytesAtPlan(video: VideoRecord, plan: WidthPlan): string {
  const est = video.estimate;
  if (est === undefined || video.bytes.perPlay <= 0) {
    return `not encoded${video.notEncoded !== undefined ? `: ${safeText(reasonText(video.notEncoded))}` : ""}`;
  }
  if (plan.perViewport.length === 0) return "-";
  const ratio = video.bytes.perView / video.bytes.perPlay;
  const total = plan.perViewport.reduce((sum, v) => sum + est.bytes * (v.width / est.width) ** 2 * ratio, 0);
  return `${kb(total / plan.perViewport.length)}/view est. (scaled)`;
}

/** Audit: each viewport's need, and the bytes per view at one, two and three widths. No pick: the agent chooses. */
function widthOptionLines(options: WidthPlan[]): string[] {
  const lines: string[] = [];
  const first = options[0];
  if (first !== undefined && first.perViewport.length > 0) {
    lines.push(`   viewports: ${first.perViewport.map((v) => `${JSON.stringify(safeText(v.viewport))} needs ${v.need}px`).join(", ")}`);
  }
  lines.push("   widths → bytes/view (audit: no pick)");
  return lines;
}

/**
 * The line that says a video's served width is capped at its file's own: a viewport needs more than the file has, and the
 * plan serves the file's width. Undefined when no viewport is capped (or the file's width is not known).
 */
export function videoSourceCapLine(video: VideoRecord): string | undefined {
  const source = video.probe?.width;
  const plan = video.widths;
  if (plan === undefined || source === undefined || !(source > 0)) return undefined;
  // The plan's needs are already capped at the file's width, so the need is taken from the boxes: what the page shows.
  const need = Math.max(0, ...video.perViewport.filter((v) => v.boxWidth > 0).map((v) => Math.ceil(v.boxWidth * v.dpr)));
  if (!(need > source) || !plan.perViewport.some((row) => row.width === source)) return undefined;
  return sourceCapLine(need, source, source);
}

/** Scan: the `<source>` list of the planned widths, AV1 then H.264 for each, with the encode's CRF and bytes at its width. */
function targetLines(video: VideoRecord, plan: WidthPlan): string[] {
  if (plan.containerDriven) {
    return plan.perViewport.map((row) => {
      const box = video.perViewport.find((v) => v.viewport === row.viewport);
      const boxText = box !== undefined ? `box ${box.boxWidth} px at ${box.dpr}x` : "box not read";
      return `     viewport ${JSON.stringify(safeText(row.viewport))}: ${boxText}, serve ${row.width}px`;
    });
  }
  const est = video.estimate;
  const lines: string[] = [];
  for (const source of plan.sources) {
    const media = source.media !== undefined ? `media="${source.media}" ` : "";
    for (const kind of ["av1", "h264"] as const) {
      const codec = kind === "av1" ? "av1-mp4" : "h264-mp4";
      const label = kind === "av1" ? "AV1" : "H.264";
      // Every source names the exact encoder settings an agent runs: the estimate's codec, preset and CRF. At the estimate's
      // own width that is measured; at another width the same settings apply, which is not measured there.
      const same = est !== undefined && est.codec === codec ? est : undefined;
      let at: string;
      if (same !== undefined && same.width === source.width) {
        at = ` ${label} MP4 (${encoderRecipe(codec, same)}), CRF ${same.quality}${qualityApprox(same)}, ${same.width}px, ${kb(same.bytes)} ${estLabel(same)}`;
      } else if (same !== undefined) {
        at = ` ${label} MP4 (${encoderRecipe(codec, same)}), CRF ${same.quality}${qualityApprox(same)}, ${source.width}px: same settings, not measured at this width`;
      } else if (kind === "h264") {
        at = ` H.264 MP4 (${H264_RECIPE}), ${source.width}px: not measured (no H.264 encode for this video)`;
      } else {
        at = ` AV1 MP4 (libsvtav1 -preset 10 -pix_fmt yuv420p -movflags +faststart), CRF not measured: no AV1 encode passed for this video`;
      }
      lines.push(`     <source ${media}src="…-${source.width}.${kind}.mp4" type="${kind === "av1" ? AV1_TYPE : H264_TYPE}">${at}`);
    }
  }
  return lines;
}

/**
 * The lines of one video's hint: where and the bytes; the levers of the encode (audio, resolution, re-encode, one line each
 * with its bytes per play; never a quality line, as the encode's quality is the re-encode); the loading, codec and poster
 * levers; the target sources (or the widths table in audit); the evidence; and the saving. Without steps, the target and its
 * bytes only. Without an encode, the reason.
 */
export function videoLines(video: VideoRecord, rank = 1): string[] {
  const lines = [`${rank}. ${safeText(video.id)}  ${JSON.stringify(safeText(videoWhere(video)))}  ${safeText(video.page)}`];
  lines.push(`   bytes: ${kb(video.bytes.perView)}/view (${viewBasisOf(video)}), ${kb(video.bytes.perPlay)}/play`);
  if (video.hidden !== undefined) lines.push(...videoHiddenLines(video.hidden));
  // A video no viewport shows has no claim: no encode, source, width, loading or codec line, only its hidden fix.
  if (video.hidden !== undefined && video.hidden.shownIn.length === 0) {
    lines.push(`   not encoded: ${reasonText(NEVER_SHOWN)}`);
    return lines;
  }
  const est = video.estimate;
  if (est !== undefined && video.steps !== undefined) {
    const s = video.steps;
    lines.push(`   audio: drop the track (muted video): saves ${kb(s.audio)}/play est.`);
    lines.push(`   resolution: serve ${est.width}px: saves ${kb(s.resolution)}/play est.`);
    lines.push(`   re-encode (${codecName(est.codec)} CRF ${est.quality}): saves ${kb(s.codec)}/play est.`);
  }
  if (video.levers.loading !== undefined) {
    const loading = video.levers.loading;
    const attr = video.attributes.preload === "" ? "no preload attribute" : `preload=${JSON.stringify(safeText(video.attributes.preload))}`;
    const action = video.attributes.autoplay
      ? "autoplay fetches the file on load: lazy-load the video until it is in view"
      : loading.belowFold
        ? 'below the fold: set preload="none"'
        : 'set preload="metadata"';
    lines.push(`   loading: ${attr} loads ${kb(loading.perViewBytes)}/view before play: ${action}`);
  }
  if (video.levers.codec !== undefined) lines.push("   codec: no AV1 source: serve AV1 first, H.264 fallback");
  if (video.levers.posterMissing === true) lines.push('   poster: none: add poster="<first frame>" (audited as an image)');
  for (const note of video.levers.info) lines.push(`   info: ${safeText(note)}`);
  if (video.widthOptions !== undefined) {
    lines.push(...widthOptionLines(video.widthOptions));
    for (const plan of video.widthOptions) {
      lines.push(`     ${plan.widths.length} width(s): ${plan.widths.map((w) => `${w}px`).join(", ")} → ${bytesAtPlan(video, plan)}`);
    }
  } else if (video.widths !== undefined) {
    lines.push(...targetLines(video, video.widths));
    const cap = videoSourceCapLine(video);
    if (cap !== undefined) lines.push(cap);
  }
  if (est !== undefined) lines.push(`   evidence: ${evidenceOf(est)}`);
  else if (video.notEncoded !== undefined) lines.push(`   not encoded: ${safeText(reasonText(video.notEncoded))}`);
  if (est !== undefined && video.steps !== undefined) {
    const s = videoSavingOf(video);
    lines.push(`   saves ${kb(s.view)}/view est., ${kb(s.play)}/play est. ${SAMPLE_NOTE}`);
  } else if (est !== undefined) {
    lines.push(`   ${SAMPLE_NOTE}`);
  }
  return lines;
}

/** The hints command's Video part: each video's hint, numbered. Empty with no video. */
export function renderVideoHints(videos: VideoRecord[]): string {
  if (videos.length === 0) return "";
  const body = videos.flatMap((video, i) => videoLines(video, i + 1));
  return `${videos.length} video(s) on the page(s), self-hosted files:\n${body.join("\n")}\n`;
}

/**
 * The line that says where the sources of a file came from: the dev page it was located on, or, when hinted images still
 * have no file:line, the command that locates them. Undefined when every hint has its source.
 */
export function locateNoteOf(result: PageResult, hints: Hint[]): string | undefined {
  const l = cleanLocate(result.locate);
  if (l !== undefined) {
    return `located on the dev page at ${safeText(l.viewport)}: ${l.joined} of ${l.flagged} flagged image(s) have a file:line (the others: see scan --locate-only)`;
  }
  const without = hints.filter((h) => h.file === undefined).length;
  if (without === 0) return undefined;
  return `${without} of ${hints.length} image(s) have no file:line: locate them on the dev server (scan <dev-url> --locate-only --from <this file>)`;
}

/** The site's images.qualities plan as JSON (null when there is none). The savings are per view, in bytes, and approximate. */
function planJson(plan: QualityCapPlan | undefined): object | null {
  if (plan === undefined) return null;
  return {
    values: plan.values,
    maxValues: plan.maxValues,
    images: plan.images,
    approx: true,
    estKeptBytes: Math.round(plan.kept),
    estTotalBytes: Math.round(plan.total),
  };
}

/** The videos of the selected pages, for the hints command (none when a --component filter is given: videos have no sizes). */
function videosOf(results: PageResult[], args: HintsArgs): VideoRecord[] {
  if (args.component !== undefined) return [];
  const page = args.page?.toLowerCase();
  return results.flatMap((r) => r.videos ?? []).filter((v) => page === undefined || v.page.toLowerCase().includes(page));
}

/** The resource findings of the selected pages, one row per finding with its page (the JSON's `resources`). */
function resourceRowsOf(results: PageResult[]): { page: string; kind: string; url: string; bytes: number; savedBytes: number; estimate: boolean; title: string; fix: string[] }[] {
  return results.flatMap((r) => (r.resources ?? []).map((f) => ({ page: r.url, kind: f.kind, url: f.url, bytes: f.bytes, savedBytes: f.savedBytes, estimate: f.estimate, title: f.title, fix: f.fix })));
}

/** The text block of the resource findings, one heading per page that has any (none when no page has any). */
function renderResourceHints(results: PageResult[]): string {
  const pages = results.filter((r) => (r.resources ?? []).length > 0);
  if (pages.length === 0) return "";
  const body = pages.flatMap((r) => [`${pathOf(r.url)} (resources)`, ...resourceLinesOf(r.resources ?? [], (text) => safeText(text))]);
  return `${body.join("\n")}\n`;
}

/** `imgtune hints <scan.json> [<scan.json> ...] ...`: reads the pages' scan files, returns the text or JSON to print. */
export async function hintsCommand(argv: string[], cwd: string): Promise<{ output: string; exitCode: number }> {
  const args = parseHintsArgs(argv);
  const results: PageResult[] = [];
  for (const file of args.files) {
    let result: PageResult;
    try {
      result = JSON.parse(await readFile(resolve(cwd, file), "utf8")) as PageResult;
    } catch (err) {
      throw new Error(`cannot read ${safeText(file)} as a scan file: ${(err as Error).message}`);
    }
    if (!Array.isArray(result.images)) {
      throw new Error(`${safeText(file)} has no image records: scan it with this version of imgtune`);
    }
    // The file's locate block is checked before anything prints it (a block that is not usable is dropped).
    results.push({ ...result, locate: cleanLocate(result.locate) });
  }
  // The site's images.qualities cap: over all the files given, and not when the framework's own --qualities list is given.
  const plan = args.qualities === undefined ? planQualityCap(results, args.maxQualities) : undefined;
  const perPage = results.map((result) => ({ result, hints: hintsOf(result, args.qualities, plan) }));
  const all = perPage.flatMap((p) => p.hints);
  const notes = perPage.map((p) => locateNoteOf(p.result, p.hints)).filter((n): n is string => n !== undefined);
  if (plan !== undefined) notes.push(qualitiesLine(plan));
  // Sizes proposals the scan dropped because their predicted outcome adds bytes (or saves none): not hints, but counted.
  const dropped = results.reduce((sum, r) => sum + (r.images ?? []).filter((i) => i.fix?.noSaving !== undefined).length, 0);
  if (dropped > 0) notes.push(`${dropped} sizes proposal(s) left out: no saving (their predicted outcome adds bytes or changes nothing)`);
  const filtered = selectHints(all, { ...args, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
  const videos = videosOf(results, args);
  const resourceRows = resourceRowsOf(results);
  if (args.top !== undefined) {
    const top = groupHints(filtered).slice(0, args.top);
    if (args.format === "json") {
      return { output: `${JSON.stringify({ top: top.map((g, i) => ({ rank: i + 1, key: g.key, saved: g.saved, images: g.hints.length, pages: g.pages.map((p) => pathOf(p)), file: g.hints[0].file ?? null, line: g.hints[0].line ?? null, component: g.hints[0].component, sizes: combinedSizes(g), srcset: groupSrcsetOf(g) ?? null })), qualities: planJson(plan) }, null, 2)}\n`, exitCode: 0 };
    }
    return { output: `${notes.length > 0 ? `${notes.join("\n")}\n` : ""}${renderTop(top)}${renderVideoHints(videos)}${renderResourceHints(results)}`, exitCode: 0 };
  }
  // JSON is not cut to the text default: it is all of it unless --limit is passed, and `truncated` says whether it is.
  const jsonLimit = args.limitGiven ? args.limit : Number.MAX_SAFE_INTEGER;
  if (!args.flat) {
    // Grouped (the default): --limit and --offset count call sites, so a batch is whole call sites.
    const groups = groupHints(filtered);
    const selectedGroups = groups.slice(args.offset, args.offset + (args.format === "json" ? jsonLimit : args.limit));
    if (args.format === "json") {
      const body = {
        page: results.length === 1 ? results[0].url : undefined,
        pages: results.map((r) => r.url),
        located: results.length === 1 ? results[0].locate ?? null : undefined,
        groups: groups.length,
        images: filtered.length,
        offset: args.offset,
        limit: args.limitGiven ? args.limit : null,
        truncated: args.offset + selectedGroups.length < groups.length,
        qualities: planJson(plan),
        callSites: selectedGroups.map((group) => ({
          key: group.key,
          file: group.hints[0].file,
          line: group.hints[0].line,
          component: group.hints[0].component,
          count: group.hints.length,
          pages: group.pages.map((p) => pathOf(p)),
          saved: group.saved,
          sizes: combinedSizes(group),
          sizesFitted: groupSizesOf(group) ?? null,
          srcset: groupSrcsetOf(group) ?? null,
          callers: callerMapOf(group) ?? null,
          ids: group.hints.map((h) => h.id),
          hints: group.hints,
        })),
        ...(videos.length > 0 ? { videos } : {}),
        ...(resourceRows.length > 0 ? { resources: resourceRows } : {}),
      };
      return { output: `${JSON.stringify(body, null, 2)}\n`, exitCode: 0 };
    }
    const text = `${renderGroups(selectedGroups, groups.length, filtered.length, args.offset, args.page)}${renderVideoHints(videos)}${renderResourceHints(results)}`;
    return { output: notes.length > 0 ? `${notes.join("\n")}\n${text}` : text, exitCode: 0 };
  }
  const selected = selectHints(all, args.format === "json" ? { ...args, limit: jsonLimit } : args);
  if (args.format === "json") {
    const body = {
      page: results.length === 1 ? results[0].url : undefined,
      pages: results.map((r) => r.url),
      located: results.length === 1 ? results[0].locate ?? null : undefined,
      total: filtered.length,
      offset: args.offset,
      limit: args.limitGiven ? args.limit : null,
      truncated: args.offset + selected.length < filtered.length,
      qualities: planJson(plan),
      hints: selected,
      ...(videos.length > 0 ? { videos } : {}),
      ...(resourceRows.length > 0 ? { resources: resourceRows } : {}),
    };
    return { output: `${JSON.stringify(body, null, 2)}\n`, exitCode: 0 };
  }
  const text = `${renderHints(selected, filtered.length, args.offset, args.page)}${renderVideoHints(videos)}${renderResourceHints(results)}`;
  return { output: notes.length > 0 ? `${notes.join("\n")}\n${text}` : text, exitCode: 0 };
}

/** How many hints the PR comment lists. */
export const COMMENT_HINTS = 10;
/** Longest value shown in the comment, before JSON quoting and escaping. */
const COMMENT_FIELD = 80;
/** Longest text one field may take after quoting (a capped value, JSON-quoted, is far shorter). */
const COMMENT_QUOTED_LIMIT = 1000;

/** The hints of a PR comment: the top `limit` across the pages, one line each, and the number of hints in all. */
export function commentHints(results: PageResult[], limit = COMMENT_HINTS, maxQualities?: number): { total: number; lines: string[] } {
  const ok = results.filter((r) => r.status === "ok");
  const plan = planQualityCap(ok, maxQualities);
  const all = ok.flatMap((r) => hintsOf(r, undefined, plan));
  const top = selectHints(all, { limit, offset: 0 });
  return { total: all.length, lines: top.map((hint, i) => `${i + 1}. ${commentLine(hint)}`) };
}

/** The loaded-but-not-shown line of the PR comment: all ok pages together (the same numbers as the text output). */
export function hiddenPagesLine(results: PageResult[]): string | undefined {
  const pages = results.filter((r) => r.status === "ok" && r.hidden !== undefined);
  if (pages.length === 0) return undefined;
  const totals: HiddenPage = { images: 0, bytesPerView: 0, cases: { responsive: 0, lazy: 0, "never-shown-on-load": 0 } };
  for (const page of pages) {
    const hidden = page.hidden as HiddenPage;
    totals.images += hidden.images;
    totals.bytesPerView += hidden.bytesPerView;
    for (const key of Object.keys(totals.cases) as (keyof HiddenPage["cases"])[]) totals.cases[key] += hidden.cases[key];
  }
  return hiddenSummaryLine(totals);
}

/**
 * A page-derived value in the comment: capped at COMMENT_FIELD characters, then JSON-quoted the way the CLI text prints it
 * (so an instruction inside a name stays a quoted string). The block is fenced, and GitHub does not decode entities inside
 * a fence, so there is no entity escaping here. Instead every backtick becomes an apostrophe: no value can close the fence.
 */
function quoted(value: string): string {
  const capped = value.length > COMMENT_FIELD ? `${value.slice(0, COMMENT_FIELD - 3)}...` : value;
  return safeText(JSON.stringify(capped), COMMENT_QUOTED_LIMIT).replace(/`/g, "'");
}

/** One hint as a line of the comment's fenced block. Every page-derived value goes through `quoted`. */
function commentLine(hint: Hint): string {
  const location =
    hint.file !== undefined
      ? `${quoted(`${hint.file}:${hint.line ?? 0}`)}${locationNote(hint)}`
      : quoted(hint.component[0] ?? hint.selector);
  const component = hint.file !== undefined && hint.component[0] !== undefined ? ` (${quoted(hint.component[0])})` : "";
  const sizes =
    hint.srcset !== undefined
      ? `serve variants at ${srcsetWidthLabel(hint.srcset.widths)}`
      : hint.width !== undefined
        ? `width ${hint.width}px`
        : `sizes ${quoted(hint.sizes.current ?? "none")} -> ${quoted(hint.sizes.proposed ?? "-")}`;
  const parts: (string | undefined)[] = [
    hint.lcp === true ? `LCP image (${(hint.lcpViewports ?? []).map((v) => quoted(v)).join(", ")})` : undefined,
    `${savesText(hint)}, +${kb(hint.bytes.addedForSharpness)} sharpness`,
    `${location}${component}`,
    hint.alt !== undefined ? `alt ${quoted(hint.alt)}` : undefined,
    `page ${quoted(pathOf(hint.page))}`,
    sizes,
    hint.quality ? `quality ${hint.quality.current}${hint.quality.target !== undefined ? ` -> ${hint.quality.target}` : ""}` : undefined,
    hint.qualityNote !== undefined ? quoted(hint.qualityNote) : undefined,
    hint.sizesAuto !== undefined ? `sizes auto alternative ${quoted(hint.sizesAuto)}` : undefined,
    hint.format ? `format ${quoted(hint.format.current ?? "?")}${hint.format.best && hint.format.best !== hint.format.current ? ` -> ${quoted(hint.format.best)}` : ""}` : undefined,
    `rung ${hint.rung}`,
    `id ${quoted(hint.id)}`,
  ];
  return parts.filter((part): part is string => part !== undefined).join("; ");
}

/** The host and path of a page URL (no query): what a comment shows of a page. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}
