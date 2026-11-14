// Capture helpers for the resource analyzers: how a response becomes a ResourceRecord, and the page context read once per
// view. The capture runs in the scan (remote.ts readGroup); the analyzers never see a Playwright object.
import type { Page, Response } from "playwright";
import { isFirstParty } from "../third-party.js";
import { ANALYZERS } from "./index.js";
import type { PageContext, ResourceRecord } from "./types.js";

/** A body larger than this is never kept (the record keeps its bytes): see ResourceRecord.body. */
export const RESOURCE_BODY_MAX = 20 * 1024 * 1024;

/** The page context as the browser reads it; the page URL and the viewport are added by the caller. */
export type PageContextData = Omit<PageContext, "url" | "viewport">;

/** The content type without parameters, lower-cased ("text/css; charset=utf-8" is "text/css"). */
export function contentTypeOf(header: string | undefined): string {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}

/** The content encoding the server applied, lower-cased ("br", "gzip", ...), or undefined for an identity body. */
export function contentEncodingOf(header: string | undefined): string | undefined {
  const value = (header ?? "").split(",")[0].trim().toLowerCase();
  return value === "" || value === "identity" ? undefined : value;
}

/** Whether any registered analyzer wants a response with this record (decided before its body is read). */
export function anyAnalyzerWants(record: ResourceRecord): boolean {
  return ANALYZERS.some((analyzer) => analyzer.wants(record));
}

/** The record of a response, with its bytes still unknown (see readResourceBody). */
export function resourceRecordOf(response: Response, pageUrl: string, viewport: string, contentType: string | undefined): ResourceRecord {
  const headers = response.headers();
  return {
    url: response.url(),
    pageUrl,
    viewport,
    resourceType: response.request().resourceType(),
    contentType: contentTypeOf(contentType),
    contentEncoding: contentEncodingOf(headers["content-encoding"]),
    bytes: 0,
    status: response.status(),
    thirdParty: !isFirstParty(pageUrl, response.url()),
  };
}

/**
 * Settles a resource record once its response has finished: the bytes (the encoded size the browser counted, else the
 * Content-Length), and the decoded body when an analyzer wants it and it is within RESOURCE_BODY_MAX.
 */
/** How long a scan waits for the resource bodies of a page view before it moves on (a body still streaming is fetched again by the phase). */
export const RESOURCE_BODY_SETTLE_MS = 1500;

export async function readResourceBody(record: ResourceRecord, response: Response): Promise<void> {
  await response.finished().catch(() => null);
  let encoded = 0;
  try {
    encoded = (await response.request().sizes()).responseBodySize;
  } catch {
    encoded = 0;
  }
  const length = Number(response.headers()["content-length"]);
  record.bytes = encoded > 0 ? encoded : Number.isFinite(length) && length >= 0 ? length : 0;
  if (record.bytes > RESOURCE_BODY_MAX || !anyAnalyzerWants(record)) return;
  const body = await response.body().catch(() => undefined);
  if (body === undefined) return;
  // Playwright's headers can lack a Content-Encoding the server sent (seen on an SVG served as br): a body that decodes
  // to more than the browser counted on the wire was encoded, so it is not a candidate for compression.
  if (record.contentEncoding === undefined && encoded > 0 && body.length > encoded) record.contentEncoding = "unknown";
  record.bytes = body.length;
  if (body.length <= RESOURCE_BODY_MAX) record.body = body;
}

/** What the page shows, read in one page.evaluate after the scroll (see types.ts PageContext). Never throws. */
export async function readPageContext(page: Page): Promise<PageContextData | undefined> {
  return page
    .evaluate(() => {
      const TEXT_MAX = 200_000;
      const MAX_TEXT_ELEMENTS = 6000;
      const unquote = (value: string): string => value.trim().replace(/^["']|["']$/g, "").toLowerCase();
      const selectorOf = (el: Element): string => {
        const id = /^[A-Za-z][\w-]*$/.test(el.id) ? `#${el.id}` : "";
        const cls = Array.from(el.classList).slice(0, 2).map((c) => `.${c}`).join("");
        return `${el.tagName.toLowerCase()}${id}${cls}`;
      };
      const rectOf = (el: Element): { width: number; height: number } => {
        const r = el.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height) };
      };

      // The visible text, capped.
      const text = ((document.body as HTMLElement | null)?.innerText ?? "").slice(0, TEXT_MAX);

      // Font faces the rendered text uses: the first family of each text-bearing element's computed font stack.
      const usedKeys = new Set<string>();
      const usedFonts: { family: string; weight: number; style: string }[] = [];
      let scanned = 0;
      for (const el of Array.from(document.body?.querySelectorAll("*") ?? [])) {
        if (scanned >= MAX_TEXT_ELEMENTS) break;
        const hasText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
        if (!hasText) continue;
        scanned++;
        const style = getComputedStyle(el);
        const family = unquote(style.fontFamily.split(",")[0] ?? "");
        const weight = Number(style.fontWeight) || 400;
        const fontStyle = style.fontStyle === "normal" ? "normal" : style.fontStyle;
        const key = `${family}|${weight}|${fontStyle}`;
        if (family !== "" && !usedKeys.has(key)) {
          usedKeys.add(key);
          usedFonts.push({ family, weight, style: fontStyle });
        }
      }

      // @font-face rules: the source URL and the unicode-range of each face, by family, weight and style.
      interface FaceInfo {
        url?: string;
        unicodeRange?: string;
      }
      const faceRules = new Map<string, FaceInfo>();
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSFontFaceRule)) continue;
          const family = unquote(rule.style.getPropertyValue("font-family"));
          const weight = rule.style.getPropertyValue("font-weight") || "400";
          const fontStyle = rule.style.getPropertyValue("font-style") || "normal";
          const src = rule.style.getPropertyValue("src");
          const match = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(src);
          const info: FaceInfo = {
            url: match ? new URL(match[1], sheet.href ?? document.baseURI).href : undefined,
            unicodeRange: rule.style.getPropertyValue("unicode-range") || undefined,
          };
          faceRules.set(`${family}|${weight}|${fontStyle}`, info);
        }
      }
      const fontFaces: PageContextData["fontFaces"] = [];
      document.fonts.forEach((face) => {
        const family = unquote(face.family);
        const info = faceRules.get(`${family}|${face.weight}|${face.style}`);
        fontFaces.push({
          family,
          weight: face.weight,
          style: face.style,
          status: face.status,
          ...(info?.url !== undefined ? { url: info.url } : {}),
          ...(info?.unicodeRange !== undefined ? { unicodeRange: info.unicodeRange } : {}),
        });
      });

      const icons = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel*='icon']"))
        .filter((link) => link.href !== "")
        .map((link) => ({
          rel: link.rel,
          href: link.href,
          ...(link.getAttribute("sizes") ? { sizes: link.getAttribute("sizes") as string } : {}),
          ...(link.type ? { type: link.type } : {}),
        }));

      const audio = Array.from(document.querySelectorAll<HTMLAudioElement>("audio")).map((el) => ({
        src: el.currentSrc || el.src || el.querySelector("source")?.src || "",
        autoplay: el.autoplay,
        loop: el.loop,
        preload: el.preload,
        muted: el.muted,
        selector: selectorOf(el),
      }));

      const lottie = Array.from(document.querySelectorAll("lottie-player, dotlottie-player, dotlottie-wc, [data-animation-path], [data-lottie-src]")).map((el) => {
        const src = el.getAttribute("src") ?? el.getAttribute("data-animation-path") ?? el.getAttribute("data-lottie-src") ?? undefined;
        return { ...(src ? { src: new URL(src, document.baseURI).href } : {}), selector: selectorOf(el), ...rectOf(el) };
      });

      const models = Array.from(document.querySelectorAll("model-viewer")).map((el) => {
        const src = el.getAttribute("src") ?? undefined;
        return { ...(src ? { src: new URL(src, document.baseURI).href } : {}), selector: selectorOf(el), ...rectOf(el) };
      });

      return { text, usedFonts, fontFaces, icons, audio, lottie, models };
    })
    .catch(() => undefined);
}

/** A @font-face rule read from a stylesheet's text: its family, weight, style, unicode-range and first src URL. */
export interface FontFaceRule {
  family: string;
  weight: string;
  style: string;
  unicodeRange?: string;
  url: string;
}

/**
 * The @font-face rules of a stylesheet's text, with each src URL made absolute against the sheet's URL. Used for the
 * sheets the browser's CSSOM does not show (cross-origin ones), read from the captured CSS response bodies.
 */
export function fontFaceRulesOf(css: string, cssUrl: string): FontFaceRule[] {
  const out: FontFaceRule[] = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = match[1];
    const prop = (name: string): string | undefined => {
      const found = new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`, "i").exec(body);
      return found ? found[1].trim() : undefined;
    };
    const src = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(prop("src") ?? "");
    if (!src) continue;
    let url: string;
    try {
      url = new URL(src[1], cssUrl).href;
    } catch {
      continue;
    }
    out.push({
      family: (prop("font-family") ?? "").replace(/["']/g, "").trim().toLowerCase(),
      weight: prop("font-weight") ?? "normal",
      style: prop("font-style") ?? "normal",
      unicodeRange: prop("unicode-range"),
      url,
    });
  }
  return out;
}

const normalWeight = (w: string): string => (w === "normal" ? "400" : w === "bold" ? "700" : w.replace(/\s+/g, " ").trim());

/**
 * The faces of a page with the URL and unicode-range the rules declare, where the page's own face (from the CSSOM) has
 * none: matched by family, weight and style, and by unicode-range when several rules share them. A face no rule matches
 * is returned as it is.
 */
export function completeFontFaces(faces: PageContextData["fontFaces"], rules: FontFaceRule[]): PageContextData["fontFaces"] {
  return faces.map((face) => {
    if (face.url !== undefined) return face;
    const family = face.family.replace(/["']/g, "").trim().toLowerCase();
    const same = rules.filter(
      (r) => r.family === family && normalWeight(r.weight) === normalWeight(face.weight) && r.style.split(" ")[0] === face.style.split(" ")[0],
    );
    const rangeOf = (r: string | undefined): string => (r ?? "").replace(/\s+/g, "").toUpperCase();
    const pick = same.find((r) => rangeOf(r.unicodeRange) === rangeOf(face.unicodeRange)) ?? same[0];
    if (pick === undefined) return face;
    return { ...face, url: pick.url, ...(face.unicodeRange === undefined && pick.unicodeRange !== undefined ? { unicodeRange: pick.unicodeRange } : {}) };
  });
}
