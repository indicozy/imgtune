import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { METRICS, type Metric } from "./metric.js";
import type { ImgtuneConfig, QualityLevel, Viewport } from "./types.js";

export type Command = "audit" | "apply" | "verify" | "restore";

const COMMANDS: readonly Command[] = ["audit", "apply", "verify", "restore"];
const QUALITY_LEVELS: readonly QualityLevel[] = ["relaxed", "strict"];
const CONFIG_FILE = "imgtune.config.json";

const DEFAULT_METRIC: Metric = "ssimulacra2";
type Preset = { threshold: number; delta?: number; tolerance: number };
const SSIMULACRA2_PRESETS: Record<QualityLevel, Preset> = {
  relaxed: { threshold: 70, delta: 2, tolerance: 5 },
  strict: { threshold: 80, delta: 1, tolerance: 3 },
};
/**
 * ssimulacra2 presets are relative (R38): `threshold` is the floor and `delta` the allowed drop from the current quality.
 * ssim keeps its absolute bars.
 */
const QUALITY_PRESETS: Record<Metric, Record<QualityLevel, Preset>> = {
  ssimulacra2: SSIMULACRA2_PRESETS,
  "ssimulacra2-native": SSIMULACRA2_PRESETS,
  ssim: {
    relaxed: { threshold: 0.975, tolerance: 5 },
    strict: { threshold: 0.99, tolerance: 3 },
  },
};

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

export const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { name: "iphone-se", width: 375, height: 667, dpr: 2, mobile: true, userAgent: IPHONE_UA },
  { name: "iphone-15", width: 390, height: 844, dpr: 3, mobile: true, userAgent: IPHONE_UA },
  { name: "pixel-7", width: 412, height: 915, dpr: 2.625, mobile: true, userAgent: ANDROID_UA },
  { name: "iphone-15-pro-max", width: 430, height: 932, dpr: 3, mobile: true, userAgent: IPHONE_UA },
  { name: "desktop", width: 1440, height: 900, dpr: 2, mobile: false },
  { name: "desktop-1280", width: 1280, height: 800, dpr: 1, mobile: false },
];

/**
 * Keys read from `imgtune.config.json`. `projectDir` always comes from `--project` or cwd. `threshold` stays unchecked
 * here: its range depends on the metric the flags and the file settle on, so `loadConfig` checks it.
 */
type FileConfig = Partial<Omit<ImgtuneConfig, "projectDir" | "threshold" | "delta">> & { threshold?: unknown; maxScoreDrop?: unknown };

interface Flags {
  project?: string;
  paths: string[];
  quality?: QualityLevel;
  metric?: Metric;
  threshold?: string;
  maxDrop?: string;
  port?: number;
  url?: string;
  all: boolean;
  allowGrowth: boolean;
}

export async function loadConfig(
  argv: string[],
  cwd: string,
): Promise<{ command: Command; config: ImgtuneConfig; allowGrowth: boolean }> {
  const { command, flags } = parseArgs(argv);
  if (flags.allowGrowth && command !== "apply") throw new Error("--allow-growth only applies to apply");
  const projectDir = resolve(cwd, flags.project ?? ".");
  const file = await readConfigFile(projectDir);

  const metric = flags.metric ?? file.metric ?? DEFAULT_METRIC;
  const quality = flags.quality ?? file.quality ?? "relaxed";
  const preset = QUALITY_PRESETS[metric][quality];
  // An explicit threshold is an absolute bar and switches the relative rule off (R38).
  const explicit = flags.threshold !== undefined || file.threshold !== undefined;
  const dropValue = flags.maxDrop ?? file.maxScoreDrop;
  if (dropValue !== undefined) {
    if (explicit) throw new Error("--max-drop has no effect with an absolute --threshold (remove one of them)");
    if (metric === "ssim") throw new Error("--max-drop applies to ssimulacra2 only");
  }
  const delta =
    dropValue === undefined
      ? explicit
        ? undefined
        : preset.delta
      : parseDrop(dropValue, flags.maxDrop !== undefined ? "--max-drop" : CONFIG_FILE);
  const threshold =
    flags.threshold !== undefined
      ? parseThreshold(flags.threshold, "--threshold", metric)
      : parseThreshold(file.threshold ?? preset.threshold, CONFIG_FILE, metric);

  const config: ImgtuneConfig = {
    projectDir,
    paths: flags.paths.length > 0 ? flags.paths : (file.paths ?? ["."]),
    quality,
    metric,
    threshold,
    delta,
    tolerance: file.tolerance ?? preset.tolerance,
    market: file.market ?? "ae-en",
    port: flags.port ?? file.port ?? 3999,
    devCommand: file.devCommand,
    sitemapUrl: file.sitemapUrl,
    url: flags.url ?? file.url,
    ssimulacra2Path: file.ssimulacra2Path === undefined ? undefined : resolve(projectDir, file.ssimulacra2Path),
    urls: file.urls ?? {},
    viewports: file.viewports ?? DEFAULT_VIEWPORTS.map((viewport) => ({ ...viewport })),
    samplesPerComponent: file.samplesPerComponent ?? 20,
    maxPagesPerPattern: file.maxPagesPerPattern ?? 2,
    includeDone: flags.all || (file.includeDone ?? false),
  };
  return { command, config, allowGrowth: flags.allowGrowth };
}

function parseArgs(argv: string[]): { command: Command; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = { paths: [], all: false, allowGrowth: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") {
      flags.all = true;
      continue;
    }
    if (arg === "--allow-growth") {
      flags.allowGrowth = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${name} needs a value`);
      }
      value = next;
      i++;
    }

    switch (name) {
      case "--project":
        flags.project = value;
        break;
      case "--path":
        flags.paths.push(value);
        break;
      case "--quality":
        flags.quality = parseQuality(value, "--quality");
        break;
      case "--metric":
        flags.metric = parseMetric(value, "--metric");
        break;
      case "--threshold":
        flags.threshold = value;
        break;
      case "--max-drop":
        flags.maxDrop = value;
        break;
      case "--port":
        flags.port = parsePort(value, "--port");
        break;
      case "--url":
        flags.url = value;
        break;
      default:
        throw new Error(`Unknown option ${name}`);
    }
  }

  if (positionals.length === 0) {
    throw new Error(`Missing command: expected one of ${COMMANDS.join(", ")}`);
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument "${positionals[1]}"`);
  }
  const command = positionals[0];
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Unknown command "${command}": expected one of ${COMMANDS.join(", ")}`);
  }
  return { command: command as Command, flags };
}

async function readConfigFile(projectDir: string): Promise<FileConfig> {
  const file = join(projectDir, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }

  const fileConfig: FileConfig = { ...(parsed as FileConfig) };
  if (fileConfig.quality !== undefined) {
    fileConfig.quality = parseQuality(fileConfig.quality, CONFIG_FILE);
  }
  if (fileConfig.metric !== undefined) {
    fileConfig.metric = parseMetric(fileConfig.metric, CONFIG_FILE);
  }
  if (fileConfig.maxScoreDrop !== undefined && typeof fileConfig.maxScoreDrop !== "string" && typeof fileConfig.maxScoreDrop !== "number") {
    throw new Error(`Invalid maxScoreDrop ${JSON.stringify(fileConfig.maxScoreDrop)} (${CONFIG_FILE}): expected a positive number`);
  }
  if (fileConfig.ssimulacra2Path !== undefined && typeof fileConfig.ssimulacra2Path !== "string") {
    throw new Error(`Invalid ssimulacra2Path ${JSON.stringify(fileConfig.ssimulacra2Path)} (${CONFIG_FILE}): expected a path string`);
  }
  if (fileConfig.port !== undefined) {
    fileConfig.port = parsePort(fileConfig.port, CONFIG_FILE);
  }
  if (fileConfig.tolerance !== undefined) {
    fileConfig.tolerance = parsePositive(fileConfig.tolerance, "tolerance", false);
  }
  if (fileConfig.samplesPerComponent !== undefined) {
    fileConfig.samplesPerComponent = parsePositive(fileConfig.samplesPerComponent, "samplesPerComponent", true);
  }
  if (fileConfig.maxPagesPerPattern !== undefined) {
    fileConfig.maxPagesPerPattern = parsePositive(fileConfig.maxPagesPerPattern, "maxPagesPerPattern", true);
  }
  if (fileConfig.includeDone !== undefined && typeof fileConfig.includeDone !== "boolean") {
    throw new Error(`Invalid includeDone ${JSON.stringify(fileConfig.includeDone)} (${CONFIG_FILE}): expected true or false`);
  }
  return fileConfig;
}

function parsePositive(value: unknown, key: string, integer: boolean): number {
  if (typeof value !== "number" || !(value > 0) || (integer && !Number.isInteger(value))) {
    const kind = integer ? "integer" : "number";
    throw new Error(`Invalid ${key} ${JSON.stringify(value)} (${CONFIG_FILE}): expected a positive ${kind}`);
  }
  return value;
}

function parseQuality(value: unknown, source: string): QualityLevel {
  if (typeof value !== "string" || !(QUALITY_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid quality ${JSON.stringify(value)} (${source}): expected one of ${QUALITY_LEVELS.join(", ")}`,
    );
  }
  return value as QualityLevel;
}

/** The allowed score drop of the relative rule (R38): a positive number of points. */
function parseDrop(value: unknown, source: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    const key = source === "--max-drop" ? "max-drop" : "maxScoreDrop";
    throw new Error(`Invalid ${key} ${JSON.stringify(value)} (${source}): expected a positive number of points`);
  }
  return n;
}

function parseMetric(value: unknown, source: string): Metric {
  if (typeof value !== "string" || !(METRICS as readonly string[]).includes(value)) {
    throw new Error(`Invalid metric ${JSON.stringify(value)} (${source}): expected one of ${METRICS.join(", ")}`);
  }
  return value as Metric;
}

/** A threshold on the metric's scale: 0-100 for ssimulacra2 (either scorer), 0-1 for ssim. */
function parseThreshold(value: unknown, source: string, metric: Metric): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  const max = metric === "ssim" ? 1 : 100;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) {
    throw new Error(`Invalid threshold ${JSON.stringify(value)} (${source}): expected a number between 0 and ${max} for ${metric}`);
  }
  return n;
}

function parsePort(value: unknown, source: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port ${JSON.stringify(value)} (${source}): expected an integer between 1 and 65535`);
  }
  return n;
}
