<script setup lang="ts">
import { computed } from "vue";
import media from "../../../../data/media-survey.json";
import { fmtInt, fmtPct } from "./shared";

// Per-view media weight over all sites: video, images (animated included) and animated images.
// The solid part is what stays after the estimated saving; the striped part is the saving.
interface MediaSummary {
  sites: number;
  imageMb: number;
  imageSavedMb: number;
  videoMbPerView: number;
  videoSavedMb: number;
  videoMbPerPlay: number;
  animatedMb: number;
  animatedSavedMb: number;
  sitesWithVideo: number;
  sitesWithAnimated: number;
  videos: number;
}
const s = media.summary as MediaSummary;

interface Bar {
  name: string;
  meta: string;
  total: number;
  saved: number;
}
const bars: Bar[] = [
  {
    name: "Video, per view",
    meta: `${fmtInt(s.videos)} videos on ${s.sitesWithVideo} sites`,
    total: s.videoMbPerView,
    saved: s.videoSavedMb,
  },
  {
    name: "Images, per view",
    meta: `all ${s.sites} sites, animated included`,
    total: s.imageMb,
    saved: s.imageSavedMb,
  },
  {
    name: "Animated GIF, WebP, APNG",
    meta: `part of the images, ${s.sitesWithAnimated} sites`,
    total: s.animatedMb,
    saved: s.animatedSavedMb,
  },
];

const maxTotal = Math.max(...bars.map((b) => b.total), 1);
const laid = computed(() =>
  bars.map((b) => {
    const share = (b.total / maxTotal) * 100;
    const savedShare = b.total > 0 ? (b.saved / b.total) * share : 0;
    return {
      ...b,
      pct: fmtPct((b.saved / b.total) * 100),
      keptW: share - savedShare,
      savedW: savedShare,
    };
  }),
);

const videoShare = s.videoMbPerView / (s.videoMbPerView + s.imageMb);
const videoSavedPct = (s.videoSavedMb / s.videoMbPerView) * 100;
const imageSavedPct = (s.imageSavedMb / s.imageMb) * 100;
const takeaway = `Video is ${fmtPct(videoShare * 100)} of the media bytes per view. ${fmtPct(videoSavedPct)} of video bytes could be saved, against ${fmtPct(imageSavedPct)} of image bytes.`;
const mb = (n: number) => `${fmtInt(n)} MB`;
</script>

<template>
  <figure class="survey-figure media-bars">
    <div class="survey-head">
      <div class="survey-title" role="heading" aria-level="3">Media weight per view</div>
      <p class="survey-takeaway">{{ takeaway }}</p>
    </div>
    <ul class="rows" role="list">
      <li v-for="row in laid" :key="row.name" class="row" role="img" :aria-label="`${row.name}: ${mb(row.total)} per view, ${mb(row.saved)} estimated saving, ${row.pct}`">
        <div class="label">
          <span class="name">{{ row.name }}</span>
          <span class="meta">{{ row.meta }}</span>
        </div>
        <div class="track" aria-hidden="true">
          <span class="kept" :style="{ width: `${row.keptW}%` }"></span>
          <span class="saved" :style="{ width: `${row.savedW}%` }"></span>
        </div>
        <div class="value">
          <span class="total">{{ mb(row.total) }}</span>
          <span class="saving">{{ mb(row.saved) }} saved, {{ row.pct }}</span>
        </div>
      </li>
    </ul>
    <div class="legend" aria-hidden="true">
      <span><i class="swatch kept"></i>left after the estimated saving</span>
      <span><i class="swatch saved"></i>estimated saving</span>
    </div>
    <figcaption class="survey-caption">
      Megabytes per page view, summed over {{ s.sites }} homepages at two viewports. The bars share one scale. The
      estimated saving is built as in the method above, and video savings are a floor (see Limits).
    </figcaption>
  </figure>
</template>

<style scoped>
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.9rem;
}
.row {
  display: grid;
  gap: 0.35rem 0.75rem;
  grid-template-columns: minmax(0, 1fr) auto;
}
.label {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.1rem 0.75rem;
}
.name {
  font: 500 0.9375rem var(--scan-sans);
  color: var(--scan-ink);
}
.meta {
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-muted);
}
.track {
  grid-column: 1 / -1;
  display: flex;
  height: 1.25rem;
  border-radius: 3px;
  overflow: hidden;
  background: var(--scan-track);
}
.kept {
  display: block;
  height: 100%;
  background: var(--scan-accent);
}
.saved {
  display: block;
  height: 100%;
  background: repeating-linear-gradient(
    135deg,
    var(--scan-accent) 0 3px,
    var(--scan-accent-soft) 3px 7px
  );
  box-shadow: inset 0 0 0 1px var(--scan-accent);
}
.value {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.1rem 0.75rem;
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-muted);
}
.total {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--scan-ink);
  font-variant-numeric: tabular-nums;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.2rem;
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-muted);
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.swatch {
  display: inline-block;
  width: 0.9rem;
  height: 0.6rem;
  border-radius: 2px;
}
.swatch.kept {
  background: var(--scan-accent);
}
.swatch.saved {
  background: repeating-linear-gradient(135deg, var(--scan-accent) 0 2px, var(--scan-accent-soft) 2px 4px);
  box-shadow: inset 0 0 0 1px var(--scan-accent);
}
</style>
