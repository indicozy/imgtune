# Scanning any site

`scan` measures live pages by URL. It needs no source, no config and no dev server.

```sh
npx imgtune scan https://your-site https://your-site/products
```

Each URL is one page. For each page, ImgTune loads the page in headless Chromium at six viewports (four phones, a 1440 px
desktop at 2x, and a 1280 px desktop at 1x), scrolls it to the end so lazy images load, and records every image: the size it
renders at, the file the browser fetched, and its `srcset` candidates.

## Options

| flag | what it does |
| --- | --- |
| `--out <dir>` | where the JSON files go (default `.imgtune/scan`), one file per page |
| `--summary-json <file>` | one JSON file with every page's status and numbers |
| `--markdown <file>` | a Markdown summary: per page, its top groups and the method. Used as the CI comment |
| `--viewports <names>` | a comma-separated subset of the six viewport names (default: all six) |
| `--no-quality` | skip the SSIMULACRA2 quality measurement |
| `--aggressive` | also report a delta 4 column, beside the main numbers. It is never used for the headline |
| `--fail-over <pct>` | exit with status 3 when a page's exact + est. share is above this percentage (default: never fail) |

The six viewport names are `iphone-se`, `iphone-15`, `pixel-7`, `iphone-15-pro-max`, `desktop` and `desktop-1280`.

## What a scan does not do

- **robots.txt.** Before a page is scanned, its `robots.txt` is checked for the `*` user agent. A disallowed page is skipped and
  recorded with the status `robots`.
- **Bot walls.** A page that returns a challenge or bot wall is recorded as `blocked` and is not retried.
- **Redirects.** A page that ends on another site, or on a URL that robots.txt disallows, is recorded as `redirected`, and
  nothing is measured for it.
- **Stealth.** The scanner identifies itself with the default Chromium user agent and uses no stealth plugins.
- **New requests to the CDN.** Besides the page, a scan fetches the page's own `srcset` candidates and, for a quality estimate,
  the original of a sampled image. Each URL is fetched at most once per scan. It never asks the CDN for new transformations.

Scan only the sites you own, and scan each one once unless you need more.

## CPU use

`scan` keeps Chrome on the CPUs it was started on, so you can keep it off the cores you need: `taskset -c 8-19 npx imgtune scan …` on Linux.

## Reading the result

The JSON for each page has the numbers listed in [Output JSON fields](/reference/output-json). The short version:

- **exact**: savings from the site's own smaller candidates, fetched and measured.
- **est.**: savings from a local re-encode. It is an estimate.
- **sharpness**: images smaller than their slot. Reported apart, and it contributes no saving.

Report exact and est. separately. [How it measures](./how-it-measures) explains each number.
