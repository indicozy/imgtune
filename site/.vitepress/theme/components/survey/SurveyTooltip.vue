<script setup lang="ts">
import { computed } from "vue";

// Shown for the hovered or focused mark. Text goes through interpolation, so it is escaped.
const props = defineProps<{
  x: number;
  y: number;
  boxW: number;
  title: string;
  rows: { value: string; label: string }[];
}>();

const tipW = computed(() => Math.min(240, props.boxW - 8));
const left = computed(() => {
  const half = tipW.value / 2;
  return Math.min(Math.max(props.x, half), props.boxW - half);
});
const below = computed(() => props.y < 120);
const style = computed(() => ({
  left: `${left.value}px`,
  top: `${props.y}px`,
  width: `${tipW.value}px`,
}));
</script>

<template>
  <div class="tip" :class="{ below }" :style="style" aria-hidden="true">
    <p class="tip-title">{{ title }}</p>
    <dl>
      <div v-for="r in rows" :key="r.label" class="row">
        <dt>{{ r.label }}</dt>
        <dd>{{ r.value }}</dd>
      </div>
    </dl>
  </div>
</template>

<style scoped>
.tip {
  position: absolute;
  transform: translate(-50%, calc(-100% - 14px));
  pointer-events: none;
  z-index: 2;
  background: var(--scan-panel);
  color: var(--scan-ink);
  border: 1px solid var(--scan-rule);
  border-radius: 4px;
  padding: 0.5rem 0.6rem;
  font: 400 0.8125rem/1.4 var(--scan-sans);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
}
.tip.below {
  transform: translate(-50%, 16px);
}
.tip-title {
  margin: 0 0 0.3rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}
dl {
  margin: 0;
  display: grid;
  gap: 0.1rem;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}
dt {
  color: var(--scan-muted);
}
dd {
  margin: 0;
  font-family: var(--scan-mono);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
