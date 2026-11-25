// The resolve hook sqlite-guard-register.mjs installs: `node:sqlite`, asked for by a module under packages/serve/test, is
// fixtures/sqlite-guard.mjs (which is its own importer of the real one, so it is let through).
const GUARD = new URL("./sqlite-guard.mjs", import.meta.url).href;
const TESTS = new URL("../", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "node:sqlite" && context.parentURL?.startsWith(TESTS) && context.parentURL !== GUARD) {
    return { url: GUARD, shortCircuit: true };
  }
  return next(specifier, context);
}
