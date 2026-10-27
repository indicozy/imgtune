import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Next 16 defaults used when `images.*` is absent or not a literal. */
export const NEXT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const NEXT_IMAGE_SIZES = [32, 48, 64, 96, 128, 256, 384];
const NEXT_FORMATS = ["image/webp"];

const CONFIG_FILES = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"];

export interface ImageConfig {
  /** Absolute path of the next.config file that was read; "" when the project has none. */
  file: string;
  loaderFile?: string;
  deviceSizes: number[];
  imageSizes: number[];
  qualities?: number[];
  /** `images.formats` as written (MIME types). */
  formats: string[];
  /** Source offsets of the `qualities` array literal, from `[` through `]`. */
  qualitiesRange?: { start: number; end: number };
  /** Values that were not literals and were treated as absent. */
  warnings: string[];
}

/**
 * Static read of the project's `next.config.*` (first existing of ts, mts, mjs, js, cjs). Finds the `images` property
 * in any object literal (`const x = {...}`, `export default {...}`, `withX({...})`, a function returning the object)
 * and reads its literal `deviceSizes`, `imageSizes`, `qualities`, `formats` and `loaderFile`. Anything else is
 * treated as absent and reported in `warnings`.
 */
export function readImageConfig(projectDir: string): ImageConfig {
  const file = CONFIG_FILES.map((name) => join(projectDir, name)).find((p) => existsSync(p));
  const config: ImageConfig = {
    file: file ?? "",
    deviceSizes: [...NEXT_DEVICE_SIZES],
    imageSizes: [...NEXT_IMAGE_SIZES],
    formats: [...NEXT_FORMATS],
    warnings: [],
  };
  if (!file) return config;

  const text = readFileSync(file, "utf8");
  const kind = /\.m?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const images = findImagesProperty(sf);
  if (!images) return config;

  const value = ts.isPropertyAssignment(images) ? unwrap(images.initializer) : undefined;
  if (!value || !ts.isObjectLiteralExpression(value)) {
    config.warnings.push("images is not an object literal; Next defaults assumed");
    return config;
  }
  readImagesObject(value, sf, config);
  return config;
}

/** The first `images` property assignment in source order, or undefined. */
function findImagesProperty(sf: ts.SourceFile): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
  let found: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && propName(node.name) === "images") {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function readImagesObject(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile, config: ImageConfig): void {
  // Last occurrence wins, as in JavaScript. `undefined` marks a shorthand (non-literal) entry.
  const values = new Map<string, ts.Expression | undefined>();
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = propName(prop.name);
      if (name) values.set(name, unwrap(prop.initializer));
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      values.set(prop.name.text, undefined);
    }
  }

  const read = <T>(name: string, reader: (node: ts.Expression) => T | undefined): T | undefined => {
    if (!values.has(name)) return undefined;
    const node = values.get(name);
    const value = node && reader(node);
    if (value === undefined) config.warnings.push(`images.${name} is not a literal list; treated as absent`);
    return value;
  };

  config.deviceSizes = read("deviceSizes", numberArray) ?? config.deviceSizes;
  config.imageSizes = read("imageSizes", numberArray) ?? config.imageSizes;
  config.formats = read("formats", stringArray) ?? config.formats;
  config.loaderFile = read("loaderFile", stringValue);

  const qualitiesNode = values.get("qualities");
  const qualities = read("qualities", numberArray);
  if (qualities && qualitiesNode) {
    config.qualities = qualities;
    config.qualitiesRange = { start: qualitiesNode.getStart(sf), end: qualitiesNode.getEnd() };
  }
}

function propName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined;
}

/** Strips parentheses and type-only wrappers (`as`, `satisfies`, `<T>`) around an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** A non-empty array of numeric literals, or undefined. */
function numberArray(node: ts.Expression): number[] | undefined {
  const array = unwrap(node);
  if (!ts.isArrayLiteralExpression(array) || array.elements.length === 0) return undefined;
  const numbers: number[] = [];
  for (const element of array.elements) {
    if (!ts.isNumericLiteral(element)) return undefined;
    numbers.push(Number(element.text));
  }
  return numbers;
}

/** A non-empty array of string literals, or undefined. */
function stringArray(node: ts.Expression): string[] | undefined {
  const array = unwrap(node);
  if (!ts.isArrayLiteralExpression(array) || array.elements.length === 0) return undefined;
  const strings: string[] = [];
  for (const element of array.elements) {
    if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) return undefined;
    strings.push(element.text);
  }
  return strings;
}

function stringValue(node: ts.Expression): string | undefined {
  const value = unwrap(node);
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
}
