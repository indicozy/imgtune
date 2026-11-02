// The arguments of `imgtune audit` (audit.ts): the audit-only flags, the check passthrough, and the refusals.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { parseAuditArgs, sourceFilesOf } from "../src/audit.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/audit-app", import.meta.url));

describe("parseAuditArgs", () => {
  it("needs --app and --prod", () => {
    expect(() => parseAuditArgs(["--prod", "https://shop.example"])).toThrow(/needs --app/);
    expect(() => parseAuditArgs(["--app", "web"])).toThrow(/needs --prod/);
  });

  it("keeps the origin of --prod and --dev, and reads the check flags", () => {
    const args = parseAuditArgs([
      "--app",
      "web",
      "--prod",
      "https://shop.example/some/path",
      "--dev",
      "http://localhost:3000/",
      "--block-third-party",
      "--allow-host",
      "cdn.x.io",
      "--qualities",
      "75,85",
      "--deep",
      "5",
      "--sample-per-pattern",
      "2",
    ]);
    expect(args.app).toBe("web");
    expect(args.prod).toBe("https://shop.example");
    expect(args.dev).toBe("http://localhost:3000");
    expect(args.flags.thirdParty).toEqual({ block: true, allowHosts: ["cdn.x.io"] });
    expect(args.flags.qualities).toEqual([75, 85]);
    expect(args.flags.deep).toBe(5);
    expect(args.flags.samplePerPattern).toBe(2);
    expect(args.flags.target).toBeUndefined();
  });

  it("takes --urls-from as its URL source", () => {
    expect(parseAuditArgs(["--app", "web", "--prod", "https://shop.example", "--urls-from", "urls.txt"]).flags.urlsFrom).toBe("urls.txt");
  });

  it("refuses a URL in place of --prod, and a --dev that is not an http origin", () => {
    expect(() => parseAuditArgs(["--app", "web", "--prod", "https://shop.example", "https://other.example/x"])).toThrow(/takes --prod for the site/);
    expect(() => parseAuditArgs(["--app", "web", "--prod", "ftp://shop.example"])).toThrow(/http or https origin/);
    expect(() => parseAuditArgs(["--app", "web", "--prod", "https://shop.example", "--dev", "nope"])).toThrow(/http or https origin/);
  });

  it("takes --max-locales (3 by default), a whole number of at least 1", () => {
    expect(parseAuditArgs(["--app", "web", "--prod", "https://shop.example"]).maxLocales).toBe(3);
    expect(parseAuditArgs(["--app", "web", "--prod", "https://shop.example", "--max-locales", "5"]).maxLocales).toBe(5);
    expect(() => parseAuditArgs(["--app", "web", "--prod", "https://shop.example", "--max-locales", "0"])).toThrow(/--max-locales needs a whole number/);
    expect(() => parseAuditArgs(["--app", "web", "--prod", "https://shop.example", "--max-locales"])).toThrow(/--max-locales needs a value/);
  });

  it("allows third-party requests by default, as check does", () => {
    expect(parseAuditArgs(["--app", "web", "--prod", "https://shop.example"]).flags.thirdParty).toEqual({ block: false, allowHosts: [] });
  });
});

describe("sourceFilesOf", () => {
  it("lists the files under app/ and pages/ of the app root, skipping node_modules", async () => {
    const files = await sourceFilesOf(FIXTURE);
    expect(files).toEqual(expect.arrayContaining(["app/page.tsx", "app/blog/[slug]/page.tsx", "pages/posts/[id].tsx"]));
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("returns nothing for an app root with no route folders", async () => {
    expect(await sourceFilesOf(fileURLToPath(new URL("./fixtures", import.meta.url)) + "/no-such-app")).toEqual([]);
  });
});
