# imgtune

Your images waste bytes three ways: served larger than the space they fill, encoded at a quality nobody can see, and
in an older format, usually all at once. Image tools fix one of these at a time. imgtune measures all three together on
your live page, at six viewports, against a perceptual quality bar, and in a Next.js project it gives you the exact
`sizes` and `quality` to change. Your pages send the fewest image bytes that still look the same.

### Why one lever is not enough

- **Compressors** squeeze the file you hand them, but never learn how wide it is shown. A 6,000 px logo in a 150 px
  slot stays 6,000 px, only better compressed.
- **Image CDNs and `next/image`** resize on request, but only to the widths your `sizes` attribute asks for. A wrong or
  missing `sizes` makes every phone fetch a file several times too wide.
- **Lighthouse** flags oversized, poorly encoded and old-format images, at one viewport per run, with a fixed estimate.
  It tells you something is wrong, not which `sizes` or quality to set.
- **imgtune** measures size, quality and format together, per image, on the live page at six viewports, accepts a
  saving only when SSIMULACRA2 says nobody can see it, and in Next.js writes the fix, verifies it against the server
  and can undo it.

It looks at three levers for each image: **resolution** (the pixels the browser actually needs), **quality** (the
encoder setting), and **format** (for example AVIF or WebP instead of JPEG). Measurements are per page view, per
viewport, and quality is scored with SSIMULACRA2.

## Quick start

Measure any live site, with no access to its source:

```sh
npx imgtune scan https://your-site
```

In a Next.js project, tune `next/image` sizes and quality against the running app:

```sh
npx imgtune audit     # measure and propose sizes and quality (writes .imgtune/report.json)
npx imgtune apply     # write the proposals into the source files
npx imgtune verify    # re-check the applied changes against the served images (report only)
```

Run `npx imgtune --help`, or `npx imgtune <command> --help`, for every option.

When `verify` reports a usage `regressed (raise quality to N)`, raise its applied quality with:

```sh
npx imgtune apply --raise <Component>=<N>     # repeatable; N must be above the applied quality, at most 100
npx imgtune verify                             # measure it again
```

The raise rewrites that usage's `quality` literal, lists N in `images.qualities` when the project has a list (or
`[75, N]` when it has none and N is not 75), and records the new file in the state. Nothing else is applied. `verify`
prints the exact command under each such usage. A quality you already wrote by hand is picked up by `verify` as the
applied value, so it is measured as it stands.

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
- Pages are scanned after their `robots.txt` is checked for the `*` user agent. A disallowed page is skipped and
  recorded as `robots`. Pages that return a challenge or bot wall are recorded as `blocked` and not retried. The
  scanner identifies itself with the default Chromium user agent, uses no stealth plugins, and fetches each image URL
  at most once per scan.
- Besides the page itself, scan fetches the page's own srcset candidates and, for quality estimates, the original of a
  sampled image (derived from the loader URL), each at most once per scan. It never requests new transformations from
  the CDN.

## Supported loaders

Loaders are detected from the URL each image renders. `original known?` means imgtune can find the untransformed
source, which is what quality is measured against. `quality settable?` means the URL carries a quality parameter
that imgtune can change.

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

Where the original is unknown, imgtune still measures resolution, and reports the count of images it could not score
for quality.

## Safety

- imgtune never commits. `apply` writes the proposed sizes and quality into your files and leaves git to you.
- Measuring a project adds temporary instrumentation to the source files. A run that is interrupted (for example with
  Ctrl-C) restores the files; if one was killed harder, `npx imgtune restore` undoes what it left behind.
- Progress is kept in `imgtune.state.json` in the project, so a second `audit` skips usages that were already applied.
  Use `--all` to measure them again.
- `--url` measures a server you already run; imgtune never starts or stops it.

## Demand study (2026-10-28)

Before packaging, imgtune scanned two groups of sites: production sites, which decided whether it was worth building,
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

## CI

`action.yml` at the root scans a preview deployment on each pull request and comments its image waste on the pull
request. Set `fail-over` to fail the job when a page is above a budget. The action builds itself, so `dist/` is not
needed in the repository. See [docs/ci.md](docs/ci.md) for the inputs and two example workflows.

For the command line, `scan` takes `--markdown <file>` (the comment text), `--summary-json <file>` (every page's
numbers) and `--fail-over <pct>` (exit 3 above the budget).

## Use with a coding agent

`skills/imgtune/SKILL.md` teaches a coding agent (Claude Code, or any tool that reads `SKILL.md` skills) to run imgtune
safely: scan a live URL, or audit, apply and verify in a Next.js project. It ships in the npm package under `skills/`.
Copy the `skills/imgtune` folder into your agent's skills directory to use it.

## Requirements

- Node.js 20 or later.
- Chromium for Playwright. Install it once with `npx playwright install chromium`. If it is missing, imgtune prints
  that command and exits with status 2.
- `audit` and `verify` start your dev server (`next dev`) unless you pass `--url`.

## License

MIT. See [LICENSE](LICENSE). Third-party attributions, including the Optiq-derived SSIM code and the vendored
SSIMULACRA2 WebAssembly module, are in [NOTICE](NOTICE).
