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
- **Hover swap** (a sibling image that a `:hover` rule shows): load it on demand. `loading="lazy"` does this for a display change.
- **Never shown on load** at any viewport. Remove it, or load it on demand when the menu, modal or hover opens.

## Limits

- CSS backgrounds are covered when their file was downloaded while hidden. A background that the browser did not download
  (`display: none`, usually) is not counted.
- The checks are a snapshot at the time of the scan, after its scroll. A carousel slide that is out of its track at that
  moment shows as `clipped`, so treat `lazy` as "not shown on load", not as proof that a user never sees it.
- The scan does not click or open menus. A menu, modal or dialog that opens by script shows as "never shown on load". Check
  the source before removing anything: the advice is to load it on demand, not to delete it.
- Hover swaps are found from the stylesheets the page loads (same-origin). A hover that a script drives is not seen.
