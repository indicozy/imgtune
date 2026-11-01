# Getting started

ImgTune measures the images of a live page: size, quality and format together, per image, at six viewports. Each image gets
a fix hint with the sizes, quality and format to use, and the bytes the fix saves. It runs on your machine, and it never edits
your code. Your AI agent makes the change from the hints, and a rescan checks it. See [Fix it with your agent](./fix-with-your-agent).

## Install

Add ImgTune to your project as a dev dependency:

```sh
npm i -D imgtune
```

You can also run `npx imgtune` without installing it. The commands below work either way.

## Requirements

- Node.js 20.9 or later.
- Chromium for Playwright. Install it once:

```sh
npx playwright install chromium
```

If Chromium is missing, ImgTune prints that command and exits with status 2.

## Scan a page

No access to the source is needed:

```sh
npx imgtune scan https://your-site.example/
```

ImgTune loads each page in headless Chromium at six viewports (four phones, a 1440 px desktop at 2x, and a 1280 px desktop
at 1x), scrolls it to the end so lazy images load, and records every image. It writes one JSON file per page to
`.imgtune/scan` (change the folder with `--out`). For a page at `https://your-site.example/bags` the file is
`.imgtune/scan/your-site.example-bags.json`. See [Scanning any site](./scanning-any-site) for every option.

## Read the output

The terminal prints a summary for each page. The numbers below are an example:

```text
https://your-site.example/bags  ok  (Next.js)
  viewports: iphone-se, iphone-15, pixel-7, iphone-15-pro-max, desktop, desktop-1280
  image bytes per view   1480 KB
  saving exact           6.2%
  saving exact + est.    24.8%
  of fixable images      41.0%
  sharpness (separate)   +0.0 KB
  12 images with fix hints: run `imgtune hints .imgtune/scan/your-site.example-bags.json`
  top groups:
    33vw -> calc((100vw - 24px - 8px) / 2)  saves 180 KB/view  loader: next-default
```

- **image bytes per view** is the image weight a visitor downloads on one view of the page, averaged over the viewports.
- **saving exact** is what the site's own smaller candidates would save, measured byte for byte.
- **saving exact + est.** adds the savings of a local re-encode (another quality, another format, or a resize). These are
  estimates, labelled as such.
- **sharpness (separate)** is the bytes that undersized images would add. It is reported apart and never netted against the
  savings.
- **top groups** are the largest groups of images, with the `sizes` in use and a suggested one.

[How it measures](./how-it-measures) explains each number.

## Read the hints

The hints are the part an agent works from. Print the first ten:

```sh
npx imgtune hints .imgtune/scan/your-site.example-bags.json
```

Each hint names the image, its component and `file:line` when they resolve, the `sizes` and quality to use, and the two byte
numbers. For example:

```text
1. c1c774f4dfb8  "components/ProductCard.tsx:40" ("ProductCard")  https://your-site.example/bags
   sizes 33vw -> calc((100vw - 24px - 8px) / 2) (layout-formula)
   quality 90 -> 80 (max of 8, ProductCard)  format jpeg -> avif
   saves 90 KB/view, +4 KB sharpness (separate)  rung measured-page
```

Hints are sorted by bytes saved, largest first. Use `--limit` and `--offset` for batches, and `--page`, `--component` or
`--min-kb` to filter. `--format json` prints the same hints as JSON. Run `npx imgtune hints --help` for the options.

The source location (`file:line`) only resolves in a development build. Without it, a hint names the element by its selector,
and prints the `alt`, `testid` and classes it has, so the agent can search for the usage in the source.

## Where to next

- [Fix it with your agent](./fix-with-your-agent): install the skill, and the loop an agent follows to make the fixes.
- [Scanning any site](./scanning-any-site): every scan option, including sitemaps, logged-in pages and resuming a long run.
- [Repo images and file mode](./repo-images): measure image files in your repository, without a page.
- [CLI reference](/reference/cli): every command and flag.
