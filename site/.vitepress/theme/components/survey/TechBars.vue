<script setup lang="ts">
import { computed } from "vue";
import { survey, median } from "./shared";
import CategoryBars, { type BarRow } from "./CategoryBars.vue";

// By tech stack: the same bars as CategoryBars, one row per stack from the data.
// Counts and medians come from summary.byTech; fixable and saved come from the sites.
const rows = computed<BarRow[]>(() =>
  survey.summary.byTech.map((t) => {
    const rs = survey.sites.filter((s) => s.tech === t.tech);
    return {
      name: t.tech,
      count: t.count,
      medianKbPerView: t.medianKbPerView,
      medianExactEstPct: t.medianExactEstPct,
      medianFixablePct: median(rs.map((s) => s.fixablePct)),
      medianSavedKbPerView: median(rs.map((s) => s.savedKbPerView)),
    };
  }),
);
</script>

<template>
  <CategoryBars :rows="rows" noun="tech stack" />
</template>
