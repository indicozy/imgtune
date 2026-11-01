# Limitations and FAQ

## Limitations

- **Six deciders.** The production study is a signal, not proof. Its sample leans toward sites without bot walls. See the
  [study](/study/).
- **Exact is measured, est. is estimated.** Estimates are local re-encodes scored against the original, not bytes a server sent.
  Where a loader could not be scored, the estimate is a floor.
- **Live pages only.** A scan measures the page as the browser loads it, at six viewports, scrolled to the end.
- **CSS backgrounds are measured apart.** An element whose `background-image` names a file gets its own records
  (`kind: "css-background"`), and the report gives a separate line for them. The headline numbers stay `<img>`-only. There is
  no `sizes` in CSS, so the fix is a smaller file or `image-set()`. Gradients and inline `data:` images are not measured.
- **Source locations: dev builds, or a built page with source maps.** A dev page gives component names and `file:line`
  from React's data. A production build with source maps gives the component's definition (`via: prod-sourcemap`, the
  file and line, not the image's line); production names are minified, so no component name. Without source maps the agent
  matches those hints by their search clues, `alt`, `testid` and the loader URL.
- **Bot walls.** A page behind a challenge is recorded as `blocked`, and it is not retried.
- **Chromium is required** for `scan`. Install it with `npx playwright install chromium`.
- **Savings are for the pages and viewports scanned.** A usage that does not render on them is not measured.
- **Quality targets follow the loader.** Only loaders with a quality parameter get quality proposals. See
  [Image loaders and CDNs](./loaders-and-cdns).
- **Node.js 20.9 or later.**

## FAQ

**Does ImgTune change my site?** No. `scan` writes its JSON, and the optional Markdown and summary files, and nothing else.
`imgtune image` writes copies only when you pass `--write`, into a folder you name. Your agent makes the changes in your
source, from the hints, and it never commits. Review the change with `git diff`.

**Why doesn't ImgTune edit my code?** A fix needs the code around the image: the component, its props, the framework's image
API. An agent reads that code well, and a measuring tool does not. So ImgTune measures, and the agent edits. The CLI is the
trustworthy part: it reports the bytes, judges each candidate with SSIMULACRA2, and the rescan checks every change the agent
makes. Because the hint is the same whatever the framework, the same loop works in any framework.

**Why is there an est. number at all?** Not every site serves a smaller candidate for every image. The estimate shows what a re-encode
or a resize would save. It is always labelled as an estimate.

**Why six viewports?** Four phones, a 1440 px desktop at 2x and a 1280 px desktop at 1x. Lighthouse measures one viewport per run.
ImgTune measures all six, because the width an image needs changes with the viewport.

**What does "fixable" mean?** The share of the bytes of the images that have a saving, rather than the share of all image bytes.

**Can I scan a site I do not own?** The agent skill says to scan only sites you own, and to scan each one once. The scanner
loads the pages a browser loads, and it checks robots.txt first. `--ignore-robots` scans a page that robots.txt disallows, and
it is for sites you own or are authorised to test.

**Where do the numbers come from?** The scan JSON, with the fields listed in [Output JSON fields](/reference/output-json).

**Is there a demo that needs no install?** Yes. The [demo](/demo) runs in your browser and measures a file you drop. Its numbers are
browser estimates and are not the CLI's.

**How long does the demo take on a phone?** On a mid-range phone, expect about 9–13 s for a 1200 px photo, and up to about 56 s at
