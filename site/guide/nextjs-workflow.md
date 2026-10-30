# Next.js workflow

In a Next.js project, ImgTune can write the `sizes` and `quality` props of `next/image`, then check them against the server.
The loop is audit, apply, verify, and restore only if something went wrong.

## 1. Audit

```sh
npx imgtune audit [--path <path>] [--url <baseUrl>] [--port <n>]
```

`audit` measures the images of the running app and writes `.imgtune/report.json`. It starts your dev server (`next dev`)
unless `--url` names a server that is already running. ImgTune never stops a server that you started yourself.

- `--path <path>` narrows the scan to one file or directory. Repeat it for more than one.
- `--port <n>` picks the port of a dev server that ImgTune starts (default 3999).
- `--all` also measures usages that were already applied.

Read `.imgtune/report.json`, and look at its top results before you change anything.

## 2. Apply

```sh
npx imgtune apply [--allow-growth]
```

`apply` edits literal `sizes` and `quality` props and the qualities in `next.config`. It skips expressions and reports each
skip. `--allow-growth` also writes media branches that make files heavier. Use it only when you accept heavier files for
sharper images.

Progress is kept in `imgtune.state.json` in the project, so a second `audit` skips usages that were already applied.

## 3. Verify

```sh
npx imgtune verify [--url <baseUrl>] [--path <path>]
```

`verify` changes no files. It measures the applied changes against the images the server now serves. Each usage is reported
as `verified`, `regressed` or `unmeasured`, with `n`, the number of distinct images the usage was judged on. A usage with fewer
than five distinct images is judged on those.

If a usage is `regressed (raise quality to N)`, raise its quality with the command `verify` prints under the table:

```sh
npx imgtune apply --raise <Component>=<N>
npx imgtune verify
```

`--raise` moves the quality of that one usage, and its entry in `images.qualities` when the project has a list. It must be
above the applied quality and at most 100. For any other `regressed` reason, or for an `unmeasured` usage, report it and stop.

## 4. Review

Run `git diff`. Do not commit. Leave the commit to the person who owns the repository.

## Restore

```sh
npx imgtune restore
```

Measuring adds temporary instrumentation to the source files. A run that is interrupted (for example with Ctrl-C) restores
the files. If one was killed harder, `restore` undoes what it left behind. It only undoes that instrumentation. To back out
applied changes, restore the files from `git diff`; `restore` does not do that.

## Notes

- `audit` and `verify` manage the dev server. Do not start or stop it by hand while they run.
- A large project with slow results: narrow the scope with `--path`, for example `--path app/products`.
- A loader that cannot set quality gets `sizes` changes only. See [Image loaders and CDNs](./loaders-and-cdns).
