import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestorsOf, sourceRootOf, unreadSourceNote } from "../src/source-root.js";
import { parseScanArgs } from "../src/remote.js";
import { parseLocateArgs } from "../src/locate-only.js";

/** A monorepo-like tree: repo/ (with .git) and repo/app/ (with package.json and its own cwd). */
async function monorepo(): Promise<{ repo: string; app: string }> {
  const repo = await mkdtemp(join(tmpdir(), "imgtune-root-"));
  const app = join(repo, "app");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(app, "src", "components"), { recursive: true });
  await writeFile(join(app, "package.json"), "{}");
  await writeFile(join(app, "src", "components", "Card.tsx"), "export const Card = () => <img />;\n");
  return { repo, app };
}

describe("sourceRootOf", () => {
  it("reads a project file from the nearest folder above the cwd that holds it", async () => {
    const { app } = await monorepo();
    const sub = join(app, "src", "components");
    expect(await sourceRootOf(sub, "src/components/Card.tsx")).toBe(join(app));
    expect(await sourceRootOf(app, "src/components/Card.tsx")).toBe(app);
  });

  it("falls back to the nearest project marker when no folder holds the file", async () => {
    const { repo, app } = await monorepo();
    expect(await sourceRootOf(join(app, "src"), "src/missing.tsx")).toBe(app);
    expect(ancestorsOf(app)[0]).toBe(app);
    // A cwd outside any marker keeps the cwd itself.
    const bare = await mkdtemp(join(tmpdir(), "imgtune-bare-"));
    expect(await sourceRootOf(bare, "src/x.tsx")).toBe(bare);
    expect(repo.length).toBeGreaterThan(0);
  });

  it("uses --root when given, whatever the cwd holds", async () => {
    const { repo, app } = await monorepo();
    expect(await sourceRootOf(app, "src/components/Card.tsx", repo)).toBe(repo);
  });

  it("names the folder a missing file was looked up in, and says so in the note", async () => {
    const { app } = await monorepo();
    const note = await unreadSourceNote(["src/nope.tsx", "src/components/Card.tsx"], app);
    expect(note).toMatch(/^unread: 2 source file\(s\) could not be read/);
    expect(note).toContain(`src/nope.tsx (not found under ${app})`);
    expect(note).toContain("--root");
    expect(note).not.toContain("Card.tsx (not found");
    expect(await unreadSourceNote([], app)).toBeUndefined();
  });

  it("names a file that is there but cannot be read as too large or unreadable", async () => {
    const { app } = await monorepo();
    const note = await unreadSourceNote(["src/components/Card.tsx"], app, join(app, "src"));
    expect(note).toContain("Card.tsx (not found under");
    expect(await unreadSourceNote(["src/components/Card.tsx"], app)).toContain("Card.tsx (too large or unreadable)");
  });
});

describe("the --root argument", () => {
  it("is read by scan and by --locate-only", () => {
    expect(parseScanArgs(["https://example.com/", "--root", "../.."]).root).toBe("../..");
    expect(parseScanArgs(["https://example.com/"]).root).toBeUndefined();
    expect(parseLocateArgs(["http://localhost:3000/list", "--from", "m.json", "--root", "/work/repo"]).root).toBe("/work/repo");
    expect(() => parseLocateArgs(["http://localhost:3000/list", "--from", "m.json", "--root"])).toThrow(/needs a value/);
  });
});
