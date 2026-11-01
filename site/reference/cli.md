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
| `-h, --help` | show this help |

`--recheck` rescans the page at the URL the scan file recorded, so that server must be running (the dev server, for source
locations). For each image it prints, per viewport, the rendered width, the served bytes and whether the image is undersized,
before and after, and the hint's `sizes` and bytes saved. It writes nothing. It exits 1 when an image became undersized or
bytes rose without a sharpness fix.

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
| `--limit <N>` | hints to print (default 10) |
| `--offset <N>` | skip the first N hints (for the next batch) |
| `--min-kb <N>` | only hints that save at least N KB per view |
| `--format <text\|json>` | `text` (default) or `json` |
| `-h, --help` | show this help |

With `--format json`, the output is an object with `page`, `total` (the hints that match the filters), `offset`, `limit` and
`hints`. Each hint has the fields `id`, `page`, `component`, `file`, `line`, `verified`, `testid`, `alt`, `classes`, `find`,
`selector`, `sizes`, `width`, `quality`, `format`, `bytes`, `rung` and `notes`. The `bytes` field has `saved` and
`addedForSharpness`, and both are per page view. See [Output JSON fields](./output-json).

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
| `-h, --help` | show this help |

Exit status: 0 when every file was measured, 1 when one failed.

## Global

| flag | meaning |
| --- | --- |
| `--version` | print the version |
| `-h, --help` | show the usage |
