// Main-thread side of the demo: runs one fresh worker per candidate (the file-size candidate, then resize, WebP and
// AVIF at each needed width), reports progress, assembles the result and can cancel the task in flight.
import { simd } from "wasm-feature-detect";
import type { Candidate, FileInfo, RunRequest, TaskRequest, WorkerOut } from "./types";
import { modulesFor } from "./modules";

export interface Run {
  promise: Promise<Extract<WorkerOut, { type: "done" }>>;
  cancel: () => void;
}

type TaskDone = Extract<WorkerOut, { type: "task-done" }>;

export function startRun(
  req: Omit<RunRequest, "type">,
  onProgress: (done: number, total: number, label: string) => void,
): Run {
  let cancelled = false;
  let worker: Worker | null = null;
  let rejectTask: ((err: Error) => void) | null = null;
  let done = 0;
  let total = 1; // Provisional until the image's width is known: the file-size candidate.

  // One worker per candidate: terminated when its result (or failure) arrives, so its WASM memory is released.
  function runTask(kind: TaskRequest["kind"], width: number, capWidth: number): Promise<TaskDone> {
    return new Promise<TaskDone>((resolve, reject) => {
      rejectTask = reject;
      // The modules are compiled on the page once, then passed in, so the worker only instantiates them.
      simd()
        .then((useSimd) => modulesFor(kind, useSimd))
        .then((modules) => {
          if (cancelled) throw new Error("cancelled");
          // Created here, with a literal URL, so the bundler emits the worker and its codecs.
          const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
          worker = w;
          const finish = () => {
            w.terminate();
            worker = null;
            rejectTask = null;
          };
          w.onmessage = (ev: MessageEvent<WorkerOut>) => {
            const msg = ev.data;
            if (msg.type === "task-done") {
              finish();
              resolve(msg);
            } else {
              finish();
              reject(new Error(msg.type === "error" ? msg.message : "unexpected worker message"));
            }
          };
          w.onerror = (ev) => {
            finish();
            reject(new Error(cancelled ? "cancelled" : ev.message || "the worker failed"));
          };
          w.postMessage({ type: "task", file: req.file, kind, width, capWidth, modules, skipAvif: req.skipAvif } satisfies TaskRequest);
        })
        .catch(reject);
    });
  }

  const promise = (async () => {
    const started = performance.now();
    onProgress(0, total, "starting");
    const cap = Math.max(1, ...req.targets);
    const quality = await runTask("quality", 0, cap);
    done += 1;
    onProgress(done, total, "JPEG 75, file size");

    const targets = [...new Set(req.targets.map((n) => Math.min(Math.max(1, Math.round(n)), quality.imageW)))].sort((a, b) => a - b);
    total = 1 + targets.length * 3;

    const candidates: Candidate[] = [...quality.candidates];
    const notes: string[] = [];
    const addNotes = (list: string[]) => list.forEach((n) => notes.includes(n) || notes.push(n));
    addNotes(quality.notes);
    for (const width of targets) {
      for (const kind of ["resize", "webp", "avif"] as const) {
        const res = await runTask(kind, width, cap);
        candidates.push(...res.candidates);
        addNotes(res.notes);
        done += 1;
        onProgress(done, total, `${kind} at ${width} px`);
      }
    }

    // Combined: the smallest passing candidate at each width (resize, WebP or AVIF).
    for (const width of targets) {
      const passing = candidates.filter((c) => c.width === width && c.id !== "quality" && c.pass && c.bytes !== null);
      const best = passing.sort((a, b) => (a.bytes as number) - (b.bytes as number))[0];
      if (best) {
        candidates.push({ ...best, key: `${width}:combined`, id: "combined", label: `best passing at ${width} px (${best.label.split(" at ")[0]})` });
      } else {
        candidates.push({ key: `${width}:combined`, width, id: "combined", label: `best passing at ${width} px`, bytes: null, score: null, pass: false, blob: null, ms: 0, note: "no candidate passes at this width" });
      }
    }

    const file: FileInfo = { name: req.file.name, type: req.file.type, bytes: req.file.size, width: quality.imageW, height: quality.imageH };
    return {
      type: "done" as const,
      file,
      candidates: candidates.map((c) => ({ ...c })),
      totalMs: Math.round(performance.now() - started),
      notes,
    };
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      worker?.terminate();
      rejectTask?.(new Error("cancelled"));
    },
  };
}
