// The allowed image qualities of a Next.js app, read statically from its next.config (js, mjs or ts). The config is never
// run or evaluated: comments are removed by a small scanner (strings are kept whole, so a URL in a string is not a comment),
// then `qualities: [ ... ]` is read as a list of whole numbers. Anything else is reported, and Next's default is assumed.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Next 16's default for images.qualities. */
export const NEXT_DEFAULT_QUALITIES = [75];

const CONFIG_NAMES = ["next.config.js", "next.config.mjs", "next.config.ts"] as const;

/** The config text with its comments removed. Quoted strings and template literals are copied as they are. */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && n === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export type QualitiesReading =
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string }
  | { kind: "found"; qualities: number[] };

/** The `qualities` list of a config's text: found, not there, or not a plain list of whole numbers from 1 to 100. */
export function qualitiesOfConfig(source: string): QualitiesReading {
  const match = /(^|[^\w$.])qualities\s*:\s*\[([^\]]*)\]/.exec(stripComments(source));
  if (match === null) return { kind: "missing" };
  const items = match[2]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (items.length === 0) return { kind: "unreadable", reason: "the list is empty" };
  const values: number[] = [];
  for (const item of items) {
    if (!/^\d{1,3}$/.test(item)) return { kind: "unreadable", reason: `${item.slice(0, 40)} is not a whole number` };
    const value = Number(item);
    if (value < 1 || value > 100) return { kind: "unreadable", reason: `${value} is not a quality from 1 to 100` };
    values.push(value);
  }
  return { kind: "found", qualities: [...new Set(values)].sort((a, b) => a - b) };
}

export interface NextQualities {
  qualities: number[];
  /** One line for the report and the terminal: where the list came from, or why the default is assumed. */
  note: string;
}

/** The allowed qualities of the app at `appRoot`, from its next.config, or Next's default with the reason. */
export async function nextQualities(appRoot: string): Promise<NextQualities> {
  let found: { name: string; text: string } | undefined;
  for (const name of CONFIG_NAMES) {
    try {
      found = { name, text: await readFile(join(appRoot, name), "utf8") };
      break;
    } catch {
      // not this file: try the next name
    }
  }
  if (found === undefined) {
    return { qualities: [...NEXT_DEFAULT_QUALITIES], note: `no next.config.{js,mjs,ts} in the app: Next's default [${NEXT_DEFAULT_QUALITIES.join(", ")}] assumed` };
  }
  const reading = qualitiesOfConfig(found.text);
  if (reading.kind === "found") {
    return { qualities: reading.qualities, note: `images.qualities [${reading.qualities.join(", ")}] from ${found.name}` };
  }
  if (reading.kind === "missing") {
    return { qualities: [...NEXT_DEFAULT_QUALITIES], note: `no images.qualities in ${found.name}: Next's default [${NEXT_DEFAULT_QUALITIES.join(", ")}] assumed` };
  }
  return {
    qualities: [...NEXT_DEFAULT_QUALITIES],
    note: `images.qualities in ${found.name} is not a plain list (${reading.reason}): Next's default [${NEXT_DEFAULT_QUALITIES.join(", ")}] assumed; pass --qualities to set it`,
  };
}
