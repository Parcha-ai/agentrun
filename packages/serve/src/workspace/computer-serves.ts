// What a started computer says it is (its hello: machine kind and groups), read against the computer module's kind
// registry for the run's setting kind: the one check every path that starts a run's computer makes (the runner's Docker
// computer, runner/computer.ts; computerForClaim for every other provider), so a computer that does not serve the kind
// is refused in the registry's words, and its caller releases it, never hands it on.

/** The kind registry's servingRefusals (the computer package's, or --faux's), by its shape. */
export type ServingRefusals = (capabilities: { readonly kind: string; readonly groups: readonly string[] }, kind: string) => string[];

/** The groups the computer declares, when it serves `kind`; else a refusal thrown in the registry's words. A hello that
 *  declares no groups (absent, or not a list) declares none, and one that names no machine kind names none: the registry
 *  refuses either in words, never a TypeError. */
export function servedGroups(said: { readonly kind?: unknown; readonly groups?: unknown }, kind: string, refusals: ServingRefusals): readonly string[] {
  const groups = Array.isArray(said.groups) ? said.groups.filter((group): group is string => typeof group === "string") : [];
  const machine = typeof said.kind === "string" ? said.kind : "unknown";
  const why = refusals({ kind: machine, groups }, kind);
  if (why.length > 0) throw new Error(`the run's computer can't serve a ${kind}: ${why.join("; ")}`);
  return groups;
}
