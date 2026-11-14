# Resources: compression and favicons

`scan` records every response a page makes, not only images, and runs the resource checks on them. These are reported in
their own section, after the video section, with their own totals. They never change the image numbers.

## Compression

A text response with no `Content-Encoding` header is sent at full size. Typical: a stylesheet, a bundle, a JSON
payload, an SVG or a font file that the server did not compress.

- **What is checked.** JavaScript, CSS, HTML, JSON, XML, SVG, WASM, TTF and OTF responses of at least 1 KB, with a 2xx
  status, and no `Content-Encoding`.
- **The saving.** The file's length minus its brotli-11 length. A body over 1 MB is encoded only in part and extrapolated,
  and is labelled an estimate.
- **The fix.** Enable brotli (or gzip) for that content type at the server or CDN. The nginx setting is named in the
  finding. The findings are grouped per host and content type, because one setting covers the group.

## Favicons

A favicon is fetched once per site, on a first visit, so its bytes are paid by every new visitor once.

- **What is checked.** The icons the page declares (`<link rel="icon">`, `apple-touch-icon`), and `/favicon.ico` when no
  icon is declared. A favicon over 10 KB, or an apple-touch-icon over 30 KB, is flagged.
- **The saving.** The icon is re-encoded to the size the browser uses: 32 px for a favicon, 180 px for an apple-touch-icon,
  as a PNG (sharp). ICO files are read through their largest PNG frame. An ICO with no PNG frame is not decoded: its
  finding has no saving.
- **The fix.** The re-encode, or an SVG favicon when the logo is vector.

## Flags

`--no-resources` skips the capture and the checks. A page scanned that way is recorded with `resources: false`, so
`--resume` measures it again for a scan with the checks.

## Testing an analyzer on real pages

`scripts/try-analyzer.mjs <kind> <url-list>` runs one analyzer on a list of pages, outside the scan, and prints its findings
as JSON. Build first (`npm run build`).
