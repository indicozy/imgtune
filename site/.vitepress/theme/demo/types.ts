// Shared between the demo's worker and the page. Types and constants only, so importing this has no side effects.

export interface RunRequest {
  type: "run";
  file: File;
  /** Distinct needed widths in device pixels, from the width picker. Widths above the file's own are dropped. */
  targets: number[];
  skipAvif: boolean;
}

export type CandidateId = "resize" | "quality" | "webp" | "avif" | "combined";

export interface Candidate {
  key: string;
  width: number;
  id: CandidateId;
  label: string;
  /** Encoded bytes, or null when the candidate was not made. */
  bytes: number | null;
  /** SSIMULACRA2 score against the file at the same width, 0-100. Null when not scored. */
  score: number | null;
  pass: boolean;
  blob: Blob | null;
  ms: number;
  note?: string;
}

export interface FileInfo {
  name: string;
  type: string;
  bytes: number;
  width: number;
  height: number;
}

export type WorkerOut =
  | { type: "progress"; done: number; total: number; label: string }
  | { type: "done"; file: FileInfo; candidates: Candidate[]; totalMs: number; notes: string[] }
  | { type: "error"; message: string };

/** The demo's pass mark: the CLI's relaxed floor. The delta-2 rule needs the served copy, which a dropped file is not. */
export const PASS_FLOOR = 70;
/** Longest side the demo will decode. Bigger files are refused with a message, not silently shrunk. */
export const MAX_SIDE = 3000;
