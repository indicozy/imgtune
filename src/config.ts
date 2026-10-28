import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ImgtuneConfig, QualityLevel, Viewport } from "./types.js";

export type Command = "audit" | "apply" | "verify" | "restore";

const COMMANDS: readonly Command[] = ["audit", "apply", "verify", "restore"];
const QUALITY_LEVELS: readonly QualityLevel[] = ["relaxed", "strict"];
const CONFIG_FILE = "imgtune.config.json";

const QUALITY_PRESETS: Record<QualityLevel, { threshold: number; tolerance: number }> = {
  relaxed: { threshold: 0.975, tolerance: 5 },
  strict: { threshold: 0.99, tolerance: 3 },
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

/** Keys read from `imgtune.config.json`. `projectDir` always comes from `--project` or cwd. */
type FileConfig = Partial<Omit<ImgtuneConfig, "projectDir">>;

interface Flags {
  project?: string;
  paths: string[];
  quality?: QualityLevel;
  threshold?: number;
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

  const quality = flags.quality ?? file.quality ?? "relaxed";
  const preset = QUALITY_PRESETS[quality];

  const config: ImgtuneConfig = {
    projectDir,
    paths: flags.paths.length > 0 ? flags.paths : (file.paths ?? ["."]),
    quality,
    threshold: flags.threshold ?? file.threshold ?? preset.threshold,
    tolerance: file.tolerance ?? preset.tolerance,
    market: file.market ?? "ae-en",
    port: flags.port ?? file.port ?? 3999,
    devCommand: file.devCommand,
    sitemapUrl: file.sitemapUrl,
    url: flags.url ?? file.url,
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
      case "--threshold":
        flags.threshold = parseThreshold(value, "--threshold");
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
  if (fileConfig.threshold !== undefined) {
    fileConfig.threshold = parseThreshold(fileConfig.threshold, CONFIG_FILE);
  }
  if (fileConfig.port !== undefined) {
    fileConfig.port = parsePort(fileConfig.port, CONFIG_FILE);
  }
  return fileConfig;
}

function parseQuality(value: unknown, source: string): QualityLevel {
  if (typeof value !== "string" || !(QUALITY_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid quality ${JSON.stringify(value)} (${source}): expected one of ${QUALITY_LEVELS.join(", ")}`,
    );
  }
  return value as QualityLevel;
}

function parseThreshold(value: unknown, source: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`Invalid threshold ${JSON.stringify(value)} (${source}): expected a number between 0 and 1`);
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
