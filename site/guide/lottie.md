# Lottie animations

Lottie animations are JSON files (and `.lottie` archives, a zip of JSON and image files) that players draw in the browser.
ImgTune's resource analyzer for Lottie reads every animation the page loads and reports what can shrink.

## What is reported

For each animation, one line with its size, layer count, frame rate and duration. Then, only when there is a saving:

- **Embedded rasters.** PNG, JPEG or WebP images stored inside the JSON as `data:` URIs are decoded and re-encoded to WebP at
  the size they are drawn. The saving is measured on the JSON text. A WebP or AVIF image that keeps its size is not reported,
  since a second lossy pass gains nothing.
- **Precision and whitespace.** Numbers rounded to three decimals and the file minified. Measured with brotli against the
  served body. Only reported above 1 KB and 5% of the body.
- **`.lottie` repack.** An estimate of the same animation as a `.lottie` zip with the images as files. Only reported when it beats
  the brotli-compressed JSON by 1 KB and 10%. It rarely does, because brotli already removes most of the base64 overhead.
- **Stored entries** (in a `.lottie` file): JSON entries kept without deflate.

A huge animation drawn in a small box gets a hint to export at the display size, or to render a video or animated AVIF instead.

## Fixes

Each raster line names the asset and the command. For example, for a PNG drawn 250 px wide:

```js
sharp(src).resize({ width: 250, withoutEnlargement: true }).webp({ quality: 80 })
```

Then set `assets[i].p` to `data:image/webp;base64,…`. For `.lottie` files, replace the file under `images/` and keep its name.

## Where the numbers come from

- The display box is the size of the element that plays the animation, times the device pixel ratio. ImgTune finds it when the
  player is a `<lottie-player>`, `<dotlottie-player>` or an element with `data-animation-path`. Animations that a script starts
  on a plain `div` have no box, so the raster width is the composition's own width.
- Raster savings are measured by re-encoding each image with sharp. The repack and precision figures are measured, except the
  repack, which is an estimate and says so.

## Limits

- Only the first animation of a `.lottie` file gets the display-size check. Zip64 archives are not read.
- Animations are read from the response bodies the page loads. An animation fetched only by a script after the scroll may not
  be in the scan.
- The precision figure is a measurement, not a visual check. Play the animation after applying it.
