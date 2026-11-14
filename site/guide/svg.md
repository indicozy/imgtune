# SVG files

ImgTune checks each SVG file the page loads (2 KB or more, up to 5 MB) against an optimised copy made with SVGO.

## What is reported

- **SVGO savings.** The file is optimised with SVGO's default preset, with numbers at two decimal places. The saving is the
  difference in brotli size, which is what the server would send. It is reported only when it is at least 20% of the brotli
  size, and only when the optimised file still renders like the original.
- **Embedded rasters.** An SVG that holds PNG, JPEG or WebP images as `data:` URIs is listed with the decoded size. The
  saving is 0: the fix is to move each image into its own file at its display size, or to redraw it as vector.

## How the render is checked

Both files are rendered at 512 px on the longer side, then compared at 256 px with SSIMULACRA2. The file is reported only at
70 or more. The bar is the same one ImgTune uses for images.

## Fix

```sh
npx svgo --precision=2 input.svg -o input.min.svg
```

Check the render at its display size before shipping, and keep the original under version control. The brotli size after the
change is in the finding.

## Limits

- Inline `<svg>` elements in the HTML are not measured.
- Very large exports skip SVGO's `mergePaths` step (above 256 KB), which takes seconds on a 700 KB file and gains little there.
  This can leave some saving on the table for files of that size.
- The fidelity check runs at half size. A fine detail that vanishes at 256 px is not caught.
