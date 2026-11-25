/** Whether `value` is an object that is not null and not an array. That is all it checks: a class instance, a Map, a
 *  Date or a null-prototype object passes too. The package's modules use this one copy, except graph.ts and
 *  recovery/item-state.ts: each of those imports nothing, so a static viewer can bundle it alone, and keeps its own. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
