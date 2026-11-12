import { canonicalHash } from "./canonical-hash.js";

/** The external call a model tool call stands for: the gateway tool and the hash of its arguments. Only a `fetch`
 *  wrapper names the gateway tool in its arguments; every other tool is its own name, whatever its arguments look like.
 *  The same key is computed for an effect from its receipt's intent. */
export function gatewayIntentOf(name: string, args: unknown): { tool: string; argsHash: string } {
  const a = args as any;
  if (name === "fetch" && a && typeof a === "object" && typeof a.tool === "string" && a.args && typeof a.args === "object" && !Array.isArray(a.args)) return { tool: a.tool, argsHash: canonicalHash(a.args) };
  return { tool: name, argsHash: canonicalHash(args ?? {}) };
}
