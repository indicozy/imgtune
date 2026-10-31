/**
 * Opt-in timing and counts for a scan (`IMGTUNE_TIMING=1`). Off by default: every call is then a plain call, and nothing
 * is printed. Labels nest (an encode runs inside a quality estimate), so the phase totals are not additive; each label is
 * the wall time spent inside that step, summed over the scan.
 */

interface PhaseTotal {
  ms: number;
  calls: number;
}

const phases = new Map<string, PhaseTotal>();
const counters = new Map<string, number>();

export const TIMING_ENABLED = process.env.IMGTUNE_TIMING === "1";

function add(label: string, ms: number): void {
  const total = phases.get(label) ?? { ms: 0, calls: 0 };
  total.ms += ms;
  total.calls++;
  phases.set(label, total);
}

/** Runs `fn` and adds its wall time under `label`. Awaits a returned promise before the time is taken. */
export function measure<T>(label: string, fn: () => T): T {
  if (!TIMING_ENABLED) return fn();
  const start = performance.now();
  const result = fn();
  if (result instanceof Promise) {
    return result.finally(() => add(label, performance.now() - start)) as T;
  }
  add(label, performance.now() - start);
  return result;
}

/** Adds `by` to the count under `name`. */
export function count(name: string, by = 1): void {
  if (!TIMING_ENABLED) return;
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/** Current counts, for tests and the report. */
export function timingCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

/** Current phase totals in milliseconds, for tests and the report. */
export function timingPhases(): Record<string, { ms: number; calls: number }> {
  return Object.fromEntries([...phases].map(([label, t]) => [label, { ms: t.ms, calls: t.calls }]));
}

/** Forgets every phase and count. */
export function resetTiming(): void {
  phases.clear();
  counters.clear();
}

/** The report lines: phases by wall time, then counts. Empty when timing is off. */
export function renderTiming(): string[] {
  if (!TIMING_ENABLED) return [];
  const lines = ["imgtune timing (ms, summed over the scan; nested steps overlap their parents):"];
  const sorted = [...phases].sort((a, b) => b[1].ms - a[1].ms);
  for (const [label, t] of sorted) {
    lines.push(`  ${label.padEnd(34)} ${t.ms.toFixed(0).padStart(9)} ms  ${String(t.calls).padStart(7)} calls`);
  }
  lines.push("imgtune counts:");
  for (const [name, n] of [...counters].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${name.padEnd(34)} ${String(n).padStart(9)}`);
  }
  return lines;
}
