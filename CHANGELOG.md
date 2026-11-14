# Changelog

## Unreleased

- Resources. `scan` records every non-image response of a page and reports two checks in a Resources section (after
  Video, and in the JSON as `resources`): text served without compression (brotli-11 saving, grouped per host and content
  type), and favicons or apple-touch-icons over 10 KB or 30 KB (the saving from a 32 px or 180 px re-encode). `--no-resources`
  turns them off. Neither is in the image totals.
- Measuring browser: `--disable-software-rasterizer` is no longer passed to Chromium (`--disable-gpu` stays). With it WebGL
  was off, so a page with a 3D viewer never requested its model. Only WebGL pages pay the extra CPU.
- Fonts. `scan` reports each web font file's bytes per view and its savings: a re-encode to WOFF2 (measured for small files,
  estimated for large ones), a subset to the Unicode scripts the page's text uses (the subset keeps Basic Latin, Latin-1,
  punctuation and currency), and faces the browser downloaded but no rendered text uses. Icon fonts are not subset, and a
  family of several static weights is noted as a candidate for one variable font. Each finding names the command and the
  expected bytes. See the Fonts guide.
- Lottie animations. `scan` reads each Lottie JSON and `.lottie` file the page loads: the size, layers, frame rate and duration,
  and the savings: embedded rasters re-encoded to WebP at the display size, numbers rounded to three decimals, and a `.lottie`
  repack (an estimate). A huge animation shown small gets a hint to export at the display size.
- SVG files. Each SVG of 2 KB to 5 MB is optimised with SVGO (floatPrecision 2) and reported when the brotli size drops by at
  least 20% and the render still scores 70 or more on SSIMULACRA2 at half size. SVGs with embedded `data:` rasters are listed.
- 3D models. `scan` checks glTF and GLB files: the geometry saving with meshopt is measured (the file is repacked and
  run through gltf-transform), base64 buffers get the GLB repack, and PNG or JPEG textures get a WebP estimate. Draco and
  meshopt files are reported as compressed. USDZ, OBJ, FBX, KTX2, splats and PLY are informational.
- Audio. `scan` probes each audio file with ffprobe. WAV and FLAC, lossy files above 128 kbps stereo (64 kbps mono), and
  stereo files with identical channels get an Opus re-encode, measured on a 10 s sample. A file loaded on page load gets the
  `preload="none"` fix. Without ffmpeg only the bytes are reported.

- Vector art. A still raster that is flat (a few colours cover most of it: logos, icons, flat illustrations) gets a vector
  check. `scan` traces the heaviest such images (`--svg-budget`, default 50, 0 to 1000; 0 traces none) with vtracer, through
  the optional `@neplex/vectorizer` dependency, and renders each SVG back at the served size. The fidelity is SSIMULACRA2 at
  half size against the served image (bar 70). A passing SVG must be at least 30% smaller than the served file. Its saving is
  the record's claim when it is the larger one, and the raster fix stays as the fallback. The traced file is written to
  `svg/<id>.svg` in the scan folder. Without the vectorizer, a flat image gets one note and no byte claim. `check` and `run`
  pass the flag through.
- `fix.vector` in the scan JSON and a `vector` field on hints. The summary and the check report count the flat and traced
  images.
- Loaded but not shown. `scan` now reports the images the browser downloaded but no viewport shows: `display:none` or
  `visibility:hidden` on the element or an ancestor, `opacity: 0`, a zero-size box, and an offscreen slide of an
  `overflow:hidden` track. Each one gets its bytes per view and how many of the six viewports hide it, in a "Loaded but not
  shown" line per page and in the hints, apart from the savings. Each case gets its own fix: a responsive twin (`<picture>`
  with a media condition), a carousel, tab, closed-details or hover-swap copy (`loading="lazy"`, or load on demand), or an
  image never shown on load (remove it, or load it on demand when the menu, modal or hover opens). CSS background layers
  whose file was downloaded while hidden are reported too. Such an element gets no sizes, quality or animated-encode claim
  at the viewports that hide it.

## 0.2.0 (2026-11-14)

- Animated media and video. `scan` measures animated GIFs (in an `<img>` or a CSS background), animated WebP and APNG, and
  self-hosted `<video>` elements with a plain file source. Each page gets a Video section with the bytes per view and per
  play, and the levers (audio, width, codec, preload, poster). Adaptive streams (HLS, DASH, Mux, Cloudflare Stream) and
  third-party iframes (YouTube, Vimeo) are not reported. A video hosted on another site follows the third-party rules.
- Hints for animated media. A large animated GIF gets `<video autoplay muted loop playsinline>` with AV1 first and an H.264
  fallback. The H.264 fallback is a recipe (libx264, CRF 23, yuv420p, faststart), marked not measured. The animated-image
  alternative is shown with its size. A small `<img>` GIF or a CSS background gets an animated AVIF or WebP, and only its
  `src` changes. A `<video>` hint names each lever: the width per breakpoint (`<source media>`), the CRF, the codec, the
  audio track of a muted video, and `preload`. A poster is audited through the image pipeline. Duration and frame rate are
  informational notes only, never part of the claim.
- Static GIFs (one frame) get the normal image hints. Animated images stay in the image totals.
- Bytes per view and per play. Per view is what the first view fetches: an autoplay video counts its full file,
  `preload="auto"` counts the bytes the scan saw (labelled browser-dependent), and `preload="metadata"` or `"none"` counts 0.
  Per play is the full file, shown for every video, so a large click-to-play file is not missed. A URL's bytes are the union
  of the byte ranges read, capped at the file length, and a length probe reads the size when the server sends no
  Content-Length, so a looping video is not counted once per loop. Posters count as images.
- Quality bars. A candidate must reach VMAF 93 (`--video-bar`) against the served file at its display size. A still-frame
  guard (SSIMULACRA2 on the stillest frames) catches blurred text in screen recordings. Its bar is `--video-still-bar`
  (default 65), lowered to at most 10 points below the best the same codec reaches on that content, and never below 20. The
  relative bar catches the loss the encode adds, not what a format can never reproduce, such as GIF dither. For GIF sources
  both frames of the guard are blurred slightly (Gaussian, sigma 1) before scoring, so dither the eye averages out does not
  fail it.
- Encodes and budget. Encodes run on the heaviest animated assets first (by per-view bytes), at most `--media-budget` per run
  (default 20) and within `--media-time` seconds (default 600). Assets over the budget keep their cheap hints and are marked
  "over --media-budget". The CRF search runs on 2 s sample clips: one for a video of up to 6 s, three for a longer one. The
  full-file bytes are extrapolated from the samples and labelled as an estimate; nothing is encoded in full. Each asset is
  encoded once per run, keyed by URL and content hash in the result cache. Widths are snapped to a few buckets first.
- Video widths. `scan` and `check` serve each video at most `--max-video-widths` widths (default 2): each viewport gets the
  smallest kept width that covers its display width times its device pixel ratio. `audit` does not choose: it reports each
  viewport's needed width and the bytes per view at one, two and three widths.
- ffmpeg. The system ffmpeg on `PATH` is used; ImgTune does not bundle it. Without it, animated media is still detected, and
  its bytes and needed width are still reported, with one note: `install ffmpeg for verified video and GIF hints`. ffmpeg and
  ffprobe read only the protocols they need, and a URL input goes through the egress proxy (the scan's own policy for
  private addresses), so a scanned page cannot reach a private host through a video.
- `imgtune image` accepts GIF, animated WebP and APNG (candidates: animated AVIF, animated WebP and AV1 MP4 at `--width`),
  and MP4 and WebM. `--reference <original>` checks a candidate against the original with the same VMAF and still-frame bars.
  It prints one line, `VMAF <v> (bar <b>) still p10 <s> (bar <sb>): pass|fail`, and exits 0 or 1.
- `audit` locates `<video>` and GIF elements at `file:line`, as it locates images. `hints` prints the animated and video hints.
- Network idle. A streaming media request does not hold the wait for network idle, so an autoplay video does not hold each
  resize up to `--idle-timeout`.
- Scan JSON. Each page gains `videos` and `mediaNote`, and an animated image record gains `fix.animated`. The resume record
  gains the media settings (`mediaBudget`, `mediaTime`, `videoBar`, `videoStillBar`, `maxVideoWidths`, `ffmpeg`).
- New flags, with their defaults: `--media-budget <N>` (20, 0 to 1000), `--media-time <s>` (600, 1 to 3600), `--video-bar <n>`
  (93), `--video-still-bar <n>` (65), `--max-video-widths <n>` (2, 1 to 3). `--survey` and `--no-quality` make no encodes.
  `image` takes `--reference`, `--video-bar` and `--video-still-bar`.
- `--gpu-encode` (experimental, off by default). The media encodes run on the GPU with NVENC (`av1_nvenc`, `h264_nvenc`), and
  VMAF runs on the GPU with `libvmaf_cuda` when the ffmpeg on `PATH` has it. The NVENC bytes are scaled by 1 / 1.4 to a CPU
  encode and labelled `est. (GPU-encoded, scaled to a CPU encode ÷1.4)`. Each GPU is proven by a small test encode first, and
  a width under 144 px is encoded on the CPU. In our measurements it was slower than the CPU on 2 s samples (CUDA starts once
  per ffmpeg process), so the CPU stays the default.
- `--gpu-device` takes a comma list (`0,1`). The first GPU scores. With `--gpu-encode`, each listed GPU gets its own encode
  workers beside the CPU ones. `--gpu` alone is unchanged.
- Ctrl-C and SIGTERM stop the whole run: the media phase is aborted, the pages already written are kept, and the process
  exits 130 (SIGINT) or 143 (SIGTERM) within 2 s.
- Media fetches and the ffmpeg reads of a page's videos go through the egress proxy. ffmpeg's `httpproxy` tunnel is allowed,
  so `https` videos are read through it.
- Animated WebP and APNG are decoded one frame at a time, only for the frames of each 2 s sample window, and streamed to
  ffmpeg. A long animation does not fill memory, and the pixel limit applies to each frame.
- A measured page's JSON is written after its image estimates and before the media phase, so a long media phase does not
  hold back the results.
- Cache: `CACHE_VERSION` is 3. Entries from 0.1 are not read, so the first scan on 0.2 is cold.
- Changes for 0.1 users:
  - A scan that encodes media takes longer. The encodes are bounded by `--media-time` (600 s) and `--media-budget` (20
    assets); `--no-quality` or `--survey` keeps the 0.1 timing.
  - Without ffmpeg on `PATH`, `scan` prints one note and gives no encode hints.
  - `--resume` scans a 0.1 page again when the new run encodes media, because its record has no media settings. A run with
    no encodes (`--no-quality`, `--survey`, or no ffmpeg) resumes 0.1 pages as before.
  - The JSON gains fields (`videos`, `mediaNote`, `fix.animated`, the resume media settings); existing fields are unchanged.
    Animated GIFs, WebP and APNG keep their place in the image totals, but their hint is now a video or animated-image hint.
  - `<video>` elements are not image records: their bytes are in the Video section, and their posters are images.
  - The cache is not reused across the version change (see above).

## 0.1.0 (2026-11-03)

- LCP first. Each scanned page reads the largest contentful paint before its first scroll, per viewport. A page's report
  and the PR comment show one line above its numbers: `LCP image (<viewports>): <file:line>, <KB> served, <KB> fixable`,
  or `LCP is not an image`. `hints` sorts the LCP image first and prefixes its line with `LCP image (<viewports>):`. The
  scan JSON gains `lcp` and `lcpViewports` on images, `lcp` on each viewport, and the hints JSON gains `lcp` and `lcpViewports`.
- `sizes="auto"` awareness. A lazy image whose only fix is its sizes gets an alternative line,
  `sizes="auto, <proposed>"` (Chrome, Edge, Firefox 150 or later; Safari falls back to the proposed value). The explicit
  value stays the fix. Eager and LCP images never get it.
- CDN auto quality. A Cloudinary `q_auto` group whose estimated quality saving is below a tenth of its served bytes is
  reported as `quality handled by <loader> (q_auto)`, and that saving is not counted. Above it, the hint names the explicit
  `q_<N>`. A jpeg or png whose format the CDN negotiates (`f_auto`, imgix `auto=format`) gets no format change. The
  fix record gains `cdnQuality` and `formatHandled`.
- `images.qualities` cap. The next/image quality targets of a scan (across its pages) are clustered into at most
  `--max-qualities N` values (default 2, 1 to 4). Each target is raised to the nearest chosen value, so the SSIMULACRA2 bar
  still holds. The site-level line `next.config: images.qualities: [...]` is printed by `hints`, `scan` and the reports;
  a usage's estimated quality saving is scaled to its capped value and marked approximate. `--qualities` turns the cap off.
- The agent skill has a "Fix the images" section: the hints in batches, the LCP image first, the `images.qualities` line
  once, then a scan again with before and after reported apart. Its description names "fix image sizes", "next/image
  sizes" and "LCP image".
- Third-party requests are allowed by default. `--block-third-party` turns the blocking on (scans, rechecks, locate-only,
  sizes-only, `run` and `check`). Blocking can drop images that a page loads through its own API on another host: on a
  local store build, 0 images were recorded with blocking and 50 without it. `--allow-host <h1,h2>` now needs
  `--block-third-party`. `--allow-third-party` is accepted for one release as a no-op with a deprecation note. The
  recorded setting is `allowed` by default, so a scan from before this change (recorded as `blocked`, or with no record)
  does not match on `--resume` or `recheck` where the setting differs.
- `check`: failed pages are counted. A deep page the browser could not load (status `failed`, for example a navigation
  timeout) gets one retry: the next-heaviest measured page of its route type is scanned in its place, and the report names
  both. `run.json` has a `failed` count per phase and a `deepRetries` list, `imgtune summary` prints the failed count in its
  survey and deep lines, and the report's header and "broken, not measured" section count the failed pages.
- Browser errors in the report and the terminal are one line: ANSI escape sequences are removed whole (`stripControls`), and
  the Playwright "Call log:" block after the first line is dropped (`errorLine`). The full message stays in the page JSON.
- Route types (`src/routes.ts`): a version segment after the first segment (`/docs/15/app/...`, `/docs/v2.3/...`) is a
  dimension when the same section has unversioned pages, so the versions merge with them. Dated archives and numeric ids
  are not read as versions (see the tests).
- Route types (`src/routes.ts`): the URLs of a site group into the templates they are instances of. A leading locale or store
  segment (`ae-en`, `sa_AR`) and a `desktop` or `mobile` variant are dimensions, not part of the type. Product slugs, ids
  and listing families collapse to `*`, and query strings keep their parameter names (`/search?q=*`). Used by the survey
  sampler (`--sample-per-pattern`), `run` and `check`. `--route-map <file>` names the URLs that match a pattern (`pattern =>
  type`, or JSON). A store set of 299 URLs gave 289 patterns with the old grouping; the new grouping is not yet measured on it.
- Deep selection (`src/deep.ts`): the heaviest page of each route type that has images, by image KB per view (exact KB as the
  tie-break), with the types ordered by their total KB per view. `--deep <N>` defaults to 20 (was 5). The types the cap leaves
  out, and the types with no images, are named in the output.
- `imgtune check <origin | sitemap-url | page-url> | --urls-from <file|sitemap>`: the production check, in a browser only.
  It surveys at most `--sample-per-pattern N` URLs per route type (default 3), full-scans the heaviest page of each type, and writes
  `report.md` (header, summary numbers with sharpness as its own number, ranked fixes merged across the deep pages, heavy
  pages with little to save, sharpness images, a route-type table, what was not measured, and how to read the numbers),
  `run.json` (the manifest: `imgtune summary` reads it), `survey/`, `deep/` and `urls.txt`. It passes through `--gpu`,
  `--gpu-device`, `--page-concurrency`, `--qualities`, `--block-third-party`, `--allow-host`, `--idle-timeout`, `--no-cache`,
  `--ignore-robots` and `--storage-state`. `run` is kept: it also locates on a dev server (`--dev`) and writes the hints.
- `imgtune audit --app <dir> --prod <origin> [--dev <origin>]`: the deep mode for your own Next.js app. It reads the route
  files (`app/`, `src/app/`, `pages/`, `src/pages/`) into route patterns, and `images.qualities` from `next.config.{js,mjs,ts}`
  (a static read; Next's `[75]` is assumed and reported when the list is missing). It surveys `--prod` and full-scans the
  heaviest page of each route type, as `check` does. With `--dev` it locates those pages' images in the sources, and its
  `report.md` has the file:line of every located fix and the route file of every route type. A preflight stops the audit
  when the production home's stylesheets do not load (a CDN host the machine cannot reach: set the CDN variable empty for
  both `next build` and `next start`). URLs come from `--urls-from`, else the `--prod` sitemap, else a same-origin crawl of
  the home page two links deep (at most 500 pages, plain HTTP, no browser). See the audit discovery entry below.
- `imgtune audit` discovery: the crawl starts from the home page and from the app's seeds (its static routes, and each route under a
  dynamic first segment such as `/[store]/about-us` once per learned value). The values are where the home page redirects, then the
  other first segments of its links and its `hreflang` alternates, capped by `--max-locales N` (default 3). The crawl takes the groups
  of first segments in turn, so one locale cannot use up the page budget. A redirect or link is followed only on the exact origin of
  `--prod` (a redirect to a sibling subdomain is refused). A sitemap or alternate that names another host is read on a local `--prod`
  instead (path and query kept, the other host never fetched), and the audit says how many URLs it moved. `--urls-from` replaces the
  discovery and adds no seeds.
- `imgtune audit` route types are URL templates (`routes.ts`), not route files. The first segment of a URL that the app takes as a
  dynamic segment, and a `desktop` or `mobile` variant after it, are dimensions. The route file of each type is an attribute and a
  column of the report's route-type table. A route file that renders several templates gives several types.
- Scan: the extra fetches (originals, srcset candidates, source maps, robots) are shared across the whole run as before, but a
  failed fetch, or a body with `Cache-Control: no-store`, is no longer kept for later pages: a later page asks again. No
  response of the 8-URL nextjs.org run changed.
- Scan: a lossy image over 2 MP (MATCH_MAX_PIXELS) keeps its resize estimate. Its quality match runs at the fast AVIF effort
  with at most 5 probes and no effort-4 confirmation, so the estimate is approximate: its record says `estimate: "approx"`
  and the scan summary, the Markdown report and `imgtune summary` show it with ≈. On nextjs.org/conf the exact + est. share
  is 94.6% ≈ (the 3840-px images, about 6.5 MB per view of est. saving).
- Scan: each measured page is written to `<out>/.staged` as soon as it is measured, with its bodies as blobs, and is
  complete only once its analysis is written. `--resume` after an interruption measures no staged page again and runs
  only the analysis; the stage folder is removed when the run finishes.
- `imgtune run <url...> | --urls-from <file|sitemap>` is the whole agent flow in one command: survey every URL, rank the pages
  by image KB per view per route type, full-scan the heaviest page of each type (`--deep <N>`, default 20), locate
  them on a dev server (`--dev <origin>`), and group the fix hints by call site (`--qualities`). It writes a run directory
  (`survey/`, `deep/`, `located/`, `hints.json`, and `run.json`, a manifest that lists every file and every command it ran) and
  prints a summary of at most 40 lines. The scan passthroughs are `--gpu`, `--gpu-device`, `--page-concurrency`,
  `--idle-timeout` and `--no-cache`, plus `--root`, `--storage-state` and `--ignore-robots`.
- `imgtune summary <run dir | scan.json ...>` prints the same one-screen summary again, from a run directory or from scan files.
- Broken pages: a page whose document answered an HTTP error, whose linked stylesheet did not load, or that finds no images
  where the survey found some is `broken`, with its reason and the likely fix. A broken page has no page numbers and counts in
  no total. `scan --fail-on-broken` exits 4. `run` stops before the deep phase when more than half of the survey is broken.
  A page now records `documentStatus` and `stylesheetHosts` when they apply.
- Scan: `--survey` is a fast site-wide pass (viewports `iphone-15` and `desktop`, no quality estimate, four pages at once,
  a 3 s network-idle cap). Its numbers are exact savings only and are labelled so in the scan's output, the Markdown and
  the report. A survey is recorded in each page's options, so `--resume` and `compare` never mix it with a full scan.
- Scan: `--page-concurrency <N>` (1 to 6, default 1) scans up to N pages at once on one browser. Results keep the input
  order and each page's JSON is written as it finishes; `--max-pages` and `--max-images` stop new pages and keep those in
  flight. The GPU scorer's CPU fallbacks are counted per page.
- Scan: `--idle-timeout <ms>` (0 to 600000, default 10000) caps the wait for network idle after scroll; 0 skips it.
- Faster AVIF quality search, same numbers: the search encodes AVIF at effort 2 (`cdn-fast`) and confirms the answer at
  effort 4 from the qualities that decided it (two or three effort-4 probes). A confirmation that fails moves the fast bar by the
  score difference seen at that quality and searches again (twice at most); when none confirms, the search runs at effort 4 as
  before. The reported target and bytes are the effort-4 ones. On the Next.js guard scan the per-image targets and estimated
  bytes are identical to the previous build, and the scan's CPU time fell from about 247 s to 155 s (shared machine).
- Scans can block the requests to other sites that cannot change an image or the layout (scripts, fetch and xhr,
  websockets, event streams, media, beacons and pings, manifests, iframes, other), with `--block-third-party`. Documents,
  stylesheets, fonts and images are never blocked, from any host. Blocking makes pages reach `load` and network idle sooner.
  `--allow-host <h1,h2>` keeps named hosts while blocking (for a third-party script that renders images). The page JSON
  counts the aborted requests (`thirdPartyBlocked`) and records the setting, so `--resume` does not mix settings; a recheck
  refuses a scan file recorded with the other setting.
- Scan: `--shared-loads` (opt-in) loads each viewport class (mobile, desktop) once and resizes the open page for the other
  viewports of the class. It saves CPU but costs wall time (survey: 98.7 s shared against 69.1 s fresh), so the default loads
  each viewport fresh, as before. The mode is recorded in each page's options (`loads`): `--resume` rescans pages of the other
  mode and `compare` warns about it.
- Caller map: a call site whose component is rendered for several callers lists each caller at the first owner level above
  the image that differs between usages (`callers:` in the grouped `hints`, `callers` in the JSON), with its file:line,
  pages and its own sizes formula. The dev owner chain is read at `--locate-only` and kept on each located record
  (`locator.ownerChain`, sanitised on read).
- Docs: for Next.js, the asset-prefix env must be set the same for `next build` and `next start`; the skill says to check
  the stylesheets load before a scan.
- Fix: the GPU scorer no longer overwrites the user's `CUDA_VISIBLE_DEVICES` (a GPU the user excluded could run the scorer).
  `--gpu-device` is an index within the user's visible list; imgtune never sets `CUDA_DEVICE_ORDER`. The scorer prints the
  device it opened (name, index, order, visible list) and the scan JSON records `deviceOrder` and `visibleDevices`.
- Fix: the sizes-only check judges undersize on the measured server's width, computes the chosen candidate from the dev
  page's `sizes` (and checks it is the file the browser loaded), and reports a dev/measured layout difference as `LAYOUT`
  (not a pass). It stops with no verdict when the dev page has a stylesheet that did not load.
- Scans warn when a linked stylesheet did not load (`stylesheetsFailed` on the page): the widths measured on such a page
  are not the app's. Earlier numbers measured on a page whose utility stylesheet was refused are void.
- A sizes proposal undersized at any measured viewport is not a saving (the per-image records and the group report).
  The candidate evaluation moves to `src/candidates.ts`, with a reader for the calc, min, max and clamp forms.
- `hints --format json` is not cut to the text default of 10: JSON is unlimited unless `--limit` is passed, and carries
  `truncated`.
- `imgtune report` accepts `--compare` once per page; the byte totals are summed.
- A PASS that adds bytes is labelled `PASS (sharpness fix)`; a batch that mixes them with savings prints a `mixed:` line.
- Security: page-derived text in the sizes output is cleaned of bidi overrides and zero-width marks, and capped.

- CSS background images are measured (`kind: "css-background"` records): every layer of a computed `background-image` that
  names a file, with its box, `background-size`, the file the browser loaded, the device pixels it needs, undersized, and a
  local resize estimate. Gradients, inline `data:` images and hidden or tiny elements are skipped with a reason. The headline
  numbers stay `<img>`-only (the page's `backgrounds` line reports the layers apart). Page-controlled values are capped
  (4096 characters, 8 layers) and parsed in one pass.
- A harness route (`/__imgtune/<component>`, or any URL scanned with `--harness`) is measured-harness, not measured-page:
  its records and report say the component was measured in isolation. The skill's harness step is fixed for App Router
  (a `%5F_` folder: a plain `_` folder is private) and says to verify with recheck on the harness URL.
- `scan --locate-only` works on a built page that ships source maps: the owner components' definitions, read through the
  debugger and mapped by the chunk's source map, give `file:line` with `via: prod-sourcemap` (never verified: the definition
  is not an image line). The same caps apply. Dev data stays the first choice.
- Fix: a score the CPU made (a GPU scorer's fallback, or a pair too small for the GPU) is no longer stored under the GPU's
  cache key. The cache version moves to 2, so entries written before are not read.
- `imgtune compare <before.json> <after.json>`: the per-image before and after of two scans of one page, paired by URL
  pattern and alt, and by rendered width where one key has several elements. Saved and added-for-sharpness bytes are two
  numbers; unpaired images are listed, not counted. Drift is excluded and its totals printed: an image whose rendered
  width changed (layout changed), the same file served with different bytes (server variance), and a view one scan did
  not load. Two scans of one build compare to 0 KB saved.
- Faster scans, same numbers: the quality samples of a scan are estimated two at a time (each encode already uses four
  threads), and a served file under 2 KB is not swept (`quality.sweep: "skipped-small"` in the JSON). On the nextjs.org
  guard the JSON is identical to the previous build. Cold CPU scan about 18% faster (median 57.5 s over four runs before,
  46.9 s over five after).
- `imgtune scan --recheck` with several pages starts one browser for all of them (it started one per page).
- `imgtune hints --help` lists `--top`, `--flat` and `--qualities`, and accepts several scan files.
- Shared and varied call sites get a fitted `sizes`: a linear `vw + px` per band of viewports where the measurements allow,
  a ceiling constant elsewhere, never below a measured width at any measured viewport. When pages need different widths,
  the call site says `shared component: pass sizes per caller` and each page gets its own formula. `hints` takes several
  scan files, so call sites group across pages.
- A sizes proposal whose predicted outcome adds bytes (or saves none) is not a saving: the scan leaves it out with a
  `no saving` reason, and `hints` counts it. The prediction uses the candidate each proposed value would pick, per viewport.
- `imgtune hints --top N`: the N call sites that save the most per view, one line each.
- Recheck (full and `--sizes-only`) prints one line per image (`PASS`, `FAIL` or `GONE`, predicted and measured bytes) and a
  batch line; the detail follows only for images that did not pass.
- `imgtune report`: a Markdown run report from `.imgtune/ledger.jsonl` and the compare JSON. Ledger values are escaped as
  code in pipe-free table cells.

- Faster scans, same numbers. The AVIF and WebP calibration no longer encodes all 25 local qualities of each match: a
  parallel search over the coarse grid and then the refine window encodes about half as many, and any probe that shows
  bytes falling as quality rises falls back to the full scan. Targets and ratios are identical to the previous build on
  the nextjs.org guard, on its five quality samples and on 25 generated images, with the CPU and with `--gpu`.
- Result cache in `.imgtune/cache` (bounded to 500 MB, oldest removed first): the local encode sizes and each probe's
  score, keyed by the original's content hash, width, scorer, encoder, quality, profile and tool version. Used by `scan`,
  `scan --recheck` and `image`; a warm run reuses everything the cold run computed. `--no-cache` turns it off. Corrupt or
  foreign entries are ignored.
- Settle waits only for real document navigations. Same-document URL changes (`history.pushState`, `replaceState`, hash
  changes) no longer repeat the settle and its 10 s network-idle wait; the wait itself is unchanged.
- `--root <dir>` (`scan`, `--locate-only`): the folder project sources are read from. By default each file is read from the
  nearest folder above the cwd that holds it, so a scan run from a sub-folder of a monorepo no longer marks every source
  `unread`. Unread sources are named in the output with the folder they were looked up in.
- `scan --recheck` takes several pages (repeat `--recheck`, at most three browser contexts in all) and `--viewports <names>`
  to measure other viewports than the ones where the images rendered. Its default is unchanged.
- Security: the `locate` block and the located records of a scan file are checked as a whole when read. A dev URL that is
  not http or https, an unknown viewport, a count that is not a non-negative integer, or a short label that is not plain
  text drops the block (the rest of the scan is kept, and the drop is reported). The sizes recheck refuses a non-http dev
  URL from the file or the command line. `hints` prints the located line only from a checked block.

- Split measure and locate. `scan <built-url>` measures the bytes on a built server or a preview (no source needed).
  `scan <dev-url> --locate-only --from <scan.json>` reads the React source of the flagged images from a dev page, at one
  viewport (default `iphone-15`), with no image bytes read and nothing scored. It writes `<scan>.located.json`: the measured
  file with `file:line` and component joined in, and a `locate` summary (joined, not joined by reason). Elements join on
  the whole srcset as URL patterns (origin, widths and qualities taken out) and alt, in document order, only when the counts
  on both sides are equal; a count that differs joins nothing. Scans from before this version (no `domIndex`) cannot be
  located: scan again.
- `scan --recheck <file> --sizes-only [--ids ...] [--url <dev-url>]`: the per-batch check on dev, in seconds. Per image and
  viewport: the `sizes` attribute, the rendered width, the DPR, the candidate chosen and its bytes (Content-Length), undersized,
  the hint's target, and a verdict. Fails an undersized choice, a choice bigger than the hint's sizes need, and bytes that rose
  without a sharpness fix. No bytes decoded, nothing scored. The full `--recheck` is unchanged.
- `hints` on a located file prints where the sources came from, and says how many hinted images still have no `file:line`.
- The agent skill, its reference and the AGENTS snippet use the four-step flow: measure (built), locate (dev), check each
  batch (dev, sizes only), measure again (built, the real before and after).
- `--gpu` and `--gpu-device <n>` (`scan`, `scan --recheck`, `image`): SSIMULACRA2 scoring on an NVIDIA GPU, opt-in. It runs
  through `imgtune-ssimu2-gpu`, an external program built from `native/ssimulacra2-gpu/` against libvship (Vship). A missing
  or failing program prints a warning and the run scores on the CPU. Encoding stays on the CPU. On nextjs.org scoring took
  19 s on the CPU and 1 s on the GPU (a timed scan: 110 s to 89 s on a loaded machine). The quality targets and per-image
  records of the nextjs.org scan were identical; scores differ by up to 1.2 points on its re-encode pairs.
- Scan JSON records the scorer: `scorer` on each page and on the summary, and in `resume` options. `scan --recheck` warns when
  its scorer differs from the scan's.
- Locator check: a resolved `file:line` is read from the project (local pages only) and must render an image. A call
  site that only uses the component which renders the image is `kind: owner`, `verified: false`, and hints say which
  component to search. `kind` is `image`, `owner`, `unread` or `unchecked`. Scan from the project root.
- Placeholder owner names (such as the app's fallback name) are never searched for or printed as a component; a hint with no clue says
  `owner unknown`.
- Recheck pairing: an image's id no longer includes its line, so an edit above it keeps the id. A changed id is paired
  by source file and URL pattern, and `gone` lists what was looked for and asks for a pristine rescan first. The cause of
  the earlier false `gone` results was the line in the id, not the `sizes` value.
- `hints` groups by call site across pages (default; `--flat` for one entry per image). Shared components print each
  caller's sizes and the rule to follow.
- `hints --qualities <list>` snaps quality targets to the framework's allowed values and marks the quality saving void
  after a snap.
- Savings are split into `sizes` (exact) and `quality` (est.) in the scan records, hints and call sites. Recheck prints the
  predicted saving beside the measured served bytes.
- `basis: fit` is kept: it is emitted when the layout formula does not match the measured widths (for example with no
  layout chain). It is rare, and documented as such.

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
