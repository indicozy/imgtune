// src/resources/types.ts: the shared interface of the resource analyzers (streams R, F, L, M). Every analyzer lives in
// src/resources/<kind>.ts and implements ResourceAnalyzer. Changing this file changes every analyzer.
export type ResourceKind = "compression" | "favicon" | "font" | "lottie" | "svg" | "model" | "audio";

/** One response the page made, deduped by URL within a page view. */
export interface ResourceRecord {
  url: string;
  pageUrl: string;
  viewport: string;              // viewport name
  resourceType: string;          // Playwright request.resourceType()
  contentType: string;           // lower-cased, without parameters
  contentEncoding?: string;      // response header, lower-cased: "br" | "gzip" | "zstd" | "deflate" | undefined
  bytes: number;                 // decoded body length (or the sum of range lengths for media)
  status: number;
  thirdParty: boolean;
  body?: Buffer;                 // present when an analyzer's wants() said so and the body is ≤ 20 MB
}

/** What the page shows, collected once per page view after scrolling. */
export interface PageContext {
  url: string;
  viewport: { name: string; width: number; height: number; dpr: number };
  /** Visible text of the page (document.body.innerText), at most 200k chars. */
  text: string;
  /** Font faces actually used by rendered text: from computed styles of text-bearing elements. */
  usedFonts: { family: string; weight: number; style: string }[];
  /** document.fonts entries: family, weight, style, status ("loaded" | "unloaded" | ...), and src URL when known. */
  fontFaces: { family: string; weight: string; style: string; status: string; url?: string; unicodeRange?: string }[];
  icons: { rel: string; href: string; sizes?: string; type?: string }[];
  audio: { src: string; autoplay: boolean; loop: boolean; preload: string; muted: boolean; selector: string }[];
  lottie: { src?: string; selector: string; width: number; height: number }[];
  models: { src?: string; selector: string; width: number; height: number }[];
}

export interface ResourceFinding {
  /** Stable across viewports: `${kind}:${hash(url)}` (+ suffix if several findings per URL). */
  id: string;
  kind: ResourceKind;
  url: string;
  /** Bytes per view now (as fetched). */
  bytes: number;
  /** Bytes per view the fix saves (0 for informational findings). */
  savedBytes: number;
  /** True when savedBytes comes from a sample, ratio or model rather than a measured re-encode. */
  estimate: boolean;
  /** One line, e.g. "font Inter-Variable.ttf: TTF, 412 KB; WOFF2 subset to the page's Latin text ~38 KB". */
  title: string;
  /** Concrete lines an agent can apply without guessing (target format, settings, tool command, expected bytes). */
  fix: string[];
  /** Machine-readable numbers for JSON output. */
  details?: Record<string, unknown>;
  /** Where it comes from on the page, when known. */
  locator?: { selector?: string; file?: string; line?: number };
}

export interface ResourceAnalyzer {
  kind: ResourceKind;
  /** Cheap filter; true means the analyzer needs this response (and its body). */
  wants(r: ResourceRecord): boolean;
  /** Must never throw; return [] on any failure. Should finish in < 2 s per resource; heavy work samples. */
  analyze(records: ResourceRecord[], ctx: PageContext): Promise<ResourceFinding[]>;
}
