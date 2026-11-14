// 3D model analyzer: the model files a page loads (glTF, GLB, USDZ, KTX2, Draco, OBJ, FBX, splats, PLY). A glTF or GLB is
// parsed for its geometry, its textures and its extensions. The geometry saving is measured: the file is repacked and
// run through meshopt with gltf-transform (the same transform as `--compress meshopt`), so the bytes are real, not
// estimated. Each PNG or JPEG texture gets a WebP (q80) re-encode with sharp, an estimate for textures over 4 MP. Other
// formats are informational. It never throws.

import { createHash } from "node:crypto";
import type { Document } from "@gltf-transform/core";
import sharp from "sharp";
import { digestOf, heavyValue } from "./cache.js";
import type { PageContext, ResourceAnalyzer, ResourceFinding, ResourceRecord } from "./types.js";

const GLTF_EXTS = new Set(["glb", "gltf"]);
const OTHER_EXTS = new Set(["usdz", "ktx2", "drc", "obj", "fbx", "splat", "ply"]);
const MODEL_TYPES = /^model\//;

/** Geometry bigger than this is not run through meshopt within the budget; it is reported without a measured saving. */
export const MAX_MEASURED_GEOMETRY_BYTES = 12 * 1024 * 1024;
/** Textures over this many pixels are re-encoded at 2048 px on the long side and scaled up (an estimate). */
export const TEXTURE_FULL_PIXELS = 4_000_000;
/** The WebP quality the texture estimate is made at. */
export const TEXTURE_WEBP_QUALITY = 80;
/** Stop re-encoding textures once this much time has passed in one page view, in ms. */
const TEXTURE_BUDGET_MS = 4_000;
/** A saving is reported only when it is at least this much, absolutely and as a share of the bytes per view. */
const MIN_SAVING_BYTES = 5 * 1024;
const MIN_SAVING_SHARE = 0.05;

interface GltfBufferJson {
  byteLength: number;
  uri?: string;
}

interface GltfJson {
  extensionsUsed?: string[];
  buffers?: GltfBufferJson[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[];
  accessors?: { bufferView?: number }[];
  meshes?: {
    primitives?: {
      attributes?: Record<string, number>;
      indices?: number;
      targets?: Record<string, number>[];
    }[];
  }[];
  images?: { mimeType?: string; uri?: string; bufferView?: number }[];
  textures?: { source?: number }[];
  animations?: unknown[];
}

interface Parsed {
  json: GltfJson;
  /** The GLB BIN chunk, when the file is a GLB. */
  bin?: Buffer;
  /** Length of the JSON chunk (GLB) or of the whole file (glTF). */
  jsonBytes: number;
}

function hashUrl(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 12);
}

function extOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf(".");
    return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || "model";
  } catch {
    return "model";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Reads a GLB (container of a JSON chunk and a BIN chunk) or a glTF JSON document. Undefined when it is neither. */
export function parseGltf(body: Buffer): Parsed | undefined {
  try {
    if (body.length >= 20 && body.subarray(0, 4).toString("ascii") === "glTF") {
      const jsonLen = body.readUInt32LE(12);
      if (body.subarray(16, 20).toString("ascii") !== "JSON") return undefined;
      const json = JSON.parse(body.subarray(20, 20 + jsonLen).toString("utf8")) as GltfJson;
      let bin: Buffer | undefined;
      const binHead = 20 + jsonLen;
      if (binHead + 8 <= body.length && body.subarray(binHead + 4, binHead + 8).toString("ascii") === "BIN\0") {
        const binLen = body.readUInt32LE(binHead);
        bin = body.subarray(binHead + 8, binHead + 8 + binLen);
      }
      return { json, bin, jsonBytes: jsonLen };
    }
    const json = JSON.parse(body.toString("utf8")) as GltfJson;
    if (typeof json !== "object" || json === null || !("asset" in json)) return undefined;
    return { json, jsonBytes: body.length };
  } catch {
    return undefined;
  }
}

/** A data: URI's decoded bytes and the base64 overhead (encoded length minus decoded length), or undefined. */
function decodeDataUri(uri: string): { data: Buffer; mime: string; overhead: number } | undefined {
  if (!uri.startsWith("data:")) return undefined;
  const comma = uri.indexOf(",");
  if (comma < 0 || !/;base64$/i.test(uri.slice(0, comma))) return undefined;
  const data = Buffer.from(uri.slice(comma + 1), "base64");
  const mime = uri.slice(5, uri.indexOf(";") > 0 ? uri.indexOf(";") : comma).toLowerCase();
  return { data, mime, overhead: uri.length - comma - 1 - data.length };
}

/** The bytes of one glTF buffer, from the GLB BIN chunk or a data URI. Undefined for an external file. */
function bufferBytes(parsed: Parsed, index: number): Buffer | undefined {
  const b = parsed.json.buffers?.[index];
  if (!b) return undefined;
  if (b.uri === undefined) return index === 0 ? parsed.bin : undefined;
  return decodeDataUri(b.uri)?.data;
}

/** The bytes a bufferView covers. Undefined when its buffer is external or not in the file. */
function viewBytes(parsed: Parsed, viewIndex: number): Buffer | undefined {
  const view = parsed.json.bufferViews?.[viewIndex];
  if (!view) return undefined;
  const buf = bufferBytes(parsed, view.buffer);
  if (!buf) return undefined;
  const start = view.byteOffset ?? 0;
  return buf.subarray(start, start + view.byteLength);
}

/** The bufferViews the meshes read (vertex attributes, morph targets, indices). */
function geometryViews(json: GltfJson): Set<number> {
  const views = new Set<number>();
  const accessorViews = (accessor: number | undefined): void => {
    if (accessor === undefined) return;
    const view = json.accessors?.[accessor]?.bufferView;
    if (view !== undefined) views.add(view);
  };
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const acc of Object.values(prim.attributes ?? {})) accessorViews(acc);
      accessorViews(prim.indices);
      for (const target of prim.targets ?? []) for (const acc of Object.values(target)) accessorViews(acc);
    }
  }
  return views;
}

function sumViews(json: GltfJson, views: Set<number>): number {
  let total = 0;
  for (const v of views) total += json.bufferViews?.[v]?.byteLength ?? 0;
  return total;
}

interface TextureInfo {
  index: number;
  mime: string;
  bytes?: number;
  data?: Buffer;
}

/** The images the textures use, with their bytes when the file holds them. */
function textureImages(parsed: Parsed): TextureInfo[] {
  const out: TextureInfo[] = [];
  const images = parsed.json.images ?? [];
  images.forEach((img, index) => {
    if (img.bufferView !== undefined) {
      const data = viewBytes(parsed, img.bufferView);
      out.push({ index, mime: img.mimeType ?? "", bytes: data?.length, data });
      return;
    }
    if (img.uri !== undefined) {
      const decoded = decodeDataUri(img.uri);
      if (decoded) out.push({ index, mime: img.mimeType ?? decoded.mime, bytes: decoded.data.length, data: decoded.data });
      else out.push({ index, mime: img.mimeType ?? "" });
    }
  });
  return out;
}

/** The WebP (q80) size of a PNG or JPEG texture: measured at full size, or at 2048 px and scaled (an estimate). */
async function webpBytes(data: Buffer): Promise<{ bytes: number; estimate: boolean; width: number; height: number } | undefined> {
  const meta = await sharp(data, { limitInputPixels: 100_000_000 }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) return undefined;
  const pixels = width * height;
  if (pixels <= TEXTURE_FULL_PIXELS) {
    const out = await sharp(data, { limitInputPixels: 100_000_000 }).webp({ quality: TEXTURE_WEBP_QUALITY }).toBuffer();
    return { bytes: out.length, estimate: false, width, height };
  }
  const long = Math.max(width, height);
  const scale = 2048 / long;
  const small = await sharp(data, { limitInputPixels: 100_000_000 })
    .resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
    .webp({ quality: TEXTURE_WEBP_QUALITY })
    .toBuffer();
  const ratio = (Math.round(width * scale) * Math.round(height * scale)) / pixels;
  return { bytes: Math.round(small.length / ratio), estimate: true, width, height };
}

/** The packages the geometry measurement needs. They are optional dependencies: a missing one turns the measurement off. */
export interface GltfTools {
  Logger: typeof import("@gltf-transform/core").Logger;
  NodeIO: typeof import("@gltf-transform/core").NodeIO;
  EXTMeshoptCompression: typeof import("@gltf-transform/extensions").EXTMeshoptCompression;
  meshopt: typeof import("@gltf-transform/functions").meshopt;
  MeshoptEncoder: typeof import("meshoptimizer").MeshoptEncoder;
}

/** The note for a missing measurement package: what installing it adds (printed with the model findings). */
export const GLTF_NOTE = "install @gltf-transform/core, @gltf-transform/extensions, @gltf-transform/functions and meshoptimizer to measure 3D compression";

async function loadGltfPackages(): Promise<GltfTools> {
  const [core, extensions, functions, meshoptimizer] = await Promise.all([
    import("@gltf-transform/core"),
    import("@gltf-transform/extensions"),
    import("@gltf-transform/functions"),
    import("meshoptimizer"),
  ]);
  return { Logger: core.Logger, NodeIO: core.NodeIO, EXTMeshoptCompression: extensions.EXTMeshoptCompression, meshopt: functions.meshopt, MeshoptEncoder: meshoptimizer.MeshoptEncoder };
}

let gltfTools: Promise<GltfTools | undefined> | undefined;

/**
 * The measurement packages, loaded once (dynamic import, so a missing optional dependency costs nothing until a model is
 * seen). Undefined when one will not load. Never throws. `load` is the loader (tests pass a failing one).
 */
export function importGltfTools(load: () => Promise<GltfTools> = loadGltfPackages): Promise<GltfTools | undefined> {
  if (load !== loadGltfPackages) return load().then((tools) => tools, () => undefined);
  gltfTools ??= loadGltfPackages().then((tools) => tools, () => undefined);
  return gltfTools;
}

/** The outcome of the meshopt measurement: the sizes, or why there are none (the packages are missing, or the file did not read). */
export type MeshoptOutcome = { kind: "ok"; repackBytes: number; meshBytes: number } | { kind: "missing" } | { kind: "unreadable" };

/** The repacked (GLB) and meshopt-compressed sizes of a glTF, from gltf-transform (see MeshoptOutcome). Never throws. */
async function measureMeshopt(body: Buffer, parsed: Parsed): Promise<MeshoptOutcome> {
  const tools = await importGltfTools();
  if (tools === undefined) return { kind: "missing" };
  try {
    await tools.MeshoptEncoder.ready;
    const io = new tools.NodeIO()
      .setLogger(new tools.Logger(tools.Logger.Verbosity.ERROR))
      .registerExtensions([tools.EXTMeshoptCompression])
      .registerDependencies({ "meshopt.encoder": tools.MeshoptEncoder });
    let doc: Document;
    if (body.subarray(0, 4).toString("ascii") === "glTF") {
      doc = await io.readBinary(new Uint8Array(body));
    } else {
      doc = await io.readJSON({ json: parsed.json as never, resources: {} });
    }
    const repackBytes = (await io.writeBinary(doc)).byteLength;
    await doc.transform(tools.meshopt({ encoder: tools.MeshoptEncoder, level: "medium" }));
    const meshBytes = (await io.writeBinary(doc)).byteLength;
    return { kind: "ok", repackBytes, meshBytes };
  } catch {
    return { kind: "unreadable" };
  }
}

function displayBox(ctx: PageContext, url: string): { selector: string; width: number; height: number } | undefined {
  const el = ctx.models.find((m) => m.src === url);
  return el === undefined ? undefined : { selector: el.selector, width: el.width, height: el.height };
}

async function analyzeGltf(r: ResourceRecord, body: Buffer, ctx: PageContext): Promise<ResourceFinding[]> {
  const parsed = parseGltf(body);
  if (!parsed) return [];
  const name = fileName(r.url);
  const fmt = extOf(r.url) === "gltf" || !parsed.bin ? "glTF" : "GLB";
  const id = `model:${hashUrl(r.url)}`;
  const box = displayBox(ctx, r.url);
  const locator = box === undefined ? undefined : { selector: box.selector };
  const extensions = parsed.json.extensionsUsed ?? [];
  const compressed = extensions.includes("KHR_draco_mesh_compression") || extensions.includes("EXT_meshopt_compression");
  const geomViews = geometryViews(parsed.json);
  const geomBytes = sumViews(parsed.json, geomViews);
  const externalBuffers = (parsed.json.buffers ?? []).some((b, i) => b.uri !== undefined && bufferBytes(parsed, i) === undefined);
  const details: Record<string, unknown> = {
    format: fmt,
    extensionsUsed: extensions,
    geometryBytes: geomBytes,
    meshes: parsed.json.meshes?.length ?? 0,
    animations: parsed.json.animations?.length ?? 0,
    externalBuffers,
  };
  const findings: ResourceFinding[] = [];

  // Textures.
  const images = textureImages(parsed);
  const textures = parsed.json.textures?.length ?? 0;
  const texDetails: Record<string, unknown>[] = [];
  let texSaved = 0;
  let texBytes = 0;
  let texWebp = 0;
  const startedAt = Date.now();
  let unmeasured = 0;
  for (const img of images) {
    if (img.data === undefined || img.bytes === undefined) continue;
    texBytes += img.bytes;
    const isRaster = /^image\/(png|jpeg)$/.test(img.mime) || (img.mime === "" && /^\x89PNG|^\xff\xd8/.test(img.data.subarray(0, 8).toString("latin1")));
    if (!isRaster) continue;
    if (Date.now() - startedAt > TEXTURE_BUDGET_MS) {
      unmeasured++;
      continue;
    }
    try {
      const w = await webpBytes(img.data);
      if (w === undefined) continue;
      texWebp += w.bytes;
      texSaved += Math.max(0, img.bytes - w.bytes);
      texDetails.push({ image: img.index, mime: img.mime, bytes: img.bytes, width: w.width, height: w.height, webpBytes: w.bytes, estimate: w.estimate });
    } catch {
      unmeasured++;
    }
  }
  const longestTexture = Math.max(0, ...texDetails.map((t) => Math.max(Number(t.width), Number(t.height))));
  const resizeTo = box === undefined ? undefined : Math.max(box.width, box.height) * ctx.viewport.dpr;
  const texResize = resizeTo !== undefined && longestTexture > 2 * resizeTo;
  details.textures = textures;
  details.textureBytes = texBytes;
  details.textureDetails = texDetails;
  if (unmeasured > 0) details.texturesNotMeasured = unmeasured;

  if (texSaved >= MIN_SAVING_BYTES || (texResize && texBytes > 0)) {
    const fix = [`textures: npx @gltf-transform/cli optimize in.glb out.glb --texture-compress webp (WebP q${TEXTURE_WEBP_QUALITY})`];
    if (texSaved >= MIN_SAVING_BYTES) {
      fix.push(`expected ~${formatBytes(texWebp)} for the textures, from ${formatBytes(texBytes)} (estimate)`);
    }
    if (texResize && resizeTo !== undefined) {
      fix.push(
        `resize textures to at most ${Math.round(resizeTo)} px on the long side, keeping the aspect ratio ` +
          `(the model shows at ${Math.round(box!.width)}x${Math.round(box!.height)} CSS px at ${ctx.viewport.dpr}x)`,
      );
    }
    findings.push({
      id: `${id}:textures`,
      kind: "model",
      url: r.url,
      bytes: r.bytes,
      savedBytes: texSaved,
      estimate: true,
      title: `3D model ${name}: ${textures} texture${textures === 1 ? "" : "s"}, ${formatBytes(texBytes)} as PNG/JPEG` +
        (texSaved >= MIN_SAVING_BYTES ? `; WebP ~${formatBytes(texWebp)}` : ""),
      fix,
      details: { ...details, savedBytes: texSaved },
      ...(locator ? { locator } : {}),
    });
  }

  // Geometry.
  if (compressed) {
    findings.push({
      id,
      kind: "model",
      url: r.url,
      bytes: r.bytes,
      savedBytes: 0,
      estimate: false,
      title: `3D model ${name}: already compressed (${extensions.filter((e) => /draco|meshopt/i.test(e)).join(", ")}), geometry not re-measured`,
      fix: [],
      details,
      ...(locator ? { locator } : {}),
    });
    return findings;
  }
  if (externalBuffers) {
    findings.push({
      id,
      kind: "model",
      url: r.url,
      bytes: r.bytes,
      savedBytes: 0,
      estimate: true,
      title: `3D model ${name} (${fmt}): ${formatBytes(r.bytes)}; its .bin buffers are external and not in the scan, so geometry is not measured`,
      fix: ["measure: npx @gltf-transform/cli optimize in.gltf out.glb --compress meshopt (run it on the source file)"],
      details,
      ...(locator ? { locator } : {}),
    });
    return findings;
  }
  if (geomBytes > MAX_MEASURED_GEOMETRY_BYTES) {
    findings.push({
      id,
      kind: "model",
      url: r.url,
      bytes: r.bytes,
      savedBytes: 0,
      estimate: true,
      title: `3D model ${name} (${fmt}): ${formatBytes(geomBytes)} of geometry, too large to measure within the budget`,
      fix: ["npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt (meshopt quantizes positions and normals: check the model visually)"],
      details,
      ...(locator ? { locator } : {}),
    });
    return findings;
  }

  // The meshopt measurement is heavy: once per run by content, and not at all once the run's budget is spent.
  const outcome = await heavyValue(`model:meshopt:${digestOf(body)}`, () => measureMeshopt(body, parsed));
  if (outcome === undefined || outcome.kind !== "ok") {
    // No measurement: the model is reported with no number, and the reason (a missing package prints its one note).
    if (outcome?.kind === "unreadable") return findings;
    const reason = outcome === undefined ? "over the run's --resource-time budget" : GLTF_NOTE;
    findings.push({
      id: `${id}:geometry`,
      kind: "model",
      url: r.url,
      bytes: r.bytes,
      savedBytes: 0,
      estimate: true,
      title: `3D model ${name} (${fmt}): geometry not measured (${reason})`,
      fix: [outcome === undefined ? "npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt (run it on the source file)" : GLTF_NOTE],
      details: { ...details, ...(outcome?.kind === "missing" ? { note: GLTF_NOTE } : {}) },
      ...(locator ? { locator } : {}),
    });
    return findings;
  }
  const measured = outcome;
  const savedBytes = body.length - measured.meshBytes;
  details.repackBytes = measured.repackBytes;
  details.meshoptBytes = measured.meshBytes;
  details.repackSavedBytes = body.length - measured.repackBytes;
  if (savedBytes < MIN_SAVING_BYTES || savedBytes < MIN_SAVING_SHARE * body.length) return findings;
  const fix: string[] = [];
  if (details.repackSavedBytes as number >= MIN_SAVING_BYTES) {
    fix.push(
      `the file embeds its buffers as base64 (about a third larger): writing it as a GLB removes ` +
        `${formatBytes(details.repackSavedBytes as number)} on its own`,
    );
  }
  fix.push(`npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt`);
  const combined = measured.meshBytes - (texSaved >= MIN_SAVING_BYTES ? texSaved : 0);
  fix.push(
    `expected ~${formatBytes(measured.meshBytes)} for the file as it is (measured; meshopt quantizes positions and normals, ` +
      `check the model visually)` +
      (texSaved >= MIN_SAVING_BYTES ? `; with the texture fix above ~${formatBytes(combined)}` : ""),
  );
  findings.push({
    id,
    kind: "model",
    url: r.url,
    bytes: r.bytes,
    savedBytes,
    estimate: false,
    title: `3D model ${name} (${fmt}): ${formatBytes(body.length)}; with meshopt ~${formatBytes(measured.meshBytes)} (measured)`,
    fix,
    details,
    ...(locator ? { locator } : {}),
  });
  return findings;
}

function otherFormat(r: ResourceRecord, ext: string): ResourceFinding {
  const name = fileName(r.url);
  const fix: Record<string, string> = {
    usdz: "convert to .glb (Blender: export glTF 2.0 binary), then npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp",
    obj: "convert to .glb (Blender: export glTF 2.0 binary), then npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp",
    fbx: "convert to .glb (Blender: export glTF 2.0 binary), then npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp",
    ply: "a point cloud or splat: serve a compressed .glb or a splat-specific compressed format; the saving is not measured here",
    splat: "a Gaussian splat is large by design; serve a splat-specific compressed format (not measured here)",
    ktx2: "already a GPU texture container: nothing to re-encode here",
    drc: "standalone Draco file: the decoder is part of the page's cost; a glTF with KHR_draco_mesh_compression keeps the same bytes",
  };
  return {
    id: `model:${hashUrl(r.url)}`,
    kind: "model",
    url: r.url,
    bytes: r.bytes,
    savedBytes: 0,
    estimate: true,
    title: `3D model ${name} (${ext}): ${formatBytes(r.bytes)}; informational, not converted`,
    fix: [fix[ext] ?? "informational"],
    details: { format: ext },
  };
}

export const analyzer: ResourceAnalyzer = {
  kind: "model",
  wants(r: ResourceRecord): boolean {
    try {
      const ext = extOf(r.url);
      return GLTF_EXTS.has(ext) || OTHER_EXTS.has(ext) || MODEL_TYPES.test(r.contentType);
    } catch {
      return false;
    }
  },
  async analyze(records: ResourceRecord[], ctx: PageContext): Promise<ResourceFinding[]> {
    const out: ResourceFinding[] = [];
    for (const r of records) {
      try {
        const ext = extOf(r.url);
        if (GLTF_EXTS.has(ext) || (MODEL_TYPES.test(r.contentType) && (r.contentType.includes("gltf") || r.contentType.includes("glb")))) {
          if (!r.body) {
            out.push({
              id: `model:${hashUrl(r.url)}`,
              kind: "model",
              url: r.url,
              bytes: r.bytes,
              savedBytes: 0,
              estimate: true,
              title: `3D model ${fileName(r.url)}: ${formatBytes(r.bytes)}; over 20 MB, not parsed`,
              fix: [],
            });
            continue;
          }
          out.push(...(await analyzeGltf(r, r.body, ctx)));
        } else if (OTHER_EXTS.has(ext) || MODEL_TYPES.test(r.contentType)) {
          out.push(otherFormat(r, ext || r.contentType));
        }
      } catch {
        // One unreadable model does not drop the others.
      }
    }
    return out;
  },
};
