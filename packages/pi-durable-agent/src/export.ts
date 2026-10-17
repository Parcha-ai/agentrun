import type { JsonValue } from "@earendil-works/chord";

/** The kinds an exporter may copy out of an agent home. Deny by default: any kind not listed, one this release does
 *  not know included, is dropped. */
export const EXPORTABLE_KINDS: readonly string[] = Object.freeze(["agent.identity", "agent.definition", "agent.source", "agent.skills", "agent.runs"]);

/** The kinds that never leave an agent home: saved sign-ins, save leases, and each host's own names for the agent and
 *  for where its tools run. */
export const SECRET_KINDS: readonly string[] = Object.freeze(["browser.profiles", "agent.leases", "agent.bindings", "agent.aliases"]);

/** What an exporter may write for one stored document of `kind`: a deep copy of `value`, without the caller's `host`
 *  for an `agent.runs` record, or `undefined` when the document is dropped. */
export function projectForExport(kind: string, value: JsonValue): JsonValue | undefined {
  if (!EXPORTABLE_KINDS.includes(kind)) return undefined;
  const copy = structuredClone(value);
  if (kind === "agent.runs" && typeof copy === "object" && copy !== null && !Array.isArray(copy)) delete copy.host;
  return copy;
}
