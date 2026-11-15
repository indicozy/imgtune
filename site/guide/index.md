# Guide

imgtune measures the page weight of a live site, and your AI agent fixes it. These pages walk through a first scan, the agent
loop, scanning many pages, repo images, CI, how the numbers are made, and each thing a scan checks.

## What it checks

- [Images](/guide/how-it-measures): the `sizes`, quality and format of each image, per viewport. Also see [Image loaders and CDNs](/guide/loaders-and-cdns).
- [Video and animated images](/guide/video-and-gifs): animated GIF, WebP and APNG, and self-hosted `<video>`.
- [Loaded but not shown](/guide/hidden-images): images and videos the browser downloads and no viewport shows.
- [Fonts](/guide/fonts): WOFF2, subsetting, unused faces and static weights.
- [Compression](/guide/compression): text served with no `Content-Encoding`.
- [Vector art](/guide/vector-art): flat rasters that could be SVG.
- [SVG files](/guide/svg): SVGO and the render check.
- [Lottie animations](/guide/lottie): size, embedded rasters and the `.lottie` repack.
- [3D models](/guide/3d-models): glTF and GLB, meshopt and textures.
- [Audio](/guide/audio): Opus re-encodes and lazy loading.
- [Favicons](/guide/favicons): favicons and apple-touch-icons over their size.
- [Resources](/guide/resources): the overview of the non-image checks, their labels, the budget and the flags.

## The guides

- [Getting started](/guide/getting-started): install, a first scan, how to read the output, and the hints.
- [Fix it with your agent](/guide/fix-with-your-agent): install the skill, the eight-step loop, batches with a ledger, the evidence ladder, and the rules.
- [Scanning any site](/guide/scanning-any-site): sitemaps, sampling, logged-in pages, resuming a long run, and the limits.
- [Repo images and file mode](/guide/repo-images): measure image files in your repository, with `imgtune image`.
- [CI action](/guide/ci-action): scan the pages of each pull request, and comment the page weight and the fix hints on it.
- [How it measures](/guide/how-it-measures): resolution, quality and format per view and viewport, and what the estimated saving and sharpness mean.
- [Limitations and FAQ](/guide/limitations-and-faq): what imgtune does not measure, and common questions.
- [Compared with other tools](/guide/compared-with-other-tools): how it differs from compressors, image CDNs, `next/image` and Lighthouse.
