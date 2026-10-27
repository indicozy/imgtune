import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { ImageUsage, PropInfo } from "./types.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "storybook-static",
  ".imgtune",
]);
const SKIPPED_FILE = /\.(test|stories)\.[^.]+$/;
const NEXT_IMAGE_MODULE = "next/image";

type PropName = keyof ImageUsage["props"];
const TRACKED_PROPS: readonly PropName[] = ["src", "sizes", "quality", "width", "height", "fill"];

function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !SKIPPED_FILE.test(name);
}

async function collect(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await collect(abs, out);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(abs);
    }
  }
}

/** Absolute paths of the source files under `paths` (resolved against `projectDir`). */
export async function listSourceFiles(projectDir: string, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolve(projectDir, p);
    if ((await stat(abs)).isDirectory()) {
      await collect(abs, out);
    } else if (isSourceFile(abs)) {
      out.push(abs);
    }
  }
  return out.sort();
}

/** Local names bound to the default export of `next/image`. */
function nextImageBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text !== NEXT_IMAGE_MODULE) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if ((el.propertyName ?? el.name).text === "default") names.add(el.name.text);
      }
    }
  }
  return names;
}

const WRAPPER_NAMES = new Set(["memo", "forwardRef"]);

/** `memo` / `forwardRef`, bare or as `React.memo` / `React.forwardRef`. */
function isWrapperCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return WRAPPER_NAMES.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && WRAPPER_NAMES.has(callee.name.text);
}

/** True when `expr` is a function, or a memo/forwardRef chain whose first argument is one. */
function isComponentInit(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr)) return isComponentInit(expr.expression);
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return true;
  if (ts.isCallExpression(expr) && isWrapperCallee(expr.expression) && expr.arguments.length > 0) {
    return isComponentInit(expr.arguments[0]);
  }
  return false;
}

/**
 * Nearest enclosing function declaration, class, or variable whose initializer is the
 * component function (directly or via memo/forwardRef). Other variables are skipped.
 */
function componentName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n)) return n.name?.text ?? "anonymous";
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return n.name?.text ?? "anonymous";
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      isComponentInit(n.initializer)
    ) {
      return n.name.text;
    }
  }
  return "anonymous";
}

function toPropInfo(attr: ts.JsxAttribute, sf: ts.SourceFile): PropInfo {
  const start = attr.getStart(sf);
  const end = attr.getEnd();
  const init = attr.initializer;
  if (!init) return { kind: "literal", value: true, start, end };
  if (ts.isStringLiteral(init)) return { kind: "literal", value: init.text, start, end };
  if (!ts.isJsxExpression(init)) return { kind: "expression", start, end };

  const expr = init.expression;
  if (expr && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))) {
    return { kind: "literal", value: expr.text, start, end };
  }
  if (expr && ts.isNumericLiteral(expr)) {
    return { kind: "literal", value: Number(expr.text), start, end };
  }
  if (expr && expr.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "literal", value: true, start, end };
  }
  if (expr && expr.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "literal", value: false, start, end };
  }
  return { kind: "expression", start, end };
}

function srcText(attr: ts.JsxAttribute, sf: ts.SourceFile): string | undefined {
  const init = attr.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (!ts.isJsxExpression(init) || !init.expression) return undefined;
  const expr = init.expression;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return expr.getText(sf).trim();
}

function scanElement(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
  relFile: string,
  file: string,
  imageNames: Set<string>,
): ImageUsage | undefined {
  const tagText = node.tagName.getText(sf);
  let tag: ImageUsage["tag"];
  if (imageNames.has(tagText)) tag = "Image";
  else if (tagText === "img") tag = "img";
  else return undefined;

  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const props: Record<PropName, PropInfo> = {
    src: { kind: "absent" },
    sizes: { kind: "absent" },
    quality: { kind: "absent" },
    width: { kind: "absent" },
    height: { kind: "absent" },
    fill: { kind: "absent" },
  };
  let srcAttr: ts.JsxAttribute | undefined;
  let hasSpread = false;

  for (const attr of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      hasSpread = true;
      continue;
    }
    const name = attr.name.getText(sf);
    if (!(TRACKED_PROPS as readonly string[]).includes(name)) continue;
    // JSX: a later attribute overrides an earlier one with the same name.
    props[name as PropName] = toPropInfo(attr, sf);
    if (name === "src") srcAttr = attr;
  }

  const usage: ImageUsage = {
    id: `${relFile}:${line + 1}:${character + 1}`,
    file,
    relFile,
    line: line + 1,
    col: character + 1,
    tag,
    component: componentName(node),
    props,
    hasSpread,
    tagNameEnd: node.tagName.getEnd(),
  };
  if (srcAttr) {
    const text = srcText(srcAttr, sf);
    if (text !== undefined) usage.srcExpressionText = text;
  }
  return usage;
}

/** `.ts` parses as TypeScript (no JSX, so `<T>x` is a cast); `.tsx` as TSX; `.js`/`.jsx` as JSX. */
export function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.JSX;
}

/** Every next/image (`Image`) and plain `<img>` JSX element in one source file. */
export function scanFile(file: string, projectDir: string): ImageUsage[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const relFile = relative(projectDir, file).split(sep).join("/");
  const imageNames = nextImageBindings(sf);
  const usages: ImageUsage[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const usage = scanElement(node, sf, relFile, file, imageNames);
      if (usage) usages.push(usage);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return usages;
}
