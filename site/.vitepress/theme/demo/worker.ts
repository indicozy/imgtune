/// <reference lib="webworker" />
// The demo's engine. Runs in a module worker so the page stays responsive. Nothing here sends bytes anywhere: the file
// is read from the drop, encoded with WASM codecs, decoded again by the browser and scored with ImgTune's SSIMULACRA2.
//
// Pipeline for one file and its needed widths (device pixels):
//   decode (createImageBitmap, flattened on white) -> resize to each width (jSquash lanczos3, sRGB, no linear light)
//   -> encode (JPEG 90 resized, JPEG 75 at the file's size, WebP 75, AVIF 50) -> decode (browser) -> SSIMULACRA2.
// Codecs are loaded on the first run only, so a visitor who never drops a file downloads none of them.

import jpegEncode, { init as initJpegEncoder } from "@jsquash/jpeg/encode";
import webpEncode, { init as initWebpEncoder } from "@jsquash/webp/encode";
import avifEncode, { init as initAvifEncoder } from "@jsquash/avif/encode";
import resize, { initResize } from "@jsquash/resize";
import { simd, threads } from "wasm-feature-detect";
import mozjpegUrl from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url";
import webpUrl from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import webpSimdUrl from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";
import avifUrl from "@jsquash/avif/codec/enc/avif_enc.wasm?url";
import resizeUrl from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm?url";
import ssimUrl from "../ssim/ssim_wasm_bg.wasm?url";
import ssimInit, { score as ssimScore } from "../ssim/ssim_wasm.js";
import { MAX_SIDE, PASS_FLOOR, type Candidate, type RunRequest, type WorkerOut } from "./types";

const post = (msg: WorkerOut) => (self as unknown as Worker).postMessage(msg);

let codecsReady: Promise<{ avif: boolean; notes: string[] }> | null = null;

async function compile(url: string): Promise<WebAssembly.Module> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url.split("/").pop()} (${res.status})`);
  return WebAssembly.compile(await res.arrayBuffer());
}

/** Loads the encoders and the resizer, and the SSIMULACRA2 module, once. AVIF is skipped when threads are on. */
function loadCodecs(): Promise<{ avif: boolean; notes: string[] }> {
  if (!codecsReady) {
    codecsReady = (async () => {
      const notes: string[] = [];
      await initResize(resizeUrl);
      await initJpegEncoder(await compile(mozjpegUrl));
      const useSimd = await simd();
      await initWebpEncoder(await compile(useSimd ? webpSimdUrl : webpUrl));
      await ssimInit(ssimUrl);
      // The threaded AVIF build needs cross-origin isolation, which GitHub Pages cannot set. Only the single-thread
      // module is bundled, so AVIF is turned off if a browser reports threads; the other formats still run.
      let avif = false;
      if (await threads()) {
        notes.push("AVIF skipped: this browser would use the threaded AVIF build, which is not bundled");
      } else {
        await initAvifEncoder(await compile(avifUrl));
        avif = true;
      }
      return { avif, notes };
    })();
    codecsReady.catch(() => (codecsReady = null));
  }
  return codecsReady;
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
  step: () => void,
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
    step();
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
    step();
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

async function run(req: RunRequest): Promise<void> {
  const started = performance.now();
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

  const targets = [...new Set(req.targets.map((n) => Math.min(Math.max(1, Math.round(n)), w)))].sort((a, b) => a - b);
  // Steps: codecs (1), the file's own-size quality candidate (1), then three encodes per target width.
  const total = 2 + targets.length * 3;
  let done = 0;
  const step = (label: string) => post({ type: "progress", done: ++done, total, label });

  post({ type: "progress", done: 0, total, label: "loading codecs" });
  const codecs = await loadCodecs();
  step("codecs ready");

  const src = await toImageData(file, w, h);
  const candidates: Candidate[] = [];
  const notes: string[] = [...codecs.notes];

  // Quality only: the file's own size, JPEG 75. Shown once, it is the same for every width.
  candidates.push(await evaluate("quality", "JPEG 75, file size", w, src, file.size, src, () => step("JPEG 75, file size")));

  for (const width of targets) {
    const ref = width === w ? src : await resizeTo(src, width);
    const label = (name: string) => `${name} at ${width} px`;
    candidates.push(await evaluate("resize", label("JPEG 90, resized"), width, ref, file.size, ref, () => step(label("JPEG 90"))));
    candidates.push(await evaluate("webp", label("WebP 75"), width, ref, file.size, ref, () => step(label("WebP 75"))));
    if (codecs.avif && !req.skipAvif) {
      candidates.push(await evaluate("avif", label("AVIF 50"), width, ref, file.size, ref, () => step(label("AVIF 50"))));
    } else {
      step(label("AVIF skipped"));
      candidates.push({ key: `${width}:avif`, width, id: "avif", label: label("AVIF 50"), bytes: null, score: null, pass: false, blob: null, ms: 0, note: req.skipAvif ? "skipped" : "not available in this browser" });
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

  post({
    type: "done",
    file: { name: file.name, type: file.type, bytes: file.size, width: w, height: h },
    candidates: candidates.map((c) => ({ ...c })),
    totalMs: Math.round(performance.now() - started),
    notes,
  });
}

self.onmessage = (ev: MessageEvent<RunRequest>) => {
  if (ev.data?.type !== "run") return;
  run(ev.data).catch((err) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
};
