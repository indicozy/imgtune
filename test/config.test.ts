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
    expect(config.threshold).toBe(0.975);
    expect(config.tolerance).toBe(5);
    expect(config.viewports).toHaveLength(6);
    expect(config.paths).toEqual(["."]);
  });

  it("strict", async () => {
    const { config } = await loadConfig(["audit", "--quality", "strict"], EMPTY);
    expect(config.threshold).toBe(0.99);
    expect(config.tolerance).toBe(3);
  });

  it("threshold override", async () => {
    const { config } = await loadConfig(
      ["audit", "--quality", "strict", "--threshold", "0.98"],
      EMPTY,
    );
    expect(config.threshold).toBe(0.98);
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
