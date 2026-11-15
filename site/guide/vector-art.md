# Vector art

A flat logo, icon or illustration served as a PNG, WebP or JPEG can often be an SVG: smaller, and sharp at every pixel
density. imgtune finds the still images that look like that, traces the heaviest of them, and checks the trace before it
reports a saving.

## What is checked

- Every still raster the page loads (PNG, WebP, JPEG, AVIF and static GIF) of at least 2 KB. Animated images are not
  checked here; see [Video and animated images](/guide/video-and-gifs).
- An image is **flat** when its colours are few and change in sharp steps: at a 256 px decode, the 16 most common colours
  cover at least 97% of its pixels, the image has at most 300 colours, and at most 12% of its neighbouring pixel pairs differ
  by a small step (soft shading). Images over 5 megapixels are not flagged flat.
- A flat image that is not traced gets a hint with no byte claim: "looks like vector art (flat colors); if a source SVG
  exists, serve it".

## The trace and the check

Flat images are traced within a budget: `--svg-budget <N>` (default 50, 0 to 1000; 0 traces none), heaviest first. Each
trace is capped at 2 seconds.

1. The served image is traced to SVG with vtracer (the Poster preset), through `@neplex/vectorizer`. The trace input is downscaled to at most
   1 megapixel, with a long side of 1024 px.
2. The SVG is rendered back at the served size with sharp (librsvg).
3. The render and the served image are both scaled to half size, and compared with SSIMULACRA2. The bar is 70, the same
   as the image bar.
4. The SVG is compressed with brotli-11. A passing SVG must be at least 30% smaller than the served file.

The saving is the served bytes minus the SVG bytes, the same at every pixel density. The traced file is written to
`svg/<id>.svg` in the scan folder, so the agent or the user can open it before it is used.

`@neplex/vectorizer` is an optional dependency. Without it, a flat image gets one note (`install @neplex/vectorizer to
check vector art`) and no byte claim. The trace is skipped with `--survey` and `--no-quality`, because both leave the
quality check out.

## The fix

Serve the source SVG when the project has one (preferred). Otherwise serve the traced file from `svg/`, after a look at
it. The raster fix stays in the hint as the fallback, so the agent can choose the other one if the trace is not good
enough.

## Limits

- The fidelity check runs at half size. Fine detail at full size, such as the edges of small text inside a logo, is not
  scored. Look at the traced file at its full size before you ship it.
- A photograph is rejected by the flatness check. Use the image guide's quality and format hints for it.
- Inline `<svg>` in the HTML is not checked here. [SVG files](/guide/svg) covers the SVG files a page loads.
