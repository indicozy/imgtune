// Main-thread side of the WASM: each module is fetched and compiled once per page, then handed to the workers as a
// WebAssembly.Module (structured-cloneable), so no worker recompiles. The HTTP cache serves the bytes after the first fetch.
import { WASM, type WasmKey } from "./wasm-urls";

const compiled = new Map<string, Promise<WebAssembly.Module>>();

export function wasmModule(url: string): Promise<WebAssembly.Module> {
  let p = compiled.get(url);
  if (!p) {
    p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`could not load ${url.split("/").pop()} (${res.status})`);
      return WebAssembly.compileStreaming(res);
    });
    // A failed fetch or compile is not kept, so the next run tries again.
    p.catch(() => compiled.delete(url));
    compiled.set(url, p);
  }
  return p;
}

/** The modules one candidate kind needs, keyed by logical name. */
export async function modulesFor(kind: "quality" | "resize" | "webp" | "avif", useSimd: boolean): Promise<Partial<Record<WasmKey, WebAssembly.Module>>> {
  const keys: WasmKey[] = ["ssim", "resize"];
  if (kind === "webp") keys.push("webp");
  else if (kind === "avif") keys.push("avif");
  else keys.push("mozjpeg");
  const urls: Record<WasmKey, string> = { mozjpeg: WASM.mozjpeg, webp: useSimd ? WASM.webpSimd : WASM.webp, avif: WASM.avif, resize: WASM.resize, ssim: WASM.ssim };
  const mods = await Promise.all(keys.map((k) => wasmModule(urls[k])));
  return Object.fromEntries(keys.map((k, i) => [k, mods[i]])) as Partial<Record<WasmKey, WebAssembly.Module>>;
}
