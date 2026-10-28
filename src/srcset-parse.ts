// Parses a srcset attribute the way the HTML srcset algorithm does. Pure: no DOM or Node APIs, so the browser-side
// measurement (parsed in Node) and remote scan share it.

/** Largest width the tool decodes or encodes at. A srcset candidate above it is not one the tool can use. */
export const MAX_WIDTH = 8192;

export interface Candidate {
  url: string;
  width: number;
}

const isSrcsetSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

/**
 * The candidates of a srcset attribute, split as the HTML srcset algorithm splits them: a URL runs to whitespace, and a
 * comma ends the descriptors only outside parentheses. So a URL may hold commas (`w_400,q_80`) and a comma may follow a
 * descriptor with no space. A URL ending in commas has no descriptors.
 */
function srcsetCandidates(input: string): { url: string; descriptors: string[] }[] {
  const out: { url: string; descriptors: string[] }[] = [];
  let pos = 0;
  while (pos < input.length) {
    while (pos < input.length && (isSrcsetSpace(input[pos]) || input[pos] === ",")) pos++;
    if (pos >= input.length) break;
    const start = pos;
    while (pos < input.length && !isSrcsetSpace(input[pos])) pos++;
    let url = input.slice(start, pos);
    const descriptors: string[] = [];
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      while (pos < input.length && isSrcsetSpace(input[pos])) pos++;
      let current = "";
      let inParens = false;
      while (pos < input.length) {
        const c = input[pos++];
        if (inParens) {
          current += c;
          if (c === ")") inParens = false;
        } else if (c === ",") {
          break;
        } else if (isSrcsetSpace(c)) {
          if (current) descriptors.push(current);
          current = "";
        } else {
          if (c === "(") inParens = true;
          current += c;
        }
      }
      if (current) descriptors.push(current);
    }
    if (url) out.push({ url, descriptors });
  }
  return out;
}

/**
 * The w-descriptor candidates of a srcset attribute, with absolute URLs. x-descriptors are not candidates here, and a
 * candidate with no descriptor or with more than one is invalid, so it is left out.
 */
export function parseSrcset(srcset: string, base: string): Candidate[] {
  const out: Candidate[] = [];
  for (const { url, descriptors } of srcsetCandidates(srcset)) {
    const match = descriptors.length === 1 ? /^(\d+)w$/.exec(descriptors[0]) : null;
    if (!match) continue;
    const width = Number(match[1]);
    if (width <= 0 || width > MAX_WIDTH) continue;
    try {
      out.push({ url: new URL(url, base).toString(), width });
    } catch {
      // An unparsable candidate is not one the page advertises, so it is left out.
    }
  }
  return out;
}

/**
 * The widths of the w-descriptor candidates of a srcset attribute, in page order, with the same rules as parseSrcset.
 * No URL is resolved, so no base is needed.
 */
export function srcsetWidths(srcset: string): number[] {
  const out: number[] = [];
  for (const { descriptors } of srcsetCandidates(srcset)) {
    const match = descriptors.length === 1 ? /^(\d+)w$/.exec(descriptors[0]) : null;
    if (!match) continue;
    const width = Number(match[1]);
    if (width > 0 && width <= MAX_WIDTH) out.push(width);
  }
  return out;
}
