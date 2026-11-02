# Scanning any site

`scan` measures live pages by URL. It needs no source, no config file and no dev server.

```sh
npx imgtune scan https://your-site https://your-site/products
```

Each URL is one page. For each page, ImgTune loads the page in headless Chromium at six viewports (four phones, a 1440 px
desktop at 2x, and a 1280 px desktop at 1x), scrolls it to the end so lazy images load, and records every image: the size it
renders at, the file the browser fetched, its `srcset` candidates, and the layout around it. Each image then gets a fix hint.

## Options

| flag | what it does |
| --- | --- |
| `--out <dir>` | where the JSON files go (default `.imgtune/scan`), one file per page |
| `--summary-json <file>` | one JSON file with every page's status and numbers |
| `--markdown <file>` | a Markdown summary: per page, its top groups and the method. Used as the CI comment |
| `--viewports <names>` | a comma-separated subset of the six viewport names (default: all six) |
| `--survey` | a fast site-wide pass: two viewports (`iphone-15`, `desktop`), no quality, 4 pages at once, a 3 s network-idle cap. Exact savings only. See below |
| `--no-quality` | skip the SSIMULACRA2 quality measurement |
| `--page-concurrency <N>` | scan up to N pages at once on one browser, 1 to 6 (default 1; `--survey` sets 4) |
| `--idle-timeout <ms>` | cap on the wait for network idle after scroll, 0 to 600000 (default 10000; `0` skips the wait; `--survey` sets 3000) |
| `--shared-loads` | opt-in: one page load per viewport class (the mobile and the desktop viewports), the other viewports of the class resize the open page. It saves CPU but costs wall time, so by default each viewport is loaded fresh |
| `--aggressive` | also report a delta 4 column, beside the main numbers. It is never used for the headline |
| `--fail-over <pct>` | exit with status 3 when a page's exact + est. share is above this percentage (default: never fail) |
| `--urls-from <file\|sitemap-url>` | scan the URLs of a text file, a local `sitemap.xml`, or a remote sitemap of the same domain |
| `--sample-per-pattern <N>` | with `--urls-from`, at most N URLs per route type (`/p/*`, `/c/*`: see the CLI reference), spread over the type |
| `--storage-state <file>` | a Playwright storage state, for a logged-in session in every browser context |
| `--ignore-robots` | scan a page that robots.txt disallows. A warning is printed, and the JSON records it |
| `--resume` | reuse the complete pages already in `--out` that were scanned with the same options |
| `--max-pages <N>` | stop after N pages, scanned or resumed. Run again with `--resume` to continue |
| `--max-images <N>` | stop after the page that brings the images counted to N. Checked between pages |

The six viewport names are `iphone-se`, `iphone-15`, `pixel-7`, `iphone-15-pro-max`, `desktop` and `desktop-1280`.

## Site-wide: check (production, no source)

`imgtune check` measures a live site from its URLs alone, in a browser. It surveys the URLs of the site's sitemap (or a
list, or one page), full-scans the heaviest page of each route type, and writes a Markdown report:

```sh
npx imgtune check https://example.com/sitemap.xml --sample-per-pattern 3
```

The report (`report.md`, in the check directory) gives the summary numbers, the fixes ranked across the deep pages, the
heavy pages with little to save, the images that would get bigger for sharpness, a table of the route types, and what
could not be measured. The survey and the deep pages are the same scans `scan` makes. `--block-third-party` is off by
default; see the CLI reference before turning it on.

## Site-wide: one command

`imgtune run` does the whole site-wide flow in one command: it surveys every URL, full-scans the heaviest page of each route
type (up to `--deep`, default 20), optionally locates them on a dev server, and groups the fix hints by call site:

```sh
npx imgtune run --urls-from sitemap.xml --sample-per-pattern 5 --deep 5 --dev http://localhost:3000
```

It writes a run directory (`.imgtune/run/<timestamp>`, or `--out`) and prints a summary of at most 40 lines: the site totals,
the worst route types, the deep pages, the top call sites by saving per view, the warnings and the next commands. The
directory's `run.json` lists every file and every command, so a single step can be run again by hand. `imgtune summary
<run dir>` prints the same summary again.

A page that cannot be measured as the app is (its document answered an HTTP error, a linked stylesheet did not load, or a
full scan finds no images where the survey found some) is `broken`. A broken page has no numbers and counts in no total; its
reason and the likely fix are printed. When more than half of the survey is broken, `run` stops before the deep phase.

## Site-wide: survey first

A whole site is faster to read in two passes (this is what `run` and `check` do for you). First, survey every URL (or a sample of each route type):

```sh
npx imgtune scan --urls-from sitemap.xml --survey --out .imgtune/survey
npx imgtune scan --urls-from sitemap.xml --survey --sample-per-pattern 5 --out .imgtune/survey
```

A survey measures two viewports, `iphone-15` and `desktop`, with no quality estimate, four pages at once, and at most 3 s
of waiting for the network to go idle. Its numbers are exact savings only, and every output says so, for example
`survey: 2 viewports, exact savings only, no est.`

Then full-scan only the heaviest route types, or the pages that stand for them, with all six viewports and the estimate:

```sh
npx imgtune scan https://your-site/products/a https://your-site/category/b --out .imgtune/scan
```

A survey and a full scan are not interchangeable. `compare` refuses to pair one with the other, `report` never mixes them,
and `--resume` reuses a page only for the same kind of scan.

Any flag of the survey can be set on its own. `--page-concurrency` and `--idle-timeout` work on a full scan too. Concurrency
changes the wall time and keeps the input order of the results. A page's numbers match one page at a time, within the
run-to-run variation the page already has: on a heavy page, which of two duplicate images is the record, or a sub-pixel
layout width, can differ between runs whatever the concurrency.

## Scanning many pages

For a catalogue, give ImgTune a list of pages instead of typing them. A text file has one URL per line, and `#` starts a
comment. A sitemap works too:

```sh
npx imgtune scan --urls-from sitemap.xml --sample-per-pattern 5
```

`--sample-per-pattern` keeps at most that many URLs of each route type, so a site with ten thousand product pages is
sampled, not read in full. Each type is spread across its URLs, not taken from the top of the list.

A long run can be split into parts. Each page is written as soon as it is done:

```sh
npx imgtune scan --urls-from sitemap.xml --sample-per-pattern 5 --max-pages 40
npx imgtune scan --urls-from sitemap.xml --sample-per-pattern 5 --max-pages 40 --resume
```

`--resume` reuses the complete pages from the first run. A page that was interrupted is scanned again. It is reused only when
the options are the same, so changing a viewport starts it over.

## Logged-in pages

Pages behind a login are scanned with a session saved as a Playwright storage state:

```sh
npx imgtune scan https://your-site/account --storage-state .imgtune/state.json
```

The file holds session cookies. Never commit it. Keep it outside the repository, or add it to `.gitignore`. ImgTune never
prints its contents.

## What a scan does not do

- **robots.txt.** Before a page is scanned, its `robots.txt` is checked for the `*` user agent. A disallowed page is skipped and
  recorded with the status `robots`. `--ignore-robots` scans it anyway, prints a warning and records `robotsIgnored`. Use it
  only on a site you own or are authorised to test.
- **Bot walls.** A page that returns a challenge or bot wall is recorded as `blocked` and is not retried.
- **Redirects.** A page that ends on another site, or on a URL that robots.txt disallows, is recorded as `redirected`, and
  nothing is measured for it. The `finalUrl` field says where it went.
- **Stealth.** The scanner identifies itself with the default Chromium user agent and uses no stealth plugins.
- **New requests to the CDN.** Besides the page, a scan fetches the page's own `srcset` candidates and, for a quality estimate,
  the original of a sampled image. Each URL is fetched at most once per scan. It never asks the CDN for new transformations.
- **Hidden images.** An image that is not shown at any of the six viewports is not measured, and neither is one behind a click.
  Lazy images that never load are counted in `notLoaded`.

Scan only the sites you own, and scan each one once unless you need more.

## Security

- **Private addresses.** `scan` refuses loopback, private and link-local addresses, and names that resolve to them, unless
  the URL you give is itself local (`localhost`, or a loopback or private IP address). Then loopback and private addresses
  are allowed. Cloud metadata and link-local addresses (`169.254.0.0/16`, `fd00:ec2::/64`, `100.100.100.200`) are refused
  even for a local URL.
- **Every hop.** Every request the browser makes is checked before it connects: each redirect, each image, script and
  other sub-resource, and each tunnel. The check is made on the address the connection goes to, so a DNS answer that
  changes later does not help. A refused request is dropped and counted as blocked.
- **Sitemaps.** A child sitemap is read only when it is on the same registrable domain as the sitemap that lists it, and every
  redirect of it stays on that domain. Each file is capped at 50 MB, at most 50,000 URLs are read, at most two levels of index
  are followed, at most 50 child sitemaps are read, and each request has a 15 second timeout. Compressed (`.gz`) sitemaps are
  not read.
- **Source maps.** Source maps come from the scanned site, so they are untrusted. They are read with caps: 20 MB each, 64 per
  scan, and only a relative path under the project is kept as a source file.

## CPU use

`scan` keeps Chrome on the CPUs it was started on, so you can keep it off the cores you need: `taskset -c 8-19 npx imgtune scan …` on Linux.

## Reading the result

The JSON for each page has the numbers listed in [Output JSON fields](/reference/output-json). The short version:

- **exact**: savings from the site's own smaller candidates, fetched and measured.
- **est.**: savings from a local re-encode. It is an estimate.
- **sharpness**: images smaller than their slot. Reported apart, and it contributes no saving.
- **images**: one fix record per image, with its locator, its layout chain, its `sizes` at each viewport, and a fix hint with
  two byte numbers: bytes saved, and bytes added for sharpness.

Report exact and est. separately. [How it measures](./how-it-measures) explains each number.
