import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";

const EMPTY = resolve(import.meta.dirname, "fixtures/empty");
const WITH_CONFIG = resolve(import.meta.dirname, "fixtures/with-config");
const STRING_VALUES = resolve(import.meta.dirname, "fixtures/string-values");
const created: string[] = [];

/** A project dir whose imgtune.config.json holds `config`. */
function projectWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "imgtune-config-"));
  created.push(dir);
  writeFileSync(join(dir, "imgtune.config.json"), JSON.stringify(config));
  return dir;
}

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("defaults", async () => {
    const { command, config } = await loadConfig(["audit"], EMPTY);
    expect(command).toBe("audit");
    expect(config.quality).toBe("relaxed");
    expect(config.metric).toBe("ssimulacra2");
    expect(config.threshold).toBe(70);
    expect(config.delta).toBe(2);
    expect(config.tolerance).toBe(5);
    expect(config.viewports).toHaveLength(6);
    expect(config.paths).toEqual(["."]);
  });

  it("strict", async () => {
    const { config } = await loadConfig(["audit", "--quality", "strict"], EMPTY);
    expect(config.threshold).toBe(80);
    expect(config.delta).toBe(1);
    expect(config.tolerance).toBe(3);
  });

  it("ssim keeps the 0.975 and 0.99 presets", async () => {
    const relaxed = await loadConfig(["audit", "--metric", "ssim"], EMPTY);
    expect(relaxed.config.threshold).toBe(0.975);
    expect(relaxed.config.delta).toBeUndefined();
    const strict = await loadConfig(["audit", "--metric", "ssim", "--quality", "strict"], EMPTY);
    expect(strict.config.threshold).toBe(0.99);
    expect(strict.config.metric).toBe("ssim");
  });

  it("metric can come from the file, and the flag wins over it", async () => {
    const dir = projectWith({ metric: "ssim" });
    expect((await loadConfig(["audit"], dir)).config.metric).toBe("ssim");
    expect((await loadConfig(["audit", "--metric=ssimulacra2"], dir)).config.metric).toBe("ssimulacra2");
  });

  it("threshold override", async () => {
    const { config } = await loadConfig(
      ["audit", "--quality", "strict", "--threshold", "92"],
      EMPTY,
    );
    expect(config.threshold).toBe(92);
    expect(config.delta).toBeUndefined();
  });

  it("threshold is checked against the metric's range (0-100 ssimulacra2, 0-1 ssim)", async () => {
    await expect(loadConfig(["audit", "--threshold", "0.98"], EMPTY)).resolves.toMatchObject({ config: { threshold: 0.98 } });
    await expect(loadConfig(["audit", "--threshold", "101"], EMPTY)).rejects.toThrow(/Invalid threshold "101" \(--threshold\).*0 and 100/);
    await expect(loadConfig(["audit", "--metric", "ssim", "--threshold", "88"], EMPTY)).rejects.toThrow(/0 and 1/);
  });

  it("--max-drop and maxScoreDrop replace the preset delta; strict keeps its own otherwise", async () => {
    expect((await loadConfig(["audit", "--max-drop", "4"], EMPTY)).config.delta).toBe(4);
    expect((await loadConfig(["audit", "--max-drop=2.5"], EMPTY)).config.delta).toBe(2.5);
    expect((await loadConfig(["audit"], projectWith({ maxScoreDrop: 4 }))).config.delta).toBe(4);
    expect((await loadConfig(["audit", "--max-drop", "3"], projectWith({ maxScoreDrop: 4 }))).config.delta).toBe(3);
    expect((await loadConfig(["audit", "--quality", "strict"], EMPTY)).config.delta).toBe(1);
  });

  it("refuses a maxScoreDrop that is not a positive number, or that conflicts with the rule", async () => {
    await expect(loadConfig(["audit", "--max-drop", "0"], EMPTY)).rejects.toThrow('Invalid max-drop "0" (--max-drop)');
    await expect(loadConfig(["audit", "--max-drop", "-1"], EMPTY)).rejects.toThrow("Invalid max-drop");
    await expect(loadConfig(["audit"], projectWith({ maxScoreDrop: "x" }))).rejects.toThrow("Invalid maxScoreDrop");
    await expect(loadConfig(["audit", "--threshold", "80", "--max-drop", "2"], EMPTY)).rejects.toThrow(
      "--max-drop has no effect with an absolute --threshold",
    );
    await expect(loadConfig(["audit", "--metric", "ssim", "--max-drop", "2"], EMPTY)).rejects.toThrow(
      "--max-drop applies to ssimulacra2 only",
    );
  });

  it("refuses an unknown metric, from a flag or the file", async () => {
    await expect(loadConfig(["audit", "--metric", "psnr"], EMPTY)).rejects.toThrow(
      'Invalid metric "psnr" (--metric): expected one of ssimulacra2, ssim',
    );
    await expect(loadConfig(["audit"], projectWith({ metric: 1 }))).rejects.toThrow(
      "Invalid metric 1 (imgtune.config.json)",
    );
  });

  it("resolves ssimulacra2Path against the project", async () => {
    const { config } = await loadConfig(["audit"], projectWith({ ssimulacra2Path: "bin/ssimulacra2_rs" }));
    expect(config.ssimulacra2Path).toBe(join(config.projectDir, "bin/ssimulacra2_rs"));
    await expect(loadConfig(["audit"], projectWith({ ssimulacra2Path: 3 }))).rejects.toThrow(
      "Invalid ssimulacra2Path 3 (imgtune.config.json)",
    );
  });

  it("file + flags", async () => {
    const { config } = await loadConfig(["audit", "--port", "4200"], WITH_CONFIG);
    expect(config.urls).toEqual({ "/[store]/[...p]": ["/ae-en/x"] });
    expect(config.port).toBe(4200);
  });

  it("string port and threshold in file come back as numbers", async () => {
    const { config } = await loadConfig(["audit"], STRING_VALUES);
    expect(config.port).toBe(4100);
    expect(config.threshold).toBe(0.98);
    expect(typeof config.port).toBe("number");
    expect(typeof config.threshold).toBe("number");
  });

  it("reads valid counts, tolerance and includeDone from the file", async () => {
    const { config } = await loadConfig(
      ["audit"],
      projectWith({ samplesPerComponent: 5, maxPagesPerPattern: 3, tolerance: 4.5, includeDone: true }),
    );
    expect(config.samplesPerComponent).toBe(5);
    expect(config.maxPagesPerPattern).toBe(3);
    expect(config.tolerance).toBe(4.5);
    expect(config.includeDone).toBe(true);
  });

  it("refuses file values that are not positive integers, positive numbers or booleans", async () => {
    const bad: [string, unknown][] = [
      ["samplesPerComponent", 0],
      ["samplesPerComponent", 2.5],
      ["maxPagesPerPattern", -1],
      ["maxPagesPerPattern", "2"],
      ["tolerance", 0],
      ["tolerance", "5"],
      ["includeDone", "false"],
    ];
    for (const [key, value] of bad) {
      await expect(loadConfig(["audit"], projectWith({ [key]: value }))).rejects.toThrow(
        `Invalid ${key} ${JSON.stringify(value)} (imgtune.config.json)`,
      );
    }
  });

  it("bad args", async () => {
    await expect(loadConfig(["audit", "--quality", "ultra"], EMPTY)).rejects.toThrow(
      /relaxed.*strict/,
    );
  });

  it("--allow-growth is read for apply and refused for other commands", async () => {
    const applied = await loadConfig(["apply", "--allow-growth"], EMPTY);
    expect(applied.command).toBe("apply");
    expect(applied.allowGrowth).toBe(true);
    expect((await loadConfig(["apply"], EMPTY)).allowGrowth).toBe(false);
    await expect(loadConfig(["audit", "--allow-growth"], EMPTY)).rejects.toThrow(
      "--allow-growth only applies to apply",
    );
  });

  it("url + verify", async () => {
    const { command, config } = await loadConfig(
      ["verify", "--url", "http://localhost:3000"],
      EMPTY,
    );
    expect(command).toBe("verify");
    expect(config.url).toBe("http://localhost:3000");
  });
});
