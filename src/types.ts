import type { Metric } from "./metric.js";

export type QualityLevel = "relaxed" | "strict";

export interface Viewport {
  name: string;
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  userAgent?: string;
}

export interface ImgtuneConfig {
  projectDir: string;
  paths: string[];
  quality: QualityLevel;
  /** The metric every threshold, score and proposal is judged with. */
  metric: Metric;
  /**
   * Pass mark on the metric's scale: 0-100 for ssimulacra2, 0-1 for ssim. With `delta` set (the relative rule, R38) it is
   * the floor: a sample passes at max(threshold, its current score - delta). Without `delta` it is an absolute bar.
   */
  threshold: number;
  /** Relative rule (R38): points a candidate may drop below the current quality's score. Absent for an absolute bar. */
  delta?: number;
  tolerance: number;
  market: string;
  port: number;
  devCommand?: string[];
  sitemapUrl?: string;
  /** Base URL of an already running server (`--url`). The tool never starts or stops it. */
  url?: string;
  /** The ssimulacra2_rs binary, resolved against the project. Used by `ssimulacra2-native` only; otherwise looked up on PATH. */
  ssimulacra2Path?: string;
  /** Route pattern -> example URL paths. */
  urls: Record<string, string[]>;
  viewports: Viewport[];
  samplesPerComponent: number;
  maxPagesPerPattern: number;
  /** Re-measure usages already marked optimised (`--all`). */
  includeDone: boolean;
}

/** A request from `apply --raise`: set the applied quality of the usage named `component` to `quality`. */
export interface QualityRaise {
  component: string;
  quality: number;
}

/** start/end = source offsets of the attribute. */
export interface PropValue {
  kind: "literal";
  value: string | number | boolean;
  start: number;
  end: number;
}

export type PropInfo =
  | PropValue
  | { kind: "expression"; start: number; end: number }
  | { kind: "absent" };

export interface ImageUsage {
  /** `${relFile}:${line}:${col}` */
  id: string;
  file: string;
  relFile: string;
  line: number;
  col: number;
  tag: "Image" | "img";
  /** Enclosing function/const name, "anonymous" otherwise. */
  component: string;
  props: {
    src: PropInfo;
    sizes: PropInfo;
    quality: PropInfo;
    width: PropInfo;
    height: PropInfo;
    fill: PropInfo;
  };
  hasSpread: boolean;
  /** Offset right after the tag name, insertion point for attributes. */
  tagNameEnd: number;
  /** Source text of the src value expression. */
  srcExpressionText?: string;
}
