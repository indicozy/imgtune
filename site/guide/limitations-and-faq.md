# Limitations and FAQ

## Limitations

- **Six deciders.** The production study is a signal, not proof. Its sample leans toward sites without bot walls. See the
  [study](/study/).
- **Exact is measured, est. is estimated.** Estimates are local re-encodes scored against the original, not bytes a server sent.
  Where a loader could not be scored, the estimate is a floor.
- **Live pages only.** A scan measures the page as the browser loads it, at six viewports, scrolled to the end.
- **Bot walls.** A page behind a challenge is recorded as `blocked`, and it is not retried.
- **Chromium is required** for `scan`, `audit` and `verify`. Install it with `npx playwright install chromium`.
- **Next.js projects.** The project commands (`audit`, `apply`, `verify`) are written for Next.js. `scan` works on any URL.
- **Node.js 20 or later.**

## FAQ

**Does ImgTune change my site?** Only `apply` edits your source files, and it edits literal `sizes` and `quality` props. `audit`
and `verify` write reports under `.imgtune/`. Measuring also adds temporary instrumentation to the source, which an interrupted run
restores. `scan` writes only its JSON output. ImgTune never commits.

**Why is there an est. number at all?** Not every site serves a smaller candidate for every image. The estimate shows what a re-encode
or a resize would save. It is always labelled as an estimate.

**Why six viewports?** Four phones, a 1440 px desktop at 2x and a 1280 px desktop at 1x. Lighthouse measures one viewport per run.
ImgTune measures all six, because the width an image needs changes with the viewport.

**What does "fixable" mean?** The share of the bytes of the images that have a saving, rather than the share of all image bytes.

**Can I scan a site I do not own?** The agent skill says to scan only sites you own, and to scan each one once. The scanner
loads the pages a browser loads, and it checks robots.txt first.

**Where do the numbers come from?** The scan JSON, with the fields listed in [Output JSON fields](/reference/output-json).

**Is there a demo that needs no install?** Yes. The [demo](/demo) runs in your browser and measures a file you drop. Its numbers are
browser estimates and are not the CLI's.

**How long does the demo take on a phone?** On a mid-range phone, expect about 9–13 s for a 1200 px photo, and up to about 56 s at
4000 px, with AVIF on. With the phone-only set (devices reporting 4 GB or less), a 4000 px photo takes 13–19 s. These were measured on
two cores of a desktop CPU as a stand-in for a phone, not on a real one; older or budget phones will be slower. AVIF is the slowest codec, so skipping it is the quickest way to a result.
