# Demand study — results

Two runs are reported: **v1** (below, the original run) and **v4** (the current tool, at the end). Runs v2
and v3 were stopped part-way when they exposed tool bugs; per the protocol, every tool change rescans all sites.

Scanned 2026-10-28 with `imgtune scan` at tag `study-2026-10-28`, site list fixed and committed before the first scan (kept private: it names the production sites). Each site scanned once: 2 pages × 6 viewports (4 phones, desktop 1440@2,
desktop 1280@1 ≈ 67/33 mobile/desktop), SSIMULACRA2 delta 2. All 28 pages loaded (`ok`); none blocked.

**Saving** = share of all image bytes per page view, page fully scrolled, mean over viewports, then mean of the two
pages. **Exact** = the site's own smaller `srcset` candidate, fetched and measured. **Est.** = local re-encode
(quality, format, or resize of a plain `<img>`). Sharpness growth (undersized images) is separate, never netted.

## Production sites (decide)

| site | image KB / view | exact | exact + est. | > 15%? |
|---|---|---|---|---|
| A1 fashion retail, UK | 3,235 | 0.0% | 33.0% | est. only |
| A2 home audio, DK | 1,151 | 5.7% | 47.8% | est. only |
| A3 home audio, US | 3,355 | 13.1% | 13.1% | no |
| A4 sportswear, UK | 9,195 | 26.8% | 26.8% | yes |
| A5 home/rugs, US | 7,750 | 12.7% | 12.7% | no |
| A6 outdoor stays, US | 9,073 | 20.7% | 20.8% | yes |

Sharpness growth: ~2 KB/view on A4, 0 elsewhere.

**Kill criterion** (pass needs ≥ ceil(6/3) = 2 of 6 above 15%):
- exact only: **2 of 6 → pass (at the bar)**
- exact + est.: **4 of 6 → pass**

## Open-source apps (do not decide)

| site | image KB / view | exact | exact + est. | of fixable |
|---|---|---|---|---|
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

## Limits (read before quoting)

- **Six deciders.** A signal, not proof; sample biased to sites without bot walls.
- **Est. is a floor on 4 of 6 deciders.** Quality/format is only estimated when the original is known
  (`/_next/image`, Cloudflare `cdn-cgi/image`). Contentful, Sanity, Shopify and Cloudinary loaders → `n/a`.
  Example: A5's listing serves 640 px WebP product cards at ~200 KB each and shows 0%.
- **Plain `<img>` resize** (A1, A2): local resize at the quality that matches the served bytes, so it doesn't add a
  hidden quality saving.
- tailwindcss.com/blog rendered no `<img>` at scan time (0 images); counted as 0%.
- A2's 47.8% is driven by its speakers page (84%): 1440 px product images (~300 KB) in 150–180 CSS px slots.

## v4 (tag `study-v4-2026-10-28`, scanned 2026-10-28/29)

Changes since v1: loader adapters (Contentful, Sanity incl. custom domains, Shopify `quality=`, Cloudinary incl.
custom domains, imgix), AVIF recognised (sharp reports it as `heif`), nested loaders unwrapped, a format estimate only
counts when it meets the bar, group savings share the page denominator, srcset parsed per the HTML algorithm,
undersized images contribute no saving. All 28 pages `ok`.

| site | image KB / view | exact | exact + est. | of fixable | > 15%? |
|---|---|---|---|---|---|
| A1 fashion retail, UK | 3,250 | 0.0% | 33.2% | 50.4% | est. |
| A2 home audio, DK | 1,263 | 5.7% | 53.1% | 64.8% | est. |
| A3 home audio, US | 3,355 | 13.1% | 38.2% | 50.1% | est. |
| A4 sportswear, UK | 9,254 | 26.8% | 35.9% | 62.0% | yes |
| A5 home/rugs, US | 7,714 | 12.7% | 16.5% | 21.9% | est. |
| A6 outdoor stays, US | 9,078 | 20.7% | 27.7% | 43.9% | yes |

**Kill criterion:** exact only **2 of 6 → pass (at the bar)**; exact + est. **6 of 6 → pass**.

| open-source app | image KB / view | exact | exact + est. | of fixable |
|---|---|---|---|---|
| tailwindcss.com | 4,508 | 0.0% | 4.2% | 9.6% |
| ui.shadcn.com | 238 | 0.0% | 33.7% | 42.0% |
| supabase.com | 671 | 1.9% | 20.8% | 48.0% |
| nextjs.org | 162 | 9.1% | 19.2% | 21.4% |
| turborepo.com | 77 | 12.0% | 21.4% | 21.4% |
| langfuse.com | 3,149 | 0.2% | 1.8% | 21.7% |
| docs.sentry.io | 85 | 0.0% | 0.0% | 0.0% |
| www.openstatus.dev | 152 | 0.0% | 4.2% | 31.7% |

Notes: A3 rises from 13% to 38% because its Sanity images sit on a custom domain at `q=100`, which v1 could not
score. Est. remains a floor where images could not be scored (`qualityNA` per page JSON).
