// Rendering of the resource findings: the text lines of a page (scan, check), the totals line, and the rows of the hints
// JSON. The findings are already sorted by savedBytes (phase.ts).
import type { ResourceFinding } from "./types.js";

/** Rows shown per page in the text output; the JSON has all of them. */
export const RESOURCE_TEXT_ROWS = 8;

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/**
 * The totals of a page's findings: the savings (their count and the bytes per view they save, marked when part of it is
 * an estimate). Informational findings (no saving) are counted apart and add nothing to the bytes.
 */
export function resourceTotalsLine(findings: ResourceFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  const savings = findings.filter((f) => f.savedBytes > 0);
  const informational = findings.length - savings.length;
  const saved = savings.reduce((sum, f) => sum + f.savedBytes, 0);
  const estimated = savings.some((f) => f.estimate);
  const head = savings.length > 0 ? `resources: ${savings.length} finding(s), saves ~${kb(saved)}/view${estimated ? " (est. in part)" : ""}` : "resources: no saving";
  const info = informational > 0 ? `, ${informational} informational` : "";
  return `${head}${info}, not in the image totals`;
}

/** Text lines for a page's resource findings: the totals, then one row per finding and its first fix line. */
export function resourceLinesOf(findings: ResourceFinding[], text: (value: string) => string): string[] {
  const total = resourceTotalsLine(findings);
  if (total === undefined) return [];
  const lines = [`  ${total}`];
  for (const finding of findings.slice(0, RESOURCE_TEXT_ROWS)) {
    const saved = finding.savedBytes > 0 ? `  saves ${kb(finding.savedBytes)}/view${finding.estimate ? " (est.)" : ""}` : "";
    lines.push(`    ${finding.kind}: ${text(finding.title)}${saved}`);
    if (finding.fix[0] !== undefined) lines.push(`      fix: ${text(finding.fix[0])}`);
  }
  if (findings.length > RESOURCE_TEXT_ROWS) lines.push(`    ... ${findings.length - RESOURCE_TEXT_ROWS} more in the JSON (resources)`);
  return lines;
}
