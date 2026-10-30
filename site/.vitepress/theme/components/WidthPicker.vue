<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { PRESETS, VIEWPORTS, neededPx, presetWidth, sizesWidth, type PresetId, type WidthRow } from "../lib/layout";

// Layout presets or a `sizes` value, turned into device pixels at the CLI's six viewports.
// `fileWidth` (optional) caps the needed pixels at what the file has, as the CLI does.
const props = defineProps<{ fileWidth?: number }>();
const emit = defineEmits<{
  (e: "update", value: { rows: WidthRow[]; targets: number[]; error: string | null }): void;
}>();

const preset = ref<PresetId | "">("hero");
const sizes = ref("");

const rows = computed<WidthRow[]>(() => {
  return VIEWPORTS.map((v) => {
    if (sizes.value.trim()) {
      const r = sizesWidth(sizes.value, v.width);
      if (r.px === null) return { name: v.name, vw: v.width, dpr: v.dpr, css: null, needed: null, capped: false };
      const need = Math.ceil(r.px * v.dpr);
      const capped = props.fileWidth !== undefined && need > props.fileWidth;
      return { name: v.name, vw: v.width, dpr: v.dpr, css: r.px, needed: props.fileWidth !== undefined ? neededPx(r.px, v.dpr, props.fileWidth) : need, capped };
    }
    const css = presetWidth(preset.value || "hero", v.width);
    const need = Math.ceil(css * v.dpr);
    const capped = props.fileWidth !== undefined && need > props.fileWidth;
    return { name: v.name, vw: v.width, dpr: v.dpr, css, needed: props.fileWidth !== undefined ? neededPx(css, v.dpr, props.fileWidth) : need, capped };
  });
});

const error = computed(() => {
  if (!sizes.value.trim()) return null;
  const bad = VIEWPORTS.map((v) => sizesWidth(sizes.value, v.width)).find((r) => r.px === null);
  return bad ? bad.error ?? "the sizes value cannot be read" : null;
});

watch(
  [rows, error],
  () => {
    const targets = [...new Set(rows.value.map((r) => r.needed).filter((n): n is number => n !== null))].sort((a, b) => a - b);
    emit("update", { rows: rows.value, targets, error: error.value });
  },
  { immediate: true },
);

function pick(id: PresetId) {
  sizes.value = "";
  preset.value = id;
}

watch(sizes, (v) => {
  if (v.trim()) preset.value = "";
});
</script>

<template>
  <div class="wp">
    <div class="wp-left">
      <div class="presets" role="group" aria-label="Layout preset">
        <button
          v-for="p in PRESETS"
          :key="p.id"
          type="button"
          :aria-pressed="preset === p.id && !sizes.trim() ? 'true' : 'false'"
          @click="pick(p.id)"
        >
          {{ p.label }}<small>{{ p.note }}</small>
        </button>
      </div>
      <label class="sizes">
        or paste a <span>sizes</span> value
        <input v-model="sizes" type="text" placeholder="(min-width: 1024px) 50vw, 100vw" aria-label="sizes attribute" spellcheck="false" />
      </label>
      <p v-if="error" class="scan-note err">{{ error }}</p>
    </div>
    <div class="vp">
      <table>
        <thead>
          <tr>
            <th>viewport</th>
            <th>css px</th>
            <th>dpr</th>
            <th>needed px</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.name">
            <td>{{ r.name }}</td>
            <td>{{ r.css === null ? "n/a" : Math.round(r.css) }}</td>
            <td>{{ r.dpr }}x</td>
            <td :class="{ capped: r.capped }">{{ r.needed === null ? "n/a" : r.needed }}<span v-if="r.capped" class="cap-note"> (file max)</span></td>
          </tr>
        </tbody>
      </table>
      <div class="cap">
        Needed px = CSS width x dpr, rounded up. Viewports and dpr are the CLI's six.
        <span v-if="fileWidth !== undefined">Capped at the file's {{ fileWidth }} px.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wp {
  display: grid;
  gap: 1.25rem;
}
.presets {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.5rem;
}
.presets button {
  text-align: left;
  background: var(--scan-panel);
  border: 1px solid var(--scan-rule);
  border-radius: 3px;
  padding: 0.75rem;
  cursor: pointer;
  font: 500 0.8125rem/1.3 var(--scan-mono);
  color: var(--scan-muted);
}
.presets button[aria-pressed="true"] {
  border-color: var(--scan-accent);
  color: var(--scan-ink);
  box-shadow: inset 2px 0 0 var(--scan-accent);
}
.presets button small {
  display: block;
  font-weight: 400;
  color: var(--scan-muted);
  margin-top: 0.2rem;
}
.sizes {
  display: block;
  margin-top: 1rem;
  font: 500 0.8125rem var(--scan-mono);
  color: var(--scan-muted);
}
.sizes input {
  margin-top: 0.4rem;
  display: block;
  width: 100%;
  border: 1px solid var(--scan-rule);
  background: var(--scan-panel);
  border-radius: 3px;
  padding: 0.55rem 0.6rem;
  font: 400 0.8125rem var(--scan-mono);
  color: var(--scan-ink);
}
.sizes span {
  color: var(--scan-ink);
}
.err {
  color: var(--scan-est);
  margin-top: 0.5rem;
}
.vp {
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
  padding: 0.55rem 0.7rem;
  border-top: 1px solid var(--scan-rule);
  text-align: right;
  white-space: nowrap;
}
th:first-child,
td:first-child {
  text-align: left;
}
thead th {
  border-top: 0;
  color: var(--scan-muted);
  font-weight: 500;
}
.capped {
  color: var(--scan-est);
}
.cap-note {
  color: var(--scan-muted);
  font-size: 0.7rem;
}
.cap {
  padding: 0.6rem 0.7rem;
  color: var(--scan-muted);
  font: 400 0.75rem/1.5 var(--scan-mono);
  border-top: 1px solid var(--scan-rule);
}
</style>
