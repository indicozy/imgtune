# Output JSON fields

`scan` writes one JSON file per page into `--out` (default `.imgtune/scan`). `--summary-json` writes one file with every page.
The numbers are per page view, and the savings are shares of the image bytes, as described in [How it measures](/guide/how-it-measures).

## Page file

| field | meaning |
| --- | --- |
| `url` | the page that was scanned |
| `host` | its host |
| `scannedAt` | ISO time of the scan |
| `imgtuneVersion` | the tool version that wrote the file |
| `metric` | `ssimulacra2` |
| `delta` | the delta of the relative rule (2 in a default scan) |
| `aggressiveDelta` | 4, only with `--aggressive` |
| `viewports` | the viewport names measured |
| `status` | `ok`, `blocked`, `robots`, `redirected` or `failed` |
| `error` | the failure message, when there is one |
| `robots` | set when robots.txt was not checked, for a loopback or private host |
| `finalUrl` | the URL the page ended on, when it differs from `url` |
| `loadTimedOut` | true when the page's load event did not come in time. Its figures were taken anyway |
| `nextjs` | true when the page is detected as a Next.js app |
| `page` | the page's numbers (below). Present when the page was measured |
| `groups` | the top groups of images (below), up to ten |
| `counts` | how many images, how many could not be scored for quality, how many were skipped, the blocked requests, and the count per loader |
| `perViewport` | the measurements at each viewport (below) |

## page

| field | meaning |
| --- | --- |
| `meanImageBytes` | mean image bytes per page view, over the viewports |
| `exactPct` | exact savings, as a percentage of the image bytes |
| `exactEstPct` | exact plus est. savings, as a percentage of the image bytes |
| `fixablePct` | the same savings as a share of the bytes of the images that have a saving |
| `sharpnessKB` | sharpness growth, in KB per view |
| `aggressiveExactEstPct` | only with `--aggressive` |

## perViewport

One entry per viewport name. Each has:

| field | meaning |
| --- | --- |
| `imageBytes` | the image bytes at this viewport |
| `exactSaved` | exact bytes saved at this viewport |
| `estSaved` | est. bytes saved at this viewport |
| `estAggressiveSaved` | only with `--aggressive` |
| `sharpnessGrowth` | sharpness growth in bytes at this viewport |
| `images` | one entry per image (below) |

## images

| field | meaning |
| --- | --- |
| `url` | the image URL the browser fetched |
| `bytes` | the bytes served |
| `format` | the format reported for the file |
| `pixelWidth` | the file's width in pixels |
| `renderedWidth` | the width it renders at, in CSS px |
| `dpr` | the device pixel ratio of the viewport |
| `needed` | the device pixels the image needs: rendered width x dpr, capped at the largest candidate |
| `firstViewport` | true when the image is in the first viewport, before scrolling |
| `kind` | `srcset` (the site offers candidates), `plain` (a plain `img`), or `skipped` |
| `skipped` | the reason, when the image was skipped (for example under 16 px) |
| `sizes` | the `sizes` attribute, when the element has one |
| `right` | the next candidate the site offers, with its URL, bytes and width |
| `exactSaved` | exact bytes saved on this image |
| `estSaved` | est. bytes saved on this image |
| `estAggressiveSaved` | only with `--aggressive` |
| `sharpnessGrowth` | sharpness growth in bytes for this image |
| `group` | the key of the group the image belongs to |
| `quality` | `current`, `qualityAssumed`, `target`, `format` and `sampled`, when a quality estimate was made |
| `qualityNA` | true when the quality could not be scored |
| `loader` | the loader the URL came from, such as `next` or `generic` |
| `duplicateOf` | the index of the element measured instead, when this element repeats its URL. Its savings are zero |

## groups

| field | meaning |
| --- | --- |
| `key` | the group key |
| `sizes` | the `sizes` in use, when the group has one |
| `suggestedSizes` | the `sizes` ImgTune suggests |
| `estQuality` | the median quality the estimates reached, when there is one |
| `loader` | the loader most of the group comes from |
| `qualityHint` | how the loader's quality parameter limits the saving |
| `savedBytes` | exact + est. bytes per page view for the group, averaged over the viewports |
| `members` | the number of distinct elements in the group |
| `samples` | up to two image URLs |
| `hint` | a ready line, such as `set sizes="28px"`, when the suggestion differs from the current `sizes` |

## Summary JSON

`--summary-json` holds `imgtuneVersion` and `pages`: one entry per page with `url`, `host`, `status`, and `page` (the page fields
above). `--markdown` writes the same numbers as a Markdown table, with each page's top groups and the method. The CI action posts
that Markdown as its comment.
