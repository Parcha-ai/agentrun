const DIST_INDEX = new URL("../../../packages/dsl/dist/index.js", import.meta.url).href;
const WRAPPER = new URL("./capture-dsl.mjs", import.meta.url).href;
/** The file capture-register.mjs leaves in LEAN_SWEEP_DIR in every process it reaches. */
export const REACHED = "reached";

export function resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (resolved.url === DIST_INDEX && context.parentURL !== WRAPPER) return { ...resolved, url: WRAPPER, shortCircuit: true };
  return resolved;
}
