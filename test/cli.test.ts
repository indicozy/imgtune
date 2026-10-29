import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha1 } from "../src/atomic.js";
import { scanFile } from "../src/scan.js";
import { saveState } from "../src/state.js";

// Runs the built CLI (dist/cli.js), the same file the npm bin points at. The suite builds it first, so a missing or
// stale dist cannot make it pass or fail for the wrong reason.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist/cli.js");
const TSC = join(ROOT, "node_modules/typescript/bin/tsc");

const CARD = `import Image from "next/image";

export function Card() {
  return <Image quality={70} sizes="50vw" src="/a.png" width={100} height={100} alt="" />;
}
`;

/** A project with one applied usage: Card at quality 70, recorded in the state as applied by an earlier apply. */
async function appliedProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "imgtune-cli-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/Card.tsx"), CARD);
  const [usage] = scanFile(join(dir, "src/Card.tsx"), dir);
  await saveState(dir, [
    {
      usageId: usage.id,
      relFile: "src/Card.tsx",
      component: "Card",
      fileHash: sha1(CARD),
      applied: { sizes: "50vw", quality: 70 },
      before: { quality: 75 },
      at: "2026-10-29T00:00:00.000Z",
    },
  ]);
  return dir;
}

function cli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("imgtune apply --raise (built CLI)", () => {
  beforeAll(() => {
    const built = spawnSync(process.execPath, [TSC, "-p", join(ROOT, "tsconfig.build.json")], { encoding: "utf8" });
    if (built.status !== 0 || !existsSync(CLI)) {
      throw new Error(`building ${CLI} failed:\n${built.stdout}${built.stderr}`);
    }
  }, 120_000);

  it("parses Component=quality and raises the applied quality, from the project directory", async () => {
    const dir = await appliedProject();

    const out = cli(["apply", "--raise", "Card=75"], dir);

    expect(out.status).toBe(0);
    expect(out.stdout).toContain("raised Card quality 70 -> 75\n");
    expect(out.stdout).toContain("run imgtune verify to measure it\n");
    expect(readFileSync(join(dir, "src/Card.tsx"), "utf8")).toContain("quality={75}");
  }, 60_000);

  it("parses the --project form the verify hint prints, from another working directory", async () => {
    const dir = await appliedProject();

    const out = cli(["apply", "--project", dir, "--raise", "Card=75"], tmpdir());

    expect(out.status).toBe(0);
    expect(out.stdout).toContain("raised Card quality 70 -> 75\n");
    expect(readFileSync(join(dir, "src/Card.tsx"), "utf8")).toContain("quality={75}");
  }, 60_000);

  it("rejects a malformed --raise before it touches any file", async () => {
    const dir = await appliedProject();

    const out = cli(["apply", "--raise", "Card=0"], dir);

    expect(out.status).toBe(2);
    expect(out.stderr).toContain("--raise expects Component=quality with a quality from 1 to 100");
    expect(readFileSync(join(dir, "src/Card.tsx"), "utf8")).toBe(CARD);
  }, 60_000);

  it("reports a component with no applied usage by name", async () => {
    const dir = await appliedProject();

    const out = cli(["apply", "--raise", "Nope=75"], dir);

    expect(out.status).toBe(1);
    expect(out.stderr).toContain("imgtune: Nope: no applied quality in the state");
  }, 60_000);
});
