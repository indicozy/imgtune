import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { listSourceFiles, scriptKind } from "./scan.js";

export interface RoutePattern {
  /** App Router route pattern with route groups removed, e.g. `/[store]/[...plpPath]`. */
  pattern: string;
  /** Absolute path of the `page.*` file that renders the route. */
  pageFile: string;
}

export interface RouteIndex {
  routesFor(file: string): RoutePattern[];
  routesByFile: Map<string, RoutePattern[]>;
}

const NO_INPUTS_FOUND = 18003;
const ROUTE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
/** `(group)` segments; intercepting segments such as `(.)photo` or `(..)(..)x` are kept. */
const ROUTE_GROUP = /^\((?!\.)[^()]*\)$/;

interface RouteFile {
  file: string;
  kind: "page" | "layout";
  dir: string;
  pattern: string;
}

/** Route pattern for a directory relative to the app root. */
function routePattern(relDir: string): string {
  const segments = relDir
    .split(sep)
    .filter((s) => s !== "" && !s.startsWith("@") && !ROUTE_GROUP.test(s));
  return "/" + segments.join("/");
}

/** `page.*` / `layout.*` under `<project>/app` or `<project>/src/app`; undefined for anything else. */
function routeFileOf(file: string, appRoots: string[]): RouteFile | undefined {
  const ext = ROUTE_EXTENSIONS.find((e) => file.endsWith(e));
  if (!ext) return undefined;
  const stem = basename(file, ext);
  if (stem !== "page" && stem !== "layout") return undefined;
  const root = appRoots.find((r) => file.startsWith(r + sep));
  if (!root) return undefined;
  const dir = dirname(file);
  return { file, kind: stem, dir, pattern: routePattern(relative(root, dir)) };
}

/**
 * Compiler options from the project's tsconfig.json (`extends` included). Module resolution
 * is always Bundler, like Next.js itself, so extensionless relative imports resolve; JS files
 * are resolvable too.
 */
function compilerOptions(projectDir: string): ts.CompilerOptions {
  let options: ts.CompilerOptions = {
    jsx: ts.JsxEmit.Preserve,
  };
  const configFile = join(projectDir, "tsconfig.json");
  if (existsSync(configFile)) {
    const read = ts.readConfigFile(configFile, ts.sys.readFile);
    if (read.error) {
      throw new Error(
        `${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")} (${configFile})`,
      );
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configFile));
    for (const diagnostic of parsed.errors) {
      // 18003: "No inputs were found" is expected for a tsconfig that only sets compilerOptions.
      if (diagnostic.code === NO_INPUTS_FOUND) continue;
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      console.warn(`imgtune: tsconfig: ${message} (${configFile})`);
    }
    options = parsed.options;
  }
  return {
    ...options,
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
}

/** Module specifiers of static imports/exports, `import()` and `require()` calls. */
function importSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const add = (expr: ts.Expression | undefined): void => {
    if (expr && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))) {
      out.push(expr.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isDynamicImport || isRequire) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Project file that `spec` (imported from `from`) resolves to; undefined for anything outside the source set. */
function resolveImport(
  spec: string,
  from: string,
  options: ts.CompilerOptions,
  cache: ts.ModuleResolutionCache,
  known: Set<string>,
): string | undefined {
  const resolved = ts.resolveModuleName(spec, from, options, ts.sys, cache).resolvedModule;
  if (!resolved || resolved.isExternalLibraryImport) return undefined;
  if (resolved.extension === ts.Extension.Dts) return undefined;
  const target = resolve(resolved.resolvedFileName);
  return known.has(target) ? target : undefined;
}

/**
 * Import graph of the project's source files, mapped to the App Router pages that render each
 * file. A file reached from a `layout.*` maps to every page in that layout's directory subtree.
 */
export async function buildRouteIndex(projectDir: string): Promise<RouteIndex> {
  const root = resolve(projectDir);
  const files = await listSourceFiles(root, ["."]);
  const known = new Set(files);
  const options = compilerOptions(root);
  const cache = ts.createModuleResolutionCache(root, (f) => f, options);
  const appRoots = [join(root, "app"), join(root, "src", "app")];

  const importersOf = new Map<string, Set<string>>();
  const routeFiles = new Map<string, RouteFile>();
  for (const file of files) {
    const info = routeFileOf(file, appRoots);
    if (info) routeFiles.set(file, info);

    const sf = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
      scriptKind(file),
    );
    for (const spec of importSpecifiers(sf)) {
      const target = resolveImport(spec, file, options, cache, known);
      if (!target) continue;
      let importers = importersOf.get(target);
      if (!importers) {
        importers = new Set();
        importersOf.set(target, importers);
      }
      importers.add(file);
    }
  }

  const pages = [...routeFiles.values()].filter((r) => r.kind === "page");
  const isInSubtree = (dir: string, ancestor: string) => dir === ancestor || dir.startsWith(ancestor + sep);

  /** Pages that render `start`: walk importers upwards, expanding layouts to their subtree. */
  const routesOf = (start: string): RoutePattern[] => {
    const found = new Map<string, RoutePattern>();
    const add = (route: RouteFile) => {
      found.set(route.file, { pattern: route.pattern, pageFile: route.file });
    };
    const seen = new Set<string>([start]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      const info = routeFiles.get(node);
      if (info?.kind === "page") add(info);
      if (info?.kind === "layout") {
        for (const page of pages) if (isInSubtree(page.dir, info.dir)) add(page);
      }
      for (const importer of importersOf.get(node) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        queue.push(importer);
      }
    }
    return [...found.values()];
  };

  const routesByFile = new Map<string, RoutePattern[]>();
  for (const file of files) routesByFile.set(file, routesOf(file));

  return {
    routesByFile,
    routesFor: (file) => routesByFile.get(resolve(file)) ?? [],
  };
}

/** Unique routes (keyed by page file) that render any of `files`. */
export async function findRoutesForFiles(projectDir: string, files: string[]): Promise<RoutePattern[]> {
  const index = await buildRouteIndex(projectDir);
  const unique = new Map<string, RoutePattern>();
  for (const file of files) {
    for (const route of index.routesFor(file)) unique.set(route.pageFile, route);
  }
  return [...unique.values()];
}
