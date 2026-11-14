# Loaded but not shown

Some images are downloaded and never seen. A browser fetches an `<img>` whether or not it is displayed, so a page can spend
bytes on a copy that no visitor looks at. `scan` finds them and reports the bytes per view, apart from the savings.

## What is detected

An `<img>` the browser loaded is "not shown" at a viewport when one of these holds:

- **`display`**: `display: none` on the element or an ancestor (a desktop image hidden on phones, a `hidden` attribute).
- **`visibility`**: `visibility: hidden` on the element.
- **`opacity`**: `opacity: 0` on the element or an ancestor.
- **`zero-size`**: a box with no width or no height.
- **`clipped`**: a box outside its `overflow: hidden` (or `clip`) ancestor, such as an offscreen slide of a carousel track.

Images with a visible box are never called hidden. An image under 16 px that is shown is still skipped as before.

## What the report says

Each page gets a line like `loaded but not shown: 3 image(s), 412 KB/view (not in the savings)`, then the largest copies
with the viewports that hide them and the fix for each. The same images are in `imgtune hints` with the lines of their
case. Their bytes are not in the `exact` or `exact + est.` numbers, because a hidden file is not a saving of the image
itself. They do count in `image bytes per view`, which is the page's total of downloaded image bytes.

## The fixes

- **Responsive twin** (hidden at some viewports, shown at others). Serve one file per viewport, so the hidden viewports never
  download the other one. Replace the two elements with one `<picture>`:

  ```html
  <picture>
    <source media="(min-width: 1280px)" srcset="/hero-wide.jpg">
    <img src="/hero-narrow.jpg" alt="…" width="600" height="400">
  </picture>
  ```

  The media condition is printed with a breakpoint between the widths of the viewports. Or delete the hidden copy if the design
  does not need it.
- **Carousel slide or tab panel** (clipped, or inside a `role="tabpanel"` or a `hidden` subtree). Add `loading="lazy"`, or
  render the slide or the tab when it opens.
- **Never shown** at any viewport. Remove the element, or render it only when the part of the page it belongs to opens.

## Limits

- Only `<img>` elements are read. A CSS background that is hidden but was downloaded is still reported as `hidden` and not
  measured.
- The `clipped` check is a box test at the time of the scan. A slide that moves into view by a user's click is still a
  candidate for `loading="lazy"`, not a proof of its use.
- The scan does not click, hover or open menus. A menu or a dialog that is hidden until the user opens it shows as "never
  shown" when its image was downloaded. Check the source before removing anything.
