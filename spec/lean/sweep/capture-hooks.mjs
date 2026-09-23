const DIST_INDEX = new URL("../../../packages/dsl/dist/index.js", import.meta.url).href;
const WRAPPER = new URL("./capture-dsl.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url === DIST_INDEX && context.parentURL !== WRAPPER) return { ...resolved, url: WRAPPER, shortCircuit: true };
  return resolved;
}
