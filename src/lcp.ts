// The LCP line of a scanned page: which image the largest contentful paint is at each viewport, what it serves, and what a
// fix saves on it. The LCP is read before the page is scrolled (remote.ts), so lazy images that load on scroll cannot take
// it. Pure: it reads the scan's records and per-viewport figures.

import type { ImageRecord } from "./images.js";
import { safeText } from "./text.js";
import type { PageResult } from "./remote.js";

/** An image that is the LCP at one or more viewports, with its served and fixable bytes per view. */
export interface LcpImage {
  id: string;
  viewports: string[];
  /** Where the image is: file:line when located, else its component, else its DOM path. Page text: printed through safeText. */
  where: string;
  servedBytes: number;
  savedBytes: number;
  exactBytes: number;
  estBytes: number;
  /** Why the element is not measured at its viewports (a vector, a data URI, ...): its bytes are not counted. */
  skipped?: string;
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/** Where a record's element is, as a short name. */
export function whereOf(record: ImageRecord): string {
  const { file, line, component, selector } = record.locator;
  if (file !== undefined) return `${file}:${line ?? 0}`;
  return component[0] ?? selector;
}

/** The viewports at which a record is the LCP, in the scan's viewport order. */
export function lcpViewportsOf(record: ImageRecord): string[] {
  return record.perViewport.filter((p) => p.lcp === true).map((p) => p.viewport);
}

/** The LCP images of a page: one entry per record that is the LCP at some viewport. */
export function lcpImagesOf(result: PageResult): LcpImage[] {
  const out: LcpImage[] = [];
  for (const record of result.images ?? []) {
    if (record.kind === "css-background") continue;
    const viewports = lcpViewportsOf(record);
    if (viewports.length === 0) continue;
    const served = record.perViewport.filter((p) => p.lcp === true);
    const skipped = served.find((p) => p.skipped !== undefined)?.skipped;
    out.push({
      id: record.id,
      viewports,
      where: whereOf(record),
      servedBytes: served.reduce((sum, p) => sum + p.servedBytes, 0) / served.length,
      savedBytes: record.fix.bytes.saved,
      exactBytes: record.fix.bytes.sizes ?? 0,
      estBytes: record.fix.bytes.quality ?? 0,
      ...(skipped !== undefined ? { skipped } : {}),
    });
  }
  return out;
}

/** The viewports at which the LCP element of the page is not an image (a text block, a background, an SVG). */
export function lcpNotImageViewports(result: PageResult): string[] {
  return Object.entries(result.perViewport)
    .filter(([, report]) => report.lcp === "other")
    .map(([viewport]) => viewport);
}

/**
 * The LCP lines of a page: one per image that is the LCP (the viewports it is at, where it is, what it serves and what a fix
 * saves), then `LCP is not an image` for the viewports where it is not. The page's own names go through `quote` (safeText
 * for the terminal, mdCode for Markdown). Empty when the LCP was not read (an old scan, or a shared load's resized viewports).
 */
export function lcpLinesOf(result: PageResult, quote: (text: string) => string = safeText): string[] {
  const lines: string[] = [];
  for (const image of lcpImagesOf(result)) {
    const viewports = image.viewports.map((v) => quote(v)).join(", ");
    if (image.skipped !== undefined) {
      lines.push(`LCP image (${viewports}): ${quote(image.where)}, not measured (${quote(image.skipped)})`);
      continue;
    }
    lines.push(
      `LCP image (${viewports}): ${quote(image.where)}, ${kb(image.servedBytes)} served, ${kb(image.savedBytes)} fixable (exact ${kb(image.exactBytes)}, est. ${kb(image.estBytes)})`,
    );
  }
  const notImage = lcpNotImageViewports(result);
  if (notImage.length > 0) lines.push(`LCP is not an image (${notImage.map((v) => quote(v)).join(", ")})`);
  return lines;
}
