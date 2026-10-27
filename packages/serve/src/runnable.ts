// What keeps a revision from running on this host, checked when a definition is saved and again before each run, so
// the two cannot drift. A blocker no setting of this host fixes (a tool it does not bind, a model pi-ai does not know,
// no instructions, a workflow needing what it does not give) refuses the save, 422 by field; one a setting fixes (a
// provider's key, a default model, a tier's model) saves as a warning. Either refuses a run, 409 agent_not_runnable.
import { WORKFLOW_ADAPTERS } from "./app.js";
import type { InputIssue } from "./errors.js";
import { chooseModel, nodeTiers, workflowNodes } from "./model.js";
import { BOUND_TOOLS, CALL_TOOLS, missingEnv, NODE_TOOLS, TOOLS, workflowTools } from "./tools.js";

/** A revision's body as it is saved or stored. */
export type RevisionShape =
  | { kind: "agentic"; instructions: string; tools?: readonly string[]; model?: string }
  | { kind: "workflow"; workflow: unknown };

/** One thing that keeps a revision from running here. `host`: a setting of this host could fix it. `tool` (one it does
 *  not bind), `missing` (a bound tool's unset variables), `adapter`, `code` and `tier` name it for a run's 409 details. */
export type Blocker = InputIssue & { host: boolean; tool?: string; missing?: { tool: string; vars: string[] }; adapter?: string; code?: true; tier?: string };

/** The reason a warning gives: the revision runs once this host has what it names. */
export const NOT_SET_UP = "not_set_up_here";

export async function blockersOf(env: NodeJS.ProcessEnv, revision: RevisionShape): Promise<Blocker[]> {
  const out: Blocker[] = [];
  /** A bound tool whose variables this host does not set: a warning at save, a 409 at a run. */
  const unset = (field: string, tool: string) => {
    const vars = missingEnv(TOOLS[tool]!, env);
    if (vars.length) out.push({ field, reason: NOT_SET_UP, message: `This server's environment does not set what the tool needs: the tool ${tool} needs ${vars.join(" and ")}.`, host: true, missing: { tool, vars } });
  };
  if (revision.kind === "agentic") {
    if (!revision.instructions.trim()) out.push({ field: "definition.instructions", reason: "too_short", message: "definition.instructions is empty: an agentic revision needs instructions.", host: false });
    (revision.tools ?? []).forEach((tool, index) => {
      if (!BOUND_TOOLS.includes(tool)) out.push({ field: `definition.tools[${index}]`, reason: "not_an_option", message: `agentrun-serve binds the tools ${BOUND_TOOLS.join(", ")}; ${tool} is not one of them.`, host: false, tool });
      else unset(`definition.tools[${index}]`, tool);
    });
    const chosen = await chooseModel(env, revision.model);
    if ("why" in chosen) out.push({ field: "definition.model", reason: chosen.host ? NOT_SET_UP : "not_an_option", message: chosen.why, host: chosen.host });
    return out;
  }
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  const inspection = inspectWorkflow(revision.workflow);
  const { requires } = inspection;
  const nodes = workflowNodes(revision.workflow, inspection);
  const runs = "agentrun-serve runs a workflow's model nodes (agent, decide, extract, report)";
  for (const adapter of requires.adapters.filter((name) => !(WORKFLOW_ADAPTERS as readonly string[]).includes(name))) {
    out.push({ field: "definition.workflow", reason: "not_an_option", message: `${runs}; this workflow also needs ${adapter}.`, host: false, adapter });
  }
  if (requires.executableCode) out.push({ field: "definition.workflow", reason: "not_an_option", message: `${runs}; this workflow also needs code.`, host: false, code: true });
  const named = workflowTools(nodes);
  for (const tool of named.nodes) {
    if (!NODE_TOOLS.includes(tool)) out.push({ field: "definition.workflow", reason: "not_an_option", message: `A workflow's model nodes get the tools ${NODE_TOOLS.join(", ")} here; this workflow also names ${tool}.`, host: false, tool });
  }
  for (const tool of named.calls) {
    if (!CALL_TOOLS.includes(tool)) out.push({ field: "definition.workflow", reason: "not_an_option", message: `A workflow's call nodes run the tools ${CALL_TOOLS.join(", ")} here; this workflow also calls ${tool}.`, host: false, tool });
  }
  for (const tool of new Set([...named.nodes.filter((name) => NODE_TOOLS.includes(name)), ...named.calls.filter((name) => CALL_TOOLS.includes(name))])) unset("definition.workflow", tool);
  for (const tier of nodeTiers(nodes)) {
    const chosen = await chooseModel(env, undefined, tier);
    if ("why" in chosen) out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: chosen.why, host: true, tier });
  }
  return out;
}

/** A blocker as a field issue, for a 422 or a warning. */
export const issueOf = ({ field, reason, message }: Blocker): InputIssue => ({ field, reason, message });
