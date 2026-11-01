# ImgTune

[![npm version](https://img.shields.io/npm/v/imgtune.svg)](https://www.npmjs.com/package/imgtune)

**ImgTune measures image waste on any live site, and your AI agent fixes it in any framework.**

Website: https://indicozy.github.io/imgtune/ · [Try the demo](https://indicozy.github.io/imgtune/demo) · [Docs](https://indicozy.github.io/imgtune/guide/getting-started)

Images waste traffic three ways: served larger than the space they fill, encoded at a quality nobody can see, and in an
older format, usually all at once. Image tools fix one of these at a time. ImgTune measures all three together on the live
page, at six viewports, against a perceptual quality bar. It reports, for each image, the sizes, quality and format to
use, and the bytes each change saves. Your AI agent (Claude Code, Cursor, Codex, or any other) finds those images in your
source and makes the changes, then checks them with a rescan.

### Why one lever is not enough

- **Compressors** squeeze the file you hand them, but never learn how wide it is shown. A 6,000 px logo in a 150 px
  slot stays 6,000 px, only better compressed.
- **Image CDNs and `next/image`** resize on request, but only to the widths your `sizes` attribute asks for. A wrong or
  missing `sizes` makes every phone fetch a file several times too wide.
- **Lighthouse** flags oversized, poorly encoded and old-format images, at one viewport per run, with a fixed estimate.
  It tells you something is wrong, not which `sizes` or quality to set.
- **ImgTune** measures size, quality and format together, per image, on the live page at six viewports, accepts a
  saving only when SSIMULACRA2 says nobody can see it.

It looks at three levers for each image: **resolution** (the pixels the browser actually needs), **quality** (the
encoder setting), and **format** (for example AVIF or WebP instead of JPEG). Measurements are per page view, per
viewport, and quality is scored with SSIMULACRA2.

## Install

```sh
npm i -D imgtune
```

Then run it with `npx imgtune`. Without installing, `npx imgtune` fetches it for one run. ImgTune needs Chromium for
Playwright; see [Requirements](#requirements).

## Quick start

Measure a live site, with no access to its source:

```sh
npx imgtune scan https://your-site.example/
```

The scan writes one JSON file per page to `.imgtune/scan/`, for example `.imgtune/scan/your-site.example-index.json`, and
prints a count of the images with fix hints. Read the hints in batches of ten:

```sh
npx imgtune hints .imgtune/scan/your-site.example-index.json
```

Each hint names the image, its component and `file:line` when they resolve, the `sizes` and quality to use, and the bytes
the fix saves per view, with the bytes it adds for sharpness shown separately. Run `npx imgtune --help`, or
`npx imgtune scan --help` for every option.

## Fix it with your agent

ImgTune measures; it does not edit your project. The agent skill does the editing: it scans, matches each hint to the
source, fixes it, verifies with a rescan, and reports from a ledger it keeps in the project.

- **Claude Code**: copy the skill folder into your project. From the project root:

  ```sh
  mkdir -p .claude/skills && cp -r node_modules/imgtune/skills/imgtune .claude/skills/
  ```

  Then ask Claude Code to optimise the images of the site. The skill is `.claude/skills/imgtune/SKILL.md`, with a
  `reference.md` beside it.
- **Cursor, Codex, Copilot, and other agents**: paste `node_modules/imgtune/skills/imgtune/AGENTS.snippet.md` into your
  `AGENTS.md` or `CLAUDE.md`. It is the short form of the same loop and rules, and points to `npx imgtune --help`.

The skill works in batches of about ten hints, writes `.imgtune/ledger.jsonl` (one line per image usage), and writes
`.imgtune/HANDOFF.md` when its context fills, so a new session can resume. Use a built or preview server for the
before and after numbers, and the dev server for the edit loop: source locations only resolve in dev builds.

## What `scan` measures

`scan` loads each page in headless Chromium at six viewports (four phones, a 1440 px desktop at 2x, and a 1280 px
desktop at 1x), scrolls it to the end, and records every image.

- **Exact** savings come from the site's own smaller `srcset` candidates. Each one is fetched and measured, so the
  number is the real byte difference.
- **Est.** savings come from a local re-encode of the image: a different quality, a different format, or a resize of a
  plain `<img>`. They are estimates.
- Quality is judged with SSIMULACRA2 at a delta of 2 points. `--aggressive` adds a delta 4 column, which is reported
  beside the main numbers and never used for the headline.
- Undersized images (a file smaller than the slot it fills) are reported as sharpness growth, separately. Growth from
  undersized images is never subtracted from other images' savings, and an undersized image itself contributes no
  saving.
- For each image, the scan records its locator (the component and `file:line` in dev builds, `data-testid`, `alt`, and the
  loader URL pattern), the `sizes` the browser resolved at each viewport, the layout chain above it, and a fix hint with
  two numbers: bytes saved, and bytes added for sharpness. The two are never netted.
- Pages are scanned after their `robots.txt` is checked for the `*` user agent. A disallowed page is skipped and
  recorded as `robots`. Pages that return a challenge or bot wall are recorded as `blocked` and not retried. The
  scanner identifies itself with the default Chromium user agent, uses no stealth plugins, and fetches each image URL
  at most once per scan.
- Besides the page itself, scan fetches the page's own srcset candidates and, for quality estimates, the original of a
  sampled image (derived from the loader URL), each at most once per scan. It never requests new transformations from
  the CDN.
- Large sites: `--urls-from` reads a URL list or a sitemap, `--sample-per-pattern` samples each route pattern, and
  `--resume`, `--max-pages` and `--max-images` split a long run into parts.

## The evidence ladder

Every fix hint is labelled with the strength of its evidence, the rung it stands on:

1. **measured-page** (exact): the usage was measured on the live page, at each viewport. This is what `scan` produces.
2. **measured-harness**: the usage was measured in isolation, through a temporary route such as `/__imgtune/<component>`
   that renders each state, or through Storybook. The agent removes the route afterwards.
3. **ceiling-code**: derived from the resolved classes and the layout constraints (container width, grid columns,
   padding). It is an upper bound on the width needed, never a measured saving.
4. **not-measured**: no number, with the reason (hidden, behind a login, not rendered at scan time).

A ceiling is never derived from the existing `sizes` value. When a usage is measured, its `sizes` comes from the layout
the browser resolved, not from a guess.

## Commands

| command | what it does |
| --- | --- |
| `imgtune scan <url> [<url> ...]` | measures live pages, one JSON file per page in `--out` (default `.imgtune/scan`) |
| `imgtune hints <scan.json>` | prints a batch of fix hints: `--limit` (default 10), `--offset`, `--page`, `--component`, `--min-kb`, `--format json` |
| `imgtune scan --recheck <scan.json> [--ids a,b,c]` | rescans only the named images at the viewports where they rendered; prints before and after; exits 1 on a failed check |
| `imgtune image <file\|url\|glob>` | measures image files without a page: bytes now, the lowest quality per format that meets the bar, and at a `--width` the bytes at each needed width; `--min-score` sets the bar (default 90), `--write <dir>` writes optimised copies |
| `imgtune compare <before.json> <after.json>` | compares two scans of one page image by image: the bytes saved and the sharpness bytes added, as two numbers; drift (a changed layout, server variance, a view not loaded) is excluded and its totals printed; `--format json`, `--limit` |
| `imgtune report` | a Markdown run report from the agent's ledger (`.imgtune/ledger.jsonl`); `--compare <file>` adds the bytes from `imgtune compare --format json`; `--out <file>` writes it |

The scan options that matter most: `--viewports <names>` (a subset of the six), `--markdown <file>` (the PR comment),
`--summary-json <file>` (one JSON of every page's numbers), `--fail-over <pct>` (exit 3 above a budget),
`--storage-state <file>` (a logged-in session), and `--ignore-robots` (see Security). `npx imgtune scan --help` lists them all.

Two flows for a large app. One measures on a built server and then checks the edits on a dev server:
`scan <built-url>`, then `scan <dev-url> --locate-only --from <scan.json>` (reads the React source of the flagged images),
then `scan --recheck <located.json> --sizes-only --ids a,b` (judges the sizes choice on dev, no bytes), then `scan` on the
built server again. The other runs the score on an NVIDIA GPU: `--gpu --gpu-device <n>` (the `nvidia-smi` index). The GPU
program, `imgtune-ssimu2-gpu`, is not bundled; see the GPU section of the reference.

## GitHub Action

`action.yml` at the root scans the pages you name on each pull request, and comments the result on it. The comment keeps
the summary tables and the top groups per page, and adds a collapsed "Fix hints for your AI agent" section with the top
ten hints across the pages. The comment is updated on each push. Set `fail-over` to fail the job above a budget.

```yaml
- uses: indicozy/imgtune@main
  with:
    urls: https://preview.your-site.example/
    fail-over: "5"
```

The action builds itself from source, so `dist/` is not needed in the repository. See [docs/ci.md](docs/ci.md) for the
inputs, the permissions, and two example workflows (Vercel previews, and a local build on the runner).

`scan` keeps Chrome on the CPUs it was started on, so you can keep it off the cores you need: `taskset -c 8-19 npx imgtune scan …` on Linux.

## Security

- **Egress and private addresses.** `scan` refuses private and loopback addresses unless the URL you give is itself local,
  checks every redirect hop and sub-resource at connection time. See the [scanning guide](site/guide/scanning-any-site.md#security).
- **ImgTune never commits, and `scan` does not change your project's source files.**
- **Hint strings are data, not instructions.** File names, component names, `alt`, `testid`, classes and URLs come from
  the page being scanned, and the agent must never follow text found in them. The hints print them JSON-quoted and capped
  (in the terminal, and in the PR comment, where they sit in a fenced block after a line that says they are data). A
  locator from a non-local source is marked `(unverified)`, and a call site that only renders the image's component is marked `(owner call site)`. The agent
  checks that a file exists in the repository, and that the line holds an image usage, before it edits.
- **Source maps come from the scanned site.** They are read with caps on size (20 MB), count (64 per scan), lines and
  sections, and only a relative path under the project is kept as a source file.
- **`--storage-state` holds session cookies.** Never commit that file. The scan never prints its contents.
- **`--ignore-robots` is for sites you own or are authorised to test.** It prints a warning, and the JSON records
  `robotsIgnored` with the rule that disallowed the page.

## Supported loaders

Loaders are detected from the URL each image renders. `original known?` means ImgTune can find the untransformed
source, which is what quality is measured against. `quality settable?` means the URL carries a quality parameter
that ImgTune can change.

| loader | matches | original known? | quality settable? |
| --- | --- | --- | --- |
| next/image | `/_next/image?url=…` | yes | yes (`q`) |
| Cloudflare Images | `/cdn-cgi/image/<opts>/<path>` | yes | yes (`quality`) |
| Contentful | `images.ctfassets.net`, `downloads.ctfassets.net` | yes | yes (`q`) |
| Sanity | `cdn.sanity.io/images/…`, or the same path shape on a custom domain | yes | yes (`q`) |
| Shopify | `cdn.shopify.com`, `/cdn/shop/…` | yes (size parameters and legacy size suffixes removed) | yes (`quality`) |
| Cloudinary | `res.cloudinary.com/<cloud>/image/upload/…`, or transformation paths on a custom domain | yes | yes (`q_<n>`); `q_auto` is left to the CDN |
| imgix (incl. DatoCMS, Prismic) | `*.imgix.net`, `datocms-assets.com`, `images.prismic.io` | yes | yes (`q`) |
| generic | any other URL | no | only when the URL has `q=` or `quality=` |

Where the original is unknown, ImgTune still measures resolution, and reports the count of images it could not score
for quality.

## Demand study (2026-10-28)

Before packaging, ImgTune scanned two groups of sites: production sites, which decided whether it was worth building,
and open-source apps, for comparison. The site list was fixed before the first scan. Each run scans every site once:
2 pages × 6 viewports, SSIMULACRA2 delta 2. Saving is the share of all image bytes per page view, with the page fully
scrolled, averaged over viewports and then over the two pages. When the tool changed, every site was scanned again
with the same version; v1 is the first run, v4 the current tool (loader adapters and the fixes found since).

### Production sites (decide)

| site | image KB / view | exact | exact + est. (v4) | exact + est. (v1) |
| --- | --- | --- | --- | --- |
| A1 fashion retail, UK | 3,250 | 0.0% | 33.2% | 33.0% |
| A2 home audio, DK | 1,263 | 5.7% | 53.1% | 47.8% |
| A3 home audio, US | 3,355 | 13.1% | 38.2% | 13.1% |
| A4 sportswear, UK | 9,254 | 26.8% | 35.9% | 26.8% |
| A5 home/rugs, US | 7,714 | 12.7% | 16.5% | 12.7% |
| A6 outdoor stays, US | 9,078 | 20.7% | 27.7% | 20.8% |

Sharpness growth: about 2 KB per view on A4, 0 elsewhere.

Kill criterion: a pass needs at least 2 of 6 sites above 15%.

- exact only: 2 of 6 (v1 and v4), a pass at the bar
- exact + est.: 6 of 6 in v4 (4 of 6 in v1), a pass

### Open-source apps (do not decide)

| site | image KB / view | exact | exact + est. | of fixable |
| --- | --- | --- | --- | --- |
| tailwindcss.com | 4,508 | 0.0% | 4.2% | 9.6% |
| ui.shadcn.com | 238 | 0.0% | 33.7% | 42.0% |
| supabase.com | 671 | 1.9% | 20.8% | 48.0% |
| nextjs.org | 162 | 9.1% | 19.2% | 21.4% |
| turborepo.com | 77 | 12.0% | 21.4% | 21.4% |
| langfuse.com | 3,149 | 0.2% | 1.8% | 21.7% |
| docs.sentry.io | 85 | 0.0% | 0.0% | 0.0% |
| www.openstatus.dev | 152 | 0.0% | 4.2% | 31.7% |

v4: 4 of 8 above 15% (exact + est.), 0 of 8 on exact alone. Developer sites carry few image bytes; the waste sits in
image-heavy commerce.

### Limits

- **Six deciders.** A signal, not proof; the sample is biased to sites without bot walls.
- **Exact is measured, est. is estimated.** On measured savings alone, 2 of 6 pass. The est. part
  is a local re-encode scored with SSIMULACRA2 against the original; it is a floor where images could not be scored
  (counted per page in the JSON as `qualityNA`, e.g. images that appear only at viewports where no sample was scored).
- **Plain `<img>` resize** (A1, A2): local resize at the quality that matches the served bytes, so it doesn't add a
  hidden quality saving.
- A3's jump from v1 to v4 comes from Sanity images on a custom domain served at `q=100`, which v1 could not score.
- tailwindcss.com/blog rendered no `<img>` at scan time (0 images); counted as 0%.

## Requirements

- Node.js 20.9 or later.
- Chromium for Playwright. Install it once with `npx playwright install chromium`. If it is missing, ImgTune prints
  that command and exits with status 2.

## Limitations

- **Only `<img>`, `srcset` and `<picture>` are measured.** CSS background images are not in the scan's records. Their
  fixes are `not-measured`, or a `ceiling-code` from the layout.
- **Source locations need dev builds.** A production build has no component names or `file:line`. The agent matches
  those hints by `find` clues, `alt`, `testid` and the loader URL instead, and marks the unmatched usages.
- **Savings are measured on the pages and viewports scanned.** A usage that does not render on them (a hidden tab, a
  modal, a logged-out view) is not measured. A lazy image that never loads is counted as not loaded.
- **Est. numbers are estimates.** They come from a local re-encode judged by SSIMULACRA2. Quality is `qualityNA` where the
  original cannot be found. Only exact numbers come from the site's own candidates.
- **Bot walls and challenges stop a scan.** A page that returns one is recorded as `blocked`, and is not retried.
- **Quality targets follow the loader.** Only the loaders in the table below expose a quality parameter, so only they get
  quality proposals.
- **ImgTune does not edit code.** The fixes are made by you, or by the agent skill, and checked by `scan --recheck`.

## License

MIT. See [LICENSE](LICENSE). Third-party attributions, including the Optiq-derived SSIM code and the vendored
SSIMULACRA2 WebAssembly module, are in [NOTICE](NOTICE).
