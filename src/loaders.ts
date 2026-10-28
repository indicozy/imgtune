/**
 * Image loaders: for each URL a page renders, the adapter that made it. An adapter says where the untransformed
 * original is, what quality the URL asks for, and whether the loader can be told a quality at all. Pure: no network.
 */

/** Whether the loader takes a quality: "yes" tunable, "auto" a CDN auto quality (q_auto), "none" no knob at all. */
export type QualityParam = "yes" | "auto" | "none";

export interface LoaderAdapter {
  name: string;
  matches(url: URL): boolean;
  /** The untransformed source; undefined = unknown. Only http(s) originals are returned. */
  original(url: URL): string | undefined;
  /** The quality the URL asks for; undefined = not in URL. */
  quality(url: URL): number | undefined;
  qualityParam: QualityParam;
  /** For a loader whose parameter depends on the URL (Cloudinary's q_auto): the parameter of this URL. */
  qualityParamFor?(url: URL): QualityParam;
  /** The documented quality when the URL has none. */
  defaultQuality?: number;
}

export interface ResolvedLoader {
  adapter: LoaderAdapter;
  /** The image URL, resolved against the page. */
  url: URL;
}

const DEFAULT_NEXT_QUALITY = 75;
const DEFAULT_CLOUDFLARE_QUALITY = 85;
const DEFAULT_IMGIX_QUALITY = 75;
const DEFAULT_SANITY_QUALITY = 75;

/** `q=` style values: digits only. */
const toQuality = (text: string | null | undefined): number | undefined =>
  text !== null && text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;

/** The URL without its query (and fragment). */
const withoutQuery = (url: URL): string => `${url.origin}${url.pathname}`;

/** Copies `url` without the given query parameters; no `?` is left when none remain. */
function withoutParams(url: URL, names: string[]): string {
  const copy = new URL(url.href);
  for (const name of names) copy.searchParams.delete(name);
  copy.hash = "";
  return copy.toString();
}

const CDN_CGI = /\/cdn-cgi\/image\/([^/]+)\/(.+)$/;

const cloudflare: LoaderAdapter = {
  name: "cloudflare",
  matches: (url) => CDN_CGI.test(url.pathname),
  original(url) {
    const m = CDN_CGI.exec(url.pathname);
    if (!m) return undefined;
    const rest = m[2] + url.search;
    if (/^https?:\/\//i.test(rest)) return rest;
    return new URL(`/${rest}`, url.origin).toString();
  },
  quality(url) {
    const options = /\/cdn-cgi\/image\/([^/]+)\//.exec(url.pathname);
    const q = options ? /(?:^|,)quality=(\d+)/.exec(options[1]) : null;
    return q ? Number(q[1]) : undefined;
  },
  qualityParam: "yes",
  defaultQuality: DEFAULT_CLOUDFLARE_QUALITY,
};

const next: LoaderAdapter = {
  name: "next",
  matches: (url) => url.pathname === "/_next/image",
  original(url) {
    const inner = url.searchParams.get("url");
    if (!inner) return undefined;
    try {
      return new URL(inner, url).toString();
    } catch {
      return undefined;
    }
  },
  quality: (url) => toQuality(url.searchParams.get("q")),
  qualityParam: "yes",
  defaultQuality: DEFAULT_NEXT_QUALITY,
};

const CONTENTFUL_HOSTS = new Set(["images.ctfassets.net", "downloads.ctfassets.net"]);
const contentful: LoaderAdapter = {
  name: "contentful",
  matches: (url) => CONTENTFUL_HOSTS.has(url.hostname),
  original: withoutQuery,
  quality: (url) => toQuality(url.searchParams.get("q")),
  qualityParam: "yes",
};

/** A Sanity asset path, `/images/<project>/<dataset>/<hash>-<w>x<h>.<ext>`: the same on cdn.sanity.io and custom domains. */
const SANITY_ASSET_PATH = /^\/images\/[a-z0-9]+\/[a-z0-9_-]+\/[0-9a-f]{20,}-\d+x\d+\.(jpg|jpeg|png|webp|gif|avif|svg)$/;
const sanity: LoaderAdapter = {
  name: "sanity",
  matches: (url) => (url.hostname === "cdn.sanity.io" && url.pathname.startsWith("/images/")) || SANITY_ASSET_PATH.test(url.pathname),
  original: withoutQuery,
  quality: (url) => toQuality(url.searchParams.get("q")),
  qualityParam: "yes",
  defaultQuality: DEFAULT_SANITY_QUALITY,
};

/**
 * A legacy size before the extension of a Shopify file name: `_{w}x{h}`, `_{w}x`, `_{w}x{h}_crop_{pos}`, `_{w}x@2x`, or a
 * named size such as `_grande`.
 */
const SHOPIFY_LEGACY_SIZE =
  /_(?:\d+x\d*(?:_crop_[a-z]+)?|\d+x@2x|grande|large|medium|small|compact|thumb|icon|pico|master)(?=\.[A-Za-z0-9]+$)/;
/** The CDN's transform parameters (`width=640&quality=75`); `v` is the file version and is kept. */
const SHOPIFY_TRANSFORM_PARAMS = ["width", "height", "crop", "quality", "format"];
const shopify: LoaderAdapter = {
  name: "shopify",
  matches: (url) => url.hostname === "cdn.shopify.com" || /\/cdn\/shop\//.test(url.pathname),
  original(url) {
    const copy = new URL(withoutParams(url, SHOPIFY_TRANSFORM_PARAMS));
    // With a width param the CDN is resizing a file whose name is its own, so a size-like name is kept.
    if (!url.searchParams.has("width")) copy.pathname = copy.pathname.replace(SHOPIFY_LEGACY_SIZE, "");
    return copy.toString();
  },
  quality: (url) => toQuality(url.searchParams.get("quality")),
  qualityParam: "yes",
};

/** `/<cloud>/image/upload/<transformations…>/[v123/]<public id>` on res.cloudinary.com. */
const CLOUDINARY_UPLOAD = /^\/([^/]+)\/image\/upload\/(.+)$/;
/** A transformation segment: comma-separated `key_value` parameters, e.g. `w_400,q_80,f_auto`. */
const isTransformation = (segment: string): boolean => segment.split(",").every((param) => /^[a-z]{1,3}_/.test(param));
/** A segment with a parameter Cloudinary transforms by (width, height, crop, quality, format). */
const hasKnownParam = (segment: string): boolean => segment.split(",").some((param) => /^[whcqf]_/.test(param));

/**
 * On a host other than res.cloudinary.com, a leading segment is a transformation only when it is evidence of Cloudinary:
 * a known parameter, and either two parameters in the first transform segment or a version (`v123`) after the transforms.
 * This keeps a path such as `/c_logo/x.jpg` from matching.
 */
function isCloudinaryOnAnyHost(transforms: string[], rest: string[]): boolean {
  if (!transforms.some(hasKnownParam)) return false;
  const twoParams = transforms.length > 0 && transforms[0].split(",").length >= 2;
  const versioned = /^v\d+$/.test(rest[0] ?? "");
  return twoParams || versioned;
}

interface CloudinaryParts {
  /** The path before the transforms: `/<cloud>/image/upload` on res.cloudinary.com, empty on any other host. */
  base: string;
  transforms: string[];
  /** The version (when present) and the public id: kept. */
  rest: string[];
}

/**
 * A Cloudinary delivery path. On res.cloudinary.com: `/<cloud>/image/upload/…`. On any other host (a custom domain or a
 * CDN in front of Cloudinary): a path that starts with transformation segments, one with a known parameter at least, then
 * the version and the public id. The last segment is never a transform.
 */
function splitCloudinary(url: URL): CloudinaryParts | undefined {
  const upload = url.hostname === "res.cloudinary.com" ? CLOUDINARY_UPLOAD.exec(url.pathname) : null;
  const base = upload ? `/${upload[1]}/image/upload` : "";
  const segments = (upload ? upload[2] : url.pathname.slice(1)).split("/");
  let i = 0;
  while (i < segments.length - 1 && isTransformation(segments[i])) i++;
  const transforms = segments.slice(0, i);
  const rest = segments.slice(i);
  if (rest[rest.length - 1] === "") return undefined;
  if (!upload && !isCloudinaryOnAnyHost(transforms, rest)) return undefined;
  return { base, transforms, rest };
}

const cloudinary: LoaderAdapter = {
  name: "cloudinary",
  matches: (url) => splitCloudinary(url) !== undefined,
  original(url) {
    const parts = splitCloudinary(url);
    if (!parts) return undefined;
    return `${url.origin}${parts.base}/${parts.rest.join("/")}`;
  },
  quality(url) {
    const parts = splitCloudinary(url);
    const param = parts?.transforms.flatMap((segment) => segment.split(",")).find((p) => /^q_\d+$/.test(p));
    return param ? Number(param.slice(2)) : undefined;
  },
  qualityParamFor(url) {
    const parts = splitCloudinary(url);
    const auto = parts?.transforms.flatMap((segment) => segment.split(",")).some((p) => p.startsWith("q_auto"));
    return auto ? "auto" : "yes";
  },
  qualityParam: "yes",
};

const IMGIX_HOSTS = new Set(["datocms-assets.com", "images.prismic.io"]);
const imgix: LoaderAdapter = {
  name: "imgix",
  matches: (url) => url.hostname.endsWith(".imgix.net") || IMGIX_HOSTS.has(url.hostname) || [...IMGIX_HOSTS].some((h) => url.hostname.endsWith(`.${h}`)),
  original: withoutQuery,
  quality: (url) => toQuality(url.searchParams.get("q")),
  qualityParam: "yes",
  defaultQuality: DEFAULT_IMGIX_QUALITY,
};

/** Any other URL: no original; a quality only when the query says so. */
const generic: LoaderAdapter = {
  name: "generic",
  matches: () => true,
  original: () => undefined,
  quality: (url) => toQuality(url.searchParams.get("q")) ?? toQuality(url.searchParams.get("quality")),
  qualityParam: "yes",
};

/** Matched in order: the hosts and paths are disjoint, so the order only matters for the generic fallback last. */
const ADAPTERS: LoaderAdapter[] = [contentful, sanity, shopify, cloudinary, imgix, cloudflare, next];

/** Only http(s) originals leave an adapter: anything else (javascript:, data:, blob:) is unknown. */
function httpOnly(adapter: LoaderAdapter): LoaderAdapter {
  return {
    ...adapter,
    original(url) {
      const found = adapter.original(url);
      if (found === undefined) return undefined;
      try {
        const parsed = new URL(found);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** The adapter for one image URL as the page renders it, with the per-URL quality parameter applied. */
function specialise(adapter: LoaderAdapter, url: URL): LoaderAdapter {
  const qualityParam = adapter.qualityParamFor ? adapter.qualityParamFor(url) : adapter.qualityParam;
  return httpOnly({ ...adapter, qualityParam });
}

/** The loader of an image URL. `src` is resolved against `pageUrl` first. Throws when the URL does not parse. */
export function adapterFor(src: string, pageUrl: string): ResolvedLoader {
  const url = new URL(src, pageUrl);
  const hit = ADAPTERS.find((adapter) => adapter.matches(url)) ?? generic;
  return { adapter: specialise(hit, url), url };
}

/**
 * The untransformed original an image URL is made from, unwrapped once more when the first original is itself a
 * transformed URL (`/_next/image?url=<cdn URL>`). Undefined when the loader has no original.
 */
export function originalOf(src: string, baseUrl: string): string | undefined {
  const first = adapterFor(src, baseUrl);
  const once = first.adapter.original(first.url);
  if (once === undefined) return undefined;
  return unwrapOnce(once, first.adapter.name, baseUrl);
}

/**
 * A found original is unwrapped once more when it is a URL of another loader (a nested `/_next/image?url=<cdn URL>`).
 * The same loader is not applied again: its original is the file itself, and a second pass would drop a size-like name
 * that Shopify keeps when the URL had a width param.
 */
function unwrapOnce(found: string, from: string, baseUrl: string): string {
  const again = adapterFor(found, baseUrl);
  if (again.adapter.name === from) return found;
  return again.adapter.original(again.url) ?? found;
}

/**
 * The original an observed image was made from. An absolute http(s) `src` prop wins when the currentSrc's adapter does
 * not contradict it (it has no original, or the same one). Otherwise the adapter's original of currentSrc, else `src`
 * resolved against `baseUrl`. The result is unwrapped once more when it is itself a transformed URL.
 */
export function originalFor(currentSrc: string, src: string | undefined, baseUrl: string): string {
  const observed = adapterFor(currentSrc, baseUrl);
  const fromCurrent = observed.adapter.original(observed.url);
  const srcAbsolute = src !== undefined && /^https?:\/\//i.test(src);
  const agrees = srcAbsolute && (fromCurrent === undefined || fromCurrent === new URL(src as string).toString());
  let chosen: string;
  if (agrees) chosen = src as string;
  else if (fromCurrent !== undefined) chosen = fromCurrent;
  else chosen = new URL(src ?? currentSrc, baseUrl).toString();
  return new URL(unwrapOnce(chosen, observed.adapter.name, baseUrl), baseUrl).toString();
}

/** The Cloudflare rule alone: `/cdn-cgi/image/<opts>/<path>` gives `<path>`, anything else is resolved as it is. */
export function cloudflareOriginal(url: URL): string | undefined {
  return cloudflare.original(url);
}
