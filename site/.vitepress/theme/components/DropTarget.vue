<script setup lang="ts">
import { ref } from "vue";
import { useRouter, withBase } from "vitepress";
import { setPendingFile } from "../demo/pending";

// The homepage's drop target. A dropped file is handed to /demo in this session and the demo runs there.
// Nothing is read or uploaded here.
const router = useRouter();
const over = ref(false);
const input = ref<HTMLInputElement | null>(null);
const note = ref("");

function open(file: File | undefined) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    note.value = "That file is not an image. Drop a JPEG, PNG, WebP or AVIF.";
    return;
  }
  setPendingFile(file);
  router.go(withBase("/demo"));
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  over.value = false;
  open(e.dataTransfer?.files?.[0]);
}

function onPick(e: Event) {
  open((e.target as HTMLInputElement).files?.[0]);
}
</script>

<template>
  <div
    class="drop"
    :class="{ over }"
    role="button"
    tabindex="0"
    aria-label="Drop an image to check it in the demo"
    @click="input?.click()"
    @keydown.enter.prevent="input?.click()"
    @keydown.space.prevent="input?.click()"
    @dragenter.prevent="over = true"
    @dragover.prevent="over = true"
    @dragleave.prevent="over = false"
    @drop="onDrop"
  >
    <div class="title"><span>DROP TARGET</span><span>opens the demo</span></div>
    <p class="big">Drop an image. See what it weighs at every width it is shown.</p>
    <p class="hint">Runs in this browser. The file is never uploaded. Click to choose one.</p>
    <p v-if="note" class="hint err">{{ note }}</p>
    <input ref="input" type="file" accept="image/*" class="hidden" @change="onPick" @click.stop />
  </div>
</template>

<style scoped>
.drop {
  position: relative;
  border: 1px dashed var(--scan-accent);
  background: var(--scan-panel);
  border-radius: 4px;
  padding: 1.25rem;
  cursor: pointer;
  display: grid;
  gap: 0.9rem;
  min-height: 19rem;
  align-content: start;
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
.title {
  font: 600 0.8125rem var(--scan-mono);
  color: var(--scan-accent);
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}
.big {
  font: 600 1.875rem/1.05 var(--scan-display);
  letter-spacing: -0.015em;
  margin: 0;
  color: var(--scan-ink);
}
.hint {
  font: 400 0.8125rem/1.6 var(--scan-mono);
  color: var(--scan-muted);
  margin: 0;
}
.err {
  color: var(--scan-est);
}
.hidden {
  display: none;
}
</style>
