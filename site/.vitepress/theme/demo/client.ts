// Main-thread side of the demo: starts one worker per run, reports progress, and can cancel by terminating it.
import type { RunRequest, WorkerOut } from "./types";

export interface Run {
  promise: Promise<Extract<WorkerOut, { type: "done" }>>;
  cancel: () => void;
}

export function startRun(
  req: Omit<RunRequest, "type">,
  onProgress: (done: number, total: number, label: string) => void,
): Run {
  // Created here, with a literal URL, so the bundler emits the worker and its codecs.
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let cancelled = false;
  const promise = new Promise<Extract<WorkerOut, { type: "done" }>>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const msg = ev.data;
      if (msg.type === "progress") onProgress(msg.done, msg.total, msg.label);
      else if (msg.type === "done") {
        worker.terminate();
        resolve(msg);
      } else {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(cancelled ? "cancelled" : ev.message || "the worker failed"));
    };
    worker.postMessage({ type: "run", ...req } satisfies RunRequest);
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      worker.terminate();
    },
  };
}
