# Image loaders and CDNs

ImgTune detects the loader from the URL each image renders. Two questions decide what it can propose:

- **original known?** Can ImgTune find the untransformed source? Quality is measured against it.
- **quality settable?** Does the URL carry a quality parameter that ImgTune can change?

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

Where the original is unknown, ImgTune still measures resolution, and reports how many images it could not score for quality.
For those images the estimate is a floor, and the page JSON counts them as `qualityNA`.

## What this means in practice

- With **next/image**, ImgTune can propose both `sizes` and `quality`. Your agent writes them into your source, from the hint.
- With a CDN that only resizes on request, the loader still tells you the widths. The fix is in `sizes`.
- With a **generic** URL, ImgTune measures resolution. Quality is only proposed when the URL itself has a quality parameter.
- With **Cloudinary `q_auto`**, the quality is the CDN's. ImgTune reports it as handled unless its estimated saving is large
  enough to name an explicit `q_<N>`. Its focus is `sizes`, which no CDN can set for you.

## next/image: the qualities list

Each quality a next/image usage asks for must be listed in `images.qualities` in `next.config`, and each listed value
multiplies the cached variants. ImgTune clusters the per-usage targets of a scan into at most `--max-qualities` values
(default 2, from 1 to 4), raising each target to the nearest listed value above it so the SSIMULACRA2 bar still holds. The
result is one site-level line, `next.config: images.qualities: [75, 90]`. Its estimated saving per usage is scaled from the
measured one, and the report says so.
A usage whose target is above the listed value it needs is raised to that value, as its hint already says. A usage the list
makes go up (above its current quality) adds bytes: its hint says so, and that quality saving is not counted.

The loader name appears in every image and group of the scan output. See [Output JSON fields](/reference/output-json).
