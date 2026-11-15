# Compression

A text response with no `Content-Encoding` header is sent at full size. The usual cases are a stylesheet, a bundle, a JSON
payload, an SVG or a font file that the server did not compress.

## What is checked

- JavaScript, CSS, HTML, JSON, XML, SVG, WASM, TTF and OTF responses of at least 1 KB, with a 2xx status and no
  `Content-Encoding`.
- Every page of the scan, at each viewport. The response is taken from the bytes the browser received.

## The numbers

- **The saving** is the file's length minus its brotli-11 length. A body over 1 MB is encoded only in part and
  extrapolated, and the finding is labelled an estimate.
- **Grouped** per host and content type, because one server setting covers the whole group. The finding gives the
  bytes saved per view across the group.

## The fix

Enable brotli (or gzip) for that content type at the server or CDN. The finding names the nginx setting. imgtune does not
change the server; your agent or your ops team applies the setting, and a rescan shows the saving gone.

## Limits

- A file on another site is labelled third-party: the setting belongs to that site's owner. See [Resources](/guide/resources).
- `--no-resources` turns this check off, and so does `--no-resources` on `check`, `run` and `audit`.
