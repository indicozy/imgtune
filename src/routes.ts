// Route types: the template a page is an instance of. A storefront with one catalogue per locale or store has the same
// templates under every prefix, so the locale (`ae-en`, `sa_AR`, `en`) and the device variant (`desktop`, `mobile`) are
// stripped into dimensions, and the variable segments of the path (product slugs, ids, store names) collapse to `*`.
// The grouping reads the whole URL set: a segment is a variable one when its shape says so (digits, a long hyphenated
// slug, an id) or when its siblings are many single pages, and a `.html` leaf with many siblings is a listing or product
// family (`*.html`). A --route-map overrides the grouping for the URLs it matches. Pure functions: no browser, no files.

/** A locale segment: `en`, `ae-en`, `sa_AR`. Two of them in the set are needed before any is stripped (see groupRoutes). */
const LOCALE = /^[a-z]{2}(?:[-_][a-z]{2})?$/i;
/** The second segment of a locale-prefixed page that names its device variant, stripped into a dimension. */
const VARIANTS: ReadonlySet<string> = new Set(["desktop", "mobile"]);
/** Query parameters that only carry campaign or click tracking: dropped from a route type. */
const TRACKING = /^(utm_|fbclid$|gclid$|msclkid$)/i;
const HTML_LEAF = /\.html?$/i;
/** The `.html` leaves a parent needs before its leaves are read as one family (`*.html`). */
const HTML_FAMILY_MIN = 4;
/** The distinct children a parent needs before its single-page children are read as variable (`*`). */
const SIBLING_MIN = 4;
/** The share of single-page children that makes a parent's children variable. */
const SINGLE_SHARE = 0.8;

export interface RouteMapRule {
  /** The pattern as written (for messages). */
  pattern: string;
  /** Path segments: `*` is one segment, `*.html` one segment ending in .html, `**` the rest of the path (any depth). */
  segments: string[];
  /** Query parameter names the URL must carry (from `?name=*`). */
  params: string[];
  /** The route type the matching URLs get. */
  type: string;
}

/** One URL's route: its type, and the dimensions stripped from it. */
export interface RouteOf {
  url: string;
  type: string;
  locale?: string;
  variant?: string;
  /** True when a --route-map rule named the type. */
  mapped: boolean;
}

/** One route type: the URLs that are instances of it, and the dimensions they cover. */
export interface RouteType {
  type: string;
  urls: string[];
  locales: string[];
  variants: string[];
  mapped: boolean;
}

export interface RouteGrouping {
  /** One entry per distinct input URL, in input order. */
  routes: RouteOf[];
  /** The route types, the most URLs first (ties by type). */
  types: RouteType[];
  /** The route type of a URL of the set (the URL itself when it is not in the set). */
  typeOf(url: string): string;
}

interface Parsed {
  url: string;
  /** The path segments after the locale and variant are stripped (empty for the home page). */
  segs: string[];
  locale?: string;
  variant?: string;
  /** Query parameter names that stay in the type, sorted. */
  params: string[];
  /** False when the URL does not parse: it is its own type. */
  parsed: boolean;
}

/** The text of a route-map file: JSON `{ "pattern": "type" }`, or lines of `pattern => type` (`#` comments). */
export function parseRouteMap(text: string): RouteMapRule[] {
  const entries: [string, string, number][] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("--route-map is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--route-map JSON must be an object of pattern to type");
    for (const [pattern, type] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof type !== "string") throw new Error(`--route-map: the type of ${JSON.stringify(pattern)} must be a string`);
      entries.push([pattern, type, 0]);
    }
  } else {
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/#.*$/, "").trim();
      if (line === "") return;
      const at = line.indexOf("=>");
      if (at === -1) throw new Error(`--route-map line ${i + 1} is not "pattern => type"`);
      entries.push([line.slice(0, at).trim(), line.slice(at + 2).trim(), i + 1]);
    });
  }
  return entries.map(([pattern, type, line]) => {
    const where = line > 0 ? ` (line ${line})` : "";
    if (!pattern.startsWith("/")) throw new Error(`--route-map pattern ${JSON.stringify(pattern.slice(0, 200))} must start with /${where}`);
    if (pattern.indexOf("**") !== -1 && !pattern.split("?")[0].endsWith("/**")) {
      throw new Error(`--route-map pattern ${JSON.stringify(pattern.slice(0, 200))}: ** may only be the last segment${where}`);
    }
    if (type === "" || type.length > 200) throw new Error(`--route-map type for ${JSON.stringify(pattern.slice(0, 200))} must be 1 to 200 characters${where}`);
    const [path, query = ""] = pattern.split("?");
    const segments = path.split("/").filter((s) => s !== "");
    const params = query === "" ? [] : query.split("&").map((p) => p.split("=")[0]).filter((p) => p !== "");
    return { pattern, segments, params, type };
  });
}

/** Whether a rule's segments match a URL's path segments. */
function ruleMatches(rule: RouteMapRule, segs: string[], params: string[]): boolean {
  const wild = rule.segments.indexOf("**");
  if (wild === -1 ? rule.segments.length !== segs.length : segs.length < rule.segments.length - 1) return false;
  const head = wild === -1 ? rule.segments : rule.segments.slice(0, wild);
  for (let i = 0; i < head.length; i++) {
    const want = head[i];
    const got = segs[i];
    if (want === "*") continue;
    if (want === "*.html") {
      if (!HTML_LEAF.test(got)) return false;
      continue;
    }
    if (want !== got) return false;
  }
  return rule.params.every((name) => params.includes(name));
}

/** The stem of a segment: its `.html` removed. */
const stemOf = (segment: string): string => segment.replace(HTML_LEAF, "");

/** A segment that is an identifier: digits, a UUID, a long hex or mixed-case hash. */
function isIdLike(stem: string): boolean {
  if (/^\d+$/.test(stem)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)) return true;
  if (/^[0-9a-f]{8,}$/i.test(stem) && /\d/.test(stem)) return true;
  return stem.length >= 16 && !stem.includes("-") && /[a-z]/i.test(stem) && /\d/.test(stem);
}

/** A product or item slug: digits with a hyphen or a longer word (`aviator-1234`, `spc-000848-0101-glasses`), or a long hyphenated name. */
function isSlugLike(stem: string): boolean {
  const hyphens = (stem.match(/-/g) ?? []).length;
  if (/\d/.test(stem) && (hyphens >= 1 || stem.length >= 8 || /\d{3,}/.test(stem))) return true;
  return hyphens >= 3;
}

function parseUrlParts(url: string): Parsed {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { url, segs: [], params: [], parsed: false };
  }
  const segs = target.pathname.split("/").filter((s) => s !== "").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const params = [...new Set([...target.searchParams.keys()].filter((name) => !TRACKING.test(name)))].sort();
  return { url, segs, params, parsed: true };
}

/**
 * Groups URLs into route types. The first segment is a locale when the set has at least two distinct locale-shaped first
 * segments; a locale followed by `desktop` or `mobile` also strips that variant. Then the path is grouped top-down: at
 * each parent, a child is variable when it is an identifier or a slug, when it is a `.html` leaf and its parent has at
 * least HTML_FAMILY_MIN such leaves, or (below the root) when the parent has at least SIBLING_MIN children and most of them
 * are single pages. Variable children share one label (`*`, or `*.html` for leaves), so their subtrees merge.
 */
export function groupRoutes(urls: string[], options: { routeMap?: RouteMapRule[] } = {}): RouteGrouping {
  const distinct = [...new Set(urls)];
  const parts = distinct.map(parseUrlParts);
  const localeNames = new Set(parts.filter((p) => p.parsed && p.segs.length > 0 && LOCALE.test(p.segs[0])).map((p) => p.segs[0]));
  const stripLocale = localeNames.size >= 2;
  for (const p of parts) {
    if (!p.parsed || !stripLocale || p.segs.length === 0 || !LOCALE.test(p.segs[0])) continue;
    p.locale = p.segs[0];
    p.segs = p.segs.slice(1);
    if (p.segs.length > 0 && VARIANTS.has(p.segs[0])) {
      p.variant = p.segs[0];
      p.segs = p.segs.slice(1);
    }
  }

  const routeMap = options.routeMap ?? [];
  const labels: string[][] = parts.map(() => []);
  const mapped: (string | undefined)[] = parts.map((p) => {
    if (!p.parsed) return undefined;
    return routeMap.find((rule) => ruleMatches(rule, p.segs, p.params))?.type;
  });

  // Top-down grouping over the URLs that the route map does not name.
  const unmapped = parts.map((p, i) => i).filter((i) => parts[i].parsed && mapped[i] === undefined);
  const visit = (members: number[], depth: number): void => {
    const rest = members.filter((i) => parts[i].segs.length > depth);
    if (rest.length === 0) return;
    const byValue = new Map<string, number[]>();
    for (const i of rest) {
      const value = parts[i].segs[depth];
      const list = byValue.get(value);
      if (list) list.push(i);
      else byValue.set(value, [i]);
    }
    const singles = [...byValue.values()].filter((list) => list.length === 1).length;
    const singleShare = singles / byValue.size;
    const htmlLeaves = [...byValue.entries()].filter(([value, list]) => HTML_LEAF.test(value) && list.every((i) => parts[i].segs.length === depth + 1)).length;
    const byLabel = new Map<string, number[]>();
    for (const [value, list] of byValue) {
      const leaf = list.every((i) => parts[i].segs.length === depth + 1);
      const stem = stemOf(value);
      let label: string;
      const htmlLeaf = leaf && HTML_LEAF.test(value);
      const family = depth >= 1 && byValue.size >= SIBLING_MIN && singleShare >= SINGLE_SHARE;
      // A product or item (an id or a slug, with or without .html) is `*`; a listing family of .html leaves is `*.html`.
      if (isIdLike(stem) || isSlugLike(stem)) label = "*";
      else if (htmlLeaf && htmlLeaves >= HTML_FAMILY_MIN) label = "*.html";
      else if (family) label = htmlLeaf ? "*.html" : "*";
      else label = value;
      for (const i of list) labels[i][depth] = label;
      const group = byLabel.get(label);
      if (group) group.push(...list);
      else byLabel.set(label, [...list]);
    }
    for (const group of byLabel.values()) visit(group, depth + 1);
  };
  visit(unmapped, 0);

  const routes: RouteOf[] = [];
  parts.forEach((p, i) => {
    if (!p.parsed) {
      routes.push({ url: p.url, type: p.url, mapped: false });
      return;
    }
    const path = labels[i].length > 0 ? `/${labels[i].join("/")}` : p.segs.length > 0 ? `/${p.segs.join("/")}` : "/";
    const isMapped = mapped[i] !== undefined;
    const base = isMapped ? mapped[i]! : path;
    const query = !isMapped && p.params.length > 0 ? `?${p.params.map((name) => `${name}=*`).join("&")}` : "";
    const route: RouteOf = { url: p.url, type: `${base}${query}`, mapped: isMapped };
    if (p.locale !== undefined) route.locale = p.locale;
    if (p.variant !== undefined) route.variant = p.variant;
    routes.push(route);
  });

  return routeGrouping(routes);
}

/** The grouping of a list of routes: the types (the most URLs first), and the type of each URL. */
export function routeGrouping(routes: RouteOf[]): RouteGrouping {
  const byUrl = new Map(routes.map((r) => [r.url, r]));
  const typeMap = new Map<string, RouteType>();
  for (const route of routes) {
    let entry = typeMap.get(route.type);
    if (!entry) {
      entry = { type: route.type, urls: [], locales: [], variants: [], mapped: route.mapped };
      typeMap.set(route.type, entry);
    }
    entry.urls.push(route.url);
    if (route.locale !== undefined && !entry.locales.includes(route.locale)) entry.locales.push(route.locale);
    if (route.variant !== undefined && !entry.variants.includes(route.variant)) entry.variants.push(route.variant);
  }
  const types = [...typeMap.values()]
    .map((t) => ({ ...t, locales: t.locales.sort(), variants: t.variants.sort() }))
    .sort((a, b) => b.urls.length - a.urls.length || a.type.localeCompare(b.type));
  return {
    routes,
    types,
    typeOf: (url: string) => byUrl.get(url)?.type ?? url,
  };
}

/**
 * The grouping restricted to some of its URLs (a sample): the same types, computed on the whole set, with only the given
 * URLs counted. The types are not regrouped, so a sample does not change the shape of a type.
 */
export function restrictRoutes(grouping: RouteGrouping, urls: string[]): RouteGrouping {
  const keep = new Set(urls);
  return routeGrouping(grouping.routes.filter((r) => keep.has(r.url)));
}
