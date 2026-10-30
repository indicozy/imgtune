---
layout: page
title: Replay
description: Fresh imgtune scans of five open-source sites, replayed by name, with the production study as anonymous cards.
---

<div class="replay-page">

<h1 class="scan-h1">Scan replay.</h1>

<p class="scan-note">Fresh <code>imgtune scan</code> results of 2026-10-30, for five open-source sites. Press play to step through the pages in order, or pick a site.</p>

<ReplayViewer />

<h2>How to read it</h2>

- **Exact** is measured: the site's own smaller candidates, fetched and compared byte for byte.
- **Est.** is a local re-encode, scored with SSIMULACRA2 at a delta of 2. It is drawn hatched and is never presented as measured.
- **Slot** is the CSS width the image fills; **needed** is the device pixels it needs at the widest viewport; **served** is the file's own width.
- The numbers are the same as the [study](/study/) method, on fresh scans. The [Study page](/study/) keeps the v4 table of 2026-10-28.

</div>
