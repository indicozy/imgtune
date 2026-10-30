<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { survey, median, fmtInt, fmtPct, THRESHOLD_PCT, type SurveySite } from "./shared";
import { useRoving, useWidth } from "./chart";
import SurveyTooltip from "./SurveyTooltip.vue";

// One dot per site on exact + est. saving (0-100%), stacked in 5% bins. Single hue.
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const id = useId();
const root = ref<HTMLElement | null>(null);
const W = useWidth(root, 640);

const BINS = 20;
const PAD_L = 12;
const PAD_R = 12;
const PAD_TOP = 30;
const AXIS_H = 26;

const step = computed(() => (props.compact ? 9 : 11));
const r = computed(() => (props.compact ? 3.5 : 4.5));

// Sites in saving order (left to right); the keyboard walks this order.
const sites = [...survey.sites].sort((a, b) => a.exactEstPct - b.exactEstPct || a.id.localeCompare(b.id));

const layout = computed(() => {
  const fill = new Array<number>(BINS).fill(0);
  return sites.map((site: SurveySite) => {
    const bin = Math.min(BINS - 1, Math.floor(site.exactEstPct / 5));
    const row = fill[bin]++;
    return { site, bin, row };
  });
});
const maxStack = computed(() => {
  const fill = new Array<number>(BINS).fill(0);
  for (const d of layout.value) fill[d.bin]++;
  return Math.max(1, ...fill);
});

const H = computed(() => Math.max(props.compact ? 130 : 160, PAD_TOP + maxStack.value * step.value + AXIS_H + 8));
const plotW = computed(() => W.value - PAD_L - PAD_R);
const binW = computed(() => plotW.value / BINS);
const baseY = computed(() => H.value - AXIS_H);
const xOf = (pct: number) => PAD_L + (pct / 100) * plotW.value;
const cxOf = (bin: number) => PAD_L + (bin + 0.5) * binW.value;
const cyOf = (row: number) => baseY.value - r.value - 2 - row * step.value;

const med = computed(() => survey.summary.medianExactEstPct);
const medianLeft = computed(() => med.value < THRESHOLD_PCT);
const ticks = [0, 20, 40, 60, 80, 100];

const countAt20 = computed(() => sites.filter((s) => s.exactEstPct >= THRESHOLD_PCT).length);
const takeaway = computed(
  () =>
    `${countAt20.value} of ${sites.length} sites (${fmtPct((100 * countAt20.value) / sites.length)}) could save ${THRESHOLD_PCT}% or more of their image bytes. The median is ${fmtPct(med.value)}.`,
);

const roving = useRoving(() => layout.value.length);
const tip = computed(() => {
  const i = roving.shown.value;
  if (i === null) return null;
  const d = layout.value[i];
  if (!d) return null;
  const s = d.site;
  return {
    x: cxOf(d.bin),
    y: cyOf(d.row),
    title: `${s.id} · ${s.category}`,
    rows: [
      { label: "image KB / view", value: fmtInt(s.imageKbPerView) },
      { label: "exact", value: fmtPct(s.exactPct) },
      { label: "exact + est.", value: fmtPct(s.exactEstPct) },
      { label: "fixable", value: fmtPct(s.fixablePct) },
      { label: "saved KB / view", value: fmtInt(s.savedKbPerView) },
    ],
  };
});
const label = (s: SurveySite) =>
  `${s.id}, ${s.category}, ${fmtInt(s.imageKbPerView)} KB per view, exact ${fmtPct(s.exactPct)}, exact plus est. ${fmtPct(s.exactEstPct)}, fixable ${fmtPct(s.fixablePct)}`;
</script>

<template>
  <figure class="survey-figure">
    <div class="survey-head">
      <div class="survey-title" role="heading" aria-level="3">How much each site could save</div>
      <p class="survey-takeaway">{{ takeaway }}</p>
    </div>
    <div ref="root" class="survey-chart">
      <svg
        role="group"
        :aria-describedby="`${id}-desc`"
        aria-label="Dot plot: one dot per site by exact plus estimated saving"
        :viewBox="`0 0 ${W} ${H}`"
        :width="W"
        :height="H"
        class="survey-svg"
      >
        <line :x1="PAD_L" :x2="W - PAD_R" :y1="baseY" :y2="baseY" class="base" />
        <g class="ref">
          <line :x1="xOf(THRESHOLD_PCT)" :x2="xOf(THRESHOLD_PCT)" :y1="PAD_TOP - 6" :y2="baseY" />
          <line :x1="xOf(med)" :x2="xOf(med)" :y1="PAD_TOP - 6" :y2="baseY" class="median" />
        </g>
        <text
          :x="medianLeft ? xOf(THRESHOLD_PCT) + 5 : xOf(THRESHOLD_PCT) - 5"
          y="13"
          :text-anchor="medianLeft ? 'start' : 'end'"
          class="reflabel"
        >{{ THRESHOLD_PCT }}%</text>
        <text
          :x="medianLeft ? xOf(med) - 5 : xOf(med) + 5"
          y="13"
          :text-anchor="medianLeft ? 'end' : 'start'"
          class="reflabel strong"
        >median {{ fmtPct(med) }}</text>
        <text
          v-for="t in ticks"
          :key="t"
          :x="xOf(t)"
          :y="baseY + 18"
          :text-anchor="t === 0 ? 'start' : t === 100 ? 'end' : 'middle'"
          class="tick"
        >{{ t }}%</text>
        <g
          v-for="(d, i) in layout"
          :key="d.site.id"
          role="img"
          class="dot"
          :class="{ focus: roving.focused.value === i }"
          :tabindex="roving.current.value === i ? 0 : -1"
          :aria-label="label(d.site)"
          :ref="roving.setNode(i)"
          @focus="roving.onFocus(i)"
          @blur="roving.onBlur(i)"
          @keydown="roving.onKeydown($event, i)"
          @pointerenter="roving.onEnter(i)"
          @pointerleave="roving.onLeave(i)"
        >
          <circle :cx="cxOf(d.bin)" :cy="cyOf(d.row)" :r="Math.max(12, r + 6)" class="hit" />
          <circle
            :cx="cxOf(d.bin)"
            :cy="cyOf(d.row)"
            :r="roving.shown.value === i ? r + 1.5 : r"
            class="mark"
          />
          <circle
            v-if="roving.focused.value === i"
            :cx="cxOf(d.bin)"
            :cy="cyOf(d.row)"
            :r="r + 5"
            class="ring"
          />
        </g>
      </svg>
      <SurveyTooltip
        v-if="tip"
        :x="tip.x"
        :y="tip.y"
        :box-w="W"
        :title="tip.title"
        :rows="tip.rows"
      />
    </div>
    <figcaption v-if="!compact" :id="`${id}-desc`" class="survey-caption">
      One dot per site, grouped in {{ 100 / BINS }}% steps of exact + est. saving (share of image bytes per view). Dots
      stack upward; hover or tab through them for each site.
    </figcaption>
    <span v-else :id="`${id}-desc`" class="sr-only">
      One dot per site, grouped in 5% steps of exact plus estimated saving.
    </span>
  </figure>
</template>

<style scoped>
.base {
  stroke: var(--scan-rule);
  stroke-width: 1;
}
.ref line {
  stroke: var(--scan-muted);
  stroke-width: 1;
}
.ref line.median {
  stroke: var(--scan-ink);
}
.reflabel,
.tick {
  font: 500 11px var(--scan-mono);
  fill: var(--scan-muted);
}
.reflabel.strong {
  fill: var(--scan-ink);
}
.dot {
  outline: none;
  cursor: default;
}
.dot .hit {
  fill: transparent;
}
.dot .mark {
  fill: var(--scan-accent);
  stroke: var(--scan-panel);
  stroke-width: 2;
  transition: r 0.1s;
}
.dot .ring {
  fill: none;
  stroke: var(--scan-ink);
  stroke-width: 1.5;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
