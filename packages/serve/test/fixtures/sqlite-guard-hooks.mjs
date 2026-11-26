// The resolve hook sqlite-guard-register.mjs installs: `node:sqlite`, asked for by a module under packages/serve/test, is
// fixtures/sqlite-guard.mjs. Two modules there are let through to the real one: sqlite-guard.mjs, which wraps it, and
// real-sqlite.mjs, which sqlite-guard.test.mjs reads to compare the guarded class with the real one.
const GUARD = new URL("./sqlite-guard.mjs", import.meta.url).href;
const REAL = new Set([GUARD, new URL("./real-sqlite.mjs", import.meta.url).href]);
const TESTS = new URL("../", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "node:sqlite" && context.parentURL?.startsWith(TESTS) && !REAL.has(context.parentURL)) {
    return { url: GUARD, shortCircuit: true };
  }
  return next(specifier, context);
}
