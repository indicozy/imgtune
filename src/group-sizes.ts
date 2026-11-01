// The `sizes` value of a call site that several images (or several pages) share. From the measured rendered widths
// (per viewport width) it builds a media-query value: a linear `vw + px` per band of viewports where the measurements
// allow one, a ceiling constant elsewhere, at most MAX_CLAUSES clauses. Every value is checked at every measured point
// (the browser's own evaluation, sizesSlotAt): it is never below a measured width, or the fit is replaced by the constant
// that is. Pure: no DOM, no network.

import { breakpointBetween } from "./layout.js";
import { sizesSlotAt } from "./sizes.js";

/** One measurement: the viewport's width in CSS px and the rendered width of the element there. */
export interface SizePoint {
  width: number;
  rendered: number;
}

/** A sizes value of at most this many clauses (the browser's and the reader's limit we hold ourselves to). */
export const MAX_CLAUSES = 4;

/** A fitted line may sit above a measured width by this much (the larger of the two) before it is not used. */
const OVERSHOOT_RATIO = 0.02;
const OVERSHOOT_PX = 4;

/** The largest rendered width at each viewport width, ascending by width. */
export function maxPerWidth(points: SizePoint[]): SizePoint[] {
  const byWidth = new Map<number, number>();
  for (const p of points) {
    if (!(p.rendered > 0) || !(p.width > 0)) continue;
    byWidth.set(p.width, Math.max(byWidth.get(p.width) ?? 0, p.rendered));
  }
  return [...byWidth.entries()].sort((a, b) => a[0] - b[0]).map(([width, rendered]) => ({ width, rendered }));
}

/** The CSS value of a line: `calc(Avw +/- Bpx)`, with A in vw percent (one decimal) and B in whole px. */
export function lineValue(percent: number, px: number): string {
  if (px === 0) return `${percent}vw`;
  return `calc(${percent}vw ${px < 0 ? "-" : "+"} ${Math.abs(px)}px)`;
}

/**
 * The line through a band's points, rounded the way it is printed: slope in vw percent to one decimal, offset in whole px
 * rounded up so no point falls below its width. Undefined when the slope is not positive or the line sits too far above
 * a measured width (more than the larger of 2% or 4 px) at any of them.
 */
export function bandLine(points: SizePoint[]): { percent: number; px: number; value: string } | undefined {
  const n = points.length;
  if (n < 2) return undefined;
  const sx = points.reduce((s, p) => s + p.width, 0);
  const sy = points.reduce((s, p) => s + p.rendered, 0);
  const sxx = points.reduce((s, p) => s + p.width * p.width, 0);
  const sxy = points.reduce((s, p) => s + p.width * p.rendered, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return undefined;
  const slope = (n * sxy - sx * sy) / denom;
  const percent = Math.round(slope * 1000) / 10;
  if (!(percent > 0)) return undefined;
  const px = Math.ceil(Math.max(...points.map((p) => p.rendered - (percent / 100) * p.width)) - 1e-9);
  for (const p of points) {
    const value = (percent / 100) * p.width + px;
    if (value < p.rendered - 1e-9) return undefined;
    if (value - p.rendered > Math.max(OVERSHOOT_RATIO * p.rendered, OVERSHOOT_PX)) return undefined;
  }
  return { percent, px, value: lineValue(percent, px) };
}

/** The ceiling constant of points: the largest rendered width, rounded up to whole px. */
function constantOf(points: SizePoint[]): string {
  return `${Math.ceil(Math.max(...points.map((p) => p.rendered)))}px`;
}

interface Band {
  points: SizePoint[];
  value: string;
  /** True when the value is a fitted line (not a constant). */
  fitted: boolean;
}

/** Splits the ascending points into bands: a band grows while a verified line fits all of its points. */
function bandsOf(points: SizePoint[]): Band[] {
  const groups: SizePoint[][] = [];
  let current: SizePoint[] = [points[0]];
  for (const p of points.slice(1)) {
    if (bandLine([...current, p]) !== undefined) current.push(p);
    else {
      groups.push(current);
      current = [p];
    }
  }
  groups.push(current);
  return groups.map((group) => {
    const line = group.length >= 2 ? bandLine(group) : undefined;
    return line ? { points: group, value: line.value, fitted: true } : { points: group, value: constantOf(group), fitted: false };
  });
}

/** The result of fitting one call site: its value, how many clauses, and how many bands are fitted lines. */
export interface FittedSizes {
  value: string;
  clauses: number;
  fitted: number;
  /** Set when the fit was replaced by the single constant (a check failed, which the construction should not allow). */
  constant: boolean;
}

/** Whether the value is at least each measured width at its own viewport (0.5 px for rounding). */
export function sizesHolds(value: string, points: SizePoint[]): boolean {
  return points.every((p) => {
    const slot = sizesSlotAt(value, p.width);
    return slot !== undefined && slot >= p.rendered - 0.5;
  });
}

/**
 * The sizes value fitted to the measured points (any order; several points at one width count once, at their largest).
 * Undefined when there is no point. Bands of viewports take a line where the points allow one, else a constant; the
 * bands are joined with media conditions at the known breakpoints between them (breakpointBetween). Checked at every point.
 */
export function fitSizes(input: SizePoint[]): FittedSizes | undefined {
  const points = maxPerWidth(input);
  if (points.length === 0) return undefined;
  let bands = bandsOf(points);
  // Adjacent bands with the same value are one band.
  const merged: Band[] = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    if (last && last.value === band.value) last.points = [...last.points, ...band.points];
    else merged.push({ ...band, points: [...band.points] });
  }
  bands = merged;
  // More clauses than allowed: the widest bands join into one constant (it covers their maximum).
  while (bands.length > MAX_CLAUSES) {
    const tail = bands.splice(bands.length - 2, 2);
    const joined = tail.flatMap((b) => b.points);
    bands.push({ points: joined, value: constantOf(joined), fitted: false });
  }
  const clauses = bands.map((band, i) =>
    i + 1 < bands.length ? `(max-width: ${breakpointBetween(band.points[band.points.length - 1].width, bands[i + 1].points[0].width)}px) ${band.value}` : band.value,
  );
  const value = clauses.join(", ");
  if (!sizesHolds(value, points)) {
    return { value: constantOf(points), clauses: 1, fitted: 0, constant: true };
  }
  return { value, clauses: bands.length, fitted: bands.filter((b) => b.fitted).length, constant: false };
}
