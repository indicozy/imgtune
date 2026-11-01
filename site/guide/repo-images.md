# Repo images and file mode

`imgtune image` measures image files without a page. Use it for the images in your repository, such as `public/`, or for a
single image at a URL. It needs no server and no browser.

```sh
npx imgtune image "public/**/*.{jpg,png}"
```

For each file it reports:

- the bytes now;
- the lowest quality per format (`avif`, `webp`, `jpeg`) that keeps the file's SSIMULACRA2 bar. The bar is measured against
  the file itself: 90 by default, which is visually lossless;
- with `--width`, the bytes at the width the image is needed at, for each device pixel ratio.

| flag | what it does |
| --- | --- |
| `--width <css px>` | the CSS width the image is shown at. The width is then the one you give, not the file's |
| `--dpr <list>` | device pixel ratios for `--width` (default `1,2`) |
| `--formats <list>` | `avif`, `webp`, `jpeg` (default: all three) |
| `--min-score <n>` | the SSIMULACRA2 bar, above 0 and at most 100 (default 90) |
| `--write <dir>` | write optimised copies (best format, at the largest needed width) into this folder |
| `--format <text\|json>` | text (default) or JSON |

Globs use `**` to walk folders. `node_modules` and dot folders are skipped.

## Width

Without `--width`, a file is measured at its own size. That answers a different question from "how big does this image
need to be on the page?".

For a plain `<img>`, the hint gives `width` in device pixels. Divide it by the device pixel ratio to get the CSS width, then
pass that width to `--width` with the same ratio in `--dpr`.

A `srcset` image has a `sizes` value rather than one width, because the width changes with the viewport. The scan already
measured its bytes at each viewport, so use the hint for it, and use `imgtune image` for files in the repository.

## Copies, not originals

`--write` writes optimised copies into a folder you name. It never overwrites a file, and it refuses the file's own folder.

```sh
npx imgtune image "public/**/*.{jpg,png}" --write .imgtune/copies --min-score 90
```

Replacing the originals is your decision. Look at the table of before and after bytes first, and replace only the files you
choose. Each copy is a separate line in the report.

Results from this command are labelled `file-mode`. That is separate from the evidence rungs of a page scan, which are
described in [Fix it with your agent](./fix-with-your-agent).

## Global image settings

Some savings come from the framework's settings, not from one file: the output formats (AVIF before WebP), the device sizes,
the allowed qualities, and the default loader for a CDN. Change those in the framework's config, then check the effect with a
scan. The agent reports them as extras, separate from the usage fixes.
