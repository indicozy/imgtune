/// <reference lib="webworker" />
// The demo's engine. Each task runs in a fresh module worker (started by client.ts) so the page stays responsive and
// the WASM memory of one step is released before the next. Nothing here sends bytes anywhere: the file
// is read from the drop, encoded with WASM codecs, decoded again by the browser and scored with ImgTune's SSIMULACRA2.
//
// Pipeline for one file and its needed widths (device pixels):
//   decode (createImageBitmap, flattened on white) -> resize to each width (jSquash lanczos3, sRGB, no linear light)
//   -> encode (JPEG 90 resized, JPEG 75 at the file's size, WebP 75, AVIF 50) -> decode (browser) -> SSIMULACRA2.
// Each candidate runs in its own worker (see client.ts) and loads only the codec it needs. The browser's HTTP cache
// serves the WASM after the first fetch, and a visitor who never drops a file downloads none of them.

import jpegEncode, { init as initJpegEncoder } from "@jsquash/jpeg/encode";
import webpEncode, { init as initWebpEncoder } from "@jsquash/webp/encode";
import avifEncode, { init as initAvifEncoder } from "@jsquash/avif/encode";
import resize, { initResize } from "@jsquash/resize";
import { simd, threads } from "wasm-feature-detect";
import { WASM, type WasmKey } from "./wasm-urls";
import ssimInit, { score as ssimScore } from "../ssim/ssim_wasm.js";
import { MAX_SIDE, PASS_FLOOR, type Candidate, type TaskRequest, type WorkerOut } from "./types";

const post = (msg: WorkerOut) => (self as unknown as Worker).postMessage(msg);

/** Instantiates the SSIMULACRA2 module and, for this candidate only, the codec and resizer it needs. AVIF is off when threads are on. */
async function loadFor(kind: TaskRequest["kind"], needResize: boolean, notes: string[], mods: TaskRequest["modules"]): Promise<{ avif: boolean }> {
  const get = (key: WasmKey, url: string) => (mods[key] ? Promise.resolve(mods[key]) : compile(url));
  await ssimInit({ module_or_path: await get("ssim", WASM.ssim) });
  if (needResize) await initResize(await get("resize", WASM.resize));
  if (kind === "quality" || kind === "resize") {
    await initJpegEncoder(await get("mozjpeg", WASM.mozjpeg));
  } else if (kind === "webp") {
    const useSimd = await simd();
    await initWebpEncoder(await get("webp", useSimd ? WASM.webpSimd : WASM.webp));
  } else {
    // The threaded AVIF build needs cross-origin isolation, which GitHub Pages cannot set. Only the single-thread
    // module is bundled, so AVIF is turned off if a browser reports threads; the other formats still run.
    if (await threads()) {
      notes.push("AVIF skipped: this browser would use the threaded AVIF build, which is not bundled");
      return { avif: false };
    }
    await initAvifEncoder(await get("avif", WASM.avif));
  }
  return { avif: true };
}

async function compile(url: string): Promise<WebAssembly.Module> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url.split("/").pop()} (${res.status})`);
  return WebAssembly.compile(await res.arrayBuffer());
}

/** Decodes a file to opaque RGBA (flattened on white, as the CLI's score does). */
async function toImageData(source: Blob, w: number, h: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(source);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return ctx.getImageData(0, 0, w, h);
}

async function decodeCandidate(blob: Blob, w: number, h: number): Promise<ImageData | null> {
  try {
    return await toImageData(blob, w, h);
  } catch {
    return null;
  }
}

function resizeTo(src: ImageData, width: number): Promise<ImageData> {
  const height = Math.max(1, Math.round((src.height * width) / src.width));
  return resize(src, { width, height, method: "lanczos3", fitMethod: "stretch", premultiply: false, linearRGB: false });
}

async function encodeAs(id: Candidate["id"], data: ImageData): Promise<Blob> {
  if (id === "webp") {
    return new Blob([await webpEncode(data, { quality: 75 })], { type: "image/webp" });
  }
  if (id === "avif") {
    return new Blob([await avifEncode(data, { quality: 50 })], { type: "image/avif" });
  }
  return new Blob([await jpegEncode(data, { quality: id === "resize" ? 90 : 75 })], { type: "image/jpeg" });
}

async function evaluate(
  id: Candidate["id"],
  label: string,
  width: number,
  ref: ImageData,
  fileBytes: number,
  encodeInput: ImageData,
): Promise<Candidate> {
  const t0 = performance.now();
  const key = `${width}:${id}`;
  try {
    const blob = await encodeAs(id, encodeInput);
    const decoded = await decodeCandidate(blob, ref.width, ref.height);
    let s: number | null = null;
    if (decoded) {
      s = ssimScore(ref.width, ref.height, new Uint8Array(ref.data.buffer), new Uint8Array(decoded.data.buffer));
    }
    return {
      key,
      width,
      id,
      label,
      bytes: blob.size,
      score: s,
      pass: s !== null && s >= PASS_FLOOR,
      blob,
      ms: Math.round(performance.now() - t0),
      note: decoded ? undefined : "this browser cannot decode the result, so it is not scored",
    };
  } catch (err) {
    return {
      key,
      width,
      id,
      label,
      bytes: null,
      score: null,
      pass: false,
      blob: null,
      ms: Math.round(performance.now() - t0),
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One candidate: decodes the file, makes the candidate (or the file-size one), and reports it. */
async function runTask(req: TaskRequest): Promise<void> {
  const { file } = req;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    post({ type: "error", message: "This browser cannot read this file. Try a JPEG, PNG or WebP." });
    return;
  }
  const { width: w, height: h } = bitmap;
  bitmap.close();
  if (Math.max(w, h) > MAX_SIDE) {
    post({ type: "error", message: `This image is ${w} x ${h} px. The demo works up to ${MAX_SIDE} px on the long side; scale it down and drop it again.` });
    return;
  }

  const notes: string[] = [];
  const candidates: Candidate[] = [];
  const src = await toImageData(file, w, h);

  if (req.kind === "quality") {
    // JPEG 75, shown once. At the file's own size it is the file-size candidate; when the file is bigger than the
    // largest needed width, it is scored at that width to bound memory.
    const qw = Math.min(w, Math.max(1, Math.round(req.capWidth)));
    await loadFor("quality", qw < w, notes, req.modules);
    if (qw === w) {
      candidates.push(await evaluate("quality", "JPEG 75, file size", w, src, file.size, src));
    } else {
      const ref = await resizeTo(src, qw);
      const label = `JPEG 75 at ${qw} px (file is ${w})`;
      const q = await evaluate("quality", label, qw, ref, file.size, ref);
      candidates.push({ ...q, note: q.note ?? `scored at ${qw} px, not the file's ${w} px, so the bytes are not the file's size` });
    }
  } else {
    const width = Math.min(Math.max(1, Math.round(req.width)), w);
    const needResize = width !== w;
    const label = (name: string) => `${name} at ${width} px`;
    const notMade = (note: string) => ({ key: `${width}:avif`, width, id: "avif" as const, label: label("AVIF 50"), bytes: null, score: null, pass: false, blob: null, ms: 0, note });
    if (req.kind === "avif" && req.skipAvif) {
      candidates.push(notMade("skipped"));
    } else {
      const ready = await loadFor(req.kind, needResize, notes, req.modules);
      const ref = needResize ? await resizeTo(src, width) : src;
      if (req.kind === "resize") candidates.push(await evaluate("resize", label("JPEG 90, resized"), width, ref, file.size, ref));
      else if (req.kind === "webp") candidates.push(await evaluate("webp", label("WebP 75"), width, ref, file.size, ref));
      else if (ready.avif) candidates.push(await evaluate("avif", label("AVIF 50"), width, ref, file.size, ref));
      else candidates.push(notMade("not available in this browser"));
    }
  }

  post({ type: "task-done", imageW: w, imageH: h, candidates: candidates.map((c) => ({ ...c })), notes });
}

self.onmessage = (ev: MessageEvent<TaskRequest>) => {
  if (ev.data?.type !== "task") return;
  runTask(ev.data).catch((err) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
};
