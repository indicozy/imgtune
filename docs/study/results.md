# Demand study — results

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
