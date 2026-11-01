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

- Step: <1 measure | 2 locate | 3 fix | 4 sizes check | 5 final built scan>
- Measured: .imgtune/scan/<host>-<path>.json (built or preview server, scanned <date>)
- Located: .imgtune/scan/<host>-<path>.located.json (dev page <url>, viewport <name>; "<n> of <m> located")
- Next hint offset: <N> (of <total> with fix hints)
- Ledger: .imgtune/ledger.jsonl (<n> lines; last id <id>)
- Done: <counts by status>
- Open: <unmatched count>, <not-measured count>, questions for the user
- Resume: read this file and the ledger, then `npx imgtune hints <located file> --limit 10 --offset <N>`
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
- **Caller map** (`callers:` under a group, and `callers` in the JSON): when one component renders the image for several
  callers, each caller is listed at the first owner level above the image that differs between usages (`owner level N`).
  Each caller shows its file:line, its component, its pages and its own sizes formula (`not measured` when its images were
  not). It needs the dev owner chain (`scan --locate-only`); a built scan without source maps has none. No map means the
  usages reach the same callers.
- **Quality snap**: pass the framework's allowed qualities with `--qualities`. A target below an allowed value is raised to
  it (`q82 -> 85`), and the quality saving is then `void after snap`: it was estimated at the raw target, so it is not
  counted, and the saving is the sizes part alone.

## The split flow: measure, locate, check, measure

The bytes come from a built server and the source from a dev server. Each side does what it is good at, and the two are
joined on the page's images:

1. `scan <built-url> --out .imgtune/scan`: the measurement (served bytes, savings, sharpness, sizes). The records have no
   source (a built page has no React owner data).
2. `scan <dev-url> --locate-only --from <scan.json>`: reads one viewport of the dev page. It walks the React owner data
   only for the flagged images, reads no image bytes, and decodes and scores nothing. It writes the measured file with
   `file:line` and component joined in (`locator`, and `locate` on each joined record: viewport, rule, dev element).
3. `hints <located.json>`: the hints as before. The file:line is the dev page's, the bytes are the built page's.
4. `scan --recheck <located.json> --sizes-only --ids ...`: after each edit, on dev, in seconds. Per viewport it prints the
   `sizes` the browser read, the rendered width, the DPR, the chosen candidate and its bytes (the response's
   Content-Length), the undersized flag, the hint's target, and a verdict.
5. `scan <built-url> --out .imgtune/final`: the real before and after, built against built.

How the join works (src/locate-join.ts):

- The key of an image is its whole srcset, as URL patterns: the widths and qualities are taken out, and the page's own
  origin is taken out, so a built server and a dev server give the same key. A sizes edit changes which candidate the
  browser loads, not the key.
- Within a viewport, elements with the same key and alt text pair in document order, but only when the counts are equal on
  both sides. A count that differs joins nothing; the summary gives the reason (`count-differs`, `no-dev-image`,
  `alt-differs`, `not-measured`). A key that is unique on both sides pairs even when its alt differs (`url-unique`).
- Records from scans before this version have no element order (`domIndex`). They cannot be joined: scan again.
- Only flagged images (a saving or sharpness growth) are located. Unflagged elements still count in the groups.

The sizes check's verdict, per image and viewport: `FAIL` when the chosen file is undersized (below 0.9 times the device
pixels needed), when it is bigger than the candidate the hint's sizes choose, or when its bytes rose on an image that was
not undersized before. A plain image (no srcset) has no choice to judge: `n/a`. `gone` means no element joined at that
viewport.

Use `--url <dev-url>` when the located file is not the page you check (the default is the dev page it was located on).

## The result cache

`scan`, `scan --recheck` and `image` keep the local encode sizes and quality scores in `.imgtune/cache` in the folder they
run in (500 MB at most; the oldest entries go first). A second run on the same pages reuses them, and the numbers are
the same as a cold run. Use `--no-cache` to compute everything again, for example after changing an encoder. The cache
is keyed by the original's content hash, so a changed image never reads an old number.

## When `scan --recheck` says `gone`

`gone` means no image on the page now matches the id, or its source file and URL pattern. For `--sizes-only` it means no
element joined the record at that viewport (its key or alt changed, or the count differs). Before you act on it:

1. Set your edits aside (the page as the scan saw it: stash, or a clean copy), keep the dev server running, and run the
   same `--recheck` with the same ids.
2. If the ids are found there, the edit removed or changed the image, or the component no longer renders it under the
   same file. Fix the edit, then recheck.
3. If they are not found there either, the page no longer renders the image. Say so in the ledger (`skipped`, with the
   reason), rather than marking it fixed.

Do not mark an image `gone` in the ledger from a single recheck.

## Harness routes

Some usages render only behind a condition the scan cannot reach (a logged-in state, a tier, a feature flag). A harness
measures the component in isolation, so its numbers are the component's, not the page's.

1. Add a route that renders the component in each state the usage has, one URL per state, for example
   `/__imgtune/ProductCard?state=member`. Pages Router: `pages/__imgtune/ProductCard.tsx`. App Router: a folder whose name
   starts with `%5F` and then `_`, `app/%5F_imgtune/ProductCard/page.tsx`; a plain `_` folder is private and not routed.
2. Scan it on the dev server, so the React owner data gives `file:line`:
   `npx imgtune scan http://localhost:3000/__imgtune/ProductCard?state=member --out .imgtune/harness`.
   A route under `/__imgtune/` is recorded as measured-harness automatically. For another URL (a Storybook
   `iframe.html?id=...`), add `--harness`.
3. Fix from the hints as usual. Each record's rung is `measured-harness`, and its first note says it was measured in
   isolation. Use `scan --recheck <file> --ids ...` on the harness URL to verify, not the built page: a usage the built page
   does not render is not in its totals.
4. Remove the route file (and any Storybook story you added for this) before you finish, and check `git status`. Name the
   states you rendered in the ledger `fix` text and in the report. A state that renders no image has nothing to measure.

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
- Ask which GPU to use and pass its index with `--gpu-device`. CUDA numbers GPUs fastest first unless
  `CUDA_DEVICE_ORDER=PCI_BUS_ID` (the order `nvidia-smi` lists them in); set it yourself when the index must match
  `nvidia-smi`. A `CUDA_VISIBLE_DEVICES` the user set is kept: the index is then within the devices it lists. Without
  `--gpu-device`, index 0 is used. The run prints `--gpu: opened <name>, device index <n> (CUDA_DEVICE_ORDER: ...;
  CUDA_VISIBLE_DEVICES=...)` before the first score: check the name is the GPU you meant.
- Output begins `scored on GPU; may differ slightly from CPU`. Each page's JSON has `scorer`. Any `--gpu` warning on stderr
  means the run fell back to the CPU for some or all scores: report that.
- A `scan --recheck` whose scorer differs from the scan's prints a warning. Do not compare those numbers as a before and after.
- The measured gain is in scoring only: a timed nextjs.org scan went from 110 s to 89 s, where scoring was 19 s of the 110 s. Pages with little scoring gain little.

## Verify checklist

- [ ] `scan --recheck --sizes-only` exits 0 for every fixed id (or each failure is recorded and reverted).
- [ ] The final scan on the built server shows the bytes. The predicted and measured bytes agree in direction. A predicted
      saving with measured growth is not verified, even when the check passes.
- [ ] No `gone` image was marked fixed (see "When `scan --recheck` says `gone`").
- [ ] No fix raised the bytes without a sharpness fix on the same usage.
- [ ] Each fix is labelled with its rung.
- [ ] The final built scan is compared with the first built scan (built against built).
- [ ] The report lists saved and added-for-sharpness as two numbers.
- [ ] The ledger has a line for every usage the batches touched.

## Compare: the before and after of one page

`imgtune compare <before.json> <after.json>` (built against built, or any two scans of one page).

- Pairing: an image joins the other scan's image when its srcset URL pattern (origin, widths and qualities taken out) and
  its alt match. Images with the same key pair in document order. A key with unequal counts pairs the first n and lists
  the rest as unpaired. A fix that changes an image's pattern (a new format, a new host) makes it unpaired: say so.
- Numbers, per view (the mean over the viewports both scans measured the image at): before and after bytes of the paired
  images, `saved` (the file got smaller), `added for sharpness` (the image was undersized before), and `grew without a
  sharpness reason` (a warning, never counted as saved). Two numbers, never netted.
- The page total is each scan's own image total: it includes data drift, so it is not the claim.
- Unpaired images (in one scan only) are listed as `appeared` or `disappeared`, with their bytes, and are not counted.
- `--format json` gives every paired change and every unpaired image; `imgtune report --compare` reads that JSON.

## Fitted sizes for shared and varied call sites

A call site (its file:line, or its component) with several images gets one `sizes` value fitted to the rendered widths
measured at each viewport (group-sizes.ts):

- Points: the largest rendered width at each viewport width, over the group's images on each page.
- Bands: consecutive viewports join one band while a linear `vw + px` line fits all of them (the slope in vw to one
  decimal, the offset in whole px rounded up, never more than the larger of 2% or 4 px above a measured width). A band that
  takes no line is a ceiling constant.
- Joined by media conditions at the known breakpoints (640, 768, 1024, 1280) between bands; at most four clauses (the
  widest bands join into one constant when there are more).
- Checked at every measured viewport with the browser's own evaluation (`sizesSlotAt`). If a check ever failed, the fit is
  the single constant covering the widest measured width.
- Shared components: if the pages need different widths at the same viewport (more than the larger of 4 px or 2%), the
  call site is `shared component: pass sizes per caller`, and each page has its own formula. Otherwise one formula covers
  every image and page (`one formula over N image(s)`). A call site whose images all propose the same value keeps it.
- A group with an image that has no measurement keeps the older text (the widest measured width as a floor).

## Sizes proposals with no saving

The scan predicts each sizes proposal per viewport: the candidate the proposed sizes would pick (the smallest at or above
the device pixels it needs) against the file served now, with the candidate's bytes from the scan's fetcher.

- Kept: the proposal saves more than it adds on images that were not undersized, or it is a sharpness fix (the image was
  undersized and the larger file fixes it). Its `sizes` part is the predicted saving, and the quality part is unchanged.
- Dropped: `no saving: proposed sizes <value> picks larger candidates at <views>` (it adds bytes on an image that was not
  undersized), or `no saving: ... picks files of the same size as now` (the candidates are equal in bytes: often a source
  image smaller than the widths asked for). The record keeps the reason in `fix.noSaving`; `hints` counts the dropped
  proposals and does not list them. Do not add a dropped value by hand.
- A proposal the scan cannot judge (a candidate that cannot be read, or no decoded size) keeps the measured numbers.

## Recheck output

Full and `--sizes-only` rechecks print one line per image: `<id>  PASS|FAIL|GONE|LAYOUT  <where>  predicted saves|adds X KB/view,
measured saves|adds Y KB/view`. The predicted number is the hint's saving; the measured one is the served bytes change at
the viewports both scans have (sizes-only: the dev page's chosen file). Detail lines (viewports, reasons) follow under
`not passed:` for the images that did not pass. The last line is the batch total: counts of each verdict, and the predicted
and measured sums. The exit status and the `ok:` / `FAILED:` lines are unchanged.

- `PASS (sharpness fix)`: the PASS adds bytes (an undersized image given a sharper file). A batch with both kinds prints a
  `mixed:` line with each total on its own. Decide per group; do not net them.
- `LAYOUT`: the dev page renders the element at another width than the measured server (beyond 2 px or 2 %). The verdict is
  not a pass: the warning names the viewport. Undersize is always judged on the measured server's width. The exit is 1 and
  the last line is `NOT VERIFIED:`.
- A sizes proposal undersized at any measured viewport is not emitted as a saving: its record says `sizes proposal left
  out: <viewport>: ...` and its bytes are left out.

## A page that loads unstyled

When a linked stylesheet fails to load (the server refuses it, or a built page's stylesheet URL points at a CDN that does not
have this build's file), the page renders without its utility styles. An image with a `width` attribute then measures at
that attribute, and every width and sizes verdict on the page is wrong. The scan prints `warning: ... a linked stylesheet did
not load at <viewport>` and records `stylesheetsFailed` on the page; the sizes-only check stops with no verdict. Fix the
server's asset URLs, then scan again. For Next.js, any env that rewrites asset URLs (`NEXT_PUBLIC_CDN_URL`, or an
`assetPrefix` read from env) must be set the same, and empty when needed, for both `next build` and `next start`: a value set
only at start makes the stylesheet URLs absolute to a CDN that may refuse them (the case that unstyled a measured page).
Check the stylesheets load before a scan: the PLP card on a 1440 px screenshot should match the dev width.

## The run report

`imgtune report` reads `.imgtune/ledger.jsonl` and, with `--compare`, the JSON of `imgtune compare --format json`. It
prints a Markdown report: totals by status (applied is fixed, verified or failed), the bytes (saved, added for sharpness,
growth without a reason, the page total with drift, unpaired counts), rungs, and tables of reverted (with reasons), failed,
skipped and unmatched usages, and extras. Each ledger line is checked; a line that is not usable is counted and left out.
Every value is in a code span in a pipe-free table cell (no backslash escapes), so a page-derived or ledger text cannot
break the table, format, link or mention.

Ledger fields: `id` (letters, digits, `_`, `-`), `file`, `rung`, `fix`, `status`, `verified`, and `reason` (for reverted,
failed, skipped and unmatched usages).

## Top call sites

`imgtune hints <scan.json> --top 10` prints the ten call sites with the most saving per view, one line each (where, the
images and pages, the saving split into sizes and quality). Several scan files group across pages.
