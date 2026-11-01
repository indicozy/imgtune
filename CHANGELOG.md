# Changelog

## Unreleased

- Faster AVIF quality search, same numbers: the search encodes AVIF at effort 2 (`cdn-fast`) and confirms the answer at
  effort 4 from the qualities that decided it (two or three effort-4 probes). A confirmation that fails moves the fast bar by the
  score difference seen at that quality and searches again (twice at most); when none confirms, the search runs at effort 4 as
  before. The reported target and bytes are the effort-4 ones. On the Next.js guard scan the per-image targets and estimated
  bytes are identical to the previous build, and the scan's CPU time fell from about 247 s to 155 s (shared machine).
- Caller map: a call site whose component is rendered for several callers lists each caller at the first owner level above
  the image that differs between usages (`callers:` in the grouped `hints`, `callers` in the JSON), with its file:line,
  pages and its own sizes formula. The dev owner chain is read at `--locate-only` and kept on each located record
  (`locator.ownerChain`, sanitised on read).
- Docs: for Next.js, the asset-prefix env must be set the same for `next build` and `next start`; the skill says to check
  the stylesheets load before a scan.
- Fix: the GPU scorer no longer overwrites the user's `CUDA_VISIBLE_DEVICES` (a GPU the user excluded could run the scorer).
  `--gpu-device` is an index within the user's visible list; imgtune never sets `CUDA_DEVICE_ORDER`. The scorer prints the
  device it opened (name, index, order, visible list) and the scan JSON records `deviceOrder` and `visibleDevices`.
- Fix: the sizes-only check judges undersize on the measured server's width, computes the chosen candidate from the dev
  page's `sizes` (and checks it is the file the browser loaded), and reports a dev/measured layout difference as `LAYOUT`
  (not a pass). It stops with no verdict when the dev page has a stylesheet that did not load.
- Scans warn when a linked stylesheet did not load (`stylesheetsFailed` on the page): the widths measured on such a page
  are not the app's. Earlier numbers measured on a page whose utility stylesheet was refused are void.
- A sizes proposal undersized at any measured viewport is not a saving (the per-image records and the group report).
  The candidate evaluation moves to `src/candidates.ts`, with a reader for the calc, min, max and clamp forms.
- `hints --format json` is not cut to the text default of 10: JSON is unlimited unless `--limit` is passed, and carries
  `truncated`.
- `imgtune report` accepts `--compare` once per page; the byte totals are summed.
- A PASS that adds bytes is labelled `PASS (sharpness fix)`; a batch that mixes them with savings prints a `mixed:` line.
- Security: page-derived text in the sizes output is cleaned of bidi overrides and zero-width marks, and capped.

- CSS background images are measured (`kind: "css-background"` records): every layer of a computed `background-image` that
  names a file, with its box, `background-size`, the file the browser loaded, the device pixels it needs, undersized, and a
  local resize estimate. Gradients, inline `data:` images and hidden or tiny elements are skipped with a reason. The headline
  numbers stay `<img>`-only (the page's `backgrounds` line reports the layers apart). Page-controlled values are capped
  (4096 characters, 8 layers) and parsed in one pass.
- A harness route (`/__imgtune/<component>`, or any URL scanned with `--harness`) is measured-harness, not measured-page:
  its records and report say the component was measured in isolation. The skill's harness step is fixed for App Router
  (a `%5F_` folder: a plain `_` folder is private) and says to verify with recheck on the harness URL.
- `scan --locate-only` works on a built page that ships source maps: the owner components' definitions, read through the
  debugger and mapped by the chunk's source map, give `file:line` with `via: prod-sourcemap` (never verified: the definition
  is not an image line). The same caps apply. Dev data stays the first choice.
- Fix: a score the CPU made (a GPU scorer's fallback, or a pair too small for the GPU) is no longer stored under the GPU's
  cache key. The cache version moves to 2, so entries written before are not read.
- `imgtune compare <before.json> <after.json>`: the per-image before and after of two scans of one page, paired by URL
  pattern and alt, and by rendered width where one key has several elements. Saved and added-for-sharpness bytes are two
  numbers; unpaired images are listed, not counted. Drift is excluded and its totals printed: an image whose rendered
  width changed (layout changed), the same file served with different bytes (server variance), and a view one scan did
  not load. Two scans of one build compare to 0 KB saved.
- Faster scans, same numbers: the quality samples of a scan are estimated two at a time (each encode already uses four
  threads), and a served file under 2 KB is not swept (`quality.sweep: "skipped-small"` in the JSON). On the nextjs.org
  guard the JSON is identical to the previous build. Cold CPU scan about 18% faster (median 57.5 s over four runs before,
  46.9 s over five after).
- `imgtune scan --recheck` with several pages starts one browser for all of them (it started one per page).
- `imgtune hints --help` lists `--top`, `--flat` and `--qualities`, and accepts several scan files.
- Shared and varied call sites get a fitted `sizes`: a linear `vw + px` per band of viewports where the measurements allow,
  a ceiling constant elsewhere, never below a measured width at any measured viewport. When pages need different widths,
  the call site says `shared component: pass sizes per caller` and each page gets its own formula. `hints` takes several
  scan files, so call sites group across pages.
- A sizes proposal whose predicted outcome adds bytes (or saves none) is not a saving: the scan leaves it out with a
  `no saving` reason, and `hints` counts it. The prediction uses the candidate each proposed value would pick, per viewport.
- `imgtune hints --top N`: the N call sites that save the most per view, one line each.
- Recheck (full and `--sizes-only`) prints one line per image (`PASS`, `FAIL` or `GONE`, predicted and measured bytes) and a
  batch line; the detail follows only for images that did not pass.
- `imgtune report`: a Markdown run report from `.imgtune/ledger.jsonl` and the compare JSON. Ledger values are escaped as
  code in pipe-free table cells.

- Faster scans, same numbers. The AVIF and WebP calibration no longer encodes all 25 local qualities of each match: a
  parallel search over the coarse grid and then the refine window encodes about half as many, and any probe that shows
  bytes falling as quality rises falls back to the full scan. Targets and ratios are identical to the previous build on
  the nextjs.org guard, on its five quality samples and on 25 generated images, with the CPU and with `--gpu`.
- Result cache in `.imgtune/cache` (bounded to 500 MB, oldest removed first): the local encode sizes and each probe's
  score, keyed by the original's content hash, width, scorer, encoder, quality, profile and tool version. Used by `scan`,
  `scan --recheck` and `image`; a warm run reuses everything the cold run computed. `--no-cache` turns it off. Corrupt or
  foreign entries are ignored.
- Settle waits only for real document navigations. Same-document URL changes (`history.pushState`, `replaceState`, hash
  changes) no longer repeat the settle and its 10 s network-idle wait; the wait itself is unchanged.
- `--root <dir>` (`scan`, `--locate-only`): the folder project sources are read from. By default each file is read from the
  nearest folder above the cwd that holds it, so a scan run from a sub-folder of a monorepo no longer marks every source
  `unread`. Unread sources are named in the output with the folder they were looked up in.
- `scan --recheck` takes several pages (repeat `--recheck`, at most three browser contexts in all) and `--viewports <names>`
  to measure other viewports than the ones where the images rendered. Its default is unchanged.
- Security: the `locate` block and the located records of a scan file are checked as a whole when read. A dev URL that is
  not http or https, an unknown viewport, a count that is not a non-negative integer, or a short label that is not plain
  text drops the block (the rest of the scan is kept, and the drop is reported). The sizes recheck refuses a non-http dev
  URL from the file or the command line. `hints` prints the located line only from a checked block.

- Split measure and locate. `scan <built-url>` measures the bytes on a built server or a preview (no source needed).
  `scan <dev-url> --locate-only --from <scan.json>` reads the React source of the flagged images from a dev page, at one
  viewport (default `iphone-15`), with no image bytes read and nothing scored. It writes `<scan>.located.json`: the measured
  file with `file:line` and component joined in, and a `locate` summary (joined, not joined by reason). Elements join on
  the whole srcset as URL patterns (origin, widths and qualities taken out) and alt, in document order, only when the counts
  on both sides are equal; a count that differs joins nothing. Scans from before this version (no `domIndex`) cannot be
  located: scan again.
- `scan --recheck <file> --sizes-only [--ids ...] [--url <dev-url>]`: the per-batch check on dev, in seconds. Per image and
  viewport: the `sizes` attribute, the rendered width, the DPR, the candidate chosen and its bytes (Content-Length), undersized,
  the hint's target, and a verdict. Fails an undersized choice, a choice bigger than the hint's sizes need, and bytes that rose
  without a sharpness fix. No bytes decoded, nothing scored. The full `--recheck` is unchanged.
- `hints` on a located file prints where the sources came from, and says how many hinted images still have no `file:line`.
- The agent skill, its reference and the AGENTS snippet use the four-step flow: measure (built), locate (dev), check each
  batch (dev, sizes only), measure again (built, the real before and after).
- `--gpu` and `--gpu-device <n>` (`scan`, `scan --recheck`, `image`): SSIMULACRA2 scoring on an NVIDIA GPU, opt-in. It runs
  through `imgtune-ssimu2-gpu`, an external program built from `native/ssimulacra2-gpu/` against libvship (Vship). A missing
  or failing program prints a warning and the run scores on the CPU. Encoding stays on the CPU. On nextjs.org scoring took
  19 s on the CPU and 1 s on the GPU (a timed scan: 110 s to 89 s on a loaded machine). The quality targets and per-image
  records of the nextjs.org scan were identical; scores differ by up to 1.2 points on its re-encode pairs.
- Scan JSON records the scorer: `scorer` on each page and on the summary, and in `resume` options. `scan --recheck` warns when
  its scorer differs from the scan's.
- Locator check: a resolved `file:line` is read from the project (local pages only) and must render an image. A call
  site that only uses the component which renders the image is `kind: owner`, `verified: false`, and hints say which
  component to search. `kind` is `image`, `owner`, `unread` or `unchecked`. Scan from the project root.
- Placeholder owner names (such as the app's fallback name) are never searched for or printed as a component; a hint with no clue says
  `owner unknown`.
- Recheck pairing: an image's id no longer includes its line, so an edit above it keeps the id. A changed id is paired
  by source file and URL pattern, and `gone` lists what was looked for and asks for a pristine rescan first. The cause of
  the earlier false `gone` results was the line in the id, not the `sizes` value.
- `hints` groups by call site across pages (default; `--flat` for one entry per image). Shared components print each
  caller's sizes and the rule to follow.
- `hints --qualities <list>` snaps quality targets to the framework's allowed values and marks the quality saving void
  after a snap.
- Savings are split into `sizes` (exact) and `quality` (est.) in the scan records, hints and call sites. Recheck prints the
  predicted saving beside the measured served bytes.
- `basis: fit` is kept: it is emitted when the layout formula does not match the measured widths (for example with no
  layout chain). It is rare, and documented as such.

## 0.1.0

First release.

- `scan` measures the images of live pages in headless Chromium, per view and per viewport, at six viewports. It reports
  exact and est. byte savings, sharpness growth apart from them, and a SSIMULACRA2 quality check.
- Per-image fix hints. For each image: its locator (component, `file:line` in dev builds, `data-testid`, `alt`, loader
  URL pattern), the `sizes` the browser resolved at each viewport, the quality and format targets, and two byte numbers,
  bytes saved and bytes added for sharpness, which are never netted.
- `hints <scan.json>` prints the fix hints in batches: `--limit`, `--offset`, filters, and `--format json`.
- `scan --recheck <scan.json> [--ids a,b,c]` rescans the named images and prints before and after. It exits 1 when an
  image became undersized, or when bytes rose without a sharpness fix.
- `scan` at scale: `--urls-from` (a URL list or a sitemap), `--sample-per-pattern`, `--storage-state` for a logged-in
  session, `--resume`, `--max-pages` and `--max-images`. `--ignore-robots` is for sites the user owns or is authorised to
  test, and is recorded in the JSON.
- `image <file|url|glob>` measures image files without a page: their bytes, the lowest quality per format that meets the
  bar (SSIMULACRA2 90 by default, `--min-score` sets another), and at a `--width` the bytes at each needed width.
  `--write` writes optimised copies into a folder and never overwrites a file.
- The `skills/imgtune` agent skill (SKILL.md and reference.md), and `skills/imgtune/AGENTS.snippet.md` for AGENTS.md,
  CLAUDE.md, Cursor, Codex or Copilot.
- The composite GitHub Action in `action.yml` scans the pages it is given and comments on the pull request. The comment
  keeps the summary tables and adds a collapsed "Fix hints for your AI agent" section.
- Requires Node.js 20.9 or later and Chromium for Playwright.
