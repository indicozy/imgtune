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
  threshold: number;
  tolerance: number;
  market: string;
  port: number;
  devCommand?: string[];
  sitemapUrl?: string;
  /** Base URL of an already running server (`--url`). The tool never starts or stops it. */
  url?: string;
  /** Route pattern -> example URL paths. */
  urls: Record<string, string[]>;
  viewports: Viewport[];
  samplesPerComponent: number;
  maxPagesPerPattern: number;
  /** Re-measure usages already marked optimised (`--all`). */
  includeDone: boolean;
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
