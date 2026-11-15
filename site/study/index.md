---
title: Study
description: "The demand study behind ImgTune: which sites were scanned, how savings are counted, and what the numbers do and do not show."
outline: [2, 3]
---

# Study: results and method

ImgTune was checked against real sites before it was packaged. Six production sites decided whether it was worth building;
eight open-source apps were scanned for comparison and do not decide. The site list was fixed before the first scan and
kept private, because it names the production sites. Here they are anonymous: A1 to A6.

<script setup>
import study from "../data/study.json";
import survey from "../data/survey.json";
import SurveyStats from "../.vitepress/theme/components/survey/SurveyStats.vue";
import SavingDistribution from "../.vitepress/theme/components/survey/SavingDistribution.vue";
import CategoryBars from "../.vitepress/theme/components/survey/CategoryBars.vue";
import WeightVsSaving from "../.vitepress/theme/components/survey/WeightVsSaving.vue";
import TechBars from "../.vitepress/theme/components/survey/TechBars.vue";
import MediaBars from "../.vitepress/theme/components/survey/MediaBars.vue";
import VersionBars from "../.vitepress/theme/components/survey/VersionBars.vue";
import media from "../data/media-survey.json";

const stacks = survey.summary.byTech.filter((t) => t.tech !== "Other / unknown");
const unknownCount = survey.summary.byTech.find((t) => t.tech === "Other / unknown")?.count ?? 0;
const stackNames = stacks.map((t) => t.tech).join(", ");

const scanWhen =
  survey.scannedFrom === survey.scannedTo ? survey.scannedFrom : `${survey.scannedFrom} to ${survey.scannedTo}`;

const fmt = (n) => n.toLocaleString("en-US");
const tldr = survey.summary;
const shareCount = survey.sites.filter((s) => s.exactEstPct >= 20).length;

const ms = media.summary;
const mediaWhen =
  media.scannedFrom === media.scannedTo ? media.scannedFrom : `${media.scannedFrom} to ${media.scannedTo}`;
const pct = (a, b) => ((a / b) * 100).toFixed(1);
const videoShare = pct(ms.videoMbPerView, ms.videoMbPerView + ms.imageMb);
const videoSavedPct = pct(ms.videoSavedMb, ms.videoMbPerView);
const imageSavedPct = pct(ms.imageSavedMb, ms.imageMb);
const animatedSavedPct = pct(ms.animatedSavedMb, ms.animatedMb);
const videoPlayRatio = (ms.videoMbPerPlay / ms.videoMbPerView).toFixed(1);
</script>

## TL;DR {#tldr}

**Results**

- **6 production sites (the deciders):** the estimated saving is 16.5% to 53.1% of image bytes per view on all six. The kill
  criterion, fixed in advance, was set on the smaller-file part alone: **2 of 6** above 15%, a pass at the bar.
- **{{ survey.count }} more production sites, anonymous:** the median site loads {{ fmt(tldr.medianKbPerView) }} KB of images per view
  and could cut **{{ tldr.medianExactEstPct }}%** of them. **{{ shareCount }} of {{ survey.count }}** ({{ tldr.shareAtLeast20Pct }}%)
  could save 20% or more. Most of the estimate is re-encodes: few sites ship a smaller `srcset` candidate that goes unused.
- **8 open-source apps:** developer sites carry few image bytes. The waste sits in image-heavy commerce.
- **Video (0.2.0, {{ ms.sites }} homepages):** video is {{ videoShare }}% of the media bytes per view. On {{ pct(ms.sitesWithVideo, ms.sites) }}%
  of sites there is a video, and {{ videoSavedPct }}% of video bytes could be saved. The saving is a floor. See [Video and animated images](#video).

**Method**

- Each site is scanned once, in headless Chromium: 2 pages, 6 viewports, scrolled to the end.
- The **estimated saving** is built as described in [How it measures](/guide/how-it-measures). Re-encodes count only when
  SSIMULACRA2 stays within a delta of 2 of the original.
- robots.txt is respected, and sites behind bot walls are dropped. The sample leans toward sites without them.
- Any stack: the scan measures the live page, not the source. Details are in [Method](#method) and [Limits](#limits).

## Method

- Every site is scanned once with the same tool version: 2 pages, 6 viewports (four phones, a 1440 px desktop at 2x and a
  1280 px desktop at 1x), SSIMULACRA2 at a delta of 2.
- Each page is loaded in headless Chromium, scrolled to the end, and every image is recorded with the size it renders at.
- **Saving** is the share of all image bytes per page view. It is averaged over the viewports, then over the two pages.
- **Estimated saving** is the one number reported here. It is built as in [How it measures](/guide/how-it-measures), with
  re-encodes judged by SSIMULACRA2 against the original.
- Sharpness growth (images smaller than their slot) is reported apart and never subtracted from another image's saving.

The kill criterion was fixed in advance: a pass needs at least 2 of the 6 production sites above 15%.

## Production sites (v4)

<table class="study-table">
  <thead>
    <tr><th>site</th><th>KB / view</th><th>estimated saving</th><th>of fixable</th></tr>
  </thead>
  <tbody>
    <tr v-for="r in study.production" :key="r.id">
      <th>{{ r.id }}</th><td>{{ r.kb.toLocaleString("en-US") }}</td><td class="e">{{ r.exactEstPct.toFixed(1) }}%</td><td>{{ r.fixablePct.toFixed(1) }}%</td>
    </tr>
  </tbody>
</table>

Kill criterion (fixed in advance, on the smaller-file part alone): **2 of 6** above 15%, a pass at the bar. On the estimated saving: **6 of 6**.

## Open-source apps (v4, do not decide)

<table class="study-table">
  <thead>
    <tr><th>site</th><th>KB / view</th><th>estimated saving</th><th>of fixable</th></tr>
  </thead>
  <tbody>
    <tr v-for="r in study.openSource" :key="r.site">
      <th>{{ r.site }}</th><td>{{ r.kb.toLocaleString("en-US") }}</td><td class="e">{{ r.exactEstPct.toFixed(1) }}%</td><td>{{ r.fixablePct.toFixed(1) }}%</td>
    </tr>
  </tbody>
</table>

Developer sites carry few image bytes. The waste sits in image-heavy commerce.

## More production sites (anonymous) {#more-sites}

These are {{ survey.count }} real public sites, scanned on {{ scanWhen }} with the same CLI: 2 pages each, 6 viewports, the same rules as the
six above. The owners were not asked, so the sites stay anonymous. Labels P001 onward are assigned by rank (highest estimated saving
first), not by name or scan order. KB values are rounded to the nearest 10. The sites are a mix of stacks: {{ stacks.length }} named ones ({{ stackNames }}),
and {{ unknownCount }} that no named stack covers.

**How the sites were picked.** Public directories, showcases and company lists, any stack. Each was scanned on its homepage and
on one image-heavy inner page. robots.txt was respected. Sites that block bots were dropped, so the sample leans toward sites
without bot walls. The scan measures the live page in a browser, so it works on any site, whatever built it.

<SurveyStats />

<SavingDistribution />

<CategoryBars />

<WeightVsSaving />

<TechBars />

<details class="survey-all">
<summary>All {{ survey.count }} sites</summary>

<table class="study-table">
  <thead>
    <tr><th>id</th><th>category</th><th>stack</th><th>image KB / view</th><th>estimated saving</th><th>fixable</th><th>saved KB / view</th></tr>
  </thead>
  <tbody>
    <tr v-for="r in survey.sites" :key="r.id">
      <th>{{ r.id }}</th><td>{{ r.category }}</td><td>{{ r.tech }}</td><td>{{ r.imageKbPerView.toLocaleString("en-US") }}</td><td class="e">{{ r.exactEstPct.toFixed(1) }}%</td><td>{{ r.fixablePct.toFixed(1) }}%</td><td>{{ r.savedKbPerView.toLocaleString("en-US") }}</td>
    </tr>
  </tbody>
</table>

</details>

The estimate is built as in the method above, with re-encodes scored with SSIMULACRA2 at a delta of 2.

## Video and animated images (0.2.0) {#video}

Version 0.2.0 also measures animated GIF, animated WebP, APNG and self-hosted `<video>`. This section runs that version on
{{ ms.sites }} production homepages.

**What was scanned.** {{ ms.sites }} production homepages, from the same kind of public lists as the image survey. Sites with bot
walls were dropped. Each was scanned on its homepage only, at two viewports (iphone-15 and a desktop), one visit each, with
imgtune 0.2.0, scanned {{ mediaWhen }}. The sites are anonymous: M001 onward, ranked by total media weight.

**Method.** Per view follows the rules in [Animated media and video](/guide/video-and-gifs): an autoplay video counts its full
file, `preload="metadata"` or `"none"` counts 0, and `preload="auto"` counts the bytes the scan saw. Per play is the full file.
Videos are re-encoded on 2-second samples with SVT-AV1 or x264, heaviest first. The survey raised the limits to `--media-budget 300` and `--media-time 3600` (defaults: 20 assets, 600 s).
The CRF is bisected until VMAF reaches 93 against the served file at its display size, and a still-frame SSIMULACRA2 guard must
pass too. Bytes are extrapolated to the full file and labelled
as estimates. A file used by several elements counts once.

**Results.**

- **Per view,** the sites load {{ fmt(ms.videoMbPerView) }} MB of video, {{ fmt(ms.imageMb) }} MB of images (animated images included) and
  {{ fmt(ms.animatedMb) }} MB of animated GIF, WebP and APNG. The estimated saving is {{ fmt(ms.videoSavedMb) }} MB of video ({{ videoSavedPct }}%),
  {{ fmt(ms.imageSavedMb) }} MB of images ({{ imageSavedPct }}%) and {{ fmt(ms.animatedSavedMb) }} MB of animated images ({{ animatedSavedPct }}%).
- **Sites with video:** {{ ms.sitesWithVideo }} of {{ ms.sites }} ({{ pct(ms.sitesWithVideo, ms.sites) }}%).
- **Videos:** {{ ms.videos }} in all. {{ ms.autoplay }} autoplay ({{ pct(ms.autoplay, ms.videos) }}%), {{ ms.noPoster }} with no poster
  ({{ pct(ms.noPoster, ms.videos) }}%), and {{ ms.noAv1 }} with no AV1 source ({{ pct(ms.noAv1, ms.videos) }}%).
- **Video outweighs all images** on {{ ms.videoOutweighsImages }} of the {{ ms.sitesWithVideo }} sites with video ({{ pct(ms.videoOutweighsImages, ms.sitesWithVideo) }}%).
- **Per play,** the video total is {{ fmt(ms.videoMbPerPlay) }} MB, about {{ videoPlayRatio }} times the per-view figure. Click-to-play
  files are big, which is why both are shown.

<MediaBars />

<details class="survey-all">
<summary>All {{ ms.sites }} sites, video and animated images</summary>

<table class="study-table">
  <thead>
    <tr><th>id</th><th>image KB / view</th><th>video KB / view</th><th>video KB / play</th><th>video saved KB</th><th>animated KB / view</th><th>animated saved KB</th></tr>
  </thead>
  <tbody>
    <tr v-for="r in media.sites" :key="r.id">
      <th>{{ r.id }}</th><td>{{ r.imageKbPerView.toLocaleString("en-US") }}</td><td>{{ r.videoKbPerView.toLocaleString("en-US") }}</td><td>{{ r.videoKbPerPlay.toLocaleString("en-US") }}</td><td>{{ r.videoSavedKb.toLocaleString("en-US") }}</td><td>{{ r.animatedKbPerView.toLocaleString("en-US") }}</td><td>{{ r.animatedSavedKb.toLocaleString("en-US") }}</td>
    </tr>
  </tbody>
</table>

</details>

## 0.1 vs 0.2 vs 0.3 on 200 homepages {#versions}

Three versions of imgtune were run on the same production homepages, one visit each, at the phone and desktop viewports, with the
same flags. The 0.1.0 column is from an earlier run on 195 of the sites. 0.2.0 and 0.3.0 were run back to back, and 197 sites
scanned cleanly in both. The sites are anonymous.

| | 0.1.0 | 0.2.0 | 0.3.0 |
|---|---|---|---|
| Savings found, total per view | 195 MB | 586 MB | 525 MB |
| Savings found, median per site | 177 KB | 412 KB | 629 KB |
| Images | 195 MB | 193 MB | 138 MB |
| Animated images | n/a | 72 MB | 82 MB |
| Video | n/a | 321 MB | 233 MB |
| Fonts, compression and other | n/a | n/a | 73 MB |
| Loaded but not shown (not in the savings) | n/a | n/a | 144 MB images, 103 MB video |

The total is lower in 0.3.0 because it counts differently, not because it finds less:

- 50 MB of 0.2.0's image savings sat on copies no viewport shows, such as carousel slides cut off by overflow. They are now
  reported as "loaded but not shown", where the fix is not to load them at all.
- 77 MB of video comes from averaging each video over the viewports that load it, the same as images. A desktop-only video no
  longer counts in full on phones.

On the same sites, 0.3.0 finds more than 0.2.0 on 147 of 197 sites, less on 47, and the same on 3. The median site rises from
412 KB to 629 KB of savings per view.

<VersionBars />

## Limits

- **Six deciders** is a signal, not proof. The sample leans toward sites without bot walls.
- **Video savings are a floor.** Some videos were not encoded within the time limit (3600 s per run in this survey), so their saving is not
  counted. Their bytes are still in the totals.
- **Video is homepage only.** The video study scanned one page per site, so inner pages may weigh more.
- **Per-view bytes for `preload="auto"` depend on the browser.** The scan counts the bytes it saw, which another browser may
  fetch differently.
- **Part of the estimate is an estimate.** The re-encode part is a floor where an image could not be scored (counted per page as
  `qualityNA`).
- Quality and format are only estimated when the original is known. Where the loader is not known, the estimate is not made.
- A3 rose from 13% to 38% between v1 and v4, because its images sit on a custom domain at quality 100, which v1 could not score.
- A rescan of the open-source sites on 2026-10-30 matched v4 to the rounding shown for three of them. Two moved: supabase.com's
  smaller-file share rose from 1.9% to 4.5%, and langfuse.com's image bytes rose by about 16%. Part of the difference may come from
  tool changes since v4, not only from the sites. See the [replay](/replay) page.

## Reproduce it

The study used the CLI at tag `study-v4-2026-10-28`. Run `npx imgtune scan <url> <url> --summary-json summary.json` on your own
sites to get the same measures. See the [CLI reference](/reference/cli).
