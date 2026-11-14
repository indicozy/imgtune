# Loaded but not shown

Some images and videos are downloaded and never seen. A browser fetches an `<img>` whether or not it is displayed, and
an autoplay or `preload="auto"` `<video>` the same way, so a page can spend bytes on a copy that no visitor looks at.
`scan` finds them and reports the bytes per view, apart from the savings. Videos are covered in [the video section](#hidden-video) below.

## What is detected

An `<img>` (or a `<video>`, see below) the browser loaded is "not shown" at a viewport when one of these holds:

- **`display`**: `display: none` on the element or an ancestor (a desktop image hidden on phones, a `hidden` attribute).
- **`visibility`**: `visibility: hidden` on the element.
- **`opacity`**: `opacity: 0` on the element or an ancestor.
- **`zero-size`**: a box with no width or no height.
- **`clipped`**: a box outside its `overflow: hidden` (or `clip`) ancestor, such as an offscreen slide of a carousel track.

An opacity, clipped or zero-size copy is first brought to the centre of the window, waited on for 400 ms, and read again: if
it is shown after the scroll (a fade-in, a box a scroll brings in) it is not a finding. This is done for the first 60 such
candidates per viewport; the rest keep the snapshot reason and the page says so (`revealCapped` in the JSON).

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

## Hidden video

A `<video>` is checked with the same rules as an image, and its bytes are the bytes the browser fetched for it. A copy is
reported only when the browser fetched bytes for it: its file (autoplay, `preload="auto"`, or a `metadata` range read) or its
poster. A `preload="none"` copy with no poster download costs nothing and is not listed.

```text
loaded but not shown on load: 9 KB/view, hidden at 1 of 2 viewport(s) ("mobile"): display; not in the savings
```

The fixes, by case:

- **Responsive twin** (a desktop and a mobile `<video>`, one hidden at each width). Use one element with `<source media>`, so
  only the shown file loads:

  ```html
  <video autoplay muted playsinline poster="/hero.jpg">
    <source media="(max-width: 600px)" src="/hero-mobile.mp4" type="video/mp4">
    <source src="/hero.mp4" type="video/mp4">
  </video>
  ```

  Browsers pick the first source whose `media` matches, so the media source comes first and the no-media one last.
  `<source media>` on video: Chrome and Edge 120+ and Firefox 120+ restored support; Safari has always supported it. A browser
  that ignores it takes the first source, so the fallback is a script that sets `src` from `matchMedia` and reloads on change.
- **Carousel slide, tab, closed `<details>` or clipped box** (lazy): `preload="none"`, no `autoplay` until the video is shown
  (an `IntersectionObserver`, or the tab, details or hover opens), and the poster only.
- **Never shown on load** at any viewport (a modal, an opacity-0 or zero-size element): remove it, or load it on demand when
  the modal or menu opens.

A video with a hidden copy gets no encode and no width at the viewports that hide it. The shown copies keep their claim.

## Limits

- CSS backgrounds are covered when their file was downloaded while hidden. A background that the browser did not download
  (`display: none`, usually) is not counted.
- The checks are a snapshot at the time of the scan, after its scroll. A carousel slide that is out of its track at that
  moment shows as `clipped`, so treat `lazy` as "not shown on load", not as proof that a user never sees it.
- The scan does not click or open menus. A menu, modal or dialog that opens by script shows as "never shown on load". Check
  the source before removing anything: the advice is to load it on demand, not to delete it.
- Hover swaps are found from the stylesheets the page loads (same-origin). A hover that a script drives is not seen.
