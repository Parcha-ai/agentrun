// What keeps a revision from running on this host, checked when a definition is saved and again before each run, so
// the two cannot drift. A blocker no setting of this host fixes (a tool it does not bind, a model pi-ai does not know,
// no instructions, a workflow needing what it does not give) refuses the save, 422 by field; one a setting fixes (a
// provider's key, a default model, a tier's model) saves as a warning. Either refuses a run, 409 agent_not_runnable.
import { WORKFLOW_ADAPTERS } from "./app.js";
import { DECISION_ADAPTER, providerMissing, providersNamed } from "./decisions.js";
import { REPLAY } from "./host-tools.js";
import type { InputIssue } from "./errors.js";
import { DEFAULT_HARNESS, FAUX_HARNESS_ENV, harnessOffers } from "./harness.js";
import { chooseModel, llmTiers, nodeTiers, workflowNodes } from "./model.js";
import { BOUND_TOOLS, CALL_TOOLS, missingEnv, NODE_TOOLS, TOOLS, workflowTools } from "./tools.js";

/** A revision's body as it is saved or stored. */
export type RevisionShape =
  | { kind: "agentic"; instructions: string; tools?: readonly string[]; model?: string; harness?: string }
  | { kind: "workflow"; workflow: unknown; harness?: string };

/** One thing that keeps a revision from running here. `host`: a setting of this host could fix it. `tool` (one it does
 *  not bind), `missing` (a bound tool's unset variables), `adapter`, `decision` (a decision provider's unset key), `codeNodes`
 *  (code nodes this server does not run), `shell` (a shell or executor call), `tier` and `harness` name it for a run's 409
 *  details. */
export type Blocker = InputIssue & { host: boolean; tool?: string; missing?: { tool: string; vars: string[] }; adapter?: string; decision?: { provider: string; needs: string[] }; codeNodes?: true; shell?: true; tier?: string; harness?: string };

/** The reason a warning gives: the revision runs once this host has what it names. */
export const NOT_SET_UP = "not_set_up_here";

/** Set to 1 (`--allow-code-nodes`), this server runs workflows' `code` nodes: in the run's process, through the DSL's
 *  `new Function` transform, which is no sandbox. Off by default. */
export const CODE_NODES_ENV = "AGENTRUN_SERVE_CODE_NODES";

export async function blockersOf(env: NodeJS.ProcessEnv, revision: RevisionShape): Promise<Blocker[]> {
  const out: Blocker[] = [];
  /** A bound tool whose variables this host does not set: a warning at save, a 409 at a run. */
  const unset = (field: string, tool: string) => {
    const vars = missingEnv(TOOLS[tool]!, env);
    if (vars.length) out.push({ field, reason: NOT_SET_UP, message: `This server's environment does not set what the tool needs: the tool ${tool} needs ${vars.join(" and ")}.`, host: true, missing: { tool, vars } });
  };
  const harness = revision.harness ?? DEFAULT_HARNESS;
  const offer = (await harnessOffers(env)).find((h) => h.id === harness);
  if (!offer?.available) out.push({ field: "definition.harness", reason: NOT_SET_UP, message: offer?.reason ?? `This server does not run ${harness}.`, host: true, harness });
  if (revision.kind === "agentic") {
    if (!revision.instructions.trim()) out.push({ field: "definition.instructions", reason: "too_short", message: "definition.instructions is empty: an agentic revision needs instructions.", host: false });
    (revision.tools ?? []).forEach((tool, index) => {
      if (!BOUND_TOOLS.includes(tool)) out.push({ field: `definition.tools[${index}]`, reason: "not_an_option", message: `agentrun-serve binds the tools ${BOUND_TOOLS.join(", ")}; ${tool} is not one of them.`, host: false, tool });
      // Another harness gets the host tools only (host-tools.ts: the file tools, fetch_page and web_fetch): any other
      // tool this host binds, ask_person among them, is pi's here and refuses the run, never runs without it.
      else if (harness !== DEFAULT_HARNESS && !(tool in REPLAY)) out.push({ field: `definition.tools[${index}]`, reason: NOT_SET_UP, message: `${tool} runs on pi here; on ${harness} it is not bound yet.`, host: true, tool });
      else unset(`definition.tools[${index}]`, tool);
    });
    // claude-agent's model is its own (adapters.ts), never routed through the other harnesses' gateway; on the faux
    // harness every harness takes the run's usual model. A harness that does not run here has said why already.
    const own = harness === "claude-agent" && !env[FAUX_HARNESS_ENV];
    if (own && !offer?.available) return out;
    const chosen = own ? (await import("./adapters.js")).claudeModel(env, revision.model) : await chooseModel(env, revision.model);
    if ("why" in chosen) out.push({ field: "definition.model", reason: chosen.host ? NOT_SET_UP : "not_an_option", message: chosen.why, host: chosen.host });
    // The harness runs here; whether it runs this revision's model (its own, or the server's default) is checked on it.
    else if (harness !== DEFAULT_HARNESS && offer?.available) {
      const { harnessReason } = await import("./adapters.js");
      const why = await harnessReason(harness, env, { model: chosen.model, models: { getModel: () => undefined } });
      if (why !== undefined) out.push({ field: revision.model ? "definition.model" : "definition.harness", reason: NOT_SET_UP, message: why, host: true, harness });
    }
    return out;
  }
  // A workflow's model nodes run on pi here; on another harness they are not bound yet, and never run on pi instead.
  if (harness !== DEFAULT_HARNESS) out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `A workflow runs on pi here; on ${harness} its model nodes are not bound yet.`, host: true, harness });
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  const inspection = inspectWorkflow(revision.workflow);
  const { requires } = inspection;
  const nodes = workflowNodes(revision.workflow, inspection);
  const runs = "agentrun-serve runs a workflow's model nodes (agent, decide, extract, report)";
  for (const adapter of requires.adapters.filter((name) => !(WORKFLOW_ADAPTERS as readonly string[]).includes(name))) {
    // Typed questions run on the provider each node names (Jev for one that names none) once this host sets its key:
    // until then a warning at save, a 409 at a run. A provider this server does not have refuses the save.
    if (adapter === DECISION_ADAPTER) {
      for (const provider of providersNamed(nodes)) {
        const missing = providerMissing(env, provider);
        if (!missing) continue;
        out.push(missing.needs
          ? { field: "definition.workflow", reason: NOT_SET_UP, message: missing.message, host: true, adapter, decision: { provider, needs: missing.needs } }
          : { field: "definition.workflow", reason: "not_an_option", message: missing.message, host: false, adapter });
      }
      continue;
    }
    out.push({ field: "definition.workflow", reason: "not_an_option", message: `${runs}; this workflow also needs ${adapter}.`, host: false, adapter });
  }
  // `code` nodes run here (the DSL's pure transform) when the server allows them; a call through a shell or the executor never does.
  const shells = nodes.some((node) => node.node === "call" && (node.via === "shell" || node.via === "executor"));
  if (requires.executableCode && shells) out.push({ field: "definition.workflow", reason: "not_an_option", message: `${runs}, code nodes and calls via tool; this workflow also calls a shell or the executor.`, host: false, shell: true });
  else if (requires.executableCode && env[CODE_NODES_ENV] !== "1") out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `This server runs no code nodes: start it with --allow-code-nodes (or ${CODE_NODES_ENV}=1) to run this workflow's.`, host: true, codeNodes: true });
  const named = workflowTools(nodes);
  for (const tool of named.nodes) {
    if (!NODE_TOOLS.includes(tool)) out.push({ field: "definition.workflow", reason: "not_an_option", message: `A workflow's model nodes get the tools ${NODE_TOOLS.join(", ")} here; this workflow also names ${tool}.`, host: false, tool });
  }
  for (const tool of named.calls) {
    if (!CALL_TOOLS.includes(tool)) out.push({ field: "definition.workflow", reason: "not_an_option", message: `A workflow's call nodes run the tools ${CALL_TOOLS.join(", ")} here; this workflow also calls ${tool}.`, host: false, tool });
  }
  for (const tool of new Set([...named.nodes.filter((name) => NODE_TOOLS.includes(name)), ...named.calls.filter((name) => CALL_TOOLS.includes(name))])) unset("definition.workflow", tool);
  for (const tier of llmTiers(nodes, nodeTiers(nodes))) {
    const chosen = await chooseModel(env, undefined, tier);
    if ("why" in chosen) out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: chosen.why, host: true, tier });
  }
  return out;
}

/** A blocker as a field issue, for a 422 or a warning. */
export const issueOf = ({ field, reason, message }: Blocker): InputIssue => ({ field, reason, message });
