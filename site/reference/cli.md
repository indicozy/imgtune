# CLI commands and flags

```sh
npx imgtune <command> [options]
npx imgtune --help
npx imgtune <command> --help
npx imgtune --version
```

ImgTune needs Node.js 20.9 or later and Chromium for Playwright (`npx playwright install chromium`). When Chromium is missing,
ImgTune prints that command and exits with status 2. `image` and `hints` need no browser.

## Commands

| command | what it does |
| --- | --- |
| `run` | the whole flow in one command: survey every URL, full-scan the worst pages, locate them on a dev server (`--dev`), group the fix hints by call site, write a run directory with a manifest, and print a one-screen summary |
| `summary` | the one-screen summary of a run directory or of scan files (at most 40 lines) |
| `scan` | measure live pages by URL on a built server (no source needed). Writes one JSON file per page. With `--locate-only`, reads the source of the flagged images from a dev page. With `--recheck`, rechecks fixed images (`--sizes-only` on dev, in seconds) |
| `hints` | print a batch of the per-image fix hints of one or more scan files (one per page) |
| `image` | measure image files or URLs without a page: the bytes, the lowest quality per format, and the bytes at a width |
| `compare` | the per-image before and after of two scans of one page: saved and added-for-sharpness bytes, paired by URL pattern and alt |
| `report` | a Markdown run report from the agent's ledger, with the compare JSON for the bytes |

## run

```sh
npx imgtune run <url> [<url> ...] [options]
npx imgtune run --urls-from <file|sitemap-url> [--sample-per-pattern <N>] [options]
```

One command for the agent flow. It runs, in order:

1. **survey**: every URL (`scan --survey`: two viewports, exact savings only, no estimate).
2. **worst pages**: ranked by exact KB per view, then by route pattern. `--deep <N>` (default 5) pages are chosen: the worst
   page of each worst pattern first, then the worst pages overall. Broken pages are not ranked.
3. **deep**: a full scan of those pages (six viewports, exact and est.). `--gpu`, `--gpu-device`, `--page-concurrency`,
   `--idle-timeout`, `--no-cache`, `--root`, `--storage-state` and `--ignore-robots` pass through.
4. **locate** (with `--dev <origin>`): each deep page at the same path on the dev server (`scan --locate-only`).
5. **hints**: the fix hints of the deep pages (or of their located copies), grouped by call site, as `hints.json`.

Options: `--out <dir>` (default `.imgtune/run/<timestamp>`), `--qualities <list>` (passed to hints), `--deep <N>`,
`--dev <origin>`. Run `imgtune run --help` for all of them.

The run directory has a stable layout: `urls.txt`, `survey/`, `deep/`, `located/` (with `--dev`), `hints.json` and
`run.json`. The manifest names every file, the phase timings, every broken page with its reason and fix, and every command
the run executed (relative to the working directory), so one step can be re-run by hand.

The printed summary is the same text `imgtune summary <run dir>` prints. It is at most 40 lines: the survey totals, the worst
patterns, the deep pages (KB per view, exact, exact + est., sharpness), the top 10 call sites by KB per view saved with
their `file:line` (or `not located` and why), the warnings and the next commands.

Fail fast: when more than half of the survey pages are broken, or none was measured, `run` stops before the deep phase,
prints the reason and the likely fix, and exits 4 (1 when no page was measured). Exit 0 otherwise.

## summary

```sh
npx imgtune summary <run dir>
npx imgtune summary <scan.json> [<scan.json> ...] [--qualities <list>]
```

Prints the same one-screen summary from a run directory (its `run.json`, `survey/`, `deep/`, `located/`, `hints.json`), or
from scan files (a folder of scan files works too). It reads no other JSON.

## scan

```sh
npx imgtune scan <url> [<url> ...] [options]
npx imgtune scan --urls-from <file|sitemap-url> [options]
npx imgtune scan <dev-url> --locate-only --from <scan.json> [--viewports <name>] [--locate-out <file>]
npx imgtune scan --recheck <scan.json> [--ids a,b,c]
npx imgtune scan --recheck <located.json> --sizes-only [--ids a,b,c] [--url <dev-url>]
```

Measure live pages by URL. Writes one JSON file per page to `--out`.

| flag | meaning |
| --- | --- |
| `--out <dir>` | directory for the JSON files (default: `.imgtune/scan`) |
| `--aggressive` | also report a delta 4 column (never used for the claim) |
| `--viewports <names>` | comma-separated viewport names to measure (default: all six) |
| `--survey` | a fast site-wide pass: viewports `iphone-15` and `desktop`, no quality estimate, `--page-concurrency 4`, `--idle-timeout 3000`. Exact savings only, labelled in the output. An explicit flag overrides its part |
| `--page-concurrency <N>` | scan up to N pages at once on the shared browser, 1 to 6 (default 1). Results keep the input order |
| `--idle-timeout <ms>` | cap on the wait for network idle after scroll, 0 to 600000 (default 10000). `0` skips the wait |
| `--shared-loads` | one page load per viewport class (mobile, desktop) instead of one per viewport, each in its own browser context (the default). The other viewports of a class change the viewport and DPR of the open page (re-scrolled and settled, no reload). Saves CPU but costs wall time (survey: 98.7 s shared against 69.1 s fresh). The numbers are the same in the equivalence check; the mode is recorded in each page's options, so `--resume` and `compare` never mix the two silently |
| `--root <dir>` | the folder project source files are read from, for `--locate-only` and source checks. Default: the nearest folder above the cwd that holds the file, else the nearest with a `package.json` or `.git`. Unread sources are named in the output with the folder they were looked up in |
| `--no-quality` | skip the SSIMULACRA2 quality measurement |
| `--markdown <file>` | write a PR-comment Markdown summary: per page, its top groups and the method |
| `--fail-over <pct>` | exit 3 when a page's exact + est. share is above this percentage (default: never fail) |
| `--fail-on-broken` | exit 4 when a page is broken: a document error, a failed stylesheet, or no images where the survey had some. Each broken page prints its reason and fix. Broken pages are left out of every total |
| `--summary-json <file>` | write one JSON file with every page's status and numbers |
| `--ignore-robots` | scan a page even when robots.txt disallows it (a warning is printed; the verdict is recorded in the JSON) |
| `--resume` | reuse the complete pages already in `--out` that were scanned with the same options |
| `--max-pages <N>` | stop after N pages (scanned or resumed); run again with `--resume` to continue |
| `--no-cache` | do not read or write `.imgtune/cache`. The cache keeps the local encode sizes and scores, so a rescan or a second run reuses them; the numbers are the same either way |
| `--max-images <N>` | stop after the page that brings the images counted to N (checked between pages) |
| `--urls-from <file\|sitemap-url>` | scan the URLs of a text file (one per line, `#` comments), a local `sitemap.xml`, or a remote sitemap (same domain only) |
| `--sample-per-pattern <N>` | with `--urls-from`: at most N URLs per route pattern (`/p/*`, `/c/*`), spread over the pattern |
| `--storage-state <file>` | a Playwright storage state (logged-in session) for every context. It holds session cookies: never commit it |
| `--allow-third-party` | keep the requests to other sites that the scan blocks by default (scripts, fetch and xhr, iframes, media, websockets, beacons, manifests). Blocking is on by default: it makes pages reach `load` and network idle sooner, and images, stylesheets and fonts are never blocked. If a third-party script injects images, the scan shows fewer images than the page has: use this flag or `--allow-host` for it. The setting is recorded per page, so `--resume` does not mix the two. `--recheck`, `--locate-only` and `--sizes-only` take the same two flags, and a recheck refuses a scan file recorded with the other setting |
| `--allow-host <h1,h2>` | with blocking on: keep the requests to these exact host names (for example an image carousel's script). Not allowed with `--allow-third-party` |
| `--recheck <scan.json>` | rescan only the images of an earlier scan that have a fix hint, at the viewports where they rendered, and print before and after. Repeat it for several pages: at most three browser contexts run at once over all of them |
| `--ids <a,b,c>` | with `--recheck`: only these image ids (from the scan JSON's `images[].id`; with several pages, each id is looked up in every page) |
| `--viewports <names>` | with `--recheck`: measure these viewports instead of the ones where the images rendered |
| `--locate-only` | read the React owner source of the flagged images (a saving or sharpness growth) from the dev page `<url>`, at one viewport. No image bytes are read, nothing is decoded or scored. Needs `--from` |
| `--from <scan.json>` | with `--locate-only`: the measured scan of the same page |
| `--locate-out <file>` | with `--locate-only`: where the joined copy is written (default: the measured file's name with `.located.json`) |
| `--sizes-only` | with `--recheck`: judge the browser's sizes choice on the dev page (the `sizes`, rendered width, DPR, the file chosen and its bytes) against the hint and the measured file. Nothing decoded, nothing scored |
| `--url <dev-url>` | with `--recheck --sizes-only`: the page to check (default: the dev page the file was located on) |
| `--gpu` | score SSIMULACRA2 on an NVIDIA GPU (opt-in). Needs the `imgtune-ssimu2-gpu` program; without it, a warning and the CPU. See [GPU scoring](#gpu-scoring-gpu) |
| `--gpu-device <n>` | the GPU to score on, by CUDA index (implies `--gpu`; default 0; see [GPU scoring](#gpu-scoring-gpu)) |
| `-h, --help` | show this help |

`--locate-only` joins the flagged images of a measured scan to the dev page's elements. The URL pattern of an image is its whole
srcset (widths and qualities taken out, the page's origin taken out), so a built server and a dev server give the same key.
Within a viewport, elements with the same key and alt pair in document order, but only when the counts on both sides are
equal. A count that differs joins nothing, and the summary gives the reason. A key that is unique on both sides pairs with
any alt (`url-unique`). The output is the measured file with each joined record's `locator` (file, line, component,
verified) and `locate` set; the byte numbers are the built page's. A scan from before this version has no element order
(`domIndex`) and cannot be located: scan again.

`--recheck --sizes-only` reads the dev page at each viewport where the images rendered, in seconds. Per image it prints the
`sizes` attribute, the rendered CSS width, the DPR, the candidate the browser chose (its width and the bytes of its
response), whether it is undersized, the hint's target candidate and a verdict. It fails a choice that is undersized, that
is bigger than the hint's sizes need, or whose bytes rose without a sharpness fix on an image that was not undersized.
Plain images (no srcset) get `n/a`. It exits 1 on a failure and writes nothing.

`--recheck` (the full one) rescans the page at the URL the scan file recorded, so that server must be running. For each image it prints, per viewport, the rendered width, the served bytes and whether the image is undersized, before and
after, and the hint's `sizes` and bytes saved, with the predicted saving beside the measured one (the served bytes change).
It writes nothing. It exits 1 when an image became undersized or bytes rose without a sharpness fix.

An image is found again by its id, which is keyed on the page, the source file, and the image's order in the file, so an
edit that moves a line keeps it. The sizes check finds an image again by its join key and alt (see above). When the id is not found, the image is paired with the rescanned image that has the same
source file and the same URL pattern (the loader URL without its width and quality), and the output says so. `gone` means
neither matched: the output lists what was looked for. Before you conclude an image is gone, rescan the page as it was
before your edits and recheck the same ids: if they are found there, your edit removed or changed the image.

Exit status: 0 on success, 3 when a `--fail-over` budget was exceeded, 4 when a page is broken and `--fail-on-broken` is set,
2 when Chromium is missing, and 1 for other scan failures, a failed `--recheck` or `--sizes-only`, and a `--locate-only` that
located nothing. `run` uses the same codes: 4 when it stops on broken pages, 1 when no page was measured.

## hints

```sh
npx imgtune hints <scan.json> [options]
```

Prints a compact batch of the per-image fix hints of one scanned page, sorted by the bytes a fix saves. Each hint names the
image, its component and `file:line` when they resolved, the sizes and quality to use, and the two byte numbers.

| flag | meaning |
| --- | --- |
| `--page <text>` | only pages whose URL contains the text |
| `--component <name>` | only images whose component or file contains the text |
| `--flat` | one entry per image instead of one per call site (`file:line`, across pages) |
| `--qualities <list>` | the framework's allowed qualities, e.g. `75,85,100`: each quality target is raised to the nearest allowed value (`q82 -> 85 (allowed: 75,85,100)`), and a quality saving the snap voids is `void after snap` |
| `--limit <N>` | call sites to print (default 10; images with `--flat`) |
| `--offset <N>` | skip the first N call sites (for the next batch) |
| `--min-kb <N>` | only hints that save at least N KB per view |
| `--top <N>` | the N call sites that save the most per view, one line each (no batch) |
| `--format <text\|json>` | `text` (default) or `json` |
| `-h, --help` | show this help |

By default the text groups the hints by call site: one entry per `file:line` (or component) across pages, with its image
count, its pages, each page's current and proposed sizes and rendered widths, the combined sizes, the quality and the ids.
The sizes of a call site are fitted to its measured widths: one formula (`one formula over N image(s)`), or, when the pages
need different widths, `shared component: pass sizes per caller` with each page's own formula. Proposals that would add
bytes are left out (the scan's `no saving` note; the count is printed). Each
entry's saving is split into sizes and quality when the scan gave the split. With `--format json` the default output is an
object with `page`, `groups`, `images`, `offset`, `limit` and `callSites` (each with `key`, `file`, `line`, `component`,
`count`, `pages`, `saved`, `sizes`, `ids` and its `hints`). With `--flat`, it is `page`, `total`, `offset`, `limit` and
`hints`. Each hint has the fields `id`, `page`, `component`, `file`, `line`, `kind`, `verified`, `testid`, `alt`, `classes`,
`find`, `selector`, `sizes`, `rendered`, `width`, `quality`, `format`, `bytes`, `rung` and `notes`. The `bytes` field has
`saved` and `addedForSharpness` (both per page view), and `sizes` and `quality` when the scan gave the split. See
[Output JSON fields](./output-json).

## compare

```
npx imgtune compare <before.json> <after.json> [--format text|json] [--limit N]
```

Pairs the images of two scans of one page by their srcset URL pattern and alt; where one key has several elements, by their
rendered widths, then in document order. Prints the paired images' bytes per view before and after, the saved bytes and
the bytes added for sharpness (two numbers, never netted), a warning for growth on images that were not undersized, the
drift that is excluded and not claimed (an image whose rendered width changed, the same file served with different bytes,
a view one scan did not load), the page total (labelled as including data drift), and the images in one scan only (listed,
not counted). Two scans of one build compare to 0 KB saved. `--format json` gives every change and the `excluded` totals.

## report

```
npx imgtune report [--ledger <file>] [--compare <compare.json>] [--out <file>]
```

Builds a Markdown report from `.imgtune/ledger.jsonl` (default) and the `compare --format json` file: totals by status,
the bytes, rungs, and tables of reverted (with reasons), failed, skipped, unmatched and extra usages. Ledger values are
data: they appear in code spans in pipe-free table cells. `--out` writes the file instead of printing it.

## image

```sh
npx imgtune image <file|url|glob> [<file|url|glob> ...] [options]
```

Measures image files without a page: the bytes now, the lowest quality per format (`avif`, `webp`, `jpeg`) that keeps the
file's SSIMULACRA2 bar, and, with `--width`, the bytes at the width the image is needed at (width x dpr). The bar is measured
against the file itself: 90 (visually lossless) unless `--min-score` sets another. Files are read, never written, unless
`--write` names a folder for optimised copies (existing names are never overwritten). Globs: `**` walks folders (`node_modules`
and dot folders are skipped). See [Repo images and file mode](/guide/repo-images).

| flag | meaning |
| --- | --- |
| `--width <css px>` | the CSS width the image is shown at (the width is then the user's, not the file's) |
| `--dpr <list>` | device pixel ratios for `--width` (default `1,2`) |
| `--formats <list>` | `avif`, `webp`, `jpeg` (default all three) |
| `--min-score <n>` | the SSIMULACRA2 bar, above 0 and at most 100 (default 90) |
| `--write <dir>` | write optimised copies (best format, at the largest needed width) into this folder |
| `--format <text\|json>` | `text` (default) or `json` |
| `--gpu` | score SSIMULACRA2 on an NVIDIA GPU (opt-in; see [GPU scoring](#gpu-scoring-gpu)) |
| `--gpu-device <n>` | the GPU to score on, by CUDA index (implies `--gpu`; default 0; see [GPU scoring](#gpu-scoring-gpu)) |
| `--no-cache` | do not read or write `.imgtune/cache` (see `scan --no-cache`) |
| `-h, --help` | show this help |

Exit status: 0 when every file was measured, 1 when one failed.

## GPU scoring (`--gpu`)

Opt-in, for `scan`, `scan --recheck` and `image`. Only SSIMULACRA2 scoring moves to the GPU. Encoding stays on the CPU.

- **The program.** `imgtune-ssimu2-gpu` is built from `native/ssimulacra2-gpu/imgtune-ssimu2-gpu.cpp` against libvship
  from [Vship](https://codeberg.org/Line-fr/Vship), which is not bundled. Put the binary on `PATH`, or set
  `IMGTUNE_GPU_SCORER` to its path. Check a device by hand with
  `CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=1 imgtune-ssimu2-gpu --check --device 0`.
- **The device.** `--gpu-device <n>` is a CUDA index. CUDA numbers the GPUs fastest first unless the environment sets
  `CUDA_DEVICE_ORDER=PCI_BUS_ID`, so to match `nvidia-smi` set that too. A user's `CUDA_VISIBLE_DEVICES` is kept, and the
  index is within the devices it lists. Without `--gpu-device`, device 0 is used. The scorer prints the device it opened
  (name and index) before the first score: check the name. The scan JSON records `deviceOrder` and `visibleDevices`.
- **Fallback.** A missing program, or one that fails its self-test, prints `--gpu: ...` and the run scores on the CPU. A
  failure during the run prints the same warning, and the scores from then on are the CPU's. Nothing hard-fails.
- **What it says.** The output starts with `scored on GPU; may differ slightly from CPU (device <n>: <name>)`. Each page
  of the scan JSON records its `scorer`, and the summary JSON records the run's. `scan --recheck` warns when its scorer
  differs from the scan's.
- **How much it helps.** Scoring is the only stage it speeds up. On nextjs.org (RTX 4060, 6 viewports) scoring fell from
  19 s to 1 s, and a timed scan from 110 s to 89 s on a loaded machine (1.14x to 1.24x over three pairs). Encoding, page
  loads and settling are unchanged, so a page with little scoring gains little.
- **How much it changes.** On the nextjs.org re-encode pairs the GPU score is within 1.2 points of the CPU score (mean
  +0.4). The quality targets and the per-image records of the nextjs.org scan were identical. A score near the bar can
  still flip a target: `image` chose a different JPEG quality for one test image. Compare before and after scans only
  when both used the same scorer.

## Global

| flag | meaning |
| --- | --- |
| `--version` | print the version |
| `-h, --help` | show the usage |
