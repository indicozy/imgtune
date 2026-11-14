// Rendering of the resource findings: the text lines of a page (scan, check), the totals line, and the rows of the hints
// JSON. The findings are already sorted by savedBytes (phase.ts).
import type { ResourceFinding } from "./types.js";

/** Rows shown per page in the text output; the JSON has all of them. */
export const RESOURCE_TEXT_ROWS = 8;

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/** A finding's saving smaller than this, for a kind that is weak for its cost, is a lead (see labelFinding in phase.ts). */
export const LEAD_BYTES = 5 * 1024;

/**
 * The order and the totals of a finding: 0 a first-party saving (the headline), 1 a third-party saving (ask the vendor),
 * 2 a lead (a small saving of a weak-for-cost kind), 3 informational (no saving). Sorting and totals both read this.
 */
export function findingTier(f: ResourceFinding): 0 | 1 | 2 | 3 {
  if (f.savedBytes <= 0) return 3;
  if (f.details?.lead === true) return 2;
  return f.details?.thirdParty === true ? 1 : 0;
}

/**
 * The totals of a page's findings: first-party savings (their count and bytes per view, marked when part of it is an
 * estimate), third-party savings apart, leads and informational findings counted apart. None of the rest adds to the
 * headline saving.
 */
export function resourceTotalsLine(findings: ResourceFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  const of = (tier: number): ResourceFinding[] => findings.filter((f) => findingTier(f) === tier);
  const first = of(0);
  const third = of(1);
  const leads = of(2);
  const informational = of(3).length;
  const sumOf = (list: ResourceFinding[]): number => list.reduce((sum, f) => sum + f.savedBytes, 0);
  const estimated = first.some((f) => f.estimate);
  let head: string;
  if (first.length > 0) head = `resources: ${first.length} finding(s), saves ~${kb(sumOf(first))}/view${estimated ? " (est. in part)" : ""}`;
  else head = third.length > 0 || leads.length > 0 ? "resources: no first-party saving" : "resources: no saving";
  const thirdPart = third.length > 0 ? `; third-party ${third.length} finding(s) ~${kb(sumOf(third))}/view (ask the vendor)` : "";
  const leadPart = leads.length > 0 ? `; ${leads.length} lead(s) ~${kb(sumOf(leads))}/view (small)` : "";
  const info = informational > 0 ? `, ${informational} informational` : "";
  return `${head}${thirdPart}${leadPart}${info}, not in the image totals`;
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
