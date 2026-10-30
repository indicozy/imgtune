# How it measures

ImgTune looks at three levers for each image: **resolution** (the pixels the browser actually needs), **quality** (the encoder
setting) and **format** (for example AVIF or WebP instead of JPEG). Measurements are per page view, per viewport, and quality is
scored with SSIMULACRA2.

## Viewports and page view

Each page is loaded at six viewports and scrolled to the end. Each image is recorded with the size it renders at, the device
pixel ratio, and the pixels it needs (rendered width x dpr, capped at the largest file the site offers).

## Exact and est.

- **Exact** savings come from the site's own smaller `srcset` candidates. Each one is fetched and measured, so the number is the
  real byte difference.
- **Est.** savings come from a local re-encode of the image: another quality, another format, or a resize of a plain `<img>`.
  They are estimates, and they are labelled as such everywhere.

A page's saving is the share of all its image bytes per page view. It is the mean over the viewports of each viewport's share,
and a site's figure is the mean over its pages. The same method is used for the production study.

## Quality: SSIMULACRA2

Each candidate is judged with SSIMULACRA2 against the original. The score runs from 100 (identical) downward.

The default setting is `relaxed`: a candidate passes when its score is at least 70, and no more than 2 points below the current
quality's score. `strict` uses 80 and 1 point. The CLI reports a delta 4 column with `--aggressive`, beside the main numbers.
Quality is judged at the widths the image is shown at.

ImgTune only accepts a saving when SSIMULACRA2 says nobody can see the difference.

## Sharpness

An image smaller than the slot it fills is undersized. It is reported as **sharpness growth**, in KB per view, apart from the
savings. Growth from undersized images is never subtracted from other images' savings, and an undersized image contributes no
saving itself.

## qualityNA

When an image's quality cannot be scored, usually because its original is unknown, it is counted as `qualityNA`. Its resolution
still counts. Its estimate is then a floor.

## Groups

Images are grouped by the key ImgTune builds for each element, so one layout is reported once. For each group ImgTune reports its exact + est. bytes per page view, the
`sizes` in use, a suggested `sizes`, and up to two sample URLs. The scan keeps the ten largest groups in the JSON and the top five
in the Markdown summary.

## Robots, blocks and what was not measured

A page that is disallowed by robots.txt, a page behind a bot wall, and a page that ends on another site are recorded with their
status and are not measured. See [Scanning any site](./scanning-any-site).
