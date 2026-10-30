<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import WidthPicker from "./WidthPicker.vue";
import { startRun, type Run } from "../demo/client";
import { takePendingFile } from "../demo/pending";
import { SAMPLES, makeSample } from "../demo/samples";
import type { Candidate, FileInfo } from "../demo/types";
import { MAX_SIDE, PASS_FLOOR } from "../demo/types";
import type { WidthRow } from "../lib/layout";

// The demo. Everything runs in this browser: the file is read, encoded and scored locally. Numbers are browser
// estimates; the CLI measures the live page.

const file = shallowRef<File | null>(null);
const fileInfo = ref<FileInfo | null>(null);
const fileUrl = ref("");
const rows = ref<WidthRow[]>([]);
const targets = ref<number[]>([]);
const sizesError = ref<string | null>(null);
const skipAvif = ref(false);
const over = ref(false);
const input = ref<HTMLInputElement | null>(null);

const running = ref(false);
const progress = ref({ done: 0, total: 1, label: "" });
const startedAt = ref(0);
const elapsed = ref(0);
const error = ref("");
const notes = ref<string[]>([]);
const candidates = ref<Candidate[]>([]);
const ranWidths = ref<number[]>([]);
const ranTotalMs = ref(0);
const viewportName = ref("desktop");
const pickedKey = ref("");
const split = ref(55);
const compareUrl = ref("");
let run: Run | null = null;
let clock: number | undefined;

const bigWidth = computed(() => fileInfo.value?.width ?? 0);
const needRerun = computed(() => {
  if (!fileInfo.value || running.value) return false;
  return targets.value.some((t) => !ranWidths.value.includes(t));
});
const pct = (n: number) => Math.round((n / Math.max(progress.value.total, 1)) * 100);
const kb = (n: number) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;

function saving(bytes: number | null): string {
  if (bytes === null || !fileInfo.value) return "n/a";
  const s = 1 - bytes / fileInfo.value.bytes;
  if (s <= 0) return "0% (not smaller)";
  return `-${Math.round(s * 100)}%`;
}

const byWidth = computed(() => {
  const m = new Map<number, Candidate[]>();
  for (const c of candidates.value) {
    const list = m.get(c.width) ?? [];
    list.push(c);
    m.set(c.width, list);
  }
  return m;
});

/** Smallest passing candidate at a width, from the combined row the worker builds. */
function bestAt(width: number): Candidate | undefined {
  return candidates.value.find((c) => c.width === width && c.id === "combined");
}

const viewportRows = computed(() =>
  rows.value.map((r) => {
    const best = r.needed !== null ? bestAt(r.needed) : undefined;
    return { ...r, best, ran: r.needed !== null && ranWidths.value.includes(r.needed) };
  }),
);

const picked = computed(() => candidates.value.find((c) => c.key === pickedKey.value));

const shownRows = computed(() => {
  const row = rows.value.find((r) => r.name === viewportName.value);
  if (!row || row.needed === null) return [];
  return candidates.value.filter((c) => c.width === row.needed || c.id === "quality");
});

function setFile(f: File) {
  error.value = "";
  file.value = f;
  fileInfo.value = null;
  candidates.value = [];
  notes.value = [];
  pickedKey.value = "";
  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value);
  fileUrl.value = URL.createObjectURL(f);
  createImageBitmap(f).then(
    async (bmp) => {
      fileInfo.value = { name: f.name, type: f.type, bytes: f.size, width: bmp.width, height: bmp.height };
      const { width, height } = bmp;
      bmp.close();
      if (Math.max(width, height) > MAX_SIDE) {
        error.value = `This image is ${width} x ${height} px. The demo works up to ${MAX_SIDE} px on the long side; scale it down and drop it again.`;
        return;
      }
      // Let the width picker re-read the file's width (it caps the needed pixels) before the run reads its targets.
      await nextTick();
      if (targets.value.length) start();
    },
    () => {
      error.value = "This browser cannot read this file. Try a JPEG, PNG or WebP.";
    },
  );
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  over.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) acceptFile(f);
}

function acceptFile(f: File) {
  if (!f.type.startsWith("image/")) {
    error.value = "That file is not an image. Drop a JPEG, PNG, WebP or AVIF.";
    return;
  }
  setFile(f);
}

async function useSample(id: string) {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) return;
  acceptFile(await makeSample(s));
}

function onWidths(v: { rows: WidthRow[]; targets: number[]; error: string | null }) {
  rows.value = v.rows;
  targets.value = v.targets;
  sizesError.value = v.error;
}

function start() {
  if (!file.value || !fileInfo.value || running.value) return;
  if (sizesError.value) {
    error.value = `The sizes value cannot be used: ${sizesError.value}.`;
    return;
  }
  const todo = targets.value.filter((t) => t <= fileInfo.value!.width);
  if (todo.length === 0) return;
  error.value = "";
  running.value = true;
  notes.value = [];
  startedAt.value = performance.now();
  elapsed.value = 0;
  clock = window.setInterval(() => (elapsed.value = (performance.now() - startedAt.value) / 1000), 200);
  progress.value = { done: 0, total: 1, label: "starting" };
  run = startRun({ file: file.value, targets: todo, skipAvif: skipAvif.value }, (done, total, label) => {
    progress.value = { done, total, label };
  });
  const current = run;
  current.promise
    .then((res) => {
      candidates.value = res.candidates;
      notes.value = res.notes;
      ranWidths.value = todo;
      ranTotalMs.value = res.totalMs;
      fileInfo.value = res.file;
      pickedKey.value = res.candidates.find((c) => c.id === "combined" && c.bytes !== null)?.key ?? "";
      updateCompare();
    })
    .catch((err: Error) => {
      if (err.message !== "cancelled") error.value = err.message;
    })
    .finally(() => {
      running.value = false;
      run = null;
      if (clock !== undefined) window.clearInterval(clock);
      clock = undefined;
    });
}

function cancel() {
  run?.cancel();
  run = null;
  running.value = false;
  if (clock !== undefined) window.clearInterval(clock);
  clock = undefined;
  error.value = "Stopped. Drop the file again to start over.";
}

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) acceptFile(f);
}

watch(pickedKey, updateCompare);

onMounted(() => {
  const pending = takePendingFile();
  if (pending) acceptFile(pending);
});
onBeforeUnmount(() => {
  run?.cancel();
  if (clock !== undefined) window.clearInterval(clock);
  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value);
  if (compareUrl.value) URL.revokeObjectURL(compareUrl.value);
});

// The compare view shows the file and the picked candidate. Its object URL is made here and revoked when it changes.
function updateCompare() {
  if (compareUrl.value) URL.revokeObjectURL(compareUrl.value);
  compareUrl.value = picked.value?.blob ? URL.createObjectURL(picked.value.blob) : "";
}
</script>

<template>
  <div class="demo-page">
    <p class="kicker">demo · runs in this browser · nothing is uploaded</p>
    <h1 class="scan-h1">Demo.</h1>
    <p class="intro">
      Drop an image, or try a sample. It is encoded and scored here, and the numbers are <b>browser estimates</b>. The CLI measures
      the live page.
    </p>
  <div class="demo">

    <div
      class="drop"
      :class="{ over }"
      role="button"
      tabindex="0"
      aria-label="Drop an image"
      @click="input?.click()"
      @keydown.enter.prevent="input?.click()"
      @keydown.space.prevent="input?.click()"
      @dragenter.prevent="over = true"
      @dragover.prevent="over = true"
      @dragleave.prevent="over = false"
      @drop="onDrop"
    >
      <div v-if="!file" class="drop-empty">
        <p class="big">Drop an image here.</p>
        <p class="hint">JPEG, PNG, WebP or AVIF. Up to {{ MAX_SIDE }} px on the long side. Or click to choose a file.</p>
      </div>
      <div v-else class="drop-file">
        <img v-if="fileUrl" :src="fileUrl" alt="The dropped image" class="thumb" />
        <div class="meta">
          <p class="big">{{ fileInfo?.name ?? file.name }}</p>
          <p class="hint">
            {{ kb(file.size) }}<template v-if="fileInfo"> · {{ fileInfo.width }} x {{ fileInfo.height }} px</template>
            · click to choose another
          </p>
        </div>
      </div>
      <input ref="input" type="file" accept="image/*" class="hidden" @change="onPick" @click.stop />
    </div>

    <div class="samples" aria-label="Sample images">
      <span class="scan-note">Samples:</span>
      <button v-for="s in SAMPLES" :key="s.id" type="button" :disabled="running" @click="useSample(s.id)">
        {{ s.label }}<small>synthetic sample, made in this page</small>
      </button>
    </div>

    <section class="panel">
      <h2>1. Display width</h2>
      <p class="scan-note">The image's width on the page, at each viewport. The demo encodes at the widths these rows need.</p>
      <WidthPicker :file-width="bigWidth || undefined" @update="onWidths" />
    </section>

    <section class="panel">
      <h2>2. Run</h2>
      <div class="run">
        <label class="check"><input v-model="skipAvif" type="checkbox" :disabled="running" /> skip AVIF (slow on phones)</label>
        <button v-if="!running" type="button" class="primary" :disabled="!file || !fileInfo || targets.length === 0" @click="start">
          {{ candidates.length ? (needRerun ? "run again for these widths" : "run again") : "run" }}
        </button>
        <button v-else type="button" class="ghost" @click="cancel">cancel</button>
      </div>
      <div v-if="running" class="progress" role="status" aria-live="polite">
        <div class="bar"><i :style="{ width: pct(progress.done) + '%' }"></i></div>
        <p class="scan-note">{{ progress.done }} / {{ progress.total }} · {{ progress.label }} · {{ elapsed.toFixed(1) }} s</p>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
      <p v-for="n in notes" :key="n" class="scan-note">{{ n }}</p>
    </section>

    <section v-if="candidates.length" class="panel">
      <h2>3. Result per viewport</h2>
      <p class="scan-note">
        Browser estimate. Bytes of the best candidate that scores at least {{ PASS_FLOOR }} on SSIMULACRA2, against the file's
        size. Ran in {{ (ranTotalMs / 1000).toFixed(1) }} s on this device.
      </p>
      <div class="tablewrap">
        <table>
          <thead>
            <tr><th>viewport</th><th>needed px</th><th>best passing</th><th>bytes</th><th>saving</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in viewportRows" :key="r.name" :class="{ sel: r.name === viewportName }" @click="viewportName = r.name">
              <td>{{ r.name }}</td>
              <td>{{ r.needed ?? "n/a" }}</td>
              <td v-if="r.ran && r.best && r.best.bytes !== null">{{ r.best.label.replace(/ at \d+ px/, "") }}</td>
              <td v-else-if="r.ran">none passes</td>
              <td v-else class="muted">not run</td>
              <td>{{ r.ran && r.best?.bytes ? kb(r.best.bytes) : "-" }}</td>
              <td>{{ r.ran && r.best?.bytes ? saving(r.best.bytes) : "-" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="candidates.length" class="panel">
      <h2>4. Candidates at {{ viewportName }}</h2>
      <div class="tabs" role="tablist" aria-label="Viewport">
        <button v-for="r in rows" :key="r.name" type="button" role="tab" :aria-selected="r.name === viewportName ? 'true' : 'false'" @click="viewportName = r.name">
          {{ r.name }}
        </button>
      </div>
      <div class="tablewrap">
        <table>
          <thead>
            <tr><th>candidate</th><th>bytes</th><th>saving</th><th>SSIMULACRA2</th><th>pass</th><th>time</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in shownRows" :key="c.key" :class="{ sel: c.key === pickedKey }" @click="pickedKey = c.key">
              <td>
                {{ c.label }}
                <span v-if="c.note" class="cnote">{{ c.note }}</span>
              </td>
              <td>{{ c.bytes !== null ? kb(c.bytes) : "-" }}</td>
              <td>{{ saving(c.bytes) }}</td>
              <td>{{ c.score !== null ? c.score.toFixed(1) : "-" }}</td>
              <td :class="c.pass ? 'ok' : 'no'">{{ c.bytes === null ? "-" : c.pass ? "yes" : "no" }}</td>
              <td>{{ c.ms ? (c.ms / 1000).toFixed(2) + " s" : "-" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="scan-note">
        Pass means SSIMULACRA2 at or above {{ PASS_FLOOR }}, the CLI's relaxed floor. The CLI also requires a candidate to be within
        2 points of the current file's score; a dropped file has no served copy to compare, so that rule is not applied here.
        The browser's encoders and decoders are not the CLI's (sharp, libvips), so the bytes will not match the CLI's.
      </p>
    </section>

    <section v-if="picked && picked.blob" class="panel">
      <h2>5. Compare</h2>
      <p class="scan-note">{{ picked.label }}. Drag the line.</p>
      <div class="compare" :style="{ '--split': split + '%' }">
        <img v-if="fileUrl" :src="fileUrl" alt="The file" class="cmp-base" />
        <img v-if="compareUrl" :src="compareUrl" alt="The candidate" class="cmp-top" />
        <div class="cmp-line"></div>
      </div>
      <input v-model.number="split" type="range" min="0" max="100" aria-label="Compare split" class="range" />
      <p class="scan-note">Left of the line: the candidate. Right: the file. Both are fitted to the same box.</p>
    </section>

    <p class="scan-note foot">
      Scoring: SSIMULACRA2 from ImgTune's crate, built for the web. Codecs: jSquash (MozJPEG, libwebp, libavif). Each codec is
      downloaded the first time you drop a file. Images up to {{ MAX_SIDE }} px on the long side are decoded here, and the page
      keeps them only while it is open.
    </p>
  </div>
  </div>
</template>

<style scoped>
.demo-page {
  max-width: 74rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  color: var(--scan-ink);
}
.kicker {
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-accent);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin: 0 0 1rem;
}
.scan-h1 {
  font-family: var(--scan-display);
  font-weight: 650;
  font-size: clamp(2.6rem, 1.1rem + 5.6vw, 5.25rem);
  line-height: 0.98;
  letter-spacing: -0.025em;
  margin: 0 0 1rem;
}
.demo {
  display: grid;
  gap: 1rem;
  color: var(--scan-ink);
}
.intro {
  color: var(--scan-muted);
  margin: 0;
  max-width: 46rem;
}
.drop {
  border: 1px dashed var(--scan-accent);
  background: var(--scan-panel);
  border-radius: 4px;
  padding: 1.25rem;
  cursor: pointer;
  min-height: 11rem;
  display: grid;
  align-content: center;
}
.drop:hover,
.drop:focus-visible,
.drop.over {
  background: var(--scan-accent-soft);
}
.drop:focus-visible {
  outline: 2px solid var(--scan-accent);
  outline-offset: 2px;
}
.big {
  font: 600 1.5rem/1.15 var(--scan-display);
  letter-spacing: -0.015em;
  margin: 0;
  overflow-wrap: anywhere;
}
.hint {
  font: 400 0.8125rem/1.6 var(--scan-mono);
  color: var(--scan-muted);
  margin: 0.4rem 0 0;
}
.drop-file {
  display: flex;
  gap: 1rem;
  align-items: center;
  flex-wrap: wrap;
}
.thumb {
  width: 7rem;
  height: 5rem;
  object-fit: cover;
  border-radius: 3px;
  border: 1px solid var(--scan-rule);
}
.meta {
  min-width: 0;
  flex: 1;
}
.hidden {
  display: none;
}
.samples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.samples button,
.tabs button,
.ghost,
.primary {
  font: 500 0.8125rem var(--scan-mono);
  border-radius: 3px;
  padding: 0.4rem 0.6rem;
  cursor: pointer;
}
.samples button small {
  display: block;
  font-weight: 400;
  font-size: 0.68rem;
  color: var(--scan-muted);
  margin-top: 0.15rem;
}
.samples button,
.tabs button {
  background: transparent;
  border: 1px solid var(--scan-rule);
  color: var(--scan-muted);
}
.samples button:disabled {
  opacity: 0.5;
  cursor: default;
}
.panel {
  border-top: 1px solid var(--scan-rule);
  padding-top: 1.25rem;
  display: grid;
  gap: 0.75rem;
}
.panel h2 {
  font: 600 1.5rem/1.1 var(--scan-display);
  letter-spacing: -0.02em;
  margin: 0;
  border: 0;
  padding: 0;
}
.run {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
}
.check {
  font: 500 0.8125rem var(--scan-mono);
  color: var(--scan-muted);
}
.primary {
  background: var(--scan-accent);
  color: var(--scan-paper);
  border: 0;
  font-weight: 600;
}
.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.ghost {
  background: transparent;
  color: var(--scan-ink);
  border: 1px solid var(--scan-rule);
}
.progress {
  display: grid;
  gap: 0.4rem;
}
.bar {
  height: 6px;
  background: var(--scan-track);
  border-radius: 3px;
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--scan-accent);
  transition: width 200ms ease;
}
.err {
  color: var(--scan-est);
  font: 500 0.875rem/1.5 var(--scan-mono);
  margin: 0;
}
.scan-note {
  color: var(--scan-muted);
  font: 400 0.8125rem/1.6 var(--scan-mono);
  margin: 0;
}
.tablewrap {
  border: 1px solid var(--scan-rule);
  background: var(--scan-panel);
  border-radius: 3px;
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font: 400 0.8125rem var(--scan-mono);
  font-variant-numeric: tabular-nums;
}
th,
td {
  padding: 0.55rem 0.6rem;
  border-top: 1px solid var(--scan-rule);
  text-align: right;
  white-space: nowrap;
}
th:first-child,
td:first-child,
tbody td:nth-child(2):not(:last-child) {
  text-align: left;
}
tbody tr {
  cursor: pointer;
}
tbody tr:hover {
  background: var(--scan-accent-soft);
}
tbody tr.sel {
  box-shadow: inset 2px 0 0 var(--scan-accent);
}
thead th {
  border-top: 0;
  color: var(--scan-muted);
  font-weight: 500;
}
.muted {
  color: var(--scan-muted);
}
.ok {
  color: var(--scan-exact);
}
.no {
  color: var(--scan-muted);
}
.cnote {
  display: block;
  color: var(--scan-est);
  font-size: 0.72rem;
  white-space: normal;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.tabs button[aria-selected="true"] {
  background: var(--scan-ink);
  color: var(--scan-paper);
  border-color: var(--scan-ink);
}
.compare {
  position: relative;
  aspect-ratio: 4 / 3;
  max-height: 70vh;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--scan-rule);
  border-radius: 3px;
  background: var(--scan-track);
}
.compare img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.cmp-top {
  clip-path: inset(0 calc(100% - var(--split)) 0 0);
}
.cmp-line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--split);
  width: 2px;
  background: var(--scan-accent);
}
.range {
  width: 100%;
}
.foot {
  border-top: 1px solid var(--scan-rule);
  padding-top: 1rem;
}
</style>
