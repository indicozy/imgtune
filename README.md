# imgtune

imgtune measures the images of a site and tells you how to make them smaller without making them look worse. It
looks at three levers for each image: **resolution** (the pixels the browser actually needs), **quality** (the encoder
setting), and **format** (for example AVIF or WebP instead of JPEG). Measurements are per page view, per viewport, and
quality is scored with SSIMULACRA2.

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

## What `scan` measures

`scan` loads each page in headless Chromium at six viewports (four phones, a 1440 px desktop at 2x, and a 1280 px
desktop at 1x), scrolls it to the end, and records every image.

- **Exact** savings come from the site's own smaller `srcset` candidates. Each one is fetched and measured, so the
  number is the real byte difference.
- **Est.** savings come from a local re-encode of the image: a different quality, a different format, or a resize of a
  plain `<img>`. They are estimates.
- Quality is judged with SSIMULACRA2 at a delta of 2 points. `--aggressive` adds a delta 4 column, which is reported
  beside the main numbers and never used for the headline.
- Undersized images (a file smaller than the slot it fills) are reported as sharpness growth, separately. It is never
  netted against the savings.
- Pages are scanned after their `robots.txt` is checked for the `*` user agent. A disallowed page is skipped and
  recorded as `robots`. Pages that return a challenge or bot wall are recorded as `blocked` and not retried. The
  scanner identifies itself with the default Chromium user agent, uses no stealth plugins, and fetches each image URL
  at most once per scan.
- Nothing is requested from the site's image CDN to estimate quality or format. Only URLs the page already advertises
  are fetched.

## Supported loaders

Loaders are detected from the URL each image renders. `original known?` means imgtune can find the untransformed
source, which is what quality is measured against. `quality settable?` means the URL carries a quality parameter
that imgtune can change.

| loader | matches | original known? | quality settable? |
| --- | --- | --- | --- |
| next/image | `/_next/image?url=…` | yes | yes (`q`) |
| Cloudflare Images | `/cdn-cgi/image/<opts>/<path>` | yes | yes (`quality`) |
| Contentful | `images.ctfassets.net`, `downloads.ctfassets.net` | yes | yes (`q`) |
| Sanity | `cdn.sanity.io/images/…` | yes | yes (`q`) |
| Shopify | `cdn.shopify.com`, `/cdn/shop/…` | yes (size suffix removed) | no |
| Cloudinary | `res.cloudinary.com/<cloud>/image/upload/…` | yes | yes (`q_<n>`); `q_auto` is left to the CDN |
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

imgtune was scanned on two groups of sites before it was packaged: production sites, where the question was whether
the savings justify building it, and open-source apps, which were scanned for comparison. Each site was scanned once:
2 pages × 6 viewports, SSIMULACRA2 delta 2. Saving is the share of all image bytes per page view, with the page fully
scrolled, averaged over viewports and then over the two pages.

### Production sites (decide)

| site | image KB / view | exact | exact + est. | > 15%? |
| --- | --- | --- | --- | --- |
| A1 fashion retail, UK | 3,235 | 0.0% | 33.0% | est. only |
| A2 home audio, DK | 1,151 | 5.7% | 47.8% | est. only |
| A3 home audio, US | 3,355 | 13.1% | 13.1% | no |
| A4 sportswear, UK | 9,195 | 26.8% | 26.8% | yes |
| A5 home/rugs, US | 7,750 | 12.7% | 12.7% | no |
| A6 outdoor stays, US | 9,073 | 20.7% | 20.8% | yes |

Sharpness growth: about 2 KB per view on A4, 0 elsewhere.

Kill criterion: a pass needs at least 2 of 6 sites above 15%.

- exact only: 2 of 6, a pass (at the bar)
- exact + est.: 4 of 6, a pass

### Open-source apps (do not decide)

| site | image KB / view | exact | exact + est. | of fixable |
| --- | --- | --- | --- | --- |
| tailwindcss.com | 4,505 | 0.0% | 4.2% | 9.6% |
| ui.shadcn.com | 240 | 0.0% | 33.7% | 42.0% |
| supabase.com | 601 | 1.5% | 21.2% | 48.8% |
| nextjs.org | 162 | 9.1% | 9.1% | 10.7% |
| turborepo.com | 77 | 12.0% | 12.0% | 12.0% |
| langfuse.com | 1,285 | 0.3% | 4.5% | 18.1% |
| docs.sentry.io | 56 | 0.0% | 0.0% | 0.0% |
| www.openstatus.dev | 217 | 0.0% | 4.2% | 31.7% |

2 of 8 above 15% (exact + est.), 0 of 8 on exact alone. Developer sites carry few image bytes; the waste sits in
image-heavy commerce.

### Limits

- **Six deciders.** A signal, not proof; sample biased to sites without bot walls.
- **Est. is a floor on 4 of 6 deciders.** Quality/format is only estimated when the original is known
  (`/_next/image`, Cloudflare `cdn-cgi/image`). Contentful, Sanity, Shopify and Cloudinary loaders → `n/a`.
  Example: A5's listing serves 640 px WebP product cards at ~200 KB each and shows 0%.
- **Plain `<img>` resize** (A1, A2): local resize at the quality that matches the served bytes, so it doesn't add a
  hidden quality saving.
- tailwindcss.com/blog rendered no `<img>` at scan time (0 images); counted as 0%.
- A2's 47.8% is driven by its speakers page (84%): 1440 px product images (~300 KB) in 150–180 CSS px slots.

## CI

`action.yml` at the root scans a preview deployment on each pull request and comments its image waste on the pull
request. Set `fail-over` to fail the job when a page is above a budget. The action builds itself, so `dist/` is not
needed in the repository. See [docs/ci.md](docs/ci.md) for the inputs and two example workflows.

For the command line, `scan` takes `--markdown <file>` (the comment text), `--summary-json <file>` (every page's
numbers) and `--fail-over <pct>` (exit 3 above the budget).

## Requirements

- Node.js 20 or later.
- Chromium for Playwright. Install it once with `npx playwright install chromium`. If it is missing, imgtune prints
  that command and exits with status 2.
- `audit` and `verify` start your dev server (`next dev`) unless you pass `--url`.

## License

MIT. See [LICENSE](LICENSE). Third-party attributions, including the Optiq-derived SSIM code and the vendored
SSIMULACRA2 WebAssembly module, are in [NOTICE](NOTICE).
