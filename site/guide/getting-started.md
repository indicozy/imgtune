# Getting started

ImgTune measures the images of a page per view and per viewport, and reports the exact and estimated byte savings with a
quality check. It runs on your machine. It has two ways in: a scan of any live URL, and a tuning pass for a Next.js
project.

## Requirements

- Node.js 20 or later.
- Chromium for Playwright. Install it once:

```sh
npx playwright install chromium
```

If Chromium is missing, ImgTune prints that command and exits with status 2.

## Measure any live site

No access to the source is needed:

```sh
npx imgtune scan https://your-site
```

It loads each page in headless Chromium at six viewports, scrolls it to the end, and records every image. The result is one
JSON file per page in `.imgtune/scan` (change it with `--out`). See [Scanning any site](./scanning-any-site).

## Tune a Next.js project

In a Next.js project, ImgTune tunes `next/image` sizes and quality against the running app:

```sh
npx imgtune audit     # measure and propose sizes and quality (writes .imgtune/report.json)
npx imgtune apply     # write the proposals into the source files
npx imgtune verify    # re-check the applied changes against the served images (report only)
```

Read the steps in [the Next.js workflow](./nextjs-workflow). ImgTune never commits: `apply` writes the files, and git stays yours.

## Where to next

- [Scanning any site](./scanning-any-site): every scan option and what it reports.
- [How it measures](./how-it-measures): what exact, est. and sharpness mean.
- [CLI reference](/reference/cli): every command and flag.
