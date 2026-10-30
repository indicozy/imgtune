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

const stacks = survey.summary.byTech.filter((t) => t.tech !== "Other / unknown");
const unknownCount = survey.summary.byTech.find((t) => t.tech === "Other / unknown")?.count ?? 0;
const stackNames = stacks.map((t) => t.tech).join(", ");

const scanWhen =
  survey.scannedFrom === survey.scannedTo ? survey.scannedFrom : `${survey.scannedFrom} to ${survey.scannedTo}`;
</script>

## Method

- Every site is scanned once with the same tool version: 2 pages, 6 viewports (four phones, a 1440 px desktop at 2x and a
  1280 px desktop at 1x), SSIMULACRA2 at a delta of 2.
- Each page is loaded in headless Chromium, scrolled to the end, and every image is recorded with the size it renders at.
- **Saving** is the share of all image bytes per page view. It is averaged over the viewports, then over the two pages.
- **Exact** is the site's own smaller `srcset` candidate, fetched and measured.
- **Est.** is a local re-encode at another quality or format, or a resize of a plain `img`, judged by SSIMULACRA2 against the original.
- Sharpness growth (images smaller than their slot) is reported apart and never subtracted from another image's saving.

The kill criterion was fixed in advance: a pass needs at least 2 of the 6 production sites above 15%.

## Production sites (v4)

<table class="study-table">
  <thead>
    <tr><th>site</th><th>KB / view</th><th>exact</th><th>exact + est.</th><th>of fixable</th></tr>
  </thead>
  <tbody>
    <tr v-for="r in study.production" :key="r.id">
      <th>{{ r.id }}</th><td>{{ r.kb.toLocaleString("en-US") }}</td><td class="x">{{ r.exactPct.toFixed(1) }}%</td><td class="e">{{ r.exactEstPct.toFixed(1) }}%</td><td>{{ r.fixablePct.toFixed(1) }}%</td>
    </tr>
  </tbody>
</table>

Kill criterion: exact only, **2 of 6** above 15%, which is a pass at the bar. Exact with estimates, **6 of 6**.

## Open-source apps (v4, do not decide)

<table class="study-table">
  <thead>
    <tr><th>site</th><th>KB / view</th><th>exact</th><th>exact + est.</th><th>of fixable</th></tr>
  </thead>
  <tbody>
    <tr v-for="r in study.openSource" :key="r.site">
      <th>{{ r.site }}</th><td>{{ r.kb.toLocaleString("en-US") }}</td><td class="x">{{ r.exactPct.toFixed(1) }}%</td><td class="e">{{ r.exactEstPct.toFixed(1) }}%</td><td>{{ r.fixablePct.toFixed(1) }}%</td>
    </tr>
  </tbody>
</table>

Developer sites carry few image bytes. The waste sits in image-heavy commerce.

## More production sites (anonymous) {#more-sites}

These are {{ survey.count }} real public sites, scanned on {{ scanWhen }} with the same CLI: 2 pages each, 6 viewports, the same rules as the
six above. The owners were not asked, so the sites stay anonymous. Labels P001 onward are assigned by rank (highest exact + est.
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
    <tr><th>id</th><th>category</th><th>stack</th><th>image KB / view</th><th>exact</th><th>exact + est.</th><th>fixable</th><th>saved KB / view</th></tr>
  </thead>
  <tbody>
    <tr v-for="r in survey.sites" :key="r.id">
      <th>{{ r.id }}</th><td>{{ r.category }}</td><td>{{ r.tech }}</td><td>{{ r.imageKbPerView.toLocaleString("en-US") }}</td><td class="x">{{ r.exactPct.toFixed(1) }}%</td><td class="e">{{ r.exactEstPct.toFixed(1) }}%</td><td>{{ r.fixablePct.toFixed(1) }}%</td><td>{{ r.savedKbPerView.toLocaleString("en-US") }}</td>
    </tr>
  </tbody>
</table>

</details>

Est. is judged as in the method above: a local re-encode or resize, scored with SSIMULACRA2 at a delta of 2.

## Limits

- **Six deciders** is a signal, not proof. The sample leans toward sites without bot walls.
- **Exact is measured, est. is estimated.** On measured savings alone, 2 of 6 pass. Est. is a floor where an image could not be scored
  (counted per page as `qualityNA`).
- Quality and format are only estimated when the original is known. Where the loader is not known, the estimate is not made.
- A3 rose from 13% to 38% between v1 and v4, because its images sit on a custom domain at quality 100, which v1 could not score.
- A rescan of the open-source sites on 2026-10-30 matched v4 to the rounding shown for three of them. Two moved: supabase.com's
  exact share rose from 1.9% to 4.5%, and langfuse.com's image bytes rose by about 16%. Part of the difference may come from
  tool changes since v4, not only from the sites. See the [replay](/replay) page.

## Reproduce it

The study used the CLI at tag `study-v4-2026-10-28`. Run `npx imgtune scan <url> <url> --summary-json summary.json` on your own
sites to get the same measures. See the [CLI reference](/reference/cli).
