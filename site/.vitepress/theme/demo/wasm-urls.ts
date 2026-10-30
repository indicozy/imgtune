// The codec and scorer WASM, as emitted asset URLs. Shared by the page (which compiles each module once) and the worker.
import mozjpegUrl from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url";
import webpUrl from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import webpSimdUrl from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";
import avifUrl from "@jsquash/avif/codec/enc/avif_enc.wasm?url";
import resizeUrl from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm?url";
import ssimUrl from "../ssim/ssim_wasm_bg.wasm?url";

export const WASM = { mozjpeg: mozjpegUrl, webp: webpUrl, webpSimd: webpSimdUrl, avif: avifUrl, resize: resizeUrl, ssim: ssimUrl };
/** Logical module names. "webp" is the SIMD or plain build, chosen by the page. */
export type WasmKey = "mozjpeg" | "webp" | "avif" | "resize" | "ssim";
