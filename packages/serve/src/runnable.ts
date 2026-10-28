// What keeps a revision from running on this host, checked when a definition is saved and again before each run, so
// the two cannot drift. A blocker no setting of this host fixes (a tool it does not bind, a model pi-ai does not know,
// no instructions, a workflow needing what it does not give) refuses the save, 422 by field; one a setting fixes (a
// provider's key, a default model, a tier's model) saves as a warning. Either refuses a run, 409 agent_not_runnable.
import { BOUND_TOOLS, NODE_TOOLS, WORKFLOW_ADAPTERS } from "./app.js";
import { REPLAY } from "./host-tools.js";
import type { InputIssue } from "./errors.js";
import { DEFAULT_HARNESS, harnessOffers } from "./harness.js";
import { chooseModel, nodeTiers } from "./model.js";

/** A revision's body as it is saved or stored. */
export type RevisionShape =
  | { kind: "agentic"; instructions: string; tools?: readonly string[]; model?: string; harness?: string }
  | { kind: "workflow"; workflow: unknown; harness?: string };

/** One thing that keeps a revision from running here. `host`: a setting of this host could fix it. `tool`, `adapter`,
 *  `code` and `tier` name it for a run's 409 details. */
export type Blocker = InputIssue & { host: boolean; tool?: string; adapter?: string; code?: true; tier?: string; harness?: string };

/** The reason a warning gives: the revision runs once this host has what it names. */
export const NOT_SET_UP = "not_set_up_here";

export async function blockersOf(env: NodeJS.ProcessEnv, revision: RevisionShape): Promise<Blocker[]> {
  const out: Blocker[] = [];
  const harness = revision.harness ?? DEFAULT_HARNESS;
  const offer = (await harnessOffers(env)).find((h) => h.id === harness);
  if (!offer?.available) out.push({ field: "definition.harness", reason: NOT_SET_UP, message: offer?.reason ?? `This server does not run ${harness}.`, host: true, harness });
  if (revision.kind === "agentic") {
    if (!revision.instructions.trim()) out.push({ field: "definition.instructions", reason: "too_short", message: "definition.instructions is empty: an agentic revision needs instructions.", host: false });
    (revision.tools ?? []).forEach((tool, index) => {
      if (!(BOUND_TOOLS as readonly string[]).includes(tool)) out.push({ field: `definition.tools[${index}]`, reason: "not_an_option", message: `agentrun-serve binds the tools ${BOUND_TOOLS.join(", ")}; ${tool} is not one of them.`, host: false, tool });
      // Another harness gets the file tools only (host-tools.ts): any other tool this host binds, ask_person among them,
      // is pi's here and refuses the run, never runs without it.
      else if (harness !== DEFAULT_HARNESS && !(tool in REPLAY)) out.push({ field: `definition.tools[${index}]`, reason: NOT_SET_UP, message: `${tool} runs on pi here; on ${harness} it is not bound yet.`, host: true, tool });
    });
    const chosen = await chooseModel(env, revision.model);
    if ("why" in chosen) out.push({ field: "definition.model", reason: chosen.host ? NOT_SET_UP : "not_an_option", message: chosen.why, host: chosen.host });
    return out;
  }
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  const { requires } = inspectWorkflow(revision.workflow);
  const runs = "agentrun-serve runs a workflow's model nodes (agent, decide, extract, report)";
  for (const adapter of requires.adapters.filter((name) => !(WORKFLOW_ADAPTERS as readonly string[]).includes(name))) {
    out.push({ field: "definition.workflow", reason: "not_an_option", message: `${runs}; this workflow also needs ${adapter}.`, host: false, adapter });
  }
  if (requires.executableCode) out.push({ field: "definition.workflow", reason: "not_an_option", message: `${runs}; this workflow also needs code.`, host: false, code: true });
  for (const tool of requires.tools.filter((name) => !(NODE_TOOLS as readonly string[]).includes(name))) {
    out.push({ field: "definition.workflow", reason: "not_an_option", message: `A workflow's model nodes get the tools ${NODE_TOOLS.join(", ")} here; this workflow also names ${tool}.`, host: false, tool });
  }
  for (const tier of nodeTiers(revision.workflow)) {
    const chosen = await chooseModel(env, undefined, tier);
    if ("why" in chosen) out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: chosen.why, host: true, tier });
  }
  return out;
}

/** A blocker as a field issue, for a 422 or a warning. */
export const issueOf = ({ field, reason, message }: Blocker): InputIssue => ({ field, reason, message });
