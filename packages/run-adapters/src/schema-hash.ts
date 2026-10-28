// A tool schema's identity, for parity tables and pins. Written for AgentRun.
import { createHash } from "node:crypto";

/** `value` as canonical JSON: object keys sorted at every depth, arrays in order, no whitespace. Two schemas that say
 *  the same thing in a different key order have the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError(`canonicalJson: ${typeof value} has no JSON form`);
  return text;
}

/** The sha256 (hex) of a schema's canonical JSON: the same for the same schema whatever its key order. */
export function schemaHash(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}
