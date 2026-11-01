# Changelog

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
