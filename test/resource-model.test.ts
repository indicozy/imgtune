import { describe, expect, it } from "vitest";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { analyzer } from "../src/resources/model.js";
import type { PageContext, ResourceRecord } from "../src/resources/types.js";

// Synthetic models only: GLB and glTF files are built here, in code, so no site content is committed.

const PAGE = "https://example.test/";

function record(url: string, body: Buffer | undefined, contentType: string, bytes = body?.length ?? 0): ResourceRecord {
  return { url, pageUrl: PAGE, viewport: "desktop", resourceType: "fetch", contentType, bytes, status: 200, thirdParty: false, body };
}

function ctx(models: PageContext["models"] = []): PageContext {
  return {
    url: PAGE,
    viewport: { name: "desktop", width: 1440, height: 900, dpr: 1 },
    text: "",
    usedFonts: [],
    fontFaces: [],
    icons: [],
    audio: [],
    lottie: [],
    models,
  };
}

/** A GLB container from a JSON document and an optional BIN chunk. */
function makeGlb(json: object, bin?: Buffer): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binPadded = bin === undefined ? undefined : Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(8);
  head.writeUInt32LE(jsonPadded.length, 0);
  head.write("JSON", 4);
  chunks.push(head, jsonPadded);
  if (binPadded !== undefined) {
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(binPadded.length, 0);
    bh.write("BIN\0", 4);
    chunks.push(bh, binPadded);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** A GLB with one triangle mesh of `vertexCount` random vertices, and an optional PNG base-colour texture. */
async function meshGlb(vertexCount: number, texturePng?: Buffer): Promise<Buffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  let seed = 1;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const positions = new Float32Array(vertexCount * 3).map(() => rnd() * 2 - 1);
  const normals = new Float32Array(vertexCount * 3).map(() => rnd() * 2 - 1);
  // Whole triangles: the index count is a multiple of three.
  const indices = new Uint32Array(vertexCount - (vertexCount % 3)).map((_, i) => i);
  const pos = doc.createAccessor().setArray(positions).setType("VEC3").setBuffer(buffer);
  const nrm = doc.createAccessor().setArray(normals).setType("VEC3").setBuffer(buffer);
  const idx = doc.createAccessor().setArray(indices).setType("SCALAR").setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute("POSITION", pos).setAttribute("NORMAL", nrm).setIndices(idx);
  if (texturePng !== undefined) {
    const tex = doc.createTexture("base").setMimeType("image/png").setImage(texturePng);
    prim.setMaterial(doc.createMaterial("m").setBaseColorTexture(tex));
  }
  const mesh = doc.createMesh("mesh").addPrimitive(prim);
  doc.createScene("scene").addChild(doc.createNode("node").setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

/** A 1024x1024 gradient with a little noise, as PNG: smooth enough that WebP is much smaller. */
async function gradientPng(size = 1024): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3);
  let seed = 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed % 9) - 4;
      const o = (y * size + x) * 3;
      raw[o] = Math.max(0, Math.min(255, Math.round((x / size) * 255) + noise));
      raw[o + 1] = Math.max(0, Math.min(255, Math.round((y / size) * 255) + noise));
      raw[o + 2] = 128;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

describe("model wants()", () => {
  it("wants 3D model files and model content types", () => {
    expect(analyzer.wants(record("https://cdn.test/a.glb", undefined, "application/octet-stream"))).toBe(true);
    expect(analyzer.wants(record("https://cdn.test/a.gltf", undefined, "model/gltf+json"))).toBe(true);
    expect(analyzer.wants(record("https://cdn.test/a.bin", undefined, "model/gltf-binary"))).toBe(true);
    expect(analyzer.wants(record("https://cdn.test/a.obj", undefined, "text/plain"))).toBe(true);
    expect(analyzer.wants(record("https://cdn.test/a.ktx2", undefined, "image/ktx2"))).toBe(true);
  });

  it("does not want other JSON or images", () => {
    expect(analyzer.wants(record("https://cdn.test/anim.json", undefined, "application/json"))).toBe(false);
    expect(analyzer.wants(record("https://cdn.test/a.png", undefined, "image/png"))).toBe(false);
  });
});

describe("model analyzer", () => {
  it("measures meshopt on an uncompressed GLB's geometry, with the optimize command", async () => {
    const body = await meshGlb(20_000);
    const [f] = await analyzer.analyze([record("https://cdn.test/hero.glb", body, "model/gltf-binary")], ctx());
    expect(f).toBeDefined();
    expect(f.kind).toBe("model");
    expect(f.id).toMatch(/^model:[0-9a-f]{12}$/);
    expect(f.bytes).toBe(body.length);
    expect(f.savedBytes).toBeGreaterThan(body.length * 0.3);
    expect(f.savedBytes).toBeLessThan(body.length);
    expect(f.fix.join("\n")).toContain("npx @gltf-transform/cli optimize");
    expect(f.fix.join("\n")).toContain("--compress meshopt");
    expect(f.details?.extensionsUsed).toEqual([]);
  });

  it("reports textures with a WebP estimate and the texture option", async () => {
    const body = await meshGlb(100, await gradientPng());
    const out = await analyzer.analyze([record("https://cdn.test/tex.glb", body, "model/gltf-binary")], ctx());
    const tex = out.find((f) => f.id.endsWith(":textures"));
    expect(tex).toBeDefined();
    expect(tex!.savedBytes).toBeGreaterThan(0);
    expect(tex!.estimate).toBe(true);
    expect(tex!.fix.join("\n")).toContain("--texture-compress webp");
  });

  it("finds no geometry saving for a file that is already Draco-compressed", async () => {
    const json = {
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_draco_mesh_compression"],
      extensionsRequired: ["KHR_draco_mesh_compression"],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } }] }],
      accessors: [{ componentType: 5126, count: 3, type: "VEC3", max: [1, 1, 1], min: [0, 0, 0] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
      scenes: [{ nodes: [] }],
    };
    const body = makeGlb(json, Buffer.alloc(36));
    const out = await analyzer.analyze([record("https://cdn.test/draco.glb", body, "model/gltf-binary")], ctx());
    expect(out.some((f) => f.id.endsWith(":textures"))).toBe(false);
    const geom = out.find((f) => /^model:[0-9a-f]{12}$/.test(f.id));
    expect(geom?.savedBytes ?? 0).toBe(0);
  });

  it("counts the base64 overhead of a glTF with data-URI buffers as a repack saving", async () => {
    const glb = await meshGlb(5_000);
    const jsonLen = glb.readUInt32LE(12);
    const binLen = glb.readUInt32LE(20 + jsonLen);
    const bin = glb.subarray(20 + jsonLen + 8, 20 + jsonLen + 8 + binLen);
    const dataUri = `data:application/octet-stream;base64,${Buffer.from(bin).toString("base64")}`;
    // The GLB's JSON with its BIN chunk moved into a data URI: the same document as a plain glTF.
    const gltfJson = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
    gltfJson.buffers = [{ byteLength: bin.length, uri: dataUri }];
    const body = Buffer.from(JSON.stringify(gltfJson), "utf8");
    const [f] = await analyzer.analyze([record("https://cdn.test/embedded.gltf", body, "model/gltf+json")], ctx());
    expect(f).toBeDefined();
    expect(f.details?.repackSavedBytes as number).toBeGreaterThan(0);
    expect(f.savedBytes).toBeGreaterThan(0);
  });

  it("gives a glTF with external buffers an informational finding with no saving", async () => {
    const body = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 100, uri: "scene.bin" }] }));
    const [f] = await analyzer.analyze([record("https://cdn.test/ext.gltf", body, "model/gltf+json")], ctx());
    expect(f).toBeDefined();
    expect(f.savedBytes).toBe(0);
  });

  it("reports OBJ as informational with the glTF conversion", async () => {
    const body = Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    const [f] = await analyzer.analyze([record("https://cdn.test/a.obj", body, "text/plain")], ctx());
    expect(f).toBeDefined();
    expect(f.savedBytes).toBe(0);
    expect(f.fix.join("\n")).toContain("glb");
  });

  it("does not throw on a mesh that is not triangles (points), it just reports no measured saving", async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const pos = doc.createAccessor().setArray(new Float32Array(300).map((_, i) => i)).setType("VEC3").setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute("POSITION", pos).setMode(0);
    doc.createScene("s").addChild(doc.createNode("n").setMesh(doc.createMesh("m").addPrimitive(prim)));
    const body = Buffer.from(await new NodeIO().writeBinary(doc));
    const out = await analyzer.analyze([record("https://cdn.test/points.glb", body, "model/gltf-binary")], ctx());
    expect(Array.isArray(out)).toBe(true);
    expect(out.every((f) => f.savedBytes >= 0)).toBe(true);
  });

  it("never throws on a body that is not a model", async () => {
    const out = await analyzer.analyze([record("https://cdn.test/x.glb", Buffer.from("definitely not glb"), "model/gltf-binary")], ctx());
    expect(Array.isArray(out)).toBe(true);
    expect(out.every((f) => f.savedBytes >= 0)).toBe(true);
  });

  it("uses the model element's display box for a texture resize line", async () => {
    const body = await meshGlb(100, await gradientPng(1024));
    const url = "https://cdn.test/small.glb";
    const out = await analyzer.analyze(
      [record(url, body, "model/gltf-binary")],
      ctx([{ src: url, selector: "model-viewer#hero", width: 200, height: 200 }]),
    );
    const tex = out.find((f) => f.id.endsWith(":textures"));
    expect(tex?.fix.join("\n")).toMatch(/resize textures to at most 200 px/);
    expect(tex?.locator?.selector).toBe("model-viewer#hero");
  });
});

describe("the optional 3D measurement packages", () => {
  it("loads them when installed, and gives undefined (never throws) when one will not load", async () => {
    const { importGltfTools } = await import("../src/resources/model.js");
    expect(await importGltfTools(() => Promise.reject(new Error("@gltf-transform/core is not installed")))).toBeUndefined();
    expect(await importGltfTools(() => Promise.reject(new Error("x")))).toBeUndefined();
  });
});
