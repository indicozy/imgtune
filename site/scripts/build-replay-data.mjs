// Builds the data the website shows, from two inputs, and checks the committed JSON.
//
//   node scripts/build-replay-data.mjs --replay <dir> --results <results.md>   write site/data/*.json
//   node scripts/build-replay-data.mjs --check                                 validate site/data/*.json (run before build)
//
// --replay is a folder of `imgtune scan` output, one folder per site (summary.json and <host>-<page>.json inside).
// Only the five open-source sites named in REPLAY_SITES are read. Sample image URLs are not written: a sample
// filename can carry a name the site must not show. --results is docs/study/results.md; its v4 table
// supplies the study numbers. Production sites are written as anonymous A1-A6 rows.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "..", "data");
const REPLAY_SITES = ["tailwindcss.com", "ui.shadcn.com", "supabase.com", "nextjs.org", "langfuse.com"];
// Every open-source host the study names (v4 table). Only these may appear in the data.
const OSS_HOSTS = [...REPLAY_SITES, "turborepo.com", "docs.sentry.io", "www.openstatus.dev"];
const VIEWPORT_NAMES = ["iphone-se", "iphone-15", "pixel-7", "iphone-15-pro-max", "desktop", "desktop-1280"];
const TOP_GROUPS = 5;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function readPage(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// One page: totals from the scan's own page numbers, top groups rebuilt with exact and est. kept apart.
function pageReplay(json) {
  const viewports = json.viewports.filter((v) => json.perViewport[v]);
  const nView = viewports.length || 1;
  const byGroup = new Map();
  for (const v of viewports) {
    for (const img of json.perViewport[v].images) {
      if (img.kind === "skipped" || !img.group) continue;
      const g = byGroup.get(img.group) ?? { members: new Set(), exact: 0, est: 0, slot: [], needed: [], served: [], loader: img.loader };
      g.members.add(img.url);
      g.exact += img.exactSaved;
      g.est += img.estSaved;
      g.slot.push(img.renderedWidth);
      g.needed.push(img.needed);
      g.served.push(img.pixelWidth);
      byGroup.set(img.group, g);
    }
  }
  const groups = [...byGroup.values()]
    .map((g) => ({
      loader: g.loader,
      members: g.members.size,
      slotCssPx: Math.round(median(g.slot)),
      neededPx: Math.round(median(g.needed)),
      servedPx: Math.round(median(g.served)),
      exactKb: round1(g.exact / nView / 1024),
      estKb: round1(g.est / nView / 1024),
    }))
    .filter((g) => g.exactKb + g.estKb > 0)
    .sort((a, b) => b.exactKb + b.estKb - (a.exactKb + a.estKb))
    .slice(0, TOP_GROUPS);
  const p = json.page;
  let path = "/";
  try {
    path = new URL(json.url).pathname || "/";
  } catch {
    path = "/";
  }
  return {
    path,
    kbPerView: Math.round(p.meanImageBytes / 1024),
    exactPct: round2(p.exactPct),
    exactEstPct: round2(p.exactEstPct),
    groups,
  };
}

function buildReplay(dir) {
  const sites = [];
  for (const host of REPLAY_SITES) {
    const folder = join(dir, host);
    if (!existsSync(folder)) throw new Error(`missing scan folder for ${host}`);
    const files = readdirSync(folder).filter((f) => f.startsWith(`${host}-`) && f.endsWith(".json"));
    const okPages = files
      .map((f) => readPage(join(folder, f)))
      .filter((j) => j.status === "ok" && j.page)
      .sort((a, b) => a.url.localeCompare(b.url));
    const pages = okPages.map(pageReplay);
    if (pages.length === 0) throw new Error(`no ok pages for ${host}`);
    const first = readPage(join(folder, files[0]));
    sites.push({
      site: host,
      scannedAt: first.scannedAt.slice(0, 10),
      imgtuneVersion: first.imgtuneVersion,
      metric: "SSIMULACRA2, delta 2",
      viewports: VIEWPORT_NAMES,
      // Site figures are the mean of the page values, as in the study (values taken before rounding).
      kbPerView: Math.round(mean(okPages.map((j) => j.page.meanImageBytes / 1024))),
      exactPct: round1(mean(okPages.map((j) => j.page.exactPct))),
      exactEstPct: round1(mean(okPages.map((j) => j.page.exactEstPct))),
      pages,
    });
  }
  return { sites, note: "Browser-free data: produced by scripts/build-replay-data.mjs from imgtune scan JSON." };
}

// The study's v4 production and open-source tables, from results.md (the part under "## v4").
function parseStudy(md) {
  const v4 = md.slice(md.indexOf("## v4"));
  const rows = v4.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("|---") && !l.startsWith("| site") && !l.startsWith("| open-source"));
  const production = [];
  const oss = [];
  for (const line of rows) {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const pct = (s) => Number(s.replace("%", "").replace(/,/g, ""));
    if (/^A\d/.test(cells[0])) {
      production.push({ id: cells[0].split(" ")[0], kb: Number(cells[1].replace(/,/g, "")), exactPct: pct(cells[2]), exactEstPct: pct(cells[3]), fixablePct: pct(cells[4]) });
    } else if (OSS_HOSTS.includes(cells[0])) {
      oss.push({ site: cells[0], kb: Number(cells[1].replace(/,/g, "")), exactPct: pct(cells[2]), exactEstPct: pct(cells[3]), fixablePct: pct(cells[4]) });
    }
  }
  return { version: "v4", tag: "study-v4-2026-10-28", production, openSource: oss };
}

function check() {
  const problems = [];
  const replayFile = join(DATA, "replay.json");
  const studyFile = join(DATA, "study.json");
  for (const f of [replayFile, studyFile]) {
    if (!existsSync(f)) problems.push(`missing ${f}`);
  }
  if (problems.length === 0) {
    const replay = JSON.parse(readFileSync(replayFile, "utf8"));
    const names = replay.sites.map((s) => s.site);
    for (const host of names) if (!OSS_HOSTS.includes(host)) problems.push(`replay host not allowed: ${host}`);
    for (const host of REPLAY_SITES) if (!names.includes(host)) problems.push(`replay host missing: ${host}`);
    const text = readFileSync(replayFile, "utf8") + readFileSync(studyFile, "utf8");
    if (/\/home\/|[A-Z]:\\\\|\/Users\//.test(text)) problems.push("local path in data");
    const urls = [...text.matchAll(/https?:\/\/([^/"\s]+)/g)].map((m) => m[1]);
    for (const host of new Set(urls)) if (!OSS_HOSTS.includes(host)) problems.push(`non-open-source host in data: ${host}`);
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("data ok");
}

if (args.includes("--check")) {
  check();
} else {
  const replayDir = flag("--replay");
  const results = flag("--results");
  if (!replayDir || !results) {
    console.error("usage: --replay <scan folder> --results <results.md>  |  --check");
    process.exit(2);
  }
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, "replay.json"), JSON.stringify(buildReplay(replayDir), null, 2) + "\n");
  writeFileSync(join(DATA, "study.json"), JSON.stringify(parseStudy(readFileSync(results, "utf8")), null, 2) + "\n");
  console.log("wrote site/data/replay.json and site/data/study.json");
}
