import { canonicalHash } from "./canonical-hash.js";
import type { RecoveryIntent } from "./store.js";

/** A completed tool effect a continuation may answer an exact repeat from: the external call it paid for, and its value. */
export type InheritedReceipt = { id: string; name: string; tool: string; argsHash: string; result: unknown; session: string | null };
/** An effect whose outcome is unknown: its call is never dispatched again. `intent` is the external call it was admitted
 *  for, when its journal recorded one. */
export type InheritedUnknown = { id: string; name: string; argsHash: string; session: string | null; intent?: RecoveryIntent };

/** A tool value that is itself a returned failure: an error envelope (`ok: false`, `isError: true`, `outcome: "error"`) as
 *  an object or as its JSON text. Such a value is not a paid result; the continuation may make the call again. Structural,
 *  never prose. */
export function returnedFailure(value: unknown): boolean {
  const failed = (parsed: any) => Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed.ok === false || parsed.isError === true || parsed.outcome === "error"));
  if (typeof value !== "string") return failed(value);
  // The envelope may be the whole text (pretty-printed or not) or one line of it with guidance appended; each
  // candidate is parsed structurally, never matched as prose.
  for (const candidate of [value.trim(), ...value.split("\n").map((line) => line.trim())]) {
    if (!candidate.startsWith("{")) continue;
    try { if (failed(JSON.parse(candidate))) return true; } catch { /* not this candidate */ }
  }
  return false;
}

/** The external call a model tool call stands for: the gateway tool and the hash of its arguments. Only a `fetch`
 *  wrapper names the gateway tool in its arguments; every other tool is its own name, whatever its arguments look like.
 *  The same key is computed for an effect from its receipt's intent. */
export function gatewayIntentOf(name: string, args: unknown): { tool: string; argsHash: string } {
  const a = args as any;
  if (name === "fetch" && a && typeof a === "object" && typeof a.tool === "string" && a.args && typeof a.args === "object" && !Array.isArray(a.args)) return { tool: a.tool, argsHash: canonicalHash(a.args) };
  return { tool: name, argsHash: canonicalHash(args ?? {}) };
}
