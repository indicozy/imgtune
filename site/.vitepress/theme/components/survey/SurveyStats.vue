<script setup lang="ts">
import { computed } from "vue";
import { survey, median, fmtInt, fmtPct, scanWhen, UNKNOWN_TECH } from "./shared";

// Tile keys; `tiles` picks a subset (the homepage shows three).
type TileKey = "sites" | "medianKb" | "medianSaving" | "share20" | "totalSaved";
const props = withDefaults(defineProps<{ tiles?: TileKey[] }>(), {
  tiles: () => ["sites", "medianKb", "medianSaving", "share20", "totalSaved"],
});

const s = survey.summary;
const medianExact = median(survey.sites.map((x) => x.exactPct));
// KB = 1000 bytes, as everywhere on the site. From 10,000 KB the total reads in MB.
const totalKb = s.totalSavedKbPerView;
const totalValue = totalKb >= 10000 ? (totalKb / 1000).toFixed(1) : fmtInt(totalKb);
const totalUnit = totalKb >= 10000 ? "MB" : "KB";
const namedStacks = s.byTech ? survey.summary.byTech.filter((t) => t.tech !== UNKNOWN_TECH).length : 0;
const countAt20 = survey.sites.filter((x) => x.exactEstPct >= 20).length;

const all = computed(() => [
  { key: "sites" as TileKey, value: fmtInt(survey.count), unit: "", label: "sites scanned", sub: `${namedStacks} named stacks, ${scanWhen}` },
  { key: "medianKb" as TileKey, value: fmtInt(s.medianKbPerView), unit: "KB", label: "median image weight per view", sub: "" },
  {
    key: "medianSaving" as TileKey,
    value: fmtPct(s.medianExactEstPct),
    unit: "",
    label: "median saving, exact + est.",
    sub: `exact only: median ${fmtPct(medianExact)}`,
  },
  {
    key: "share20" as TileKey,
    value: fmtPct(s.shareAtLeast20Pct),
    unit: "",
    label: "of sites could save 20% or more",
    sub: `${countAt20} of ${survey.count} sites`,
  },
  {
    key: "totalSaved" as TileKey,
    value: totalValue,
    unit: totalUnit,
    label: "saved per page view, summed over all sites",
    sub: "",
  },
]);

const visible = computed(() => all.value.filter((t) => props.tiles.includes(t.key)));
</script>

<template>
  <ul class="stats" :style="{ '--cols': visible.length }">
    <li v-for="t in visible" :key="t.key" class="tile">
      <span class="value"><span class="num">{{ t.value }}</span><span v-if="t.unit" class="unit">{{ t.unit }}</span></span>
      <span class="label">{{ t.label }}</span>
      <span v-if="t.sub" class="sub">{{ t.sub }}</span>
    </li>
  </ul>
</template>

<style scoped>
.stats {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.6rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.tile {
  display: grid;
  gap: 0.25rem;
  align-content: start;
  border: 1px solid var(--scan-rule);
  background: var(--scan-panel);
  border-radius: 4px;
  padding: 0.75rem 0.8rem;
  min-width: 0;
}
.tile:nth-child(odd):last-child {
  grid-column: 1 / -1;
}
.value {
  white-space: nowrap;
  font: 600 clamp(1.25rem, 1.05rem + 0.6vw, 1.45rem) / 1 var(--scan-mono);
  color: var(--scan-ink);
  letter-spacing: -0.02em;
}
.unit {
  white-space: nowrap;
  margin-left: 0.2em;
  font-size: 0.5em;
  color: var(--scan-muted);
  font-weight: 500;
  letter-spacing: 0;
}
.label {
  font-size: 0.875rem;
  color: var(--scan-ink);
  line-height: 1.35;
}
.sub {
  font: 500 0.75rem/1.4 var(--scan-mono);
  color: var(--scan-muted);
}
@media (min-width: 40rem) {
  .stats {
    grid-template-columns: repeat(var(--cols, 5), minmax(0, 1fr));
  }
  .tile:nth-child(odd):last-child {
    grid-column: auto;
  }
}
</style>
