// What a started computer says it is (its hello: machine kind and groups), read against the computer module's kind
// registry for the run's setting kind: the one check every path that starts a run's computer makes (the runner's Docker
// computer, runner/computer.ts; computerForClaim for every other provider), so a computer that does not serve the kind
// is refused in the registry's words, and its caller releases it, never hands it on.

/** The kind registry's servingRefusals (the computer package's, or --faux's), by its shape. */
export type ServingRefusals = (capabilities: { readonly kind: string; readonly groups: readonly string[] }, kind: string) => string[];

/** The groups the computer declares, when it serves `kind`; else a refusal thrown in the registry's words. */
export function servedGroups(said: { readonly kind: string; readonly groups: readonly string[] }, kind: string, refusals: ServingRefusals): readonly string[] {
  const why = refusals({ kind: said.kind, groups: [...said.groups] }, kind);
  if (why.length > 0) throw new Error(`the run's computer can't serve a ${kind}: ${why.join("; ")}`);
  return said.groups;
}
