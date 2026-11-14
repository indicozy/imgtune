// The resource phase of a page: the analyzers run per page view (each viewport's records and page context), and their
// findings are deduped by id across the viewports (the largest bytes kept). Icons the page did not load (a declared icon
// link, or /favicon.ico when none is declared) are fetched here, under the run's third-party policy, so the favicon
// analyzer sees them the way a first visit would.
import type { Fetcher } from "../fetch.js";
import { count, measure } from "../timing.js";
import type { ResultCache } from "../result-cache.js";
import { isFirstParty, isThirdPartyBlocked, type ThirdPartyPolicy } from "../third-party.js";
import type { Viewport } from "../types.js";
import { newResourceRun, withResourceScope, type ResourceRun } from "./cache.js";
import { ANALYZERS } from "./index.js";
import { ICON_READ_MAX } from "./favicon.js";
import { completeFontFaces, fontFaceRulesOf, RESOURCE_BODY_MAX, type FontFaceRule } from "./capture.js";
import type { PageContextData } from "./capture.js";
import { findingTier, LEAD_BYTES } from "./report.js";
import type { PageContext, ResourceAnalyzer, ResourceFinding, ResourceKind, ResourceRecord } from "./types.js";

/** The kinds that are weak for their cost: a small saving is a lead, not a headline (the spec: svg minify, lottie, favicon). */
const WEAK_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>(["svg", "lottie", "favicon"]);

/**
 * Labels a finding by where its bytes come from: a file on another registrable domain than the page is a third-party
 * finding (the vendor fixes it), and a small saving of a weak-for-cost kind is a lead. The title gets the prefix, the
 * details the flags. Applied once per finding, when it enters the page's findings.
 */
export function labelFinding(finding: ResourceFinding, pageUrl: string): ResourceFinding {
  const thirdParty = finding.url !== "" && !isFirstParty(pageUrl, finding.url);
  const lead = WEAK_KINDS.has(finding.kind) && finding.savedBytes > 0 && finding.savedBytes < LEAD_BYTES;
  if (!thirdParty && !lead) return finding;
  const prefix = `${thirdParty ? "third-party (ask the vendor): " : ""}${lead ? "lead: " : ""}`;
  return {
    ...finding,
    title: `${prefix}${finding.title}`,
    details: { ...finding.details, ...(thirdParty ? { thirdParty: true } : {}), ...(lead ? { lead: true } : {}) },
  };
}

/** One page view as the phase reads it: the viewport, the captured resources and the page context. */
export interface ResourceView {
  viewport: Viewport;
  resources?: ResourceRecord[];
  pageContext?: PageContextData;
}

/**
 * A response the capture kept no body for (its read timed out) is fetched again only up to this size: a larger one is not worth
 * a second download in the phase; its analysis is left out, and its bytes are still counted from the response.
 */
export const REFETCH_MAX_BYTES = 1024 * 1024;

export interface ResourceDeps {
  cache?: ResultCache;
  fetcher: Fetcher;
  allowPrivate: boolean;
  thirdParty?: ThirdPartyPolicy;
  /** The run's resource state (the memo of the heavy steps and the --resource-time budget). Undefined: a fresh one per page. */
  run?: ResourceRun;
}

const EMPTY_CONTEXT: PageContextData = { text: "", usedFonts: [], fontFaces: [], icons: [], audio: [], lottie: [], models: [] };

/** The image type of a body by its first bytes, or undefined when it is not a known image. */
export function sniffImageType(body: Buffer): string | undefined {
  if (body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (body.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return "image/x-icon";
  if (body[0] === 0xff && body[1] === 0xd8) return "image/jpeg";
  if (body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (/<svg[\s>]/i.test(body.subarray(0, 4096).toString("utf8"))) return "image/svg+xml";
  return undefined;
}

/**
 * The icon URLs the phase fetches: the page's declared icon links (whatever their names; the capture reads only icons
 * named like favicons), or the site's /favicon.ico when none is declared. An icon whose body the capture kept is not
 * fetched again.
 */
function iconUrlsToFetch(view: ResourceView, pageUrl: string): string[] {
  const have = new Set((view.resources ?? []).filter((r) => r.body !== undefined).map((r) => r.url));
  const declared = (view.pageContext?.icons ?? []).map((icon) => icon.href);
  const urls = declared.length > 0 ? declared : [new URL("/favicon.ico", pageUrl).href];
  return [...new Set(urls)].filter((url) => !have.has(url) && /^https?:/i.test(url));
}

/** The findings of a page's views, from the registered analyzers (see ANALYZERS). */
export function analyzeResources(views: ResourceView[], pageUrl: string, deps: ResourceDeps): Promise<ResourceFinding[]> {
  return runPhaseWith(ANALYZERS, views, pageUrl, deps);
}

/** The phase over the given analyzers: the same merge for any list (the tests run one analyzer through it). */
export async function runPhaseWith(analyzers: ResourceAnalyzer[], views: ResourceView[], pageUrl: string, deps: ResourceDeps): Promise<ResourceFinding[]> {
  const run = deps.run ?? newResourceRun();
  return withResourceScope(deps.cache, async () => {
    // Icons are fetched once per run (a favicon is shared by the pages of a site), and the fetches of a view run at once.
    const fetchIcon = (url: string): Promise<Buffer | undefined> => {
      const key = `resources:icon:${url}`;
      let pending = run.memo.get(key) as Promise<Buffer | undefined> | undefined;
      if (pending === undefined) {
        pending = measure("resources icon fetch", () => deps.fetcher.get(url, { maxBytes: ICON_READ_MAX, allowPrivate: deps.allowPrivate })).catch(() => undefined);
        run.memo.set(key, pending);
      }
      return pending;
    };
    const byId = new Map<string, ResourceFinding>();
    // The viewports each finding was found in, by id: a finding marked perViewport "all" survives only when every view has it.
    const foundIn = new Map<string, Set<string>>();
    // A body the capture did not keep (Chromium gives none for a range response, or a read timed out) is fetched again when
    // an analyzer wants the response: once per URL, up to RESOURCE_BODY_MAX, and not when the third-party policy blocks it.
    const bodies = new Map<string, Promise<Buffer | undefined>>();
    const bodyOf = (url: string): Promise<Buffer | undefined> => {
      let pending = bodies.get(url);
      if (pending === undefined) {
        pending = measure("resources refetch body", () => deps.fetcher.get(url, { maxBytes: RESOURCE_BODY_MAX, allowPrivate: deps.allowPrivate })).catch(() => undefined);
        count("resources refetch bodies");
        bodies.set(url, pending);
      }
      return pending;
    };
    for (const view of views) {
      const records: ResourceRecord[] = [];
      for (const r of view.resources ?? []) {
        const needsBody = r.body === undefined && r.status >= 200 && r.status < 300 && r.bytes <= REFETCH_MAX_BYTES && analyzers.some((a) => a.wants(r));
        const blocked = deps.thirdParty !== undefined && isThirdPartyBlocked(deps.thirdParty, { pageUrl: r.pageUrl, requestUrl: r.url, resourceType: r.resourceType, subFrame: false });
        if (needsBody && !blocked) {
          const body = await bodyOf(r.url);
          if (body !== undefined) {
            records.push({ ...r, body, bytes: body.length });
            continue;
          }
        }
        records.push(r);
      }
      // The icons fetched here: the favicon analyzer takes them whatever their names (they are icons by the page's links).
      const fetchedIcons = new Set<ResourceRecord>();
      const iconUrls = iconUrlsToFetch(view, pageUrl).filter(
        (url) => deps.thirdParty === undefined || !isThirdPartyBlocked(deps.thirdParty, { pageUrl, requestUrl: url, resourceType: "image", subFrame: false }),
      );
      const iconBodies = await Promise.all(iconUrls.map((url) => fetchIcon(url)));
      for (const [i, url] of iconUrls.entries()) {
        const body = iconBodies[i];
        const type = body === undefined ? undefined : sniffImageType(body);
        if (body === undefined || type === undefined) continue;
        const record: ResourceRecord = {
          url,
          pageUrl,
          viewport: view.viewport.name,
          resourceType: "image",
          contentType: type,
          bytes: body.length,
          status: 200,
          thirdParty: !isFirstParty(pageUrl, url),
          body,
        };
        records.push(record);
        fetchedIcons.add(record);
      }
      // The @font-face rules of the stylesheets the page loaded, read from their captured text: the faces the CSSOM does not
      // show (cross-origin sheets) get their URL and unicode-range from them.
      const rules: FontFaceRule[] = records
        .filter((r) => r.contentType === "text/css" && r.body !== undefined)
        .flatMap((r) => fontFaceRulesOf((r.body as Buffer).toString("utf8"), r.url));
      const pageContext = view.pageContext ?? EMPTY_CONTEXT;
      const ctx: PageContext = {
        url: pageUrl,
        viewport: { name: view.viewport.name, width: view.viewport.width, height: view.viewport.height, dpr: view.viewport.dpr },
        ...EMPTY_CONTEXT,
        ...pageContext,
        fontFaces: completeFontFaces(pageContext.fontFaces ?? [], rules),
      };
      for (const analyzer of analyzers) {
        // A fetched icon was not a response of the page load: the phase's fetch decodes it and reports no transfer encoding,
        // so only the favicon analyzer takes it (the others would judge its encoding wrongly).
        const wanted = records.filter((r) =>
          fetchedIcons.has(r) ? analyzer.kind === "favicon" : analyzer.wants(r),
        );
        if (wanted.length === 0) continue;
        count(`resources ${analyzer.kind} records`, wanted.length);
        count(`resources ${analyzer.kind} bytes in`, wanted.reduce((sum, r) => sum + (r.body?.length ?? r.bytes), 0));
        let found: ResourceFinding[] = [];
        try {
          found = await measure(`resources ${analyzer.kind}`, () => analyzer.analyze(wanted, ctx));
        } catch {
          found = [];
        }
        for (const finding of found) {
          const prev = byId.get(finding.id);
          if (prev === undefined || finding.bytes > prev.bytes) byId.set(finding.id, labelFinding(finding, pageUrl));
          const seen = foundIn.get(finding.id) ?? new Set<string>();
          seen.add(view.viewport.name);
          foundIn.set(finding.id, seen);
        }
      }
    }
    // A finding about what a viewport shows (details.perViewport "all", e.g. an unused font face) is kept only when every
    // viewport reports it. Savings come first (first-party, then third-party, then leads), informational findings last.
    const kept = [...byId.values()].filter((f) => f.details?.perViewport !== "all" || (foundIn.get(f.id)?.size ?? 0) === views.length);
    return kept.sort((a, b) => findingTier(a) - findingTier(b) || b.savedBytes - a.savedBytes || a.id.localeCompare(b.id));
  }, run);
}
