---
name: imgtune
description: Use when asked to reduce image weight or improve LCP, to optimize images, or to measure the images of a live URL.
---

# imgtune

imgtune measures the images of a page per view and per viewport, and reports exact and estimated byte savings with a
quality check. Run it with `npx imgtune`. Every command below is in `imgtune --help` and `imgtune <command> --help`.

## 1. Scan a live URL

Run one scan:

```sh
npx imgtune scan <url> [<url> ...] [--markdown out.md] [--summary-json out.json] [--out dir]
```

Read the JSON files in `--out` (default `.imgtune/scan`). For each page, report the exact and estimated savings
separately. Never describe an est. number as measured. Say which figure is exact, and that est. comes from a local
re-encode. Report sharpness growth separately: growth from undersized images is never subtracted from other images' savings, and
an undersized image itself contributes no saving.

Scan only the sites the user owns, and scan each one once unless the user asks for more.

## 2. Reading the output

- **exact**: savings from the site's own smaller `srcset` candidates, fetched and measured. This is the real byte
  difference.
- **est.** (estimated): savings from a local re-encode at another quality, format, or a resize of a plain `<img>`.
  Judged by SSIMULACRA2. Report as an estimate.
- **sharpness**: images smaller than the slot they fill. Reported apart from savings. It is growth, not a saving.
- **qualityNA**: the quality of this image could not be scored, usually because the original is unknown. Resolution
  still counts for it.
- **loader**: the image CDN or framework the URL came from, such as `next/image` or `generic`. Only some loaders
  expose a quality parameter, so only those get quality proposals.
- **blocked**: the page returned a challenge or bot wall. It is not retried.
- **robots**: `robots.txt` disallows the page for the `*` user agent. The page is skipped.

## 3. Troubleshooting

- `Chromium for Playwright is not installed. Run: npx playwright install chromium`, with exit status 2. Run that
  command, then repeat the step.
- `scan --fail-over <pct>` exits with status 3 when a page is above the budget. Report that as a failed budget, not as
  a scan error.
