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
| `scan` | measure live pages by URL, with no source, config or dev server. Writes one JSON file per page. With `--recheck`, rescans fixed images |
| `hints` | print a batch of the per-image fix hints of a scan file |
| `image` | measure image files or URLs without a page: the bytes, the lowest quality per format, and the bytes at a width |

## scan

```sh
npx imgtune scan <url> [<url> ...] [options]
npx imgtune scan --urls-from <file|sitemap-url> [options]
npx imgtune scan --recheck <scan.json> [--ids a,b,c]
```

Measure live pages by URL. Writes one JSON file per page to `--out`.

| flag | meaning |
| --- | --- |
| `--out <dir>` | directory for the JSON files (default: `.imgtune/scan`) |
| `--aggressive` | also report a delta 4 column (never used for the claim) |
| `--viewports <names>` | comma-separated viewport names to measure (default: all six) |
| `--no-quality` | skip the SSIMULACRA2 quality measurement |
| `--markdown <file>` | write a PR-comment Markdown summary: per page, its top groups and the method |
| `--fail-over <pct>` | exit 3 when a page's exact + est. share is above this percentage (default: never fail) |
| `--summary-json <file>` | write one JSON file with every page's status and numbers |
| `--ignore-robots` | scan a page even when robots.txt disallows it (a warning is printed; the verdict is recorded in the JSON) |
| `--resume` | reuse the complete pages already in `--out` that were scanned with the same options |
| `--max-pages <N>` | stop after N pages (scanned or resumed); run again with `--resume` to continue |
| `--max-images <N>` | stop after the page that brings the images counted to N (checked between pages) |
| `--urls-from <file\|sitemap-url>` | scan the URLs of a text file (one per line, `#` comments), a local `sitemap.xml`, or a remote sitemap (same domain only) |
| `--sample-per-pattern <N>` | with `--urls-from`: at most N URLs per route pattern (`/p/*`, `/c/*`), spread over the pattern |
| `--storage-state <file>` | a Playwright storage state (logged-in session) for every context. It holds session cookies: never commit it |
| `--recheck <scan.json>` | rescan only the images of an earlier scan that have a fix hint, at the viewports where they rendered, and print before and after |
| `--ids <a,b,c>` | with `--recheck`: only these image ids (from the scan JSON's `images[].id`) |
| `--gpu` | score SSIMULACRA2 on an NVIDIA GPU (opt-in). Needs the `imgtune-ssimu2-gpu` program; without it, a warning and the CPU. See [GPU scoring](#gpu-scoring-gpu) |
| `--gpu-device <n>` | the GPU to score on, by its `nvidia-smi` index (implies `--gpu`; default 0) |
| `-h, --help` | show this help |

`--recheck` rescans the page at the URL the scan file recorded, so that server must be running (the dev server, for source
locations). For each image it prints, per viewport, the rendered width, the served bytes and whether the image is undersized, before and
after, and the hint's `sizes` and bytes saved, with the predicted saving beside the measured one (the served bytes change).
It writes nothing. It exits 1 when an image became undersized or bytes rose without a sharpness fix.

An image is found again by its id, which is keyed on the page, the source file, and the image's order in the file, so an
edit that moves a line keeps it. When the id is not found, the image is paired with the rescanned image that has the same
source file and the same URL pattern (the loader URL without its width and quality), and the output says so. `gone` means
neither matched: the output lists what was looked for. Before you conclude an image is gone, rescan the page as it was
before your edits and recheck the same ids: if they are found there, your edit removed or changed the image.

Exit status: 0 on success, 3 when a `--fail-over` budget was exceeded, 2 when Chromium is missing, and 1 for other scan
failures or a failed `--recheck`.

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
| `--format <text\|json>` | `text` (default) or `json` |
| `-h, --help` | show this help |

By default the text groups the hints by call site: one entry per `file:line` (or component) across pages, with its image
count, its pages, each page's current and proposed sizes and rendered widths, the combined sizes, the quality and the ids.
The combined sizes say `shared component: pass sizes from each caller` when the pages propose different values. Each
entry's saving is split into sizes and quality when the scan gave the split. With `--format json` the default output is an
object with `page`, `groups`, `images`, `offset`, `limit` and `callSites` (each with `key`, `file`, `line`, `component`,
`count`, `pages`, `saved`, `sizes`, `ids` and its `hints`). With `--flat`, it is `page`, `total`, `offset`, `limit` and
`hints`. Each hint has the fields `id`, `page`, `component`, `file`, `line`, `kind`, `verified`, `testid`, `alt`, `classes`,
`find`, `selector`, `sizes`, `rendered`, `width`, `quality`, `format`, `bytes`, `rung` and `notes`. The `bytes` field has
`saved` and `addedForSharpness` (both per page view), and `sizes` and `quality` when the scan gave the split. See
[Output JSON fields](./output-json).

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
| `--gpu-device <n>` | the GPU to score on, by its `nvidia-smi` index (implies `--gpu`; default 0) |
| `-h, --help` | show this help |

Exit status: 0 when every file was measured, 1 when one failed.

## GPU scoring (`--gpu`)

Opt-in, for `scan`, `scan --recheck` and `image`. Only SSIMULACRA2 scoring moves to the GPU. Encoding stays on the CPU.

- **The program.** `imgtune-ssimu2-gpu` is built from `native/ssimulacra2-gpu/imgtune-ssimu2-gpu.cpp` against libvship
  from [Vship](https://codeberg.org/Line-fr/Vship), which is not bundled. Put the binary on `PATH`, or set
  `IMGTUNE_GPU_SCORER` to its path. Check a device by hand with
  `CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=1 imgtune-ssimu2-gpu --check --device 0`.
- **The device.** `--gpu-device <n>` takes the `nvidia-smi` index. Without it, device 0 is used. Choose the device
  deliberately: the GPU may be busy with other work.
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
