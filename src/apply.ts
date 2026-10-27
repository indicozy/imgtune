import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import ts from "typescript";
import type { ComponentResult } from "./analyse.js";
import { sha1, writeFileAtomic } from "./atomic.js";
import { withQuality } from "./calibrate.js";
import { readImageConfig } from "./nextconfig.js";
import { scanText, scriptKind } from "./scan.js";
import { saveState, type StateEntry } from "./state.js";
import type { ImageUsage } from "./types.js";

export interface ApplyResult {
  /** Project-relative paths of the files written, next.config included. */
  edited: string[];
  skipped: { usageId: string; reason: string }[];
}

const NEXT_DEFAULT_QUALITY = 75;
const REASON_CHANGED = "file changed since audit";
const REASON_EDITED_SINCE_AUDIT = "file changed since audit; re-run imgtune audit";
const REASON_IMG = "plain <img> is report-only";
const REASON_SIZES_MANUAL = "manual change needed: sizes is an expression";
const REASON_QUALITY_MANUAL = "manual change needed: quality is an expression";
const reasonQualityNotListed = (q: number) => `manual change needed: add ${q} to images.qualities in next.config`;

/** A text range to replace (start === end for an insertion). */
interface Splice {
  start: number;
  end: number;
  text: string;
}

interface Edit {
  field: "sizes" | "quality";
  value: string | number;
  splice: Splice;
}

interface PlannedUsage {
  result: ComponentResult;
  usage: ImageUsage;
  edits: Edit[];
}

/** Escapes a value for a double-quoted JSX string attribute. */
const attrString = (value: string): string => value.replace(/"/g, "&quot;");

/** Source edits for one usage against its fresh scan. Skips are pushed to `skipped`. */
function planUsage(result: ComponentResult, usage: ImageUsage, skipped: ApplyResult["skipped"]): Edit[] {
  const edits: Edit[] = [];
  const skip = (reason: string) => skipped.push({ usageId: usage.id, reason });
  if (usage.tag === "img") {
    skip(REASON_IMG);
    return edits;
  }

  const sizes = result.proposed.sizes;
  if (sizes !== undefined) {
    const prop = usage.props.sizes;
    const text = `sizes="${attrString(sizes)}"`;
    if (prop.kind === "expression" || (usage.hasSpread && prop.kind === "absent")) {
      skip(REASON_SIZES_MANUAL);
    } else if (prop.kind === "literal") {
      if (prop.value !== sizes) edits.push({ field: "sizes", value: sizes, splice: { start: prop.start, end: prop.end, text } });
    } else {
      edits.push({ field: "sizes", value: sizes, splice: { start: usage.tagNameEnd, end: usage.tagNameEnd, text: ` ${text}` } });
    }
  }

  const quality = result.proposed.quality;
  if (quality !== undefined) {
    const prop = usage.props.quality;
    if (prop.kind === "expression" || (usage.hasSpread && prop.kind === "absent")) {
      skip(REASON_QUALITY_MANUAL);
    } else if (prop.kind === "literal") {
      if (prop.value !== quality) {
        edits.push({ field: "quality", value: quality, splice: { start: prop.start, end: prop.end, text: `quality={${quality}}` } });
      }
    } else if (quality !== result.current.quality) {
      edits.push({ field: "quality", value: quality, splice: { start: usage.tagNameEnd, end: usage.tagNameEnd, text: ` quality={${quality}}` } });
    }
  }
  return edits;
}

/** The first `images` property whose value is an object literal, in source order. */
function imagesObject(text: string, file: string): ts.ObjectLiteralExpression | undefined {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "images") {
      if (ts.isObjectLiteralExpression(node.initializer)) found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Inserts a `qualities: [...]` property as the first member of the images object, matching the next member's indent. */
function insertQualities(text: string, file: string, values: number[]): string | undefined {
  const images = imagesObject(text, file);
  if (!images) return undefined;
  const sf = images.getSourceFile();
  const hasQualities = images.properties.some((p) => {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return false;
    return ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text === "qualities" : false;
  });
  if (hasQualities) return undefined;

  const open = images.getStart(sf);
  const array = `qualities: [${values.join(", ")}],`;
  const first = images.properties[0];
  if (!first) return text.slice(0, open + 1) + ` ${array.slice(0, -1)} ` + text.slice(open + 1);
  const firstStart = first.getStart(sf);
  const lineStart = text.lastIndexOf("\n", firstStart) + 1;
  const indent = text.slice(lineStart, firstStart);
  const ownLine = text.slice(open, firstStart).includes("\n") && /^\s*$/.test(indent);
  const insert = ownLine ? `\n${indent}${array}` : ` ${array}`;
  return text.slice(0, open + 1) + insert + text.slice(open + 1);
}

/**
 * Adds the wanted qualities to `images.qualities` of the next.config text. Returns the new text and the qualities that
 * could not be added (with the file left as it is for them).
 */
function planConfigQualities(
  text: string,
  file: string,
  wanted: number[],
): { text: string; failed: Set<number> } {
  const failed = new Set<number>();
  let next = text;
  for (const q of wanted) {
    const updated = withQuality(next, q);
    if (updated === undefined) failed.add(q);
    else next = updated;
  }
  if (failed.size === 0 || failed.size < wanted.length) {
    // Either every quality went in, or some did and the rest hit a literal we cannot edit (never insert a second key).
    return { text: next, failed };
  }
  const values = [NEXT_DEFAULT_QUALITY, ...wanted.filter((q) => q !== NEXT_DEFAULT_QUALITY)];
  const inserted = insertQualities(text, file, values);
  if (inserted === undefined) return { text, failed };
  return { text: inserted, failed: new Set() };
}

/** Applies the splices from the end of the text backwards. Equal offsets keep their list order. */
function spliceText(text: string, splices: Splice[]): string {
  const ordered = splices
    .map((splice, index) => ({ splice, index }))
    .sort((a, b) => b.splice.start - a.splice.start || a.index - b.index);
  let out = text;
  for (const { splice } of ordered) {
    out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
  }
  return out;
}

/** Options for `applyResults`. */
export interface ApplyOptions {
  /** relFile -> sha1 from the audit report. A file whose current content hashes differently is not edited. */
  expectedHashes?: Record<string, string>;
}

/**
 * Edits the source files of the audited usages in place. Every file is read once and scanned from that exact text, and
 * the same text is spliced. Only the `sizes` and `quality` attribute text and `images.qualities` change. next.config is
 * written before the sources; state is saved for every file written, even when a later write throws.
 */
export async function applyResults(
  projectDir: string,
  results: ComponentResult[],
  usages: ImageUsage[],
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const skipped: ApplyResult["skipped"] = [];
  const edited: string[] = [];
  const expected = opts.expectedHashes;
  const byId = new Map(usages.map((u) => [u.id, u]));

  // Group the results that have a proposal by the file of their audited usage.
  const byFile = new Map<string, ComponentResult[]>();
  for (const result of results) {
    if (result.proposed.sizes === undefined && result.proposed.quality === undefined) continue;
    const audited = byId.get(result.usageId);
    if (!audited) {
      skipped.push({ usageId: result.usageId, reason: REASON_CHANGED });
      continue;
    }
    const list = byFile.get(audited.file);
    if (list) list.push(result);
    else byFile.set(audited.file, [result]);
  }

  // Plan every file from the one text that is read. Nothing is written until the next.config decision is made.
  const planned = new Map<string, { relFile: string; text: string; usages: PlannedUsage[] }>();
  for (const [file, fileResults] of byFile) {
    const relFile = toPosix(relative(projectDir, file));
    const text = await readFile(file, "utf8");
    if (expected && expected[relFile] !== sha1(text)) {
      for (const result of fileResults) skipped.push({ usageId: result.usageId, reason: REASON_EDITED_SINCE_AUDIT });
      continue;
    }
    const fresh = scanText(text, file, projectDir);
    const usagesInFile: PlannedUsage[] = [];
    for (const result of fileResults) {
      const usage = fresh.find((u) => u.id === result.usageId);
      if (!usage) {
        skipped.push({ usageId: result.usageId, reason: REASON_CHANGED });
        continue;
      }
      usagesInFile.push({ result, usage, edits: planUsage(result, usage, skipped) });
    }
    planned.set(file, { relFile, text, usages: usagesInFile });
  }

  // images.qualities: every quality about to be applied must be listed in next.config.
  const allPlanned = [...planned.values()].flatMap((p) => p.usages);
  const wanted = [
    ...new Set(allPlanned.flatMap((p) => p.edits).filter((e) => e.field === "quality").map((e) => e.value as number)),
  ].sort((a, b) => a - b);
  let configEdit: { relFile: string; file: string; text: string } | undefined;
  let configBlocked = false;
  let failed = new Set<number>();
  if (wanted.length > 0) {
    const imageConfig = readImageConfig(projectDir);
    if (!imageConfig.file) {
      failed = new Set(wanted);
    } else {
      const configRel = toPosix(relative(projectDir, imageConfig.file));
      const original = await readFile(imageConfig.file, "utf8");
      if (expected && expected[configRel] !== sha1(original)) {
        configBlocked = true;
        failed = new Set(wanted);
      } else {
        const outcome = planConfigQualities(original, imageConfig.file, wanted);
        failed = outcome.failed;
        if (outcome.text !== original) configEdit = { relFile: configRel, file: imageConfig.file, text: outcome.text };
      }
    }
  }
  const reasonFor = (q: number): string => (configBlocked ? REASON_EDITED_SINCE_AUDIT : reasonQualityNotListed(q));

  const entries: StateEntry[] = [];
  const now = new Date().toISOString();
  try {
    if (configEdit) {
      await writeFileAtomic(configEdit.file, configEdit.text, { root: projectDir, followSymlink: true });
      edited.push(configEdit.relFile);
    }

    for (const [file, { relFile, text, usages: usagesInFile }] of planned) {
      const splices: Splice[] = [];
      const applied: PlannedUsage[] = [];
      for (const planUse of usagesInFile) {
        const kept: Edit[] = [];
        for (const edit of planUse.edits) {
          if (edit.field === "quality" && failed.has(edit.value as number)) {
            skipped.push({ usageId: planUse.usage.id, reason: reasonFor(edit.value as number) });
          } else {
            kept.push(edit);
          }
        }
        planUse.edits = kept;
        if (kept.length > 0) applied.push(planUse);
        for (const edit of kept) splices.push(edit.splice);
      }
      if (splices.length === 0) continue;

      const next = spliceText(text, splices);
      if (next === text) continue;
      await writeFileAtomic(file, next, { root: projectDir, followSymlink: true });
      edited.push(relFile);
      const fileHash = sha1(next);
      for (const planUse of applied) {
        const sizes = planUse.edits.find((e) => e.field === "sizes");
        const quality = planUse.edits.find((e) => e.field === "quality");
        entries.push({
          usageId: planUse.usage.id,
          relFile,
          component: planUse.usage.component,
          fileHash,
          applied: {
            ...(sizes ? { sizes: sizes.value as string } : {}),
            ...(quality ? { quality: quality.value as number } : {}),
          },
          before: { sizes: planUse.result.current.sizes, quality: planUse.result.current.quality },
          at: now,
        });
      }
    }
  } finally {
    if (entries.length > 0) await saveState(projectDir, entries);
  }
  return { edited, skipped };
}

const toPosix = (path: string): string => path.split(sep).join("/");
