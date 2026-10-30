// Display widths: the CLI's six viewports, the layout presets, and a `sizes` evaluator.
// Viewports and DPRs are copied from src/config.ts of the CLI. Needed pixels follow src/remote.ts (ceil of CSS width x dpr,
// capped at the largest pixels the file has).

export interface Viewport {
  name: string;
  width: number;
  dpr: number;
}

export const VIEWPORTS: Viewport[] = [
  { name: "iphone-se", width: 375, dpr: 2 },
  { name: "iphone-15", width: 390, dpr: 3 },
  { name: "pixel-7", width: 412, dpr: 2.625 },
  { name: "iphone-15-pro-max", width: 430, dpr: 3 },
  { name: "desktop", width: 1440, dpr: 2 },
  { name: "desktop-1280", width: 1280, dpr: 1 },
];

export type PresetId = "hero" | "half" | "grid3" | "thumb";

export const PRESETS: { id: PresetId; label: string; note: string }[] = [
  { id: "hero", label: "full-width hero", note: "100vw" },
  { id: "half", label: "half width", note: "50vw" },
  { id: "grid3", label: "card in 3-col grid", note: "(vw - 2 gaps of 24px) / 3" },
  { id: "thumb", label: "thumbnail / logo", note: "160 css px" },
];

/** CSS width of an image under a preset, in CSS px, at a viewport width. */
export function presetWidth(preset: PresetId, vw: number): number {
  switch (preset) {
    case "hero":
      return vw;
    case "half":
      return vw / 2;
    case "grid3":
      return (Math.min(vw, 1200) - 48) / 3;
    case "thumb":
      return 160;
  }
}

/** Device pixels an image needs at a viewport: ceil(CSS width x dpr), never more than the file has. */
export function neededPx(cssWidth: number, dpr: number, fileWidth: number): number {
  return Math.min(Math.ceil(cssWidth * dpr), fileWidth);
}

// ---- sizes -----------------------------------------------------------------------------------

type Token = { kind: "num"; value: number; unit: string } | { kind: "op"; value: string } | { kind: "paren"; value: "(" | ")" };

function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("+-*/".includes(c)) {
      out.push({ kind: "op", value: c });
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ kind: "paren", value: c });
      i++;
      continue;
    }
    const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)/i.exec(src.slice(i));
    if (!m) return null;
    out.push({ kind: "num", value: Number(m[1]), unit: m[2].toLowerCase() });
    i += m[0].length;
  }
  return out;
}

const UNIT_PX: Record<string, number> = { px: 1, "": 1, em: 16, rem: 16 };

/** Evaluates one sizes length (`50vw`, `calc(100vw - 50px)`, `640px`) at a viewport width. Returns CSS px or null. */
export function evalLength(expr: string, vw: number): number | null {
  const tokens = tokenize(expr.trim().replace(/^calc\(/i, "(").replace(/\bcalc\(/gi, "("));
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (t: Token | undefined, ops: string) => t?.kind === "op" && ops.includes(t.value);

  function primary(): number | null {
    const t = next();
    if (!t) return null;
    if (t.kind === "paren" && t.value === "(") {
      const v = additive();
      if (v === null || next()?.kind !== "paren") return null;
      return v;
    }
    if (t.kind === "op" && t.value === "-") {
      const v = primary();
      return v === null ? null : -v;
    }
    if (t.kind !== "num") return null;
    if (t.unit === "vw") return (t.value * vw) / 100;
    if (t.unit in UNIT_PX) return t.value * UNIT_PX[t.unit];
    return null;
  }
  function multiplicative(): number | null {
    let v = primary();
    while (v !== null && (isOp(peek(), "*/"))) {
      const op = next().value;
      const r = primary();
      if (r === null) return null;
      if (op === "*") v *= r;
      else {
        if (r === 0) return null;
        v /= r;
      }
    }
    return v;
  }
  function additive(): number | null {
    let v = multiplicative();
    while (v !== null && isOp(peek(), "+-")) {
      const op = next().value;
      const r = multiplicative();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const value = additive();
  if (value === null || pos !== tokens.length || !Number.isFinite(value)) return null;
  return value;
}

/** Splits on commas that are outside parentheses. */
function splitTop(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of src) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Only `(min-width: Npx)` and `(max-width: Npx)` conditions, joined with `and`. Returns null when unsupported. */
function matchesMedia(cond: string, vw: number): boolean | null {
  const groups = cond.match(/\([^)]*\)/g);
  if (!groups) return null;
  for (const g of groups) {
    const m = /^\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/i.exec(g.trim());
    if (!m) return null;
    const limit = Number(m[2]);
    if (m[1].toLowerCase() === "min" ? !(vw >= limit) : !(vw <= limit)) return false;
  }
  return true;
}

export interface SizesResult {
  /** CSS px at the viewport, or null when the value cannot be read. */
  px: number | null;
  error?: string;
}

/**
 * The image's CSS width at a viewport from a `sizes` value. An empty value is the browser default, 100vw.
 * Entries are checked in order: the first whose media condition matches gives the width; an entry without a
 * condition always matches.
 */
export function sizesWidth(sizes: string, vw: number): SizesResult {
  const trimmed = sizes.trim();
  if (!trimmed) return { px: vw };
  for (const entry of splitTop(trimmed)) {
    // A condition is one or more `( ... )` groups joined by `and`; whatever follows is the length.
    let rest = entry;
    const conds: string[] = [];
    let group = /^\([^()]*\)/.exec(rest);
    while (group) {
      conds.push(group[0]);
      rest = rest.slice(group[0].length).replace(/^\s*(and\s+)?/i, "");
      group = /^\([^()]*\)/.exec(rest);
    }
    let media: boolean | null = true;
    for (const c of conds) {
      const r = matchesMedia(c, vw);
      if (r === null) return { px: null, error: `unsupported condition in "${entry}"` };
      if (!r) media = false;
    }
    if (media === false) continue;
    const px = evalLength(rest, vw);
    if (px === null) return { px: null, error: `cannot read "${rest}"` };
    return { px: Math.max(px, 0) };
  }
  return { px: null, error: "no entry matches this viewport" };
}

/** One row of the width table: a viewport and what an image needs there. */
export interface WidthRow {
  name: string;
  vw: number;
  dpr: number;
  /** CSS px, or null when the sizes value cannot be read at this viewport. */
  css: number | null;
  needed: number | null;
  /** True when the needed pixels were capped at the file's own width. */
  capped: boolean;
}
