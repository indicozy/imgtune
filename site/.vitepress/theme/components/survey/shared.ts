import data from "../../../../data/survey.json";

export interface SurveySite {
  id: string;
  category: string;
  tech: string;
  imageKbPerView: number;
  exactPct: number;
  exactEstPct: number;
  fixablePct: number;
  savedKbPerView: number;
}

export interface SurveyTech {
  tech: string;
  count: number;
  medianKbPerView: number;
  medianExactEstPct: number;
}

export interface SurveyCategory {
  category: string;
  count: number;
  medianKbPerView: number;
  medianExactEstPct: number;
  medianFixablePct: number;
  medianSavedKbPerView: number;
}

export interface Survey {
  scannedFrom: string;
  scannedTo: string;
  count: number;
  categories: string[];
  sites: SurveySite[];
  summary: {
    medianKbPerView: number;
    medianExactEstPct: number;
    medianFixablePct: number;
    shareAtLeast20Pct: number;
    totalSavedKbPerView: number;
    p25ExactEstPct: number;
    p75ExactEstPct: number;
    byTech: SurveyTech[];
  };
  byCategory: SurveyCategory[];
}

export const survey = data as unknown as Survey;

/** Categories with fewer sites than this are faded and marked "small sample". */
export const SMALL_N = 5;
/** The saving threshold the study names. */
export const THRESHOLD_PCT = 20;
/** Tech label for sites no named stack covers. The data folds small stacks into it. */
export const UNKNOWN_TECH = "Other / unknown";
/** Weight split used in the takeaway on the scatter (image KB per view). */
export const HEAVY_KB = 1000;

export const scanWhen =
  survey.scannedFrom === survey.scannedTo ? survey.scannedFrom : `${survey.scannedFrom} to ${survey.scannedTo}`;

export const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");
export const fmtPct = (n: number): string => `${n.toFixed(1)}%`;

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
