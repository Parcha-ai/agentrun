import { createHash } from "node:crypto";

/** SHA-256 of a value's JSON with every object's keys sorted: the identity of a binding, an input,
 *  an intent's arguments or a set of file hashes, independent of key order. */
export const canonicalHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex");

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

/** SHA-256 of a value serialized with sorted keys: an identity for a contract a host persists. Not interchangeable
 *  with canonicalHash: it writes an undefined member as `undefined` and never calls toJSON, and both identities are
 *  persisted. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
