# Guide

ImgTune measures the images of a live page and tells you what to change. These pages walk through a first scan, the Next.js
workflow, and how the numbers are made.

- [Getting started](/guide/getting-started): requirements, installing Chromium, and the two ways in: a scan of any URL or a tuning pass for Next.js.
- [Scanning any site](/guide/scanning-any-site): measure live pages by URL, with no source, config or dev server.
- [Next.js workflow](/guide/nextjs-workflow): audit, apply and verify the `sizes` and `quality` props of `next/image`.
- [Image loaders and CDNs](/guide/loaders-and-cdns): which loaders ImgTune detects, and which of them it can change the quality of.
- [How it measures](/guide/how-it-measures): resolution, quality and format per view and viewport, and what exact and est. mean.
- [CI action](/guide/ci-action): scan the pages of each pull request and comment the image waste on it.
- [Agent skill](/guide/agent-skill): teach a coding agent to run ImgTune safely.
- [Limitations and FAQ](/guide/limitations-and-faq): what ImgTune does not measure, and common questions.
- [Compared with other tools](/guide/compared-with-other-tools): how it differs from compressors, image CDNs, `next/image` and Lighthouse.
