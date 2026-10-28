---
name: imgtune
description: Use when asked to reduce image weight or improve LCP, to tune next/image sizes or quality in a Next.js project, to optimize images, or to audit the images of a live URL.
---

# imgtune

imgtune measures the images of a page per view and per viewport, and reports exact and estimated byte savings with a
quality check. Run it with `npx imgtune`. Every command below is in `imgtune --help` and `imgtune <command> --help`.

## 1. Live URL only

For a site with no source in the workspace, run one scan:

```sh
npx imgtune scan <url> [<url> ...] [--markdown out.md] [--summary-json out.json] [--out dir]
```

Read the JSON files in `--out` (default `.imgtune/scan`). For each page, report the exact and estimated savings
separately. Never describe an est. number as measured. Say which figure is exact, and that est. comes from a local
re-encode. Report sharpness growth separately: growth from undersized images is never subtracted from other images' savings, and
an undersized image itself contributes no saving.

Scan only the sites the user owns, and scan each one once unless the user asks for more.

## 2. Next.js project

1. Measure the running app:

   ```sh
   npx imgtune audit [--path <path>] [--url <baseUrl>] [--port <n>]
   ```

   `audit` starts `next dev` unless `--url` names a server that is already running. Use `--port` if the default port
   is busy. Use `--path` to narrow the scan to one file or directory.
2. Read `.imgtune/report.json` and summarise its top `results` for the user before changing anything.
3. Apply the proposals:

   ```sh
   npx imgtune apply [--allow-growth]
   ```

   `apply` edits literal `sizes` and `quality` props and the qualities in `next.config`. It skips expressions and
   reports each skip. Pass `--allow-growth` only if the user accepts heavier files for sharper images.
4. Check the result:

   ```sh
   npx imgtune verify [--url <baseUrl>] [--path <path>]
   ```

   `verify` changes no files. Each usage is `verified`, `regressed`, or `unmeasured`.
5. Show `git diff`. Do not commit. Leave the commit to the user.

If `verify` reports `regressed (raise quality to N)`, set the quality of that usage to N, then run `verify` again.
That is the one hand edit allowed on top of `apply`. For any other `regressed` reason, or for an `unmeasured` usage,
report it and stop.

To back out applied changes, ask the user first, then restore the files from `git diff`. `npx imgtune restore` does
not do this. It only undoes the instrumentation an interrupted run left in the source.

## 3. Rules

- Never hand-edit what `apply` already wrote, except the "raise quality to N" change in step 2.
- Use `--allow-growth` only when the user accepts heavier but sharper images.
- A loader that cannot set quality gets `sizes` changes only. Say so in the summary.
- Do not run scans against sites the user does not own, beyond one scan.
- Do not start, stop or restart the user's dev server by hand. `audit` and `verify` manage it.

## 4. Reading the output

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

## 5. Troubleshooting

- `Chromium for Playwright is not installed. Run: npx playwright install chromium`, with exit status 2. Run that
  command, then repeat the step.
- Port in use, or `next dev` already holding a lock in `.next/dev/lock`: stop the other dev server, or pass `--url`
  to measure it, or `--port <n>` for another port.
- A large project with slow results: narrow the scope with `--path`, for example `--path app/products`.
- `scan --fail-over <pct>` exits with status 3 when a page is above the budget. Report that as a failed budget, not as
  a scan error.
