import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from "vue";

/** Rendered width in CSS px of an element, kept live. SSR and first paint use `fallback`. */
export function useWidth(el: Ref<HTMLElement | null>, fallback = 640): Ref<number> {
  const width = ref(fallback);
  let ro: ResizeObserver | null = null;
  const measure = () => {
    const w = el.value?.clientWidth ?? 0;
    if (w > 0) width.value = Math.floor(w);
  };
  onMounted(() => {
    measure();
    if (typeof ResizeObserver !== "undefined" && el.value) {
      ro = new ResizeObserver(measure);
      ro.observe(el.value);
    } else {
      window.addEventListener("resize", measure);
    }
  });
  onBeforeUnmount(() => {
    ro?.disconnect();
    window.removeEventListener("resize", measure);
  });
  return width;
}

/**
 * One tab stop per chart (roving focus). Arrow keys move through the items in array order,
 * Home and End jump to the ends, Escape leaves the chart. Hover and focus both drive `shown`.
 */
export function useRoving(count: ComputedRef<number> | (() => number)) {
  const n = () => (typeof count === "function" ? count() : count.value);
  const current = ref(0);
  const focused = ref<number | null>(null);
  const hovered = ref<number | null>(null);
  const shown = computed<number | null>(() => hovered.value ?? focused.value);
  const nodes: (Element | null)[] = [];

  const setNode = (i: number) => (el: unknown) => {
    nodes[i] = (el as Element | null) ?? null;
  };
  const focusAt = (i: number) => {
    const total = n();
    if (!total) return;
    const j = ((i % total) + total) % total;
    current.value = j;
    (nodes[j] as HTMLElement | SVGElement | null)?.focus();
  };
  const onKeydown = (e: KeyboardEvent, i: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        focusAt(i + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        focusAt(i - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(n() - 1);
        break;
      case "Escape":
        (e.currentTarget as HTMLElement | SVGElement | null)?.blur();
        focused.value = null;
        break;
    }
  };

  return {
    current,
    focused,
    hovered,
    shown,
    setNode,
    focusAt,
    onKeydown,
    onFocus: (i: number) => {
      current.value = i;
      focused.value = i;
    },
    onBlur: (i: number) => {
      if (focused.value === i) focused.value = null;
    },
    onEnter: (i: number) => {
      hovered.value = i;
    },
    onLeave: (i: number) => {
      if (hovered.value === i) hovered.value = null;
    },
  };
}
