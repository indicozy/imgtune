// The one-line-per-image summary of a recheck (full and --sizes-only): PASS, FAIL or GONE, the predicted saving of the hint
// next to the measured one (per page view), and a batch total line. Detail lines are printed only for the images that did not
// pass. Page-derived text in a row is already safe (the caller passes it through safeText).

/** LAYOUT: the dev page lays the image out at another width than the measured server, so no verdict is given. */
export type Verdict = "PASS" | "FAIL" | "GONE" | "LAYOUT";

export interface RecheckRow {
  id: string;
  /** Where the image is: its file and line, else its component, else its selector (already safe text). */
  where: string;
  verdict: Verdict;
  /** The hint's saving per view, in bytes (negative: the hint predicted an increase). */
  predicted: number;
  /** The measured saving per view, in bytes (served bytes, mean over the viewports both scans measured). Undefined: none. */
  measured?: number;
}

/** A byte amount per view as the agent reads it: "saves 12.3 KB/view", or "adds 4.0 KB/view" when negative. */
export function perView(bytes: number): string {
  const size = `${(Math.abs(bytes) / 1024).toFixed(1)} KB/view`;
  return bytes < 0 ? `adds ${size}` : `saves ${size}`;
}

/** One image's line: id, verdict, where, predicted and measured bytes. */
export function rowLine(row: RecheckRow): string {
  const measured = row.measured === undefined ? "measured none" : `measured ${perView(row.measured)}`;
  return `${row.id}  ${row.verdict.padEnd(4)}  ${row.where}  predicted ${perView(row.predicted)}, ${measured}`;
}

/** The batch total: how many passed, failed and are gone, and the predicted and measured bytes summed over the images. */
export function batchLine(rows: RecheckRow[], seconds?: number): string {
  const count = (verdict: Verdict) => rows.filter((r) => r.verdict === verdict).length;
  const measured = rows.filter((r) => r.measured !== undefined);
  const predicted = rows.reduce((sum, r) => sum + r.predicted, 0);
  const got = measured.reduce((sum, r) => sum + (r.measured as number), 0);
  const took = seconds === undefined ? "" : ` in ${seconds.toFixed(1)} s`;
  const layout = count("LAYOUT") > 0 ? `, ${count("LAYOUT")} LAYOUT` : "";
  return `batch: ${rows.length} image(s)${took}: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("GONE")} GONE${layout}; predicted ${perView(predicted)} in total, measured ${perView(got)} in total (${measured.length} image(s) measured)`;
}
