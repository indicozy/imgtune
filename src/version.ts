import { readFileSync } from "node:fs";

/** The version in package.json. Read from `../package.json`, which is the package root for both src/ and dist/. */
export const IMGTUNE_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
