# imgtune reference

Long-form material for `SKILL.md`. Read the part you need; the main steps are in `SKILL.md`.

## Ledger and handoff

### `.imgtune/ledger.jsonl`

One JSON object per line, one line per image usage. Append; never rewrite earlier lines except to correct a status
(then append a new line with the same `id`, and the last line for an id wins).

```json
{"id":"0763e0f5e352","file":"src/components/Card.tsx:42","rung":"measured-page","fix":"sizes calc((100vw - 32px) / 2); quality 75; avif","status":"verified","verified":true,"saved_kb":28,"added_kb":0}
{"id":"ef51cdf4866c","file":null,"rung":"not-measured","fix":"","status":"unmatched","verified":false,"reason":"no source line holds this image"}
```

- `id`: the hint id (`images[].id`).
- `file`: `path:line`, or `null` when unmatched.
- `rung`: `measured-page`, `measured-harness`, `ceiling-code` or `not-measured`.
- `status`: `fixed`, `verified`, `failed`, `reverted`, `skipped`, `unmatched`, `reported`.
- `verified`: true only after a passing `scan --recheck`.
- `saved_kb` and `added_kb`: keep them separate. Never store a net value.

### `.imgtune/HANDOFF.md`

Write this when stopping early. Keep it short enough to read first in the next session.

```md
# imgtune handoff

- Scan: .imgtune/scan/<host>-<path>.json (scanned <date>, server: <built | preview | dev>)
- Next hint offset: <N> (of <total> with fix hints)
- Ledger: .imgtune/ledger.jsonl (<n> lines; last id <id>)
- Done: <counts by status>
- Open: <unmatched count>, <not-measured count>, questions for the user
- Resume: read this file and the ledger, then `npx imgtune hints <scan> --limit 10 --offset <N>`
```

## Framework notes in detail

### next/image

- `sizes` decides which widths the loader generates. Set it to the hint's `sizes` value exactly.
- `quality` takes values from `images.qualities` in `next.config`. In recent Next.js versions the list is explicit, so a
  value outside it is an error. Add the value to the list when the fix needs it, and say so in the report.
- `formats` in `next.config` (for example `['image/avif', 'image/webp']`) sets the formats the optimiser serves.
- `priority` marks the LCP image for early loading. It is a loading choice, not a bytes fix: put it in the speed note.
- `fill` makes the image take its parent's size. The parent must be positioned and sized, and `sizes` still applies.
- A `loader` prop that is a custom CDN loader ignores `width` and `quality`: the hint says `tunable: false`. Fix the
  loader function, not the call site.

### Plain `<img>` and `<picture>`

- `srcset` with width descriptors (`400w`) and a `sizes` attribute let the browser pick. Use the hint's `sizes`.
- For a plain image with no `srcset`, the hint gives `width` (device pixels needed). Resize the file to that width, or
  pass the width to the CDN's transform, then set `width` and `height` attributes to its intrinsic size.
- `width` and `height` attributes reserve the space and prevent layout shift. Keep them with the new file's size.
- `<picture>` with `<source type="image/avif" srcset="...">` and `<source type="image/webp" ...>` before the `<img>`
  fallback. Keep the `<img>` fallback in the original format.

### Nuxt `<NuxtImg>` (`@nuxt/image`)

- Props: `sizes`, `quality`, `format`, `densities`. The provider (for example `ipx` or a CDN) decides which values are
  allowed. Check the module's configuration before setting a quality the provider may not accept.
- `sizes` on `<NuxtImg>` is Nuxt Image's breakpoint syntax, not a CSS `sizes` string. For example
  `sm:100vw md:50vw lg:400px`, where each breakpoint name is one of the project's configured `screens`. The hint gives a
  CSS value (`calc(50vw - 20px)`), so translate it into breakpoint form with the project's `screens`. If that cannot be
  done faithfully, use a plain `<img>` or `<picture>` with the CSS `sizes` value instead, and say so in the report.
- For a locally served image, `ipx` resizes on request. Its widths follow the image module's `screens` settings.

### Astro `<Image>`

- Props: `widths` (the widths to generate), `sizes`, `quality`, `format` (singular, one output format).
- The hint's `sizes` goes in `sizes`, and the `widths` list should include the widths the browser can pick.
- `<Picture>` takes `formats` (plural) for several output formats, and the same `widths`, `sizes` and `quality` props.

### CSS backgrounds

- `background-image` has no `sizes`. Use `image-set()` for 1x and 2x files, or a media query that swaps the file on
  small screens.
- The scan records `<img>` elements only. A CSS background has no hint, so it is `not-measured`, or a `ceiling-code`
  from its layout, unless a measured-harness route renders it.

### Other frameworks

Use the framework's documented image component or attributes. Keep the same rules: take `sizes` from the hint, respect the
allowed qualities, and fix the loader when it is custom. Say in the report which API you used.

## Measured-harness route

Use this only for a usage that the page does not show in a measured state (a hidden tab, an image in a modal).

1. Add a temporary route, for example `/__imgtune/<component>`, that renders the component in each state: each
   width or variant the page uses.
2. Start the dev server. Scan the route with the same viewports: `npx imgtune scan http://localhost:<port>/__imgtune/<component> --out .imgtune/harness`.
3. Use the measured `sizes` and quality from that scan. Label the fix `measured-harness`, and note the states rendered.
4. Remove the route and its files before you finish. Check with `git status`, then move (do not delete) any leftover
   file into a folder the user chooses. Note the removal in the report.

Storybook works the same way: scan each story's iframe URL.

## Ceiling from code

When a usage cannot be measured at all, derive an upper bound on the width it needs from the layout:

- The container's width at each breakpoint (from the resolved classes and the Tailwind config, or the CSS).
- The number of columns in the grid, and the gap and padding around the image.
- The largest viewport the element can appear in.

Write the result as a ceiling, for example "at most 1280 px at 2x". Never derive it from the existing `sizes` value: that
value is what the scan is checking, and it has been wrong in measured runs. Report every ceiling as `ceiling-code`, and
never add its bytes to the measured total.

## Repo image files

```sh
npx imgtune image "public/**/*.{jpg,jpeg,png}" --write .imgtune/copies --min-score 90
```

- Copies go to a folder that is not the originals. The command never overwrites and refuses the file's own folder.
- A width is needed for a usage: pass `--width <css px>` and `--dpr 1,2` from the hint. Without `--width` the file is
  measured at its own size, which is a different question.
- Replacing the originals is a decision for the user. Show the table of before and after bytes first.

## Verify checklist

- [ ] `scan --recheck` exits 0 for every fixed id (or each failure is recorded and reverted).
- [ ] No fix raised the bytes without a sharpness fix on the same usage.
- [ ] Each fix is labelled with its rung.
- [ ] The final scan on the built or preview server is compared with the before scan.
- [ ] The report lists saved and added-for-sharpness as two numbers.
- [ ] The ledger has a line for every usage the batches touched.
