/** Whether `value` is a plain record: an object that is not null and not an array. graph.ts and recovery/item-state.ts
 *  keep their own copy, since each imports nothing. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
