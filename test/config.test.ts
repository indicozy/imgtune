import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";

const EMPTY = resolve(import.meta.dirname, "fixtures/empty");
const WITH_CONFIG = resolve(import.meta.dirname, "fixtures/with-config");
const STRING_VALUES = resolve(import.meta.dirname, "fixtures/string-values");

describe("loadConfig", () => {
  it("defaults", async () => {
    const { command, config } = await loadConfig(["audit"], EMPTY);
    expect(command).toBe("audit");
    expect(config.quality).toBe("relaxed");
    expect(config.threshold).toBe(0.975);
    expect(config.tolerance).toBe(5);
    expect(config.viewports).toHaveLength(5);
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

  it("bad args", async () => {
    await expect(loadConfig(["audit", "--quality", "ultra"], EMPTY)).rejects.toThrow(
      /relaxed.*strict/,
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
