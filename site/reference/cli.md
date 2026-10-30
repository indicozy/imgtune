# CLI commands and flags

```sh
npx imgtune <command> [options]
npx imgtune --help
npx imgtune <command> --help
npx imgtune --version
```

ImgTune needs Node.js 20 or later and Chromium for Playwright (`npx playwright install chromium`). When Chromium is missing,
ImgTune prints that command and exits with status 2.

## Commands

| command | what it does |
| --- | --- |
| `scan` | measure live pages by URL, with no source, config or dev server. Writes one JSON file per page |
| `audit` | measure the images of a running Next.js app and propose `sizes` and quality. Writes `.imgtune/report.json` |
| `apply` | write the proposals of the last audit into the source files. With `--raise`, raise a regressed quality instead |
| `verify` | re-check applied changes against the served images. Report only |
| `restore` | undo the temporary instrumentation an interrupted run left in the source files |

## scan

```sh
npx imgtune scan <url> [<url> ...] [options]
```

| flag | meaning |
| --- | --- |
| `--out <dir>` | directory for the JSON files (default `.imgtune/scan`) |
| `--aggressive` | also report a delta 4 column (never used for the claim) |
| `--viewports <names>` | comma-separated viewport names to measure (default: all six) |
| `--no-quality` | skip the SSIMULACRA2 quality measurement |
| `--markdown <file>` | write a PR-comment Markdown summary: per page, its top groups and the method |
| `--fail-over <pct>` | exit 3 when a page's exact + est. share is above this percentage (default: never fail) |
| `--summary-json <file>` | write one JSON file with every page's status and numbers |
| `-h, --help` | show this help |

Exit status: 0 on success, 3 when a `--fail-over` budget was exceeded, 2 when Chromium is missing, and 1 for other scan
failures.

## audit

```sh
npx imgtune audit [options]
```

Starts the app's dev server unless `--url` names one that is already running.

| flag | meaning |
| --- | --- |
| `--project <dir>` | project directory (default: current directory) |
| `--path <path>` | limit the scan to a file or directory (repeatable; default: `.`) |
| `--metric <name>` | `ssimulacra2` (default, built in), `ssimulacra2-native` (the `ssimulacra2_rs` binary) or `ssim` |
| `--quality <level>` | `relaxed` (default) or `strict`. For ssimulacra2 the level is relative: a sample may drop 2 (relaxed) or 1 (strict) points from its current score, never below 70 or 80. For ssim: absolute 0.975 or 0.99 |
| `--max-drop <points>` | relative rule (ssimulacra2): a sample may drop this many points from its current score. Positive. Not with `--threshold` or `ssim` |
| `--threshold <n>` | absolute pass mark on the metric's scale (0-100 for ssimulacra2, 0-1 for ssim). Overrides `--quality` and switches the relative rule off |
| `--port <n>` | port for a dev server the tool starts (default: 3999) |
| `--url <baseUrl>` | measure a server that is already running. The tool never starts or stops it |
| `--all` | also re-measure usages that were already applied |
| `-h, --help` | show this help |

## apply

```sh
npx imgtune apply [options]
```

Writes the proposals of the last audit into the source files. Nothing is committed.

| flag | meaning |
| --- | --- |
| `--project <dir>` | project directory (default: current directory) |
| `--allow-growth` | write the full sizes correction, including media branches that grow bytes |
| `--raise <Component>=<quality>` | raise the applied quality of a usage that `verify` reported regressed (repeatable). Only the raise is made |

`--allow-growth` and `--raise` only apply to `apply`.

## verify

```sh
npx imgtune verify [options]
```

Re-checks applied changes against the served images. The source files are not changed. It takes the same `--project`, `--path`,
`--metric`, `--quality`, `--max-drop`, `--threshold`, `--port` and `--url` flags as `audit`.

## restore

```sh
npx imgtune restore [--project <dir>]
```

Undoes the instrumentation an interrupted run left in the source files.

## Global

| flag | meaning |
| --- | --- |
| `--version` | print the version |
| `-h, --help` | show the usage |
