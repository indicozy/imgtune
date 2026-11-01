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
- `verified`: true only after a passing `scan --recheck`. (A hint's own `verified` is different: it means its source line
  holds an image. See Call sites below.)
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

## Call sites, owners and shared components

`hints` groups by call site: one entry per `file:line` (or component) across pages. Read the group, not each image.

- **Plain `file:line`** (`verified`): the line in the project holds an image. Edit it.
- **Owner call site** (`(owner call site)`, `the image is rendered inside <Name>`): the line is where `<Name>` is used,
  not the image. The image is inside `<Name>`. Find its definition (`function Name`, `const Name`, `export default function
  Name`) and fix the `<img>` or `<Image>` in that file. Use the call site only to confirm which component it is.
- **`owner unknown`**: no file and no usable name. Use `alt`, `testid` or `urlPattern`, and grep before editing.
- **Shared components**: the group lists each page's current and proposed `sizes`. One proposed value: apply it. `shared
  component: pass sizes from each caller`: make `sizes` a prop, have each caller pass its own value (the list gives them),
  and fix the component to use the prop. `max-safe`: one value covers every image on the page; it is the widest measured
  width, so nothing is cut off.
- **Quality snap**: pass the framework's allowed qualities with `--qualities`. A target below an allowed value is raised to
  it (`q82 -> 85`), and the quality saving is then `void after snap`: it was estimated at the raw target, so it is not
  counted, and the saving is the sizes part alone.

## When `scan --recheck` says `gone`

`gone` means no image on the page now matches the id, or its source file and URL pattern. Before you act on it:

1. Set your edits aside (the page as the scan saw it: stash, or a clean copy), keep the dev server running, and run the
   same `--recheck` with the same ids.
2. If the ids are found there, the edit removed or changed the image, or the component no longer renders it under the
   same file. Fix the edit, then recheck.
3. If they are not found there either, the page no longer renders the image. Say so in the ledger (`skipped`, with the
   reason), rather than marking it fixed.

Do not mark an image `gone` in the ledger from a single recheck.

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

## GPU scoring (`--gpu`)

Use it only when the user asks. It is opt-in and it speeds up only the SSIMULACRA2 scoring.

- The program is `imgtune-ssimu2-gpu`, built from `native/ssimulacra2-gpu/` in the imgtune repo against libvship (Vship,
  not bundled). Install it on `PATH` or set `IMGTUNE_GPU_SCORER`. Check it with `imgtune-ssimu2-gpu --check --device 0`
  (prints the device name and the self-test scores).
- Ask which GPU to use and pass its `nvidia-smi` index with `--gpu-device`. Without it, index 0 is used.
- Output begins `scored on GPU; may differ slightly from CPU`. Each page's JSON has `scorer`. Any `--gpu` warning on stderr
  means the run fell back to the CPU for some or all scores: report that.
- A `scan --recheck` whose scorer differs from the scan's prints a warning. Do not compare those numbers as a before and after.
- The measured gain is in scoring only: a timed nextjs.org scan went from 110 s to 89 s, where scoring was 19 s of the 110 s. Pages with little scoring gain little.

## Verify checklist

- [ ] `scan --recheck` exits 0 for every fixed id (or each failure is recorded and reverted).
- [ ] The predicted and measured bytes in each recheck line agree in direction. A predicted saving with measured growth
      is not verified, even when the check passes.
- [ ] No `gone` image was marked fixed (see "When `scan --recheck` says `gone`").
- [ ] No fix raised the bytes without a sharpness fix on the same usage.
- [ ] Each fix is labelled with its rung.
- [ ] The final scan on the built or preview server is compared with the before scan.
- [ ] The report lists saved and added-for-sharpness as two numbers.
- [ ] The ledger has a line for every usage the batches touched.
