<script setup lang="ts">
import data from "../../../../data/version-compare.json";
import { fmtInt } from "./shared";

// Savings found per view, by version, on one scale. Bytes loaded but not shown are not savings and are not drawn here.
interface Version {
  version: string;
  sites: number;
  savedMb: number;
  medianKbPerSite: number;
  imagesMb: number;
  animatedMb: number;
  videoMb: number;
  otherMb: number;
  notShownImagesMb: number | null;
  notShownVideoMb: number | null;
}
const versions = data.versions as Version[];
const max = Math.max(...versions.map((v) => v.savedMb), 1);
const pct = (n: number) => `${((n / max) * 100).toFixed(2)}%`;
const mb = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
const parts = [
  { key: "imagesMb", name: "images", cls: "images" },
  { key: "animatedMb", name: "animated", cls: "animated" },
  { key: "videoMb", name: "video", cls: "video" },
  { key: "otherMb", name: "fonts, compression, other", cls: "other" },
] as const;
</script>

<template>
  <figure class="survey-figure version-bars">
    <div class="survey-head">
      <div class="survey-title" role="heading" aria-level="3">Savings found per view, by version</div>
      <p class="survey-takeaway">
        0.3.0 finds {{ fmtInt(versions[2].savedMb) }} MB against {{ fmtInt(versions[1].savedMb) }} MB for 0.2.0 on the same sites,
        counted differently. Its loaded-but-not-shown bytes are not in these bars.
      </p>
    </div>
    <ul class="rows" role="list">
      <li v-for="v in versions" :key="v.version" class="row" role="img" :aria-label="`${v.version}: ${mb(v.savedMb)} savings found per view on ${v.sites} sites, median site ${fmtInt(v.medianKbPerSite)} KB`">
        <div class="label">
          <span class="name">{{ v.version }}</span>
          <span class="meta">{{ v.sites }} sites · median site {{ fmtInt(v.medianKbPerSite) }} KB</span>
        </div>
        <div class="track" aria-hidden="true">
          <span v-for="p in parts" :key="p.key" :class="['seg', p.cls]" :style="{ width: pct(v[p.key]) }"></span>
        </div>
        <div class="value">
          <span class="total">{{ mb(v.savedMb) }}</span>
        </div>
      </li>
    </ul>
    <div class="legend" aria-hidden="true">
      <span v-for="p in parts" :key="p.key"><i :class="['swatch', p.cls]"></i>{{ p.name }}</span>
    </div>
    <figcaption class="survey-caption">
      Megabytes of savings found per page view, summed over the sites. The bars share one scale. Medians are per site, in 1,000-byte KB.
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
.seg {
  display: block;
  height: 100%;
}
.seg.images, .swatch.images { background: var(--scan-accent); }
.seg.animated, .swatch.animated { background: var(--scan-est); }
.seg.video, .swatch.video { background: var(--scan-muted); }
.seg.other, .swatch.other { background: var(--scan-exact); }
.value {
  grid-column: 1 / -1;
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
</style>
