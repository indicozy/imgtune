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

- With **next/image**, ImgTune can propose both `sizes` and `quality`. `apply` writes them into your source.
- With a CDN that only resizes on request, the loader still tells you the widths. The fix is in `sizes`.
- With a **generic** URL, ImgTune measures resolution. Quality is only proposed when the URL itself has a quality parameter.

The loader name appears in every image and group of the scan output. See [Output JSON fields](/reference/output-json).
