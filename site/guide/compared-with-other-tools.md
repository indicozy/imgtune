# Compared with other tools

An image is as heavy as its pixels, its quality and its format together. Fix one and the other two keep the waste. Each common tool
fixes one of the three levers, or measures without deciding.

- **Compressors** squeeze the file you hand them. They do not learn how wide the image is shown. A 6,000 px logo in a 150 px slot stays
  6,000 px, only better compressed.
- **Image CDNs and `next/image`** resize on request, but only to the widths your `sizes` attribute asks for. A wrong or missing
  `sizes` makes every phone fetch a file several times too wide.
- **Lighthouse** flags oversized, poorly encoded and old-format images, at one viewport per run, with a fixed estimate. It tells you
  something is wrong. It does not tell you which `sizes` or quality to set.
- **ImgTune** measures size, quality and format together, per image, on the live page at six viewports. A saving counts only when
  SSIMULACRA2 says nobody can see the difference. In a Next.js project it writes the fix, verifies it against the server, and can undo it.

ImgTune does not replace a CDN or a compressor. It tells you which `sizes` and quality to use with them, and it checks the result.
