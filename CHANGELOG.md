# Changelog

## Unreleased

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
