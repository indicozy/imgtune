# Configuration

ImgTune reads an optional `imgtune.config.json` in the project directory (the `--project` directory, or the current directory).
Flags take precedence over the file. Without the file, every default below applies.

`scan` takes its settings from its flags only and does not read the file. `audit`, `apply`, `verify` and `restore` read it.

```json
{
  "quality": "relaxed",
  "maxScoreDrop": 2,
  "port": 3999,
  "paths": ["src"],
  "viewports": [{ "name": "iphone-15", "width": 390, "height": 844, "dpr": 3, "mobile": true }]
}
```

## Keys

| key | default | meaning |
| --- | --- | --- |
| `paths` | `["."]` | the files or directories to scan. `--path` replaces it |
| `quality` | `"relaxed"` | `relaxed` or `strict` (see [CLI](/reference/cli#audit)) |
| `metric` | `"ssimulacra2"` | `ssimulacra2`, `ssimulacra2-native` or `ssim` |
| `threshold` | `70` for relaxed, `80` for strict (ssimulacra2) | the pass mark. An explicit threshold is absolute and switches the relative rule off |
| `maxScoreDrop` | `2` for relaxed, `1` for strict | the relative rule: points a sample may drop from its current score. A positive number. Not with `threshold` or `ssim` |
| `tolerance` | `5` for relaxed, `3` for strict | how far above the applied quality `verify` may suggest raising it, capped at the quality before `apply` |
| `port` | `3999` | port for a dev server that ImgTune starts |
| `devCommand` | detected from the project | the command that starts the dev server that `audit` and `verify` manage |
| `url` | none | the base URL of a server that is already running. `--url` takes precedence. The tool never starts or stops it |
| `sitemapUrl` | none | a sitemap that `audit` reads for example page URLs |
| `urls` | `{}` | a map from a route pattern to example URL paths |
| `viewports` | the six CLI viewports | the viewports to measure. Each has `name`, `width`, `height`, `dpr`, `mobile` and optionally `userAgent` |
| `samplesPerComponent` | `20` | how many image samples `verify` takes for each usage and format |
| `maxPagesPerPattern` | `2` | how many pages `audit` visits per route pattern |
| `includeDone` | `false` | re-measure usages already marked optimised (the same as `--all`) |
| `ssimulacra2Path` | none | the `ssimulacra2_rs` binary, used by `--metric ssimulacra2-native`. Otherwise it is looked up on the PATH |

## Files ImgTune writes

| path | what it holds |
| --- | --- |
| `.imgtune/report.json` | the last `audit` result |
| `.imgtune/scan/` | the JSON of each `scan` page (the default `--out`) |
| `imgtune.state.json` | which usages were already applied, so a second `audit` skips them |

Add `.imgtune/` to your ignore list if you do not want the reports in git. The repository's own `.gitignore` lists it.
