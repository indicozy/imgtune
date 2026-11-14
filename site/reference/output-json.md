# Output JSON fields

`scan` writes one JSON file per page into `--out` (default `.imgtune/scan`). `--summary-json` writes one file with every page.
The numbers are per page view, and the savings are shares of the image bytes, as described in
[How it measures](/guide/how-it-measures). The fields below come from the scan's output types.

The primary number is the **estimated saving**: `exactEstPct` on a page, and `savedBytes` on a group. The CLI prints it as
`saving exact + est.`. The other savings fields are its breakdown: `exactPct` (and `exactSaved` on a viewport or an image) is the
smaller-file part, and `estSaved` is the re-encode part. The JSON keeps the names `exact` and `est`, so existing consumers still
read the same numbers.

## Page file

| field | meaning |
| --- | --- |
| `url` | the page that was scanned |
| `host` | its host |
| `scannedAt` | ISO time of the scan |
| `imgtuneVersion` | the tool version that wrote the file |
| `metric` | `ssimulacra2` |
| `scorer` | `{ name: "cpu" \| "gpu", device, deviceName, cpuFallbacks }`: the scorer that made the numbers. `cpuFallbacks` counts the scores the CPU took after the GPU failed during this page, and is absent when there were none. Scans from before `--gpu` have no field: they were scored on the CPU |
| `delta` | the delta of the relative rule (2 in a default scan) |
| `aggressiveDelta` | 4, only with `--aggressive` |
| `viewports` | the viewport names measured |
| `status` | `ok`, `blocked`, `robots`, `redirected` or `failed` (see below) |
| `error` | the failure message, when there is one |
| `robots` | `skipped (local host)` when robots.txt was not checked, because the page is on a loopback or private host |
| `robotsIgnored` | `true` when robots.txt disallowed the page and it was scanned anyway (`--ignore-robots`) |
| `robotsRule` | the robots.txt rule that disallowed the page, when it was scanned anyway |
| `finalUrl` | the URL the page ended on, when it differs from `url` |
| `redirectNote` | a note that the page ended on another URL, and that it was measured there |
| `loadTimedOut` | `true` when the page's load event did not come in time. Its figures were taken anyway |
| `nextjs` | `true` when the page is detected as a Next.js app |
| `page` | the page's numbers (below). Present when the page was measured |
| `groups` | the top groups of images (below), up to ten |
| `counts` | how many images, how many could not be scored for quality, how many were skipped, the blocked requests, and the count per loader |
| `perViewport` | the measurements at each viewport, keyed by viewport name (below) |
| `images` | one fix record per image element, merged across viewports (below) |
| `notLoaded` | the number of lazy images that never loaded at any viewport |
| `hidden` | loaded but not shown on load (0.3): `images` (the records, elements or CSS background layers, hidden at one or more viewports), `bytesPerView` (their files' bytes per view, summed) and `cases` (`responsive`, `lazy`, `never-shown-on-load`; they add up to `images`). Not part of the savings. Absent when there are none. See `images[].hidden` |
| `complete` | `true` once the page is done. A page without it (an interrupted run) is scanned again by `--resume` |
| `options` | the options the page was scanned with: `imgtuneVersion`, `aggressive`, `quality`, `viewports`, `ignoreRobots` and `storageState` (a boolean; the state itself is not recorded). `survey: true` on a `--survey` page and `idleTimeoutMs` when it is not the default, each present only when set. `--resume` reuses a page only when they match |

`status` values:

- `ok`: measured.
- `blocked`: a challenge page or bot wall. It is not retried.
- `robots`: robots.txt disallows the page, so it was not scanned.
- `redirected`: the page ends on another site, or on a URL that robots.txt disallows. Nothing is measured, and `finalUrl` says where it went.
- `failed`: an error. `error` says what.

## page

| field | meaning |
| --- | --- |
| `meanImageBytes` | mean image bytes per page view, over the viewports |
| `exactPct` | breakdown: the smaller-file part of the estimated saving, as a percentage of the image bytes |
| `exactEstPct` | the estimated saving (primary): the smaller-file part plus the re-encode part, as a percentage of the image bytes |
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
| `images` | one entry per image at this viewport (below) |

### perViewport.images

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
| `quality` | `current`, `qualityAssumed`, `target`, `format` and `sampled`, when a quality estimate was made; `sweep: "skipped-small"` when the served file was under 2 KB and was not swept (it gets its group's ratio, if any) |
| `qualityNA` | true when the quality could not be scored |
| `loader` | the loader the URL came from, such as `next-default` or `generic` |
| `duplicateOf` | the index of the element measured instead, when this element repeats its URL. Its savings are zero |


Each viewport's entry also has `lcp`: `image` (the LCP is an image of the page, its record is in `images` with `lcpViewports`),
`other` (the LCP is another element) or `none` (no LCP entry). It is absent in scans from before LCP was read.

## locate

Set by `scan --locate-only` on the located copy of a page: `url` (the dev page), `viewport`, `scannedAt`, `imgtuneVersion`,
`seconds`, `flagged` (images with a saving or sharpness growth), `joined`, `notJoined`, `devLeft` (dev images of a flagged URL
with no measured partner), `noOrder` (elements without `domIndex`) and `reasons` (not joined, by code: `not-measured`,
`no-dev-image`, `count-differs`, `alt-differs`).

## groups

| field | meaning |
| --- | --- |
| `key` | the group key |
| `sizes` | the `sizes` in use, when the group has one |
| `suggestedSizes` | the `sizes` ImgTune suggests |
| `estQuality` | the median quality the estimates reached, when there is one |
| `loader` | the loader most of the group comes from |
| `qualityHint` | how the loader's quality parameter limits the saving |
| `savedBytes` | the estimated saving in bytes per page view for the group (exact + est.), averaged over the viewports |
| `members` | the number of distinct elements in the group |
| `samples` | up to two image URLs |
| `hint` | a ready line, such as `set sizes="28px"`, when the suggestion differs from the current `sizes` |

## counts

| field | meaning |
| --- | --- |
| `images` | the number of distinct image elements |
| `qualityNA` | images whose quality could not be scored |
| `skipped` | images skipped, for example under 16 px |
| `blockedRequests` | requests the egress check refused |
| `byLoader` | the number of images per loader |

## images

`images` holds one record per distinct image element, merged across the viewports the element was seen at. A record is a
**fix hint** when it saves bytes, or when its `sizes` differs from the one in use. `hints` prints those records.

| field | meaning |
| --- | --- |
| `id` | 12 hex digits. A hash of the page URL and the element's key: its source file and line, else its component, its test id or its selector, plus its order among identical elements. An element keeps its id across scans of the same page while its key stays the same |
| `page` | the page URL |
| `locator` | where the element is (below) |
| `tunable` | what can be changed at the call site (below) |
| `current` | what the page serves now (below) |
| `lazy` | `true` when the element has `loading="lazy"` |
| `lcpViewports` | the viewports at which the element is the page's largest contentful paint, read before the first scroll (`[]` when none; absent in older scans) |
| `perViewport` | what the element does at each viewport it was seen at (below) |
| `layoutChain` | the ancestors of the element at the reference viewport, with the viewports whose chain differs (below) |
| `fix` | the fix and its two byte numbers (below) |
| `evidence` | the rung, and notes on how the numbers were made (below) |

### images[].locator

| field | meaning |
| --- | --- |
| `component` | the component names, nearest first. Dev builds of React only |
| `file`, `line` | the project-relative source file and line of the element, through the source map. Dev builds only. The file is read from the directory the scan ran in |
| `kind` | present with `file`: `image` (the line, or a window of three lines, holds an image tag, a srcset prop, or the component's definition), `owner` (the line is the call site of the component that renders the image: the image is inside that component), `unread` (the file was not found in the scan's directory), or `unchecked` (the page is not local, so no file was read) |
| `verified` | `true` only for `kind: image`: the source is a local project file and its line renders an image. Everything else is `false` and must be checked before it is trusted |
| `testid` | the `data-testid` of the element |
| `alt` | the `alt` text of the element |
| `selector` | a CSS selector for the element |
| `classes` | the element's class attribute, capped |
| `urlPattern` | the loader URL with its width, quality and CDN transform taken out |
| `loader` | `next-default`, a CDN adapter's name, `cdn:<host>`, `plain-img`, or `unknown` |
| `searchHints` | present when no file resolved: the component, the file name it would have, a glob to search the project with, and the `alt` and URL pattern. These are clues only; nothing is read from the project |

### images[].locate

Set on a flagged image that `scan --locate-only` joined to a dev page element: `viewport` (the dev viewport), `by` (`alt-order`:
URL pattern, alt and document order; `url-unique`: the only image with that URL on both pages), and `devIndex` (its place among
the dev page's `<img>` elements). Its `locator.file`, `line`, `component`, `kind` and `verified` come from the dev page; the
bytes do not.

### images[].perViewport[].domIndex

The element's place among the page's `<img>` elements at that viewport. The locate join pairs same-URL elements in this order.
Scans from before `--locate-only` do not have it.

### images[].tunable

| field | meaning |
| --- | --- |
| `width` | `true` when the loader takes a width |
| `quality` | `true` when the loader takes a quality |
| `reason` | present when either is `false`: `fix in the loader`. The fix goes into the loader function, not the call site |

### images[].current

| field | meaning |
| --- | --- |
| `src` | the URL the browser loaded at the reference viewport |
| `sizes` | the `sizes` attribute in use |
| `srcsetCandidates` | the site's candidates, each with `url` and `width` |
| `quality` | the current quality, estimated from the file. Absent when it could not be scored |
| `qualityAssumed` | `true` when the quality is assumed rather than measured |
| `format` | the format the file is served in |
| `naturalWidth` | the file's width in pixels |

### images[].perViewport

One entry per viewport the element was seen at:

| field | meaning |
| --- | --- |
| `viewport` | the viewport name |
| `dpr` | the device pixel ratio |
| `renderedCssPx` | the rendered width, in CSS px |
| `neededPx` | the device pixels the image needs at this viewport |
| `servedPx` | the served file's width in pixels, when it was decoded |
| `servedBytes` | the bytes served |
| `sizesResolvedPx` | the width the browser resolved from `sizes`, in CSS px. Absent without `sizes` |
| `sizesMatchedCondition` | the media condition of the `sizes` branch that matched, or `default` |
| `overFetchRatio` | served pixels per device pixel needed. Above 1, the file is larger than the screen can show |
| `undersized` | `true` when the file is smaller than the slot it fills |
| `loaded` | `true` when the element's own file was received at this viewport |
| `lcp` | `true` when the element is the largest contentful paint at this viewport (absent in older scans, and at a viewport whose LCP was not read) |
| `skipped` | why the element is not measured here (a duplicate of another element, a data URI, and so on) |

### images[].layoutChain

The layout of the element's ancestors, from the image up to the root, at the reference viewport:

| field | meaning |
| --- | --- |
| `viewport` | the reference viewport the chain was taken at |
| `nodes` | the ancestors, nearest first (below) |
| `skipped` | ancestors that do not constrain the width (`display: contents`, inline wrappers), each with its reason |
| `truncated` | `true` when the walk stopped at the depth cap before reaching the root |
| `diffs` | for each other viewport whose chain has a different structure, its `viewport` and its `nodes` |

Each node in `nodes`:

| field | meaning |
| --- | --- |
| `tag`, `classes` | the element's tag and up to three class names |
| `width` | the computed content-box width, in CSS px |
| `maxWidth` | `max-width` in px. Absent when none, or a percentage |
| `paddingX`, `borderX`, `marginX` | the horizontal padding, border and margin, in CSS px |
| `display` | the computed `display` |
| `gridCols`, `gridUniform`, `gridSpan` | for grids: the tracks in `grid-template-columns`, whether they are equal, and how many columns the node spans |
| `gap` | `column-gap` in px, for grid and flex containers |
| `flexDirection`, `flexBasis`, `flexGrow` | flex properties, as computed |
| `borderBox` | `true` when `max-width` caps the border box, not the content box |

### images[].fix

| field | meaning |
| --- | --- |
| `sizes` | present when a `sizes` value was derived: `value` (the CSS value), `basis` (`layout-formula`, `fit` or `measured-max`), `rung` (`measured-page`) and `branches`. `fit` is a fitted line through the measured widths, used when the layout formula does not match them (for example when no layout chain was captured); it is rare but reachable |
| `sizes.branches` | one per media branch: `lo` and `hi` (the viewport widths it covers), `value`, `basis` and `condition` (the media condition, or `default`) |
| `width` | plain images only: the device pixels the file needs at the reference viewport |
| `quality` | present when the image's group has a quality target and the current quality is known: `perFormat` (the target quality per format), `groupRule` (`max-of-targets`), `group` (the component, or the URL pattern, the maximum comes from), `samples` (the number of images scored in the group), `current`, and `qualityAssumed` |
| `format` | the best format for the image. `avif` for a JPEG or PNG that has a saving |
| `bytes.saved` | the bytes the fix saves per page view, averaged over the viewports |
| `bytes.addedForSharpness` | the bytes the fix adds on undersized images, per page view |
| `cdnQuality` | present on a CDN's auto quality (`q_auto`): `handled` (`true` when the CDN's quality is left alone, because its estimated saving is below a tenth of the group's served bytes; that saving is then not counted), and `saved`, the group's estimated quality saving per view |
| `formatHandled` | `true` on a jpeg or png whose format the CDN negotiates (`f_auto`, `auto=format`): no format saving is counted or proposed |

`bytes.saved` and `bytes.addedForSharpness` are two numbers and are never netted. An undersized image adds bytes and saves none.

### images[].evidence

| field | meaning |
| --- | --- |
| `rung` | `measured-page` for a scanned page, `measured-harness` for a harness route (`/__imgtune/...`, or `--harness`). `ceiling-code` and `not-measured` are added by the agent. See [Fix it with your agent](/guide/fix-with-your-agent) |
| `kind` | `css-background` for a CSS background layer; absent for an `<img>`, `srcset` or `<picture>` element |
| `notes` | how the numbers were made: where the `sizes` came from, which source was resolved, and any limit (for example a layout chain cut at the depth cap) |

### images[].hidden (0.3)

Present on an image the browser loaded but that is not shown at some viewport. It has no sizes, quality or saving of its
own at those viewports.

| field | meaning |
| --- | --- |
| `reasons` | why it is hidden, over its hidden viewports: `display` (display:none on it or an ancestor, or a closed details), `visibility` (visibility:hidden), `opacity` (opacity 0 on it or an ancestor), `zero-size` (a zero-width or zero-height box), `clipped` (a box outside its overflow:hidden or clip ancestor, such as an offscreen carousel slide) |
| `inPanel` | `true` when it sits in a tab panel (`role="tabpanel"`), a `hidden` subtree, an `aria-hidden` one or a closed `<details>` |
| `hover` | `true` when a `:hover` rule that sets display, visibility or opacity shows it (a hover swap) |
| `viewports` | the viewports where it is not shown |
| `shownIn` | the viewports where it is shown on load (empty when it is never shown on load) |
| `of` | the number of viewports in the scan |
| `widths` | the width of each viewport it was seen at, by viewport name |
| `action` | the fix by case: `responsive` (shown on load at some viewports and hidden at others: serve one file per viewport with `<picture>`), `lazy` (a carousel slide, a tab or closed-details copy, or a hover swap: `loading="lazy"`, or load on demand), `never-shown-on-load` (no viewport shows it on load: remove it, or load it on demand when the menu, modal or hover opens) |
| `perViewBytes` | the bytes per view the element downloads while it is not shown on load (the hidden viewports' bytes over all viewports). Not in `bytes.saved` |

A CSS background layer (`kind: "css-background"`) gets the same `hidden` field when its file was downloaded while hidden. A
layer that was not downloaded (for example `display: none`) is skipped with the reason `hidden`.

`perViewport[].hidden` names the reason at each viewport that hides the element. Scan JSON from before 0.3 has no such field.

## Media (0.2.0)

A page file gains `videos` (one record per `<video>` element) and `mediaNote` (set when ffmpeg is not found on `PATH`:
the bytes and widths are still measured, and the encodes are not). An animated image keeps its image record: its
`fix.vector` is set on a still raster that looks like vector art. It holds `flatness` (`uniqueColors`, `top16Share`,
`alphaBinaryShare`, `flat`). When the vector check ran it also holds `svgBytes` (brotli, quality 11), `score` (SSIMULACRA2 at
half size), `badPixelShare`, `passed`, `savedPerView`, `wins` (set when the SVG's saving is the record's claim), `tracedFile`
(the SVG, when it passed) and `notChecked` (why it did not run: `survey`, `quality off`, `svg-budget 0`, `over --svg-budget`,
`vectorizer not installed`, `timeout` or `trace failed`).

`fix.animated` holds the animation (`info`, `context` `img` or `css-background`), `perViewBytes` (the average over the
viewports), and either `estimate` (one candidate per codec and width) or `notEncoded` (the reason). Scan JSON from 0.1 has
neither field and is read as having no media.

| field | meaning |
| --- | --- |
| `videos[].bytes.perView` | bytes per view, per viewport and averaged over the viewports (a twin pair counts once): each viewport's shown copy counts its full file (autoplay), the bytes seen (`preload="auto"`, `observed`, browser-dependent), or 0 (`metadata`, `none`). `perViewBasis` names the rule of the heaviest viewport |
| `videos[].bytes.perPlay` | the full file, for every video (estimated when `fullBytesKnown` is `false`) |
| `videos[].perViewport` | each viewport's box width and DPR, and whether it is in the first view |
| `videos[].widths` (scan) / `widthOptions` (audit) | the kept widths (at most `--max-video-widths`) and the width each viewport gets; audit gives the plans at one, two and three widths |
| `videos[].levers` | the audio track, the loading cost, a missing AV1 codec, a missing poster, and `info` (frame rate, duration, source width: informational, never in the claim) |
| `videos[].estimate` | the chosen candidate: `codec`, `width`, `quality`, `bytes` (an estimate from 2 s samples; `measuredBytes` is what the encoder wrote, which differs for an NVENC encode) |
| `videos[].steps` | the lever steps, which sum to the claimed saving |
| `videos[].notEncoded` | why no encode was made (for example `over --media-budget` or `third-party blocked`, or `never-shown` for a video no viewport shows) |
| `videos[].hidden` (0.3) | loaded but not shown: the copies the browser fetched bytes for while hidden. The same fields as `images[].hidden` (`reasons`, `inPanel`, `viewports`, `shownIn`, `of`, `widths`, `action` as `responsive`, `lazy` or `never-shown-on-load`, `perViewBytes`). Not part of `bytes.perView`. Absent when no copy was fetched while hidden |
| `videos[].hidden.copies` (0.3) | each hidden copy the browser fetched bytes for: `viewport`, `src` (its URL), `bytes` (what that viewport loaded for it) and `reason`. The copies' bytes at a viewport add up to the fix's `perViewBytes` times the viewport count, over the viewports they hide |
| `videos[].perViewport[].hidden` (0.3) | the reason the video is not shown at that viewport (`display`, `visibility`, `opacity`, `zero-size`, `clipped`); absent when shown |
| `videos[].perViewport[].bytes` (0.3) | what that viewport loads for the video: the claim's bytes when it is shown there, the hidden copy's bytes when it is not |
| `revealCapped` (0.3) | the page's candidates (an opacity, clipped or zero-size copy) that were past 60 per viewport and were not re-read after a scroll: their reason is the snapshot's. Absent when all were re-read |

Media results are cached by URL and content hash. Cache version 3 (0.2.0) does not reuse 0.1 cache entries.

## Resources (0.3.0)

A page file gains `resources`: one finding per resource problem, sorted by `savedBytes`, on the page as a whole (not in
the image totals). It is absent when the scan ran with `--no-resources`. Each finding:

| field | meaning |
| --- | --- |
| `id` | stable across viewports: `compression:<hash>` (a host and content type group) or `favicon:<hash>` (the icon URL) |
| `kind` | `compression` (text served without `Content-Encoding`) or `favicon` (an icon over its size limit) |
| `url` | the file (for a compression group, its largest member) |
| `bytes` | bytes per view, as fetched (decoded) |
| `savedBytes` | bytes per view the fix saves: measured by a brotli-11 encode (compression) or a PNG re-encode at 32 px or 180 px (favicon); `0` when none |
| `estimate` | `true` when the saving comes from a sample (a compression body over 1 MB is encoded in part and extrapolated) |
| `title` | one line for people: the files, the sizes and the saving |
| `fix` | concrete lines: the setting or the re-encode, and the expected bytes |
| `details` | the numbers behind it: for compression `host`, `contentType`, `files`, `bytes`, `brotliBytes` and `urls`; for favicon `role`, `source` (the decoded size), `px` and `rebuiltBytes` |

`imgtune hints --format json` gives the same findings as a top-level `resources` array, each with its `page`.

Two flags on a finding's `details` say where it belongs: `thirdParty: true` (the file is on another registrable domain than
the page; the title starts "third-party (ask the vendor):", and the totals report it apart from first-party savings) and
`lead: true` (a small saving, under 5 KB, of a kind that is weak for its cost: SVG, Lottie, favicon). Leads and
informational findings sort after the savings.
## Fonts (0.3.0)

Font findings are the `resources` entries with `kind: "font"` (the same shape as every resource finding: `id`, `url`,
`bytes`, `savedBytes`, `estimate`, `title`, `fix`). Their `details` hold the numbers:

| field | meaning |
| --- | --- |
| `details.format` | the file's format as fetched: `woff2`, `woff`, `sfnt` (TTF or OTF) or `eot` |
| `details.numGlyphs`, `details.codepoints` | glyphs in the font, and Unicode code points its cmap maps |
| `details.textCodepoints` | distinct characters of the page's text the font maps to a glyph |
| `details.families`, `details.weightClass`, `details.italic` | the font's name table names (typographic, then family), OS/2 weight class, and italic flag |
| `details.variable`, `details.axes` | whether the font has variation axes, and each axis's `tag`, `min` and `max` |
| `details.woff2Bytes` | the WOFF2 size of the whole font (measured for files up to 256 KB; `woff2Estimate` is `true` otherwise) |
| `details.subsetBytes`, `details.subsetCodepoints` | the WOFF2 size of the subset to the page's Unicode blocks, and the code points it keeps (absent when no subset applies) |
| `details.iconic` | the font is mostly private-use code points (an icon font): no subset, no unused claim |

A finding's `savedBytes` is the fetched size minus the smaller of the WOFF2 and subset sizes; an unused face's is its full
size. A family of several static faces has `savedBytes: 0` and `details.faces` and `details.weights`.
## Resource findings: lottie and svg (0.3.0)

Each finding has `id`, `kind` (`lottie` or `svg`), `url`, `bytes` (per view), `savedBytes` (per view, 0 when informational),
`estimate`, `title`, `fix` (lines) and `details`. Lottie `details`: `layers`, `fps`, `seconds`, `width`, `height`,
`embeddedRasters`, `displayBox` when known. Lottie raster findings: `rasters[]` with `asset`, `from`, `width`, `height`,
`bytes`, `toWidth`, `toBytes`. SVG `details`: `rawBefore`, `rawAfter`, `brotliBefore`, `brotliAfter`, `ssimulacra2`
(and `brotliEstimate` for large files). Ids are `lottie:<hash>` (informational), `lottie:<hash>:raster|precision|dotlottie|stored`,
`svg:<hash>` and `svg:<hash>:raster`.
## Models and audio (0.3.0)

Each 3D model and audio file is a `ResourceFinding` (`kind` `model` or `audio`) in the `resources` list. The fields are
`id`, `url`, `bytes` (bytes per view), `savedBytes`, `estimate`, `title`, `fix` and `locator`. The `details` object holds:

| kind | details fields |
| --- | --- |
| `model` | `format` (`glTF` or `GLB`), `extensionsUsed`, `geometryBytes`, `textures`, `textureBytes`, `textureDetails` (per image: `width`, `height`, `bytes`, `webpBytes`, `estimate`), `repackBytes`, `repackSavedBytes`, `meshoptBytes`, `externalBuffers` |
| `audio` | `codec`, `channels`, `sampleRate`, `durationS`, `bitrateKbps`, `lossless`, `nearMono`, `fetchedBytes`, `fullBytes`, `eager`, `preload`, `autoplay`, `opusFullBytes`, `aacFullBytes`, `targetKbps`, `targetChannels` |

`estimate` is `false` for a measured model geometry saving; the texture and audio savings are estimates.

## Summary JSON

`--summary-json` holds `imgtuneVersion`, `scorer` (the run's scorer: the GPU when any page used it, with `cpuFallbacks` summed) and `pages`: one entry per page with `url`, `host`, `status`, and, when present,
`error`, `finalUrl`, `loadTimedOut` and `page` (the page numbers above). `--markdown` writes the same numbers as a Markdown
table, with each page's top groups and the method. The CI action posts that Markdown as its comment.

## Dropped sizes proposals

An image record's `fix` may carry `noSaving`: the reason a proposed `sizes` was left out (its predicted outcome adds
bytes, or changes no bytes). In that case `fix.sizes` is absent and `fix.bytes.sizes` is 0. The reason also appears in the
record's `evidence.notes`.
