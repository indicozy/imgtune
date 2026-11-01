import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkGpuScorer,
  countGpuFallbacks,
  encodeRequest,
  findGpuScorer,
  GPU_SCORER_BINARY,
  GPU_SCORER_ENV,
  GpuScorer,
  gpuEligible,
  gpuNote,
  gpuProgramIndex,
  gpuScorerEnv,
  openedDeviceLine,
  parseGpuDevice,
  startGpuScorer,
} from "../src/gpu.js";
import { clearScoreCache, makeScorer, score } from "../src/metric.js";
import type { RawImage } from "../src/ssim.js";
import { parseImageArgs } from "../src/image-file.js";
import {
  parseScanArgs,
  recordOptionsOf,
  renderScan,
  sameRecordOptions,
  summaryOf,
  type PageResult,
  type ScanRecordOptions,
} from "../src/remote.js";
import { parseRecheckArgs, scorerMismatch } from "../src/recheck.js";
import { gradientNoise } from "./image-fixtures.js";

const created: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "imgtune-gpu-"));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => clearScoreCache());

/**
 * A stand-in for imgtune-ssimu2-gpu that speaks the same protocol. Its score is 100 minus the mean absolute difference of
 * the RGB bytes, so a changed pair can go negative. MOCK_CHECK picks the self-test answer ("ok", "selftest", "crash");
 * MOCK_FAIL_AFTER makes it exit on request number N + 1 (0: the first request fails).
 */
async function mockScorer(dir: string): Promise<string> {
  const path = join(dir, GPU_SCORER_BINARY);
  const body = `#!${process.execPath}
let buf = Buffer.alloc(0);
let served = 0;
const failAfter = Number(process.env.MOCK_FAIL_AFTER ?? -1);
if (process.argv.includes("--check")) {
  if (process.env.MOCK_CHECK === "crash") {
    process.stderr.write("no CUDA device visible\\n");
    process.exit(3);
  }
  const identical = process.env.MOCK_CHECK === "selftest" ? 80 : 99.5;
  // MOCK_ECHO: the name carries the --device argument and the CUDA variables the program was started with.
  const at = process.argv.indexOf("--device");
  const echo = process.env.MOCK_ECHO === "1" ? \`|arg=\${process.argv[at + 1]}|vis=\${process.env.CUDA_VISIBLE_DEVICES ?? "-"}|order=\${process.env.CUDA_DEVICE_ORDER ?? "-"}\` : "";
  process.stdout.write(JSON.stringify({ device: (process.env.MOCK_NAME ?? "Mock GPU") + echo, identical, perturbed: 60 }) + "\\n");
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 4) return;
    const count = buf.readUInt32LE(0);
    let at = 4;
    const pairs = [];
    let complete = true;
    for (let k = 0; k < count; k++) {
      if (buf.length < at + 8) { complete = false; break; }
      const w = buf.readUInt32LE(at), h = buf.readUInt32LE(at + 4);
      at += 8;
      const n = w * h * 3;
      if (buf.length < at + 2 * n) { complete = false; break; }
      pairs.push([buf.subarray(at, at + n), buf.subarray(at + n, at + 2 * n)]);
      at += 2 * n;
    }
    if (!complete) return;
    buf = buf.subarray(at);
    served++;
    if (failAfter >= 0 && served > failAfter) {
      process.stderr.write("mock failure\\n");
      process.exit(4);
    }
    const out = Buffer.alloc(4 + 8 * count);
    pairs.forEach(([ref, test], i) => {
      let sum = 0;
      for (let j = 0; j < ref.length; j++) sum += Math.abs(ref[j] - test[j]);
      out.writeDoubleLE(100 - sum / ref.length, 4 + 8 * i);
    });
    process.stdout.write(out);
  }
});
process.stdin.on("end", () => process.exit(0));
`;
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

/** The mock's score for a pair: 100 minus the mean absolute difference of the RGB bytes (opaque images). */
function mockScore(a: RawImage, b: RawImage): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a.data[i + c] - b.data[i + c]);
      n++;
    }
  }
  return 100 - sum / n;
}

const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...process.env, ...extra });

function black(width: number, height: number): RawImage {
  return { data: new Uint8ClampedArray(width * height * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0)), width, height };
}

function white(width: number, height: number): RawImage {
  return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
}

describe("gpu device option", () => {
  it("accepts a GPU index and refuses anything else", () => {
    expect(parseGpuDevice("0")).toBe(0);
    expect(parseGpuDevice("1")).toBe(1);
    expect(() => parseGpuDevice("-1")).toThrow(/--gpu-device needs a GPU index/);
    expect(() => parseGpuDevice("cuda:1")).toThrow(/--gpu-device needs a GPU index/);
    expect(() => parseGpuDevice("")).toThrow(/--gpu-device needs a GPU index/);
  });

  it("states the sizes the program accepts", () => {
    expect(gpuEligible(8, 8)).toBe(true);
    expect(gpuEligible(7, 100)).toBe(false);
    expect(gpuEligible(4096, 4096)).toBe(true);
    expect(gpuEligible(4097, 4096)).toBe(false);
  });
});

describe("gpu scorer detection", () => {
  it("uses IMGTUNE_GPU_SCORER when it names an executable, and nothing when it does not", async () => {
    const dir = await tempDir();
    const bin = await mockScorer(dir);
    expect(await findGpuScorer(env({ [GPU_SCORER_ENV]: bin }))).toBe(bin);
    expect(await findGpuScorer(env({ [GPU_SCORER_ENV]: join(dir, "missing") }))).toBeUndefined();
  });

  it("looks the program up on PATH when IMGTUNE_GPU_SCORER is not set", async () => {
    const dir = await tempDir();
    const bin = await mockScorer(dir);
    expect(await findGpuScorer(env({ [GPU_SCORER_ENV]: "", PATH: `/nonexistent-dir:${dir}` }))).toBe(bin);
    expect(await findGpuScorer(env({ PATH: "/nonexistent-dir" }))).toBeUndefined();
  });

  it("accepts a self-test that passes and refuses one that fails or crashes", async () => {
    const dir = await tempDir();
    const bin = await mockScorer(dir);
    const ok = await checkGpuScorer(bin, 1, env({ MOCK_NAME: "RTX Test" }));
    expect(ok.name).toBe("RTX Test");
    await expect(checkGpuScorer(bin, 1, env({ MOCK_CHECK: "selftest" }))).rejects.toThrow(/self-test failed/);
    await expect(checkGpuScorer(bin, 1, env({ MOCK_CHECK: "crash" }))).rejects.toThrow(/failed its check \(no CUDA device visible\)/);
  });
});

describe("gpu device selection", () => {
  it("restricts the program to the device only when the user set no CUDA_VISIBLE_DEVICES", () => {
    expect(gpuScorerEnv(1, env({})).CUDA_VISIBLE_DEVICES).toBe("1");
    expect(gpuProgramIndex(1, env({}))).toBe(0);
  });

  it("keeps a user's CUDA_VISIBLE_DEVICES and reads --gpu-device as an index within it", () => {
    const user = env({ CUDA_VISIBLE_DEVICES: "0" });
    expect(gpuScorerEnv(1, user).CUDA_VISIBLE_DEVICES).toBe("0");
    expect(gpuProgramIndex(1, user)).toBe(1);
    expect(gpuProgramIndex(0, env({ CUDA_VISIBLE_DEVICES: "1" }))).toBe(0);
  });

  it("never overwrites CUDA_DEVICE_ORDER", () => {
    expect(gpuScorerEnv(1, env({ CUDA_DEVICE_ORDER: "FASTEST_FIRST" })).CUDA_DEVICE_ORDER).toBe("FASTEST_FIRST");
    expect(gpuScorerEnv(1, env({})).CUDA_DEVICE_ORDER).toBeUndefined();
    expect(gpuScorerEnv(1, env({ CUDA_DEVICE_ORDER: "PCI_BUS_ID" })).CUDA_DEVICE_ORDER).toBe("PCI_BUS_ID");
  });

  it("says which device was opened, how CUDA numbers it, and which list it came from", () => {
    expect(openedDeviceLine(1, "RTX 4060", env({ CUDA_DEVICE_ORDER: "PCI_BUS_ID", CUDA_VISIBLE_DEVICES: "1" }))).toBe(
      "--gpu: opened RTX 4060, device index 1 (CUDA_DEVICE_ORDER: PCI_BUS_ID; CUDA_VISIBLE_DEVICES=1)",
    );
    expect(openedDeviceLine(1, "RTX 4090", env({}))).toMatch(/device index 1 \(CUDA_DEVICE_ORDER: FASTEST_FIRST \(CUDA's default\); CUDA_VISIBLE_DEVICES=1 \(set by imgtune\)\)/);
  });

  it("opens the device the user's visible list names, passes the index, and prints the name", async () => {
    const dir = await tempDir();
    const bin = await mockScorer(dir);
    const logs: string[] = [];
    const saved = { ...process.env };
    try {
      process.env[GPU_SCORER_ENV] = bin;
      process.env.MOCK_ECHO = "1";
      process.env.MOCK_NAME = "RTX Test";
      process.env.CUDA_VISIBLE_DEVICES = "0,1";
      process.env.CUDA_DEVICE_ORDER = "PCI_BUS_ID";
      const scorer = await startGpuScorer(1, (m) => logs.push(m));
      expect(scorer).toBeDefined();
      // The scorer's name is the program's own report of the device it opened, with the index and the variables it saw.
      expect(scorer?.deviceName).toBe("RTX Test|arg=1|vis=0,1|order=PCI_BUS_ID");
      expect(logs.join("\n")).toMatch(/--gpu: opened RTX Test\|arg=1\|vis=0,1\|order=PCI_BUS_ID, device index 1 \(CUDA_DEVICE_ORDER: PCI_BUS_ID; CUDA_VISIBLE_DEVICES=0,1\)/);
      expect(scorer?.cuda).toEqual({ deviceOrder: "PCI_BUS_ID", visibleDevices: "0,1" });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("restricts the program to the device when the user set nothing, and records that", async () => {
    const dir = await tempDir();
    const bin = await mockScorer(dir);
    const logs: string[] = [];
    const saved = { ...process.env };
    try {
      process.env[GPU_SCORER_ENV] = bin;
      process.env.MOCK_ECHO = "1";
      process.env.MOCK_NAME = "RTX Test";
      delete process.env.CUDA_VISIBLE_DEVICES;
      delete process.env.CUDA_DEVICE_ORDER;
      const scorer = await startGpuScorer(1, (m) => logs.push(m));
      expect(scorer?.deviceName).toBe("RTX Test|arg=0|vis=1|order=-");
      expect(scorer?.cuda).toEqual({ deviceOrder: "FASTEST_FIRST", visibleDevices: "1" });
      expect(logs.join("\n")).toMatch(/CUDA_VISIBLE_DEVICES=1 \(set by imgtune\)/);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("gpu request framing", () => {
  it("writes a count, then each pair's size and RGB bytes (reference, then test), without alpha", () => {
    const a: RawImage = { data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]), width: 2, height: 1 };
    const b: RawImage = { data: new Uint8ClampedArray([11, 21, 31, 255, 41, 51, 61, 255]), width: 2, height: 1 };
    const frame = encodeRequest([[a, b]]);
    expect(frame.readUInt32LE(0)).toBe(1);
    expect(frame.readUInt32LE(4)).toBe(2);
    expect(frame.readUInt32LE(8)).toBe(1);
    expect([...frame.subarray(12)]).toEqual([10, 20, 30, 40, 50, 60, 11, 21, 31, 41, 51, 61]);
  });

  it("composites translucent pixels on white, as the CPU scorer does", () => {
    const translucent: RawImage = { data: new Uint8ClampedArray([0, 0, 0, 0]), width: 1, height: 1 };
    const frame = encodeRequest([[translucent, translucent]]);
    expect([...frame.subarray(12, 15)]).toEqual([255, 255, 255]);
  });

  it("refuses an empty request and mismatched sizes", () => {
    expect(() => encodeRequest([])).toThrow(/1 to 256 pairs/);
    expect(() => encodeRequest([[black(8, 8), black(8, 9)]])).toThrow(/equal dimensions/);
  });
});

describe("GpuScorer", () => {
  it("scores through the program, in order, and passes negative scores through", async () => {
    const dir = await tempDir();
    const bin = await mockScorer(dir);
    const warnings: string[] = [];
    const gpu = new GpuScorer({ binary: bin, device: 1, deviceName: "Mock GPU", env: env({}), warn: (m) => warnings.push(m) });
    const a = gradientNoise(16, 16, 3, 1);
    const b = gradientNoise(16, 16, 9, 2);
    const inverse = white(8, 8);
    const dark = black(8, 8);
    try {
      expect(await gpu.tryScore(a, b)).toBeCloseTo(mockScore(a, b), 9);
      const batch = await gpu.scoreBatch([[a, b], [dark, inverse], [a, a]]);
      expect(batch[0]).toBeCloseTo(mockScore(a, b), 9);
      expect(batch[1]).toBeCloseTo(-155, 9);
      expect(batch[2]).toBe(100);
      expect(gpu.fallbackScores).toBe(0);
      expect(warnings).toEqual([]);
    } finally {
      gpu.close();
    }
  });

  it("leaves pairs too small for the program to the CPU, without a request", async () => {
    const dir = await tempDir();
    const gpu = new GpuScorer({ binary: await mockScorer(dir), device: 0, deviceName: "Mock GPU", warn: () => undefined });
    try {
      expect(await gpu.tryScore(black(4, 4), black(4, 4))).toBeUndefined();
      expect(gpu.fallbackScores).toBe(0);
      // The CPU still scored the pair: the count that keeps a GPU-keyed cache write out sees it.
      expect(gpu.cpuScores).toBe(1);
    } finally {
      gpu.close();
    }
  });

  it("falls back to the CPU for a failing score, warns once and counts the fallback", async () => {
    const dir = await tempDir();
    const warnings: string[] = [];
    const gpu = new GpuScorer({
      binary: await mockScorer(dir),
      device: 0,
      deviceName: "Mock GPU",
      env: env({ MOCK_FAIL_AFTER: "0" }),
      warn: (m) => warnings.push(m),
    });
    const scorer = makeScorer("ssimulacra2", { gpu });
    const a = gradientNoise(16, 16, 3, 1);
    const b = gradientNoise(16, 16, 9, 2);
    try {
      expect(await scorer(a, b)).toBe(await score("ssimulacra2", a, b));
      // A repeated pair is answered by the score cache, so the second call uses another pair.
      expect(await scorer(b, a)).toBe(await score("ssimulacra2", b, a));
      expect(gpu.fallbackScores).toBe(2);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^--gpu: the GPU scorer stopped \(exit 4\): mock failure; the scores from here on run on the CPU$/);
    } finally {
      gpu.close();
    }
  });

  it("counts each page's CPU fallbacks for itself when two pages score at once", async () => {
    const dir = await tempDir();
    const gpu = new GpuScorer({
      binary: await mockScorer(dir),
      device: 0,
      deviceName: "Mock GPU",
      env: env({ MOCK_FAIL_AFTER: "0" }),
      warn: () => undefined,
    });
    const a = gradientNoise(16, 16, 3, 1);
    const b = gradientNoise(16, 16, 9, 2);
    const c = gradientNoise(16, 16, 5, 3);
    const d = gradientNoise(16, 16, 7, 4);
    try {
      // Two pages in flight: the first scores one pair, the second scores two. Each page's tally holds its own.
      const first = countGpuFallbacks(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return gpu.tryScore(a, b);
      });
      const second = countGpuFallbacks(async () => {
        await gpu.tryScore(c, d);
        return gpu.tryScore(d, c);
      });
      const [one, two] = await Promise.all([first, second]);
      expect(one.fallbacks).toBe(1);
      expect(two.fallbacks).toBe(2);
      expect(gpu.fallbackScores).toBe(3);
      // Outside a page nothing is tallied, and the scorer's own count still moves.
      await gpu.tryScore(a, c);
      expect(gpu.fallbackScores).toBe(4);
    } finally {
      gpu.close();
    }
  });

  it("keeps the scores it had before a mid-run failure and falls back for the rest", async () => {
    const dir = await tempDir();
    const gpu = new GpuScorer({
      binary: await mockScorer(dir),
      device: 0,
      deviceName: "Mock GPU",
      env: env({ MOCK_FAIL_AFTER: "1" }),
      warn: () => undefined,
    });
    const a = gradientNoise(16, 16, 3, 1);
    const b = gradientNoise(16, 16, 9, 2);
    try {
      expect(await gpu.tryScore(a, b)).toBeCloseTo(mockScore(a, b), 9);
      expect(await gpu.tryScore(b, a)).toBeUndefined();
      expect(gpu.fallbackScores).toBe(1);
    } finally {
      gpu.close();
    }
  });
});

describe("startGpuScorer", () => {
  it("warns and returns nothing when the program is not found", async () => {
    const logs: string[] = [];
    const gpu = await startGpuScorer(0, (m) => logs.push(m), env({ [GPU_SCORER_ENV]: "/nonexistent/imgtune-ssimu2-gpu", PATH: "/nonexistent" }));
    expect(gpu).toBeUndefined();
    expect(logs).toEqual(["--gpu: IMGTUNE_GPU_SCORER does not name an executable file; scoring on the CPU"]);
  });

  it("warns and returns nothing when the program is not on PATH", async () => {
    const logs: string[] = [];
    const gpu = await startGpuScorer(0, (m) => logs.push(m), env({ [GPU_SCORER_ENV]: "", PATH: "/nonexistent" }));
    expect(gpu).toBeUndefined();
    expect(logs).toEqual([`--gpu: ${GPU_SCORER_BINARY} is not on PATH; scoring on the CPU`]);
  });

  it("warns and returns nothing when the self-test fails", async () => {
    const dir = await tempDir();
    const logs: string[] = [];
    const gpu = await startGpuScorer(1, (m) => logs.push(m), env({ [GPU_SCORER_ENV]: await mockScorer(dir), MOCK_CHECK: "selftest" }));
    expect(gpu).toBeUndefined();
    expect(logs[0]).toMatch(/^--gpu 1: the GPU scorer's self-test failed \(identical 80, changed 60\); scoring on the CPU$/);
  });

  it("returns a scorer named by its device's own name", async () => {
    const dir = await tempDir();
    const logs: string[] = [];
    const gpu = await startGpuScorer(1, (m) => logs.push(m), env({ [GPU_SCORER_ENV]: await mockScorer(dir), MOCK_NAME: "RTX 4060" }));
    try {
      expect(gpu).toBeInstanceOf(GpuScorer);
      expect(gpu?.deviceName).toBe("RTX 4060");
      expect(gpu?.device).toBe(1);
      // The one line on success: the device it opened, before the first score.
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^--gpu: opened RTX 4060, device index 1 \(CUDA_DEVICE_ORDER: /);
    } finally {
      gpu?.close();
    }
  });

  it("says which scorer made the numbers", () => {
    expect(gpuNote(1, "RTX 4060")).toBe("scored on GPU; may differ slightly from CPU (device 1: RTX 4060)");
    expect(gpuNote(1, "RTX 4060", 3)).toBe(
      "scored on GPU; may differ slightly from CPU (device 1: RTX 4060); 3 score(s) fell back to the CPU after the GPU failed",
    );
  });
});

describe("option parsing", () => {
  it("reads --gpu and --gpu-device on scan; --gpu-device implies --gpu", () => {
    expect(parseScanArgs(["https://example.com"]).gpu).toBeUndefined();
    expect(parseScanArgs(["https://example.com", "--gpu"]).gpu).toEqual({ device: 0 });
    expect(parseScanArgs(["https://example.com", "--gpu-device", "1"]).gpu).toEqual({ device: 1 });
    expect(parseScanArgs(["https://example.com", "--gpu-device", "1", "--gpu"]).gpu).toEqual({ device: 1 });
    expect(() => parseScanArgs(["https://example.com", "--gpu-device", "x"])).toThrow(/--gpu-device/);
    expect(() => parseScanArgs(["https://example.com", "--gpu-device"])).toThrow(/needs a value/);
  });

  it("reads --gpu and --gpu-device on recheck and image", () => {
    expect(parseRecheckArgs(["--recheck", "scan.json"]).gpu).toBeUndefined();
    expect(parseRecheckArgs(["--recheck", "scan.json", "--gpu"]).gpu).toEqual({ device: 0 });
    expect(parseRecheckArgs(["--recheck", "scan.json", "--gpu-device", "1"]).gpu).toEqual({ device: 1 });
    expect(parseImageArgs(["a.png", "--gpu"]).gpu).toEqual({ device: 0 });
    expect(parseImageArgs(["a.png", "--gpu-device", "1"]).gpu).toEqual({ device: 1 });
    expect(parseImageArgs(["a.png"]).gpu).toBeUndefined();
  });
});

describe("scorer records", () => {
  const scanOptions = { viewports: [], aggressive: false, quality: true, ignoreRobots: false, storageState: undefined };

  it("treats a scan without a scorer field as a CPU scan when it is resumed", () => {
    // A scan from before the scorer field was one load per viewport, as --fresh-loads is: its record matches that mode.
    const cpu = recordOptionsOf({ ...scanOptions, freshLoads: true });
    const legacy: Partial<ScanRecordOptions> = { ...cpu };
    delete legacy.scorer;
    expect(sameRecordOptions(legacy as ScanRecordOptions, cpu)).toBe(true);
    expect(sameRecordOptions(legacy as ScanRecordOptions, recordOptionsOf({ ...scanOptions, freshLoads: true, gpu: { device: 1 } }))).toBe(false);
  });

  it("names the GPU on the output and in the summary when the GPU made the numbers", () => {
    const page = { url: "https://example.com/", host: "example.com", status: "robots" } as PageResult;
    const gpuPage = { ...page, status: "ok", scorer: { name: "gpu", device: 1, deviceName: "RTX 4060", cpuFallbacks: 2 } } as PageResult;
    expect(renderScan([page], false)).not.toContain("scored on GPU");
    expect(renderScan([gpuPage], false).split("\n")[0]).toBe(
      "scored on GPU; may differ slightly from CPU (device 1: RTX 4060); 2 score(s) fell back to the CPU after the GPU failed",
    );
    expect(summaryOf([page]).scorer).toEqual({ name: "cpu" });
    expect(summaryOf([gpuPage]).scorer).toEqual({ name: "gpu", device: 1, deviceName: "RTX 4060", cpuFallbacks: 2 });
  });

  it("warns when a recheck is scored by a different scorer from the scan", () => {
    const before = { url: "https://example.com/", scorer: { name: "cpu" } } as PageResult;
    const after = { url: "https://example.com/", scorer: { name: "gpu", device: 1, deviceName: "RTX 4060" } } as PageResult;
    expect(scorerMismatch(before, after)).toBe(
      "the scan was scored on the CPU and this recheck on the GPU; the numbers may differ slightly, so compare them with care",
    );
    expect(scorerMismatch(before, before)).toBeUndefined();
    expect(scorerMismatch({ url: "x" } as PageResult, before)).toBeUndefined();
  });
});
