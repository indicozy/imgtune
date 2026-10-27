// Test-only resolve hook: lets the plain-node child fixture load src/*.ts, whose imports use ".js" specifiers.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
    try {
      return await nextResolve(specifier.slice(0, -3) + ".ts", context);
    } catch {
      // not a TypeScript source; fall through to the default resolution
    }
  }
  return nextResolve(specifier, context);
}
