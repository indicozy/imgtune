# Fonts

`scan` also measures the web fonts a page downloads. For each font file it reports the bytes per view, what the page's text
needs from the file, and what the file could save. Fonts are checked against the text the page renders, after the page
has been scrolled, at the desktop viewport.

## What is checked

- **WOFF2.** A TTF, OTF or WOFF file that is not WOFF2 is re-encoded to WOFF2 (brotli). Small files are measured; a large
  file gets an estimate from the ratio of a typical WOFF2 and is labelled as one.
- **Subsetting.** The page's text uses some Unicode scripts (Latin, Cyrillic, Greek, CJK, and so on). A font with far more
  glyphs than those scripts need is subset to them. The subset keeps Basic Latin, Latin-1, general punctuation and currency
  even when the text has none of them, so the subset does not break a later edit. The recommendation is by Unicode block,
  not to the exact text of this page, because text changes.
- **Unused faces.** A font file that the browser downloaded, but no rendered text uses (its `document.fonts` status is
  `unloaded`), is wasted bytes. A face that is used for a weight or style that no text uses is reported the same way.
  A face the browser rendered with, even as a fallback, is never called unused.
- **Several static weights.** Three or more static faces of one family could be one variable font. This is informational
  and saves nothing in the total.

## What is not checked

- **Icon fonts.** A font whose glyphs are mostly in the private-use area is an icon font. It gets the WOFF2 check only; it
  is never subset and never called unused, because its glyphs are not text.
- **Slices.** A file the site already split with `unicode-range` is not subset again.
- **Text outside the rendered page.** The scripts come from the visible text. A character that only a hidden menu or an
  `aria-label` shows is not counted, so a subset that drops its script would break that menu.

## The numbers

- Bytes are per view, as fetched.
- The saving is the fetched size minus the best of the WOFF2 and subset sizes. A saving under 1 KB or under 10% of the file
  is not reported.
- A label marks a number as an estimate. The subset WOFF2 of a large font is estimated from its sfnt size and the WOFF2 ratio
  (about ±20% on the census fonts).

## The fixes

Each finding gives the exact command and the expected bytes, for example:

```sh
woff2_compress Font-Regular.ttf
pyftsubset Font-Regular.ttf --unicodes=U+0000-007F,U+0080-00FF,U+2000-206F,U+20A0-20CF --flavor=woff2 --output-file=Font-Regular.subset.woff2
```

Framework equivalents are named in the fix too: `next/font` with `subsets: ['latin']`, `&subset=latin` on a Google Fonts URL,
or the `latin.css` file of `@fontsource`. For an unused face, the fix is to remove its `@font-face` and any preload. Check
before removing it: a face used after a click, or on another route, is not seen by one scan.

## Limits

- One desktop view per page in a scan. Faces used only at other viewports, or after an interaction, can look unused.
- The unused check needs the face's URL, which the browser gives for each `@font-face` rule. Without it, the check is off
  and nothing is called unused.
- Only the fonts the page loads are read. A font that is never requested (a face a stylesheet declares but a page never
  uses) is not in the scan.
