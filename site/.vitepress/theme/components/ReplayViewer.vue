<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import replay from "../../../data/replay.json";
import study from "../../../data/study.json";

// The replay: fresh `imgtune scan` results for five open-source sites, played in order. Numbers come from
// data/replay.json, which scripts/build-replay-data.mjs writes from the scan JSON. Production sites are not here by
// name: they appear as anonymous cards (A1-A6) from data/study.json.

type Group = (typeof replay.sites)[number]["pages"][number]["groups"][number];
const sites = replay.sites;
const siteIdx = ref(0);
const pageIdx = ref(0);
const playing = ref(false);
let timer: number | undefined;

const site = computed(() => sites[siteIdx.value]);
const page = computed(() => site.value.pages[Math.min(pageIdx.value, site.value.pages.length - 1)]);
const barWidth = (pct: number) => `${Math.min(Math.max(pct, 0), 100)}%`;
const fmtKb = (n: number) => n.toLocaleString("en-US");
const fmtPx = (n: number) => `${n.toLocaleString("en-US")} px`;
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

const estOnly = computed(() => Math.max(page.value.exactEstPct - page.value.exactPct, 0));

function select(i: number) {
  siteIdx.value = i;
  pageIdx.value = 0;
}

function stop() {
  playing.value = false;
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

function play() {
  if (playing.value) return stop();
  playing.value = true;
  if (siteIdx.value >= sites.length - 1 && pageIdx.value >= site.value.pages.length - 1) select(0);
  timer = window.setInterval(() => {
    if (pageIdx.value < site.value.pages.length - 1) {
      pageIdx.value++;
      return;
    }
    if (siteIdx.value < sites.length - 1) {
      siteIdx.value++;
      pageIdx.value = 0;
      return;
    }
    stop();
  }, 1800);
}

watch(siteIdx, () => {
  if (playing.value && pageIdx.value !== 0) pageIdx.value = 0;
});
onBeforeUnmount(stop);

const position = computed(() => {
  let n = 0;
  for (let i = 0; i < siteIdx.value; i++) n += sites[i].pages.length;
  return n + pageIdx.value + 1;
});
const total = sites.reduce((n, s) => n + s.pages.length, 0);

function groupLabel(g: Group) {
  return g.loader === "generic" ? "plain img" : g.loader;
}
</script>

<template>
  <div class="replay">
    <div class="console">
      <div class="bar-top">
        <span>replay · <b>{{ site.site }}</b> · page {{ page.path }}</span>
        <span>KB / view · exact · exact + est.</span>
      </div>
      <div class="play">
        <button type="button" class="playbtn" @click="play">{{ playing ? "pause" : "play" }}</button>
        <span class="pos">{{ position }} / {{ total }}</span>
        <div class="prog"><i :style="{ width: barWidth((position / total) * 100) }"></i></div>
      </div>
      <div class="tabs" role="tablist" aria-label="Open-source site">
        <button
          v-for="(s, i) in sites"
          :key="s.site"
          type="button"
          role="tab"
          :aria-selected="i === siteIdx ? 'true' : 'false'"
          @click="stop(); select(i)"
        >
          {{ s.site }}
        </button>
      </div>
      <div v-if="site.pages.length > 1" class="tabs pages" role="tablist" aria-label="Page of this site">
        <button
          v-for="(p, i) in site.pages"
          :key="p.path"
          type="button"
          role="tab"
          :aria-selected="i === pageIdx ? 'true' : 'false'"
          @click="stop(); pageIdx = i"
        >
          {{ p.path }}
        </button>
      </div>

      <div class="totals">
        <div class="head">
          <span class="mono-b">{{ site.site }}{{ page.path === "/" ? "" : page.path }}</span>
          <span class="kb">{{ fmtKb(page.kbPerView) }} KB / view</span>
        </div>
        <div class="meter x">
          <span>exact</span>
          <div class="track"><i :style="{ width: barWidth(page.exactPct) }"></i></div>
          <span class="num">{{ fmtPct(page.exactPct) }}</span>
        </div>
        <div class="meter e">
          <span>+ est.</span>
          <div class="track">
            <i class="est" :style="{ left: barWidth(page.exactPct), width: barWidth(estOnly) }"></i>
            <span class="bar15"></span>
          </div>
          <span class="num">{{ fmtPct(page.exactEstPct) }}</span>
        </div>
      </div>

      <div class="groups">
        <table>
          <thead>
            <tr>
              <th>top groups</th>
              <th>slot</th>
              <th>needed</th>
              <th>served</th>
              <th>exact KB</th>
              <th>est. KB</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="page.groups.length === 0">
              <td colspan="6" class="none">No image in this page carries a saving at the six viewports.</td>
            </tr>
            <tr v-for="(g, i) in page.groups" :key="i">
              <td>
                <span class="gname">{{ groupLabel(g) }} · {{ g.members }} image{{ g.members === 1 ? "" : "s" }}</span>
              </td>
              <td>{{ fmtPx(g.slotCssPx) }} <span class="unit">css</span></td>
              <td>{{ fmtPx(g.neededPx) }}</td>
              <td :class="{ over: g.servedPx > g.neededPx * 1.5 }">{{ fmtPx(g.servedPx) }}</td>
              <td class="x">{{ g.exactKb.toFixed(1) }}</td>
              <td class="e">{{ g.estKb.toFixed(1) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="foot">
        Scanned {{ site.scannedAt }} with imgtune {{ site.imgtuneVersion }} (tool commit 14b3c12), six viewports, SSIMULACRA2 delta 2,
        page fully scrolled. Exact is measured from the site's own smaller candidates. Est. is a local re-encode and is drawn
        hatched. The 15% line is the study's bar. Slot is the CSS width the image fills, needed is the device pixels it
        needs (widest viewport), served is the file's own width.
      </div>
    </div>

    <div class="anon">
      <div v-for="r in study.production" :key="r.id" class="c">
        <span class="id">{{ r.id }} · production</span>
        <span class="kbv">{{ fmtKb(r.kb) }}<small>KB / view</small></span>
        <div class="pct">
          <span>exact <b class="x">{{ fmtPct(r.exactPct) }}</b></span>
          <span>+ est. <b class="e">{{ fmtPct(r.exactEstPct) }}</b></span>
        </div>
      </div>
    </div>
    <p class="scan-note anon-note">
      Production sites are anonymous: no names, images or URLs. Study v4 numbers, from the study's results.
    </p>
  </div>
</template>

<style scoped>
.replay {
  display: grid;
  gap: 1rem;
}
.console {
  border: 1px solid var(--scan-rule);
  background: var(--scan-panel);
  border-radius: 4px;
  position: relative;
  overflow: hidden;
}
.console::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(to bottom, transparent 0 3px, rgba(0, 0, 0, 0.035) 3px 4px);
}
.bar-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.65rem 1rem;
  border-bottom: 1px solid var(--scan-rule);
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-muted);
  flex-wrap: wrap;
}
.bar-top b {
  color: var(--scan-ink);
  font-weight: 600;
}
.play {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--scan-rule);
  font: 500 0.8125rem var(--scan-mono);
}
.playbtn {
  background: var(--scan-accent);
  color: var(--scan-paper);
  border: 0;
  border-radius: 3px;
  padding: 0.4rem 0.75rem;
  cursor: pointer;
  font: 600 0.8125rem var(--scan-mono);
  min-width: 4.5rem;
}
.pos {
  color: var(--scan-muted);
  white-space: nowrap;
}
.prog {
  flex: 1;
  height: 4px;
  background: var(--scan-track);
  border-radius: 2px;
  overflow: hidden;
}
.prog i {
  display: block;
  height: 100%;
  background: var(--scan-accent);
  transition: width 300ms ease;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--scan-rule);
}
.tabs.pages {
  padding-top: 0.5rem;
  background: var(--scan-track);
}
.tabs button {
  background: transparent;
  border: 1px solid var(--scan-rule);
  border-radius: 3px;
  padding: 0.3rem 0.55rem;
  font: 500 0.75rem var(--scan-mono);
  cursor: pointer;
  color: var(--scan-muted);
}
.tabs button[aria-selected="true"] {
  background: var(--scan-ink);
  color: var(--scan-paper);
  border-color: var(--scan-ink);
}
.totals {
  padding: 1rem;
  display: grid;
  gap: 0.5rem;
  border-bottom: 1px solid var(--scan-rule);
}
.totals .head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  font: 500 0.8125rem var(--scan-mono);
}
.mono-b {
  font-weight: 600;
}
.kb {
  color: var(--scan-muted);
}
.meter {
  display: grid;
  grid-template-columns: 3.5rem 1fr 4.5rem;
  gap: 0.6rem;
  align-items: center;
  font: 500 0.75rem var(--scan-mono);
}
.meter .track {
  position: relative;
  height: 0.6rem;
  background: var(--scan-track);
  border-radius: 1px;
  overflow: hidden;
}
.meter .track i {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--scan-exact);
  transition: width 400ms ease;
}
.meter .track i.est {
  background: repeating-linear-gradient(135deg, var(--scan-est) 0 2px, transparent 2px 5px);
}
.meter .bar15 {
  position: absolute;
  top: -2px;
  bottom: -2px;
  left: 15%;
  width: 1px;
  background: var(--scan-ink);
}
.meter .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.meter.x .num {
  color: var(--scan-exact);
}
.meter.e .num {
  color: var(--scan-est);
}
.groups {
  padding: 0 1rem;
  overflow-x: auto;
}
.groups table {
  width: 100%;
  border-collapse: collapse;
  font: 400 0.8125rem var(--scan-mono);
  font-variant-numeric: tabular-nums;
}
.groups th,
.groups td {
  padding: 0.6rem 0.5rem;
  border-top: 1px dashed var(--scan-rule);
  text-align: right;
  vertical-align: top;
  white-space: nowrap;
}
.groups th:first-child,
.groups td:first-child {
  text-align: left;
  padding-left: 0;
  white-space: normal;
}
.groups thead th {
  border-top: 0;
  color: var(--scan-muted);
  font-weight: 500;
}
.gname {
  display: block;
}
.sample {
  font-size: 0.72rem;
  color: var(--scan-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.unit {
  color: var(--scan-muted);
  font-size: 0.7rem;
}
.over {
  color: var(--scan-est);
}
.groups td.x {
  color: var(--scan-exact);
}
.groups td.e {
  color: var(--scan-est);
}
.none {
  color: var(--scan-muted);
  text-align: left !important;
}
.foot {
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--scan-rule);
  font: 400 0.72rem/1.6 var(--scan-mono);
  color: var(--scan-muted);
}
.anon {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.6rem;
}
.anon .c {
  border: 1px solid var(--scan-rule);
  background: var(--scan-panel);
  border-radius: 3px;
  padding: 0.9rem;
  font: 500 0.75rem var(--scan-mono);
  display: grid;
  gap: 0.4rem;
}
.anon .id {
  color: var(--scan-muted);
}
.kbv {
  font: 600 1.9rem/1 var(--scan-display);
  letter-spacing: -0.02em;
  color: var(--scan-ink);
  font-variant-numeric: tabular-nums;
}
.kbv small {
  font: 500 0.6875rem var(--scan-mono);
  color: var(--scan-muted);
  margin-left: 0.3rem;
}
.pct {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  color: var(--scan-muted);
}
.pct b {
  font-weight: 600;
}
.pct .x {
  color: var(--scan-exact);
}
.pct .e {
  color: var(--scan-est);
}
.anon-note {
  margin: 0;
}
@media (min-width: 58rem) {
  .anon {
    grid-template-columns: repeat(3, 1fr);
  }
}
@media (max-width: 30rem) {
  .anon {
    grid-template-columns: 1fr;
  }
}
</style>
