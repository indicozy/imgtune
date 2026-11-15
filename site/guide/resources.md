# Resources

`scan` records every response a page makes, not only images, and runs seven checks on the non-image ones. They are reported
in their own Resources section, after the video section, with their own totals. They never change the image numbers.

| Check | What it finds | Guide |
|---|---|---|
| Compression | text served with no `Content-Encoding` | [Compression](/guide/compression) |
| Favicons | a favicon over 10 KB, or an apple-touch-icon over 30 KB | [Favicons](/guide/favicons) |
| Fonts | web fonts: WOFF2, subsetting, unused faces, static weights | [Fonts](/guide/fonts) |
| SVG | an SVG that SVGO shrinks by at least 20% and still renders at 70 | [SVG files](/guide/svg) |
| Lottie | embedded rasters, numbers, a `.lottie` repack | [Lottie animations](/guide/lottie) |
| 3D models | glTF and GLB: meshopt, base64 buffers, textures | [3D models](/guide/3d-models) |
| Audio | lossless and high-bitrate files, an Opus re-encode | [Audio](/guide/audio) |

Vector art is different: it is a check on still images, which could be SVG instead. It sits with the image hints, in
[Vector art](/guide/vector-art).

## Labels

- **third-party (ask the vendor)**: the file is served from another site. The saving belongs to that site's owner, so it is
  totalled apart from the first-party savings.
- **lead**: a small saving of a kind that is weak for its cost (SVG, Lottie, favicons). It is kept, and it sorts after the
  real savings.

## The budget and the flags

- The heavy steps (brotli-11 sizes, SVGO and render, WOFF2 and subset encodes, Lottie re-encodes, 3D meshopt, audio sample
  encodes) are computed once per run for each distinct content, not once per viewport and page. Icons are fetched once per
  run.
- `--resource-time <s>` (default 60, 0 to 3600) caps the heavy work of a run. A file over the budget keeps its cheap finding,
  marked as an estimate or not measured.
- `--no-resources` skips the capture and every check. A page scanned that way is recorded with `resources: false`, so
  `--resume` measures it again for a scan with the checks. It is accepted by `scan`, `check`, `run` and `audit`.

The findings are in the JSON as `resources`, and in the Markdown PR comment of the [CI action](/guide/ci-action).

## Testing an analyzer on real pages

`scripts/try-analyzer.mjs <kind> <url-list>` runs one analyzer on a list of pages, outside the scan, and prints its findings
as JSON. Build first (`npm run build`).
