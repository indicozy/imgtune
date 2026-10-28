# imgtune in CI

The composite action at the root of the repository scans the images of pages and comments the result on the pull
request. One comment per pull request is created, then updated on each push. It is identified by a hidden marker,
`<!-- imgtune-scan -->`.

## Inputs

| input | default | meaning |
| --- | --- | --- |
| `urls` | required | page URLs, separated by newlines or spaces |
| `fail-over` | none | exit 3 when a page's exact + est. share is above this percentage |
| `comment` | `true` | post or update the pull request comment (see below for which pull request) |
| `viewports` | all six | comma-separated viewport names |
| `github-token` | `github.token` | token that posts the comment |
| `comment-author` | `github-actions[bot]` | login whose comments the action may update |

The action updates only a comment that this login wrote and that starts with the marker, so a commenter cannot make it
edit their own text. When you pass a custom `github-token` (a GitHub App or a PAT), set `comment-author` to that
account's login: the action cannot look it up from the token.

The job's result is the scan's exit code: 0 when it passed, 3 when a `fail-over` budget was exceeded, 1 or 2 when the
scan itself failed (2 when Chromium is missing).

## Which pull request gets the comment

- On a `pull_request` event, the comment goes to that pull request.
- On any other event (for example `deployment_status`, which Vercel sends for each preview), the action looks up the
  open pull request of the commit (`github.event.deployment_status.deployment.sha`, or `github.sha`). If there is none,
  it logs a line and posts nothing; the scan result still sets the job's exit code.

## Permissions

```yaml
permissions:
  contents: read
  pull-requests: write
  deployments: read # the deployment_status example only
```

## Example: Vercel previews

Vercel reports each successful preview as a `deployment_status` event, so the scan runs on the preview's own URL.

```yaml
name: imgtune preview
on:
  deployment_status:

permissions:
  contents: read
  pull-requests: write
  deployments: read

jobs:
  scan:
    # Vercel reports a preview as a successful deployment_status event; scan the URL it reports.
    # The comment goes to the open pull request of the deployed commit.
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: OWNER/imgtune@main # replace OWNER/imgtune with the repository the action is published from
        with:
          urls: ${{ github.event.deployment_status.environment_url }}
          fail-over: "5"
```

The comment goes to the open pull request of the deployed commit. If the commit has no open pull request (for example
a deploy from a branch with no PR), the job logs that and posts nothing.

## Example: a local build on the runner

This workflow builds the app, starts `next start` on the runner, and scans it on localhost. It comments on the pull
request.

```yaml
name: imgtune local build
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - name: Start the app on the runner
        run: |
          npx next start -p 3000 > "$RUNNER_TEMP/next.log" 2>&1 &
          for i in $(seq 60); do
            curl -fsS http://127.0.0.1:3000/ > /dev/null && exit 0
            sleep 1
          done
          cat "$RUNNER_TEMP/next.log"
          exit 1
      - uses: OWNER/imgtune@main # replace OWNER/imgtune with the repository the action is published from
        with:
          urls: |
            http://127.0.0.1:3000/
            http://127.0.0.1:3000/products
          fail-over: "5"
```

The action builds itself on first use (`pnpm install` and `pnpm run build` in its own folder) and installs Chromium
with `pnpm exec playwright install --with-deps chromium`. Expect a minute or two of setup per run.

## Notes

- Pull requests from forks get a read-only token, so the comment step fails for them. The scan still runs and the
  budget still applies.
- `dist/` is not committed. The action builds it, so the repository needs no build output.
- The comment lists the top five groups per page, with the current and suggested `sizes`. Page text is shown in code
  spans, so a page cannot inject links or mentions into the comment.
