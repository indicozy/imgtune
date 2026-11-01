// Which srcset candidate a `sizes` value picks, and whether a proposed `sizes` leaves any measured viewport with an undersized
// file. The browser's choice depends only on the sizes value, the viewport width and the DPR (not on layout), so a proposal
// can be checked against every measured viewport before it is printed as a saving.

import { sizesBranchAt } from "./sizes.js";
import type { Candidate } from "./srcset-parse.js";

/** A srcset candidate that is this far below the need (and below the largest) is an undersized file. */
export const UNDERSIZED_RATIO = 0.9;

/** Device pixels the image needs: rendered CSS width x dpr, capped at the largest candidate. */
export function neededWidth(renderedWidth: number, dpr: number, largest: number): number {
  return Math.min(Math.ceil(renderedWidth * dpr), largest);
}

/** The smallest candidate at or above `needed`; the largest when none reaches it. Candidates must not be empty. */
export function rightCandidate(candidates: Candidate[], needed: number): Candidate {
  const sorted = [...candidates].sort((a, b) => a.width - b.width);
  return sorted.find((c) => c.width >= needed) ?? sorted[sorted.length - 1];
}

/** The served file is undersized: its pixels are below 0.9 x need, and a larger candidate exists. */
export function isUndersized(servedWidth: number, needed: number, largest: number): boolean {
  return servedWidth < UNDERSIZED_RATIO * needed && servedWidth < largest;
}

// ---------------------------------------------------------------------------------------------------------------------
// The CSS width a sizes value gives: px, vw, unitless numbers, + - * /, parentheses, calc, min, max and clamp.
// ---------------------------------------------------------------------------------------------------------------------

const TOKEN_RE = /\s*(\d+(?:\.\d+)?(?:px|vw)?|[A-Za-z]+|[()+*/,-])/y;

/**
 * The px width a sizes slot (one value, no media condition) gives at `viewportWidth`. Undefined when the text is not a value
 * this evaluator reads: such a proposal cannot be checked, so it is not emitted.
 */
export function evalSizesSlot(value: string, viewportWidth: number): number | undefined {
  const tokens: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let at = 0;
  const text = value.trim();
  while (at < text.length) {
    TOKEN_RE.lastIndex = at;
    const m = TOKEN_RE.exec(text);
    if (!m) return undefined;
    tokens.push(m[1]);
    at = TOKEN_RE.lastIndex;
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t?: string) => {
    const got = tokens[pos++];
    return t === undefined || got === t ? got : undefined;
  };
  // A number is px already, or a unitless factor; vw is converted with the viewport width.
  const unitValue = (t: string): number | undefined => {
    const n = /^(\d+(?:\.\d+)?)(px|vw)?$/.exec(t);
    if (!n) return undefined;
    const x = Number(n[1]);
    return n[2] === "vw" ? (x / 100) * viewportWidth : x;
  };
  const fail = Symbol("fail");
  const primary = (): number => {
    const t = eat();
    if (t === undefined) throw fail;
    if (t === "(") {
      const v = sum();
      if (eat(")") === undefined) throw fail;
      return v;
    }
    if (t === "-") return -primary();
    if (/^[A-Za-z]+$/.test(t)) {
      if (eat("(") === undefined) throw fail;
      const args = [sum()];
      while (peek() === ",") {
        eat(",");
        args.push(sum());
      }
      if (eat(")") === undefined) throw fail;
      if (t === "calc" && args.length === 1) return args[0];
      if (t === "min") return Math.min(...args);
      if (t === "max") return Math.max(...args);
      if (t === "clamp" && args.length === 3) return Math.max(args[0], Math.min(args[1], args[2]));
      throw fail;
    }
    const v = unitValue(t);
    if (v === undefined) throw fail;
    return v;
  };
  const product = (): number => {
    let v = primary();
    while (peek() === "*" || peek() === "/") {
      const op = eat();
      const r = primary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  function sum(): number {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = eat();
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  try {
    const result = sum();
    if (pos !== tokens.length || !Number.isFinite(result)) return undefined;
    return Math.max(0, result);
  } catch (err) {
    if (err === fail) return undefined;
    throw err;
  }
}

/** The slot a whole sizes attribute gives at `viewportWidth`: the first media branch that holds, then its value. */
export function sizesPxAt(sizes: string, viewportWidth: number): number | undefined {
  const branch = sizesBranchAt(sizes, viewportWidth);
  return branch === undefined ? undefined : evalSizesSlot(branch.value, viewportWidth);
}

/** One measured viewport of an element: what the proposal is checked against. */
export interface ProposalPoint {
  viewport: string;
  viewportWidth: number;
  dpr: number;
  /** The rendered CSS width on the measured server at this viewport. */
  renderedWidth: number;
  /** The element's srcset (the same candidates at every viewport of one URL). */
  srcset: string;
}

/**
 * The first measured viewport where the proposed sizes make the browser load an undersized file, as text. Undefined when no
 * measured viewport is undersized. A viewport where the value cannot be evaluated counts as undersized: an unproven
 * proposal is not a saving.
 */
export function undersizedProposal(
  sizes: string,
  points: ProposalPoint[],
  parse: (srcset: string) => Candidate[],
): string | undefined {
  for (const p of points) {
    if (!(p.renderedWidth >= 1)) continue;
    const candidates = parse(p.srcset);
    if (candidates.length === 0) continue;
    const slot = sizesPxAt(sizes, p.viewportWidth);
    if (slot === undefined) return `${p.viewport} (${p.viewportWidth} px): the proposed sizes cannot be evaluated there`;
    const largest = Math.max(...candidates.map((c) => c.width));
    const needed = neededWidth(p.renderedWidth, p.dpr, largest);
    const served = rightCandidate(candidates, Math.ceil(slot * p.dpr));
    if (isUndersized(served.width, needed, largest)) {
      return `${p.viewport} (${p.viewportWidth} px, dpr ${p.dpr}): the proposed sizes load ${served.width}w, below the ${needed} px needed`;
    }
  }
  return undefined;
}
