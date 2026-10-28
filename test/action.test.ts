import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ACTION = resolve(import.meta.dirname, "../action.yml");

/** The body of the `run: |` block of the step named `name`, dedented. GitHub runs it as `bash --noprofile --norc -eo pipefail`. */
function stepRun(name: string): string {
  const lines = readFileSync(ACTION, "utf8").split("\n");
  const start = lines.findIndex((line) => line === `    - name: ${name}`);
  if (start === -1) throw new Error(`no step ${name}`);
  const run = lines.findIndex((line, i) => i > start && line === "      run: |");
  const body: string[] = [];
  for (let i = run + 1; i < lines.length && (lines[i] === "" || lines[i].startsWith("        ")); i++) {
    body.push(lines[i].slice(8));
  }
  return body.join("\n");
}

/** Runs the scan step's body with a fake `node` that exits `code`, and returns the step's exit status and GITHUB_OUTPUT. */
function runScanStep(code: number) {
  const dir = mkdtempSync(join(tmpdir(), "imgtune-action-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "node"), `#!/bin/sh\nexit ${code}\n`);
  chmodSync(join(bin, "node"), 0o755);
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const script = join(dir, "step.sh");
  writeFileSync(script, stepRun("Scan"));
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      IMGTUNE_URLS: "http://localhost:3000",
      IMGTUNE_FAIL_OVER: "",
      IMGTUNE_VIEWPORTS: "",
      IMGTUNE_ACTION_PATH: dir,
      IMGTUNE_RESULTS: join(dir, "results"),
    },
    encoding: "utf8",
  });
  return { status: result.status, output: readFileSync(output, "utf8") };
}

describe("action.yml scan step", () => {
  it("parses as bash", () => {
    execFileSync("bash", ["-n", "-c", stepRun("Scan")]);
  });

  it("writes the scan's exit code to the step output and exits 0, so the last step decides", () => {
    const { status, output } = runScanStep(3);
    expect(status).toBe(0);
    expect(output).toBe("exit-code=3\n");
  });

  it("writes exit-code=0 when the scan passes", () => {
    const { status, output } = runScanStep(0);
    expect(status).toBe(0);
    expect(output).toBe("exit-code=0\n");
  });
});
