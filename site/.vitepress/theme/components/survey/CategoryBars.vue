<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { survey, fmtInt, fmtPct, SMALL_N } from "./shared";

// One bar per group. Defaults to the site categories; TechBars passes tech stacks.
export interface BarRow {
  name: string;
  count: number;
  medianKbPerView: number;
  medianExactEstPct: number;
  medianFixablePct: number;
  medianSavedKbPerView: number;
}
const props = withDefaults(defineProps<{ rows?: BarRow[]; noun?: string }>(), { rows: undefined, noun: "category" });
const source = computed<BarRow[]>(
  () =>
    props.rows ??
    survey.byCategory.map((c) => ({
      name: c.category,
      count: c.count,
      medianKbPerView: c.medianKbPerView,
      medianExactEstPct: c.medianExactEstPct,
      medianFixablePct: c.medianFixablePct,
      medianSavedKbPerView: c.medianSavedKbPerView,
    })),
);
import { useRoving, useWidth } from "./chart";
import SurveyTooltip from "./SurveyTooltip.vue";

// Horizontal bars: median saving (or median image weight) per category, sorted. Single hue.
type Metric = "saving" | "kb";
const metric = ref<Metric>("saving");
const id = useId();
const root = ref<HTMLElement | null>(null);
const W = useWidth(root, 640);

const LINE_H = 17;
const META_H = 16;
const ROW_PAD = 12;
const VAL_W = 84;

const value = (c: BarRow) => (metric.value === "saving" ? c.medianExactEstPct : c.medianKbPerView);
const fmtVal = (v: number) => (metric.value === "saving" ? fmtPct(v) : `${fmtInt(v)} KB`);

const rows = computed(() =>
  [...source.value].sort((a, b) => value(b) - value(a) || b.count - a.count),
);

// Label column: name wraps to at most two lines, the meta line below carries n.
const L = computed(() => Math.min(220, Math.max(120, Math.round(W.value * 0.4))));
const charsPerLine = computed(() => Math.max(10, Math.floor(L.value / 7.4)));
function wrap(name: string): string[] {
  const words = name.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > charsPerLine.value && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}
const x0 = computed(() => L.value + 12);
const barMax = computed(() => Math.max(40, W.value - x0.value - VAL_W));
const maxVal = computed(() => Math.max(...rows.value.map(value), 1));

const laid = computed(() => {
  let y = 0;
  return rows.value.map((c) => {
    const lines = wrap(c.name);
    const h = lines.length * LINE_H + META_H + ROW_PAD;
    const row = { c, lines, y, h, w: (value(c) / maxVal.value) * barMax.value, small: c.count < SMALL_N };
    y += h;
    return row;
  });
});
const H = computed(() => laid.value.reduce((t, r) => t + r.h, 0) + 2);

const roving = useRoving(() => laid.value.length);

function barPath(x: number, y: number, w: number, h: number, rad: number) {
  if (w <= 0) return "";
  const r = Math.min(rad, w, h / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}

const ranked = computed(() => rows.value.filter((c) => c.count >= SMALL_N));
const takeaway = computed(() => {
  const top = ranked.value[0];
  if (!top) return "";
  const all =
    metric.value === "saving"
      ? fmtPct(survey.summary.medianExactEstPct)
      : `${fmtInt(survey.summary.medianKbPerView)} KB`;
  return `${top.name} ranks highest at ${fmtVal(value(top))} (n=${top.count}). The median across all ${survey.count} sites is ${all}.`;
});

const tip = computed(() => {
  const i = roving.shown.value;
  if (i === null) return null;
  const row = laid.value[i];
  if (!row) return null;
  const c = row.c;
  return {
    x: x0.value + row.w,
    y: row.y + row.h / 2,
    title: c.name,
    rows: [
      { label: "sites (n)", value: String(c.count) },
      { label: "median saving, exact + est.", value: fmtPct(c.medianExactEstPct) },
      { label: "median fixable", value: fmtPct(c.medianFixablePct) },
      { label: "median image KB / view", value: fmtInt(c.medianKbPerView) },
      { label: "median saved KB / view", value: fmtInt(c.medianSavedKbPerView) },
    ],
  };
});
</script>

<template>
  <figure class="survey-figure">
    <div class="survey-head">
      <div class="survey-title" role="heading" aria-level="3">
        {{ metric === "saving" ? `Median saving by ${noun}` : `Median image weight by ${noun}` }}
      </div>
      <p class="survey-takeaway">{{ takeaway }}</p>
    </div>
    <div class="toggle" role="group" aria-label="Metric">
      <button type="button" :aria-pressed="metric === 'saving'" :class="{ on: metric === 'saving' }" @click="metric = 'saving'">
        saving %
      </button>
      <button type="button" :aria-pressed="metric === 'kb'" :class="{ on: metric === 'kb' }" @click="metric = 'kb'">
        KB per view
      </button>
    </div>
    <div ref="root" class="survey-chart">
      <svg
        role="group"
        :aria-describedby="`${id}-desc`"
        :aria-label="`Bar chart: median per ${noun}, sorted`"
        :viewBox="`0 0 ${W} ${H}`"
        :width="W"
        :height="H"
        class="survey-svg"
      >
        <line :x1="x0" :x2="x0" y1="0" :y2="H" class="base" />
        <g
          v-for="(row, i) in laid"
          :key="row.c.name"
          role="img"
          class="row"
          :class="{ small: row.small, active: roving.shown.value === i }"
          :tabindex="roving.current.value === i ? 0 : -1"
          :aria-label="`${row.c.name}, n ${row.c.count}, median ${fmtVal(value(row.c))}${row.small ? ', small sample' : ''}`"
          :ref="roving.setNode(i)"
          @focus="roving.onFocus(i)"
          @blur="roving.onBlur(i)"
          @keydown="roving.onKeydown($event, i)"
          @pointerenter="roving.onEnter(i)"
          @pointerleave="roving.onLeave(i)"
        >
          <rect :x="0" :y="row.y" :width="W" :height="row.h" class="hit" />
          <text
            v-for="(line, li) in row.lines"
            :key="li"
            :x="0"
            :y="row.y + 14 + li * LINE_H"
            class="name"
          >{{ line }}</text>
          <text :x="0" :y="row.y + row.lines.length * LINE_H + 12" class="meta">
            n={{ row.c.count }}<tspan v-if="row.small"> · small sample</tspan>
          </text>
          <path
            :d="barPath(x0, row.y + row.h / 2 - Math.min(20, row.h * 0.4) / 2, row.w, Math.min(20, row.h * 0.4), 4)"
            class="bar"
          />
          <text :x="x0 + row.w + 6" :y="row.y + row.h / 2 + 4" class="val">{{ fmtVal(value(row.c)) }}</text>
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
      One row per {{ noun }}, sorted by {{ metric === "saving" ? "median saving" : "median image weight" }}. Groups with
      fewer than {{ SMALL_N }} sites are faded.
    </figcaption>
  </figure>
</template>

<style scoped>
.toggle {
  display: inline-flex;
  justify-self: start;
  border: 1px solid var(--scan-rule);
  border-radius: 4px;
  overflow: hidden;
}
.toggle button {
  font: 500 0.8125rem var(--scan-mono);
  color: var(--scan-muted);
  background: transparent;
  border: 0;
  padding: 0.55rem 0.8rem;
  min-height: 2.5rem;
  cursor: pointer;
}
.toggle button + button {
  border-left: 1px solid var(--scan-rule);
}
.toggle button.on {
  color: var(--scan-ink);
  background: var(--scan-accent-soft);
}
.toggle button:focus-visible {
  outline: 2px solid var(--scan-accent);
  outline-offset: -2px;
}
.base {
  stroke: var(--scan-rule);
  stroke-width: 1;
}
.row {
  outline: none;
}
.row .hit {
  fill: transparent;
}
.name {
  font: 500 13px var(--scan-sans);
  fill: var(--scan-ink);
}
.meta,
.val {
  font: 500 11px var(--scan-mono);
  fill: var(--scan-muted);
}
.val {
  font-size: 12px;
  fill: var(--scan-ink);
  font-variant-numeric: tabular-nums;
}
.bar {
  fill: var(--scan-accent);
  transition: stroke 0.1s;
}
.row.small .bar {
  opacity: 0.4;
}
.row.small .name {
  fill: var(--scan-muted);
}
.row.active .bar {
  stroke: var(--scan-ink);
  stroke-width: 1.5;
}
.row:focus-visible .bar {
  stroke: var(--scan-ink);
  stroke-width: 1.5;
}
.row:focus-visible .name {
  text-decoration: underline;
}
</style>
