import { canonicalHash } from "./canonical-hash.js";
import type { RecoveryEffect } from "./store.js";

/** A completed tool effect a continuation may answer an exact repeat from: the external call it paid for, and its value. */
export type InheritedReceipt = { id: string; name: string; tool: string; argsHash: string; result: unknown; session: string | null };
/** An effect whose outcome is unknown: its call is never dispatched again. */
export type InheritedUnknown = { id: string; name: string; argsHash: string; session: string | null };

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

/** The receipts a journal hands to its continuation: completed effects whose receipt names the external call (tool
 *  effects; shell and executor effects have no external call to repeat) and whose value is a result, not a returned
 *  failure. */
export function inheritableReceipts(effects: readonly RecoveryEffect[]): InheritedReceipt[] {
  return effects.filter((e) => e.status === "completed" && e.result && typeof e.result === "object" && (e.result as any).intent && typeof (e.result as any).intent.tool === "string" && !returnedFailure((e.result as any).value))
    .map((e) => { const receipt = e.result as { intent: { tool: string; args?: unknown }; value: unknown };
      // Keyed as a continuation's own call is: a node that reached the gateway through the fetch wrapper paid for the tool the wrapper names.
      const { tool, argsHash } = gatewayIntentOf(receipt.intent.tool, receipt.intent.args ?? {});
      return { id: e.id, name: e.name, tool, argsHash, result: receipt.value, session: e.session }; });
}

/** The effects a continuation must not dispatch again: every effect whose outcome is unknown, by the name and argument
 *  hash its admission recorded. A call the continuation's own tools make is matched on those two by `reuseReceipts`;
 *  an effect the driver admitted for a workflow node carries the node's label and the hash of the node's whole
 *  invocation, which is the host's to relate to a tool call. */
export function inheritableUnknowns(effects: readonly RecoveryEffect[]): InheritedUnknown[] {
  return effects.filter((e) => e.status === "unknown").map((e) => ({ id: e.id, name: e.name, argsHash: e.argsHash, session: e.session }));
}

/** The external call a model tool call stands for: the gateway tool and the hash of its arguments. Only a `fetch`
 *  wrapper names the gateway tool in its arguments; every other tool is its own name, whatever its arguments look like.
 *  The same key is computed for an effect from its receipt's intent. */
export function gatewayIntentOf(name: string, args: unknown): { tool: string; argsHash: string } {
  const a = args as any;
  if (name === "fetch" && a && typeof a === "object" && typeof a.tool === "string" && a.args && typeof a.args === "object" && !Array.isArray(a.args)) return { tool: a.tool, argsHash: canonicalHash(a.args) };
  return { tool: name, argsHash: canonicalHash(args ?? {}) };
}
