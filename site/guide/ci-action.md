# CI action

`action.yml` at the root of the repository scans the pages of each pull request and comments the image waste on it. One comment
is created per pull request and updated on each push. It is identified by a hidden marker, `<!-- imgtune-scan -->`.

## Inputs

| input | default | meaning |
| --- | --- | --- |
| `urls` | required | page URLs, separated by newlines or spaces |
| `fail-over` | none | exit 3 when a page's exact + est. share is above this percentage |
| `comment` | `true` | post or update the pull request comment |
| `viewports` | all six | comma-separated viewport names |
| `github-token` | `github.token` | token that posts the comment |
| `comment-author` | `github-actions[bot]` | login whose comments the action may update |

The action updates only a comment that this login wrote and that starts with the marker, so a commenter cannot make it edit their
own text. When you pass a custom `github-token` (a GitHub App or a personal access token), set `comment-author` to that account's
login: the action cannot look it up from the token.

The job's result is the scan's exit code: 0 when it passed, 3 when a `fail-over` budget was exceeded, and 1 or 2 when the scan
itself failed (2 when Chromium is missing).

## Which pull request gets the comment

- On a `pull_request` event, the comment goes to that pull request.
- On any other event, such as `deployment_status` (which Vercel sends for each preview), the action looks up the open pull request
  of the commit. If there is none, it logs a line and posts nothing. The scan result still sets the job's exit code.

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
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: OWNER/imgtune@main # replace OWNER/imgtune with the repository the action is published from
        with:
          urls: ${{ github.event.deployment_status.environment_url }}
          fail-over: "5"
```

## Example: a local build on the runner

The [docs/ci.md](https://github.com/indicozy/imgtune/blob/main/docs/ci.md) file in the repository has a second example. It builds
the app, starts `next start` on the runner, and scans it on localhost.

## Notes

- The action builds itself on first use (`pnpm install` and `pnpm run build` in its own folder) and installs Chromium with
  `pnpm exec playwright install --with-deps chromium`. Expect a minute or two of setup per run.
- Pull requests from forks get a read-only token, so the comment step fails for them. The scan still runs and the budget still applies.
- `dist/` is not committed. The action builds it.
- The comment lists the top five groups per page, with the current and suggested `sizes`. Page text is shown in code spans, so a page
  cannot inject links or mentions into the comment.

Required permissions for the example:

```yaml
permissions:
  contents: read
  pull-requests: write
  deployments: read # the deployment_status example only
```
