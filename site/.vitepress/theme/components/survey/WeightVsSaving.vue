<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { survey, median, fmtInt, fmtPct, HEAVY_KB, THRESHOLD_PCT, SMALL_N, type SurveySite } from "./shared";
import { useRoving, useWidth } from "./chart";
import SurveyTooltip from "./SurveyTooltip.vue";

// Scatter: image KB per view (log x) against exact + est. saving. One hue; a category filter
// highlights its sites and grays the rest. Colour never follows the category.
const id = useId();
const root = ref<HTMLElement | null>(null);
const W = useWidth(root, 640);
const H = computed(() => (W.value < 480 ? 300 : 360));

const PAD = { l: 42, r: 14, t: 26, b: 38 };
const plotW = computed(() => W.value - PAD.l - PAD.r);
const plotH = computed(() => H.value - PAD.t - PAD.b);

const sites = [...survey.sites].sort((a, b) => a.imageKbPerView - b.imageKbPerView || a.id.localeCompare(b.id));
// Log domain snapped to the 1-3 ladder (30, 100, 300, 1,000, ...) around the data.
const ladder = [1, 3].flatMap((m) => [-1, 0, 1, 2, 3, 4, 5, 6].map((k) => m * Math.pow(10, k))).sort((a, b) => a - b);
const minKb = Math.min(...sites.map((s) => s.imageKbPerView).filter((v) => v > 0));
const maxKb = Math.max(...sites.map((s) => s.imageKbPerView));
const lo = ladder.filter((v) => v <= minKb).pop() ?? 1;
const hi = ladder.find((v) => v >= maxKb) ?? maxKb;
const span = Math.log10(hi) - Math.log10(lo);

const xOf = (kb: number) => PAD.l + ((Math.log10(Math.max(kb, lo)) - Math.log10(lo)) / span) * plotW.value;
const yOf = (pct: number) => PAD.t + (1 - pct / 100) * plotH.value;

// Ladder ticks inside the domain, dropped greedily from the right so labels never touch.
const xTicks = computed(() => {
  const inside = ladder.filter((v) => v >= lo && v <= hi);
  const kept: number[] = [];
  let lastX = Infinity;
  let lastW = 0;
  for (const v of [...inside].reverse()) {
    const x = xOf(v);
    const w = fmtInt(v).length * 6.8;
    if (lastX - x >= (w + lastW) / 2 + 10 || kept.length === 0) {
      kept.push(v);
      lastX = x;
      lastW = w;
    }
  }
  return kept.reverse();
});
const yTicks = [0, 20, 40, 60, 80, 100];

// Two filter rows: category and tech stack. A site is highlighted when it matches every active filter.
const selected = ref<string | null>(null);
const selectedTech = ref<string | null>(null);
const chips = computed(() => [
  { key: null as string | null, label: "All sites", n: survey.count },
  ...survey.categories.map((c) => ({
    key: c as string | null,
    label: c,
    n: survey.byCategory.find((b) => b.category === c)?.count ?? 0,
  })),
]);
const techChips = computed(() => [
  { key: null as string | null, label: "All stacks", n: survey.count },
  ...survey.summary.byTech.map((t) => ({ key: t.tech as string | null, label: t.tech, n: t.count })),
]);
const filtering = computed(() => selected.value !== null || selectedTech.value !== null);
const isSel = (s: SurveySite) =>
  (selected.value === null || s.category === selected.value) && (selectedTech.value === null || s.tech === selectedTech.value);

const selStats = computed(() => {
  const subset = sites.filter(isSel);
  return {
    n: subset.length,
    med: median(subset.map((s) => s.exactEstPct)),
    kb: median(subset.map((s) => s.imageKbPerView)),
  };
});
const selDescription = computed(() =>
  [selected.value, selectedTech.value].filter((x): x is string => x !== null).join(" · "),
);

const heavy = computed(() => sites.filter((s) => s.imageKbPerView >= HEAVY_KB));
const light = computed(() => sites.filter((s) => s.imageKbPerView < HEAVY_KB));
const takeaway = computed(
  () =>
    `Sites at ${fmtInt(HEAVY_KB)} KB per view or more have a median saving of ${fmtPct(median(heavy.value.map((s) => s.exactEstPct)))} (n=${heavy.value.length}). Lighter sites: ${fmtPct(median(light.value.map((s) => s.exactEstPct)))} (n=${light.value.length}).`,
);

const roving = useRoving(() => sites.length);
const tip = computed(() => {
  const i = roving.shown.value;
  if (i === null) return null;
  const s = sites[i];
  if (!s) return null;
  return {
    x: xOf(s.imageKbPerView),
    y: yOf(s.exactEstPct),
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
  `${s.id}, ${s.category}, ${fmtInt(s.imageKbPerView)} KB per view, exact plus est. ${fmtPct(s.exactEstPct)}`;
</script>

<template>
  <figure class="survey-figure">
    <div class="survey-head">
      <div class="survey-title" role="heading" aria-level="3">Image weight against saving</div>
      <p class="survey-takeaway">{{ takeaway }}</p>
    </div>
    <div class="chip-rows">
      <div class="chips" role="group" aria-label="Filter sites by category">
        <span class="chip-label">Category</span>
        <button
          v-for="c in chips"
          :key="c.label"
          type="button"
          class="chip"
          :aria-pressed="selected === c.key"
          :class="{ on: selected === c.key }"
          @click="selected = c.key"
        >
          {{ c.label }} <span class="chip-n">{{ c.n }}</span>
        </button>
      </div>
      <div class="chips" role="group" aria-label="Filter sites by tech stack">
        <span class="chip-label">Stack</span>
        <button
          v-for="t in techChips"
          :key="t.label"
          type="button"
          class="chip"
          :aria-pressed="selectedTech === t.key"
          :class="{ on: selectedTech === t.key }"
          @click="selectedTech = t.key"
        >
          {{ t.label }} <span class="chip-n">{{ t.n }}</span>
        </button>
      </div>
    </div>
    <p class="sel-line" aria-live="polite">
      <template v-if="filtering">
        {{ selDescription }}: n={{ selStats.n }}, median saving {{ fmtPct(selStats.med) }}, median {{ fmtInt(selStats.kb) }} KB per
        view.
        <span v-if="selStats.n < SMALL_N" class="small">small sample</span>
      </template>
      <template v-else>All {{ survey.count }} sites. Pick a category or a stack to highlight it.</template>
    </p>
    <div ref="root" class="survey-chart">
      <svg
        role="group"
        :aria-describedby="`${id}-desc`"
        aria-label="Scatter: image weight per view against saving"
        :viewBox="`0 0 ${W} ${H}`"
        :width="W"
        :height="H"
        class="survey-svg"
      >
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="yOf(0)" :y2="yOf(0)" class="base" />
        <line :x1="xOf(HEAVY_KB)" :x2="xOf(HEAVY_KB)" :y1="PAD.t - 4" :y2="yOf(0)" class="ref" />
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="yOf(THRESHOLD_PCT)" :y2="yOf(THRESHOLD_PCT)" class="ref" />
        <text :x="xOf(HEAVY_KB)" y="12" text-anchor="middle" class="tick">{{ fmtInt(HEAVY_KB) }} KB</text>
        <text :x="W - PAD.r" :y="yOf(THRESHOLD_PCT) - 5" text-anchor="end" class="tick">{{ THRESHOLD_PCT }}%</text>
        <text
          v-for="t in yTicks"
          :key="`y${t}`"
          :x="PAD.l - 7"
          :y="yOf(t) + 4"
          text-anchor="end"
          class="tick"
        >{{ t }}%</text>
        <text
          v-for="t in xTicks"
          :key="`x${t}`"
          :x="xOf(t)"
          :y="H - 14"
          :text-anchor="t === xTicks[0] ? 'start' : t === xTicks[xTicks.length - 1] ? 'end' : 'middle'"
          class="tick"
        >{{ fmtInt(t) }}</text>
        <text :x="PAD.l" :y="H - 1" class="axis-title">image KB per view (log scale)</text>
        <g
          v-for="(s, i) in sites"
          :key="s.id"
          role="img"
          class="dot"
          :class="{ dim: !isSel(s), hi: filtering && isSel(s), focus: roving.focused.value === i }"
          :tabindex="roving.current.value === i ? 0 : -1"
          :aria-label="label(s)"
          :ref="roving.setNode(i)"
          @focus="roving.onFocus(i)"
          @blur="roving.onBlur(i)"
          @keydown="roving.onKeydown($event, i)"
          @pointerenter="roving.onEnter(i)"
          @pointerleave="roving.onLeave(i)"
        >
          <circle :cx="xOf(s.imageKbPerView)" :cy="yOf(s.exactEstPct)" r="12" class="hit" />
          <circle
            :cx="xOf(s.imageKbPerView)"
            :cy="yOf(s.exactEstPct)"
            :r="roving.shown.value === i ? 6 : isSel(s) && filtering ? 5.5 : 4.5"
            class="mark"
          />
          <circle
            v-if="roving.focused.value === i"
            :cx="xOf(s.imageKbPerView)"
            :cy="yOf(s.exactEstPct)"
            r="10"
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
    <figcaption :id="`${id}-desc`" class="survey-caption">
      One dot per site: image KB per view on a log scale against exact + est. saving. Selecting a category highlights its
      sites in the accent color and grays the others. The stack row works the same way and combines with the category.
    </figcaption>
  </figure>
</template>

<style scoped>
.chip-rows {
  display: grid;
  gap: 0.5rem;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
.chip-label {
  font: 600 0.6875rem var(--scan-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--scan-muted);
  min-width: 4.5rem;
}
.chip {
  font: 500 0.8125rem var(--scan-sans);
  color: var(--scan-muted);
  background: transparent;
  border: 1px solid var(--scan-rule);
  border-radius: 999px;
  padding: 0.4rem 0.7rem;
  min-height: 2.5rem;
  cursor: pointer;
}
.chip:hover {
  color: var(--scan-ink);
  border-color: var(--scan-muted);
}
.chip.on {
  color: var(--scan-ink);
  border-color: var(--scan-accent);
  background: var(--scan-accent-soft);
}
.chip:focus-visible {
  outline: 2px solid var(--scan-accent);
  outline-offset: 2px;
}
.chip-n {
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-muted);
  margin-left: 0.2rem;
}
.sel-line {
  margin: 0;
  font: 500 0.8125rem/1.5 var(--scan-mono);
  color: var(--scan-muted);
}
.sel-line .small {
  color: var(--scan-ink);
  margin-left: 0.4rem;
}
.base {
  stroke: var(--scan-rule);
  stroke-width: 1;
}
.ref {
  stroke: var(--scan-muted);
  stroke-width: 1;
  opacity: 0.7;
}
.tick,
.axis-title {
  font: 500 11px var(--scan-mono);
  fill: var(--scan-muted);
}
.dot {
  outline: none;
}
.dot .hit {
  fill: transparent;
}
.dot .mark {
  fill: var(--scan-accent);
  stroke: var(--scan-panel);
  stroke-width: 2;
}
.dot.dim .mark {
  fill: var(--scan-dim);
}
.dot.hi .mark {
  fill: var(--scan-accent);
}
.dot .ring {
  fill: none;
  stroke: var(--scan-ink);
  stroke-width: 1.5;
}
</style>
