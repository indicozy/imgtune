// The `--survey` preset: a fast site-wide pass over many pages. It measures two viewports, skips the quality estimate, scans
// four pages at once and caps the network-idle wait at 3 s. Its numbers are exact savings only, so its results are labelled
// wherever they are printed, and `compare` and `report` never mix them with a full scan.

/** The viewports a survey measures, unless --viewports names others. */
export const SURVEY_VIEWPORTS: readonly string[] = ["iphone-15", "desktop"];
/** Pages in flight at once in a survey, unless --page-concurrency says otherwise. */
export const SURVEY_PAGE_CONCURRENCY = 4;
/** The network-idle cap of a survey, unless --idle-timeout says otherwise. */
export const SURVEY_IDLE_TIMEOUT_MS = 3_000;

/** The label of a survey result: its viewport count, exact savings only, and no estimate. */
export function surveyNote(viewports: number): string {
  return `survey: ${viewports} ${viewports === 1 ? "viewport" : "viewports"}, exact savings only, no est.`;
}
