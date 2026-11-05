// What keeps a revision from running on this host, checked when a definition is saved and again before each run, so
// the two cannot drift. A blocker no setting of this host fixes (a tool it does not bind, a model pi-ai does not know,
// no instructions, a workflow needing what it does not give) refuses the save, 422 by field; one a setting fixes (a
// provider's key, a default model, a tier's model) saves as a warning. Either refuses a run, 409 agent_not_runnable.
import { WORKFLOW_ADAPTERS } from "./app.js";
import { DECISION_ADAPTER, providerMissing, providersNamed } from "./decisions.js";
import { REPLAY } from "./host-tools.js";
import { type InputIssue, sentence } from "./errors.js";
import { DEFAULT_HARNESS, FAUX_HARNESS_ENV, type HarnessCapability, harnessOffers } from "./harness.js";
import { chooseModel, llmTiers, type ModelRef, nodeTiers, workflowNodes } from "./model.js";
import type { BoxOffer } from "./boxes.js";
import { boxAvailability, placeFix, RUN_BOXES } from "./place.js";
import { allows, BOUND_TOOLS, CALL_TOOLS, grantedTools, missingEnv, NODE_TOOLS, toolOf, workflowTools } from "./tools.js";
import { capabilityOf, DENIED, isUnavailable, NO_PARALLEL_KEY, type Pickable, planeFor, type ToolSettingsMap, whyUnavailable } from "./tool-plane.js";
import { permissionOf } from "./tool-gate.js";
import { PARALLEL_KEY_ENV } from "./decisions.js";

/** A revision's body as it is saved or stored. */
export type RevisionShape =
  | { kind: "agentic"; instructions: string; tools?: readonly string[]; model?: string; harness?: string; place?: { mode: string; box?: string }; toolSettings?: ToolSettingsMap }
  | { kind: "workflow"; workflow: unknown; tools?: readonly string[]; harness?: string; place?: { mode: string; box?: string }; toolSettings?: ToolSettingsMap };

/** One thing that keeps a revision from running here. `host`: a setting of this host could fix it. `tool` (one it does
 *  not bind), `missing` (a bound tool's unset variables), `adapter`, `decision` (a decision provider's unset key), `codeNodes`
 *  (code nodes this server does not run), `shell` (a shell or executor call), `tier`, `harness`, `box` (the place's,
 *  which this server does not have) and `denied` (a tool a workflow's call node calls that is set to deny) name it for a
 *  run's 409 details. */
export type Blocker = InputIssue & { host: boolean; tool?: string; missing?: { tool: string; vars: string[] }; adapter?: string; decision?: { provider: string; needs: string[] }; codeNodes?: true; shell?: true; tier?: string; harness?: string; box?: string; denied?: string };

/**
 * The model `harness` runs an agentic revision on here: `ref`, its own `provider/model-id`, or with none this host's
 * default for that harness. `why`: the model itself is the problem (`host`, a setting of this host could fix it);
 * `refused`: the harness runs here but refuses that model. Undefined when claude-agent does not run here: its model is
 * its own, and the harness says why. A save, a run and capabilities' `harnesses[].default_model` all ask this, so they
 * cannot drift.
 */
export async function harnessModel(env: NodeJS.ProcessEnv, harness: string, ref: string | undefined, available: boolean): Promise<{ model: ModelRef } | { why: string; host: boolean } | { refused: string } | undefined> {
  // claude-agent's model is its own (adapters.ts), never routed through the other harnesses' gateway; on the faux
  // harness every harness takes the run's usual model.
  const own = harness === "claude-agent" && !env[FAUX_HARNESS_ENV];
  if (own && !available) return undefined;
  // codex's is the run's usual model, but an OpenAI model it reaches through OpenRouter alone is OpenRouter's (codexRef).
  const chosen = own ? (await import("./adapters.js")).claudeModel(env, ref) : harness === "codex" || harness === "opencode" ? await (await import("./adapters.js")).codexModel(env, ref, harness) : await chooseModel(env, ref, "default", harness);
  if ("why" in chosen) return chosen;
  // The harness runs here; whether it runs this model (the revision's, or the default) is checked on it.
  if (harness !== DEFAULT_HARNESS && available) {
    const { harnessReason } = await import("./adapters.js");
    const refused = await harnessReason(harness, env, { model: chosen.model, models: { getModel: () => undefined } });
    if (refused !== undefined) return { refused };
  }
  return { model: chosen.model };
}

/** The reason a warning gives: the revision runs once this host has what it names. */
export const NOT_SET_UP = "not_set_up_here";

/** Set to 1 (`--allow-code-nodes`), this server runs workflows' `code` nodes: in the run's process, through the DSL's
 *  `new Function` transform, which is no sandbox. Off by default. */
export const CODE_NODES_ENV = "AGENTRUN_SERVE_CODE_NODES";

/** What keeps `revision` from running in `env` under the server's tool `settings` (tool-plane.ts). `boxes`: what this
 *  server's box registry set up at its start (boxes.ts); none, every box is unavailable. `offers`: the harnesses' offers
 *  the server already holds (its reading); none given, they are probed here. */
export async function blockersOf(env: NodeJS.ProcessEnv, revision: RevisionShape, settings: ToolSettingsMap = {}, { capped = false, boxes = [], offers }: { capped?: boolean; boxes?: readonly BoxOffer[]; offers?: readonly HarnessCapability[] } = {}): Promise<Blocker[]> {
  const out: Blocker[] = [];
  /** A web tool its run would resolve unavailable (tool-plane.ts): a warning at save, a 409 at a run, never another
   *  provider in its place. One set to deny is not: its run starts, and the gate refuses each call. */
  const unavailable = (field: string, tools: readonly string[], tool: string) => {
    const resolved = planeFor(env, { tools, harness, ...(revision.kind === "workflow" ? { workflow: true as const } : {}), ...(revision.kind === "agentic" && revision.model ? { model: revision.model } : {}), ...(revision.toolSettings ? { overrides: revision.toolSettings } : {}) }, settings, { capped })[capabilityOf(tool) as Pickable];
    if (isUnavailable(resolved) && resolved !== DENIED) out.push({ field, reason: NOT_SET_UP, message: `The tool ${tool} does not run here on ${harness}: ${whyUnavailable(resolved)}.`, host: true, ...(resolved === NO_PARALLEL_KEY ? { missing: { tool, vars: [PARALLEL_KEY_ENV] } } : {}) });
  };
  /** A bound tool whose variables this host does not set: a warning at save, a 409 at a run. */
  const unset = (field: string, tool: string) => {
    const vars = missingEnv(toolOf(tool)!, env);
    if (vars.length) out.push({ field, reason: NOT_SET_UP, message: `This server's environment does not set what the tool needs: the tool ${tool} needs ${vars.join(" and ")}.`, host: true, missing: { tool, vars } });
  };
  const harness = revision.harness ?? DEFAULT_HARNESS;
  const offer = (offers ?? (await harnessOffers(env))).find((h) => h.id === harness);
  if (!offer?.available) out.push({ field: "definition.harness", reason: NOT_SET_UP, message: offer?.reason ?? `This server does not run ${harness}.`, host: true, harness });
  const { place } = revision;
  // A workflow's model and call nodes run on the runner here; in a box they do not run yet. Its fix names the runner: an
  // edit that leaves the place out keeps the agent's (agents.ts), so removing the field would change nothing.
  if (revision.kind === "workflow" && place && place.mode !== "runner") out.push({ field: "definition.place", reason: "not_an_option", message: `A workflow runs on the runner here: its place is runner (or none), not ${place.mode} on ${place.box ?? "no box"}.`, fix: placeFix({ mode: "runner" }), host: false });
  else if (place && place.mode !== "runner") {
    const box = boxAvailability(boxes).find((b) => b.id === place.box);
    // A box's reason says what to do, with no full stop of its own: the sentence ends in one, whatever the reason ends in.
    if (!box?.available) out.push({ field: "definition.place", reason: NOT_SET_UP, message: sentence(`This agent's place is ${place.mode} on ${place.box ?? "no box"}, and this server cannot run it there: ${box?.reason ?? "that is not a box this server has"}`), host: true, ...(place.box ? { box: place.box } : {}) });
  }
  if (revision.kind === "agentic") {
    if (!revision.instructions.trim()) out.push({ field: "definition.instructions", reason: "too_short", message: "definition.instructions is empty: an agentic revision needs instructions.", host: false });
    (revision.tools ?? []).forEach((tool, index) => {
      if (!allows(BOUND_TOOLS, tool)) out.push({ field: `definition.tools[${index}]`, reason: "not_an_option", message: `agentrun-serve binds the tools ${BOUND_TOOLS.join(", ")}; ${tool} is not one of them.`, host: false, tool });
      // A shell runs only in a box: no place, or the runner, has none.
      else if (toolOf(tool)!.sandboxOnly && (place?.mode ?? "runner") === "runner") out.push({ field: `definition.tools[${index}]`, reason: "not_an_option", message: `${tool} runs only in a box, and ${place ? "this agent's place is the runner" : "this agent names no place, so it runs on the runner"}, which has no shell: give it a sandbox place.`, fix: placeFix({ mode: "sandbox", box: RUN_BOXES[0]! }), host: false, tool });
      // Its writes into work/ go by path from this machine, and a box's command could swap a link in on their way.
      else if (toolOf(tool)!.runnerOnly && place?.mode === "sandbox") out.push({ field: `definition.tools[${index}]`, reason: "not_an_option", message: `${tool} does not run in a sandbox place yet: it saves files into the run's work/ from this server, outside the box, and a command in the box could point those writes elsewhere on this server. Give it to an agent whose place is the runner.`, fix: `Remove "${tool}" from definition.tools.`, host: false, tool });
      // Another harness gets the host tools only (host-tools.ts: the file tools, fetch_page, web_fetch, web_search and
      // monid's): any other tool this host binds, ask_person among them, is pi's here and refuses the run, never runs
      // without it.
      else if (harness !== DEFAULT_HARNESS && !(tool in REPLAY)) out.push({ field: `definition.tools[${index}]`, reason: NOT_SET_UP, message: `${tool} runs on pi here; on ${harness} it is not bound yet.`, host: true, tool });
      else {
        unset(`definition.tools[${index}]`, tool);
        unavailable(`definition.tools[${index}]`, revision.tools ?? [], tool);
      }
    });
    const resolved = await harnessModel(env, harness, revision.model, offer?.available === true);
    if (!resolved) return out;
    if ("why" in resolved) out.push({ field: "definition.model", reason: resolved.host ? NOT_SET_UP : "not_an_option", message: resolved.why, host: resolved.host });
    else if ("refused" in resolved) out.push({ field: revision.model ? "definition.model" : "definition.harness", reason: NOT_SET_UP, message: resolved.refused, host: true, harness });
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
    if (!allows(NODE_TOOLS, tool)) out.push({ field: "definition.workflow", reason: "not_an_option", message: `A workflow's model nodes get the tools ${NODE_TOOLS.join(", ")} here; this workflow also names ${tool}.`, host: false, tool });
  }
  for (const tool of named.calls) {
    if (!allows(CALL_TOOLS, tool)) out.push({ field: "definition.workflow", reason: "not_an_option", message: `A workflow's call nodes run the tools ${CALL_TOOLS.join(", ")} here; this workflow also calls ${tool}.`, host: false, tool });
    // A call node is the author's own step, which no gate asks about (ask does not apply to it); one that calls a tool
    // set to deny would be refused mid-run, so the run never starts.
    // Held to its settings key: a legacy name (fetch_page) takes its capability's permission (web_fetch's), as the gate does.
    else if (permissionOf(capabilityOf(tool), settings as never, (revision.toolSettings ?? {}) as never) === "deny") out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `This workflow's call node calls ${capabilityOf(tool) === tool ? tool : `${tool} (${capabilityOf(tool)})`}, which is set to deny on this server.`, host: true, denied: capabilityOf(tool) });
  }
  const granted = await grantedTools(revision);
  for (const tool of new Set([...named.nodes.filter((name) => allows(NODE_TOOLS, name)), ...named.calls.filter((name) => allows(CALL_TOOLS, name))])) {
    unset("definition.workflow", tool);
    unavailable("definition.workflow", granted, tool);
  }
  for (const tier of llmTiers(nodes, nodeTiers(nodes))) {
    const chosen = await chooseModel(env, undefined, tier);
    if ("why" in chosen) out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: chosen.why, host: true, tier });
  }
  return out;
}

/** A blocker as a field issue, for a 422 or a warning. */
export const issueOf = ({ field, reason, message, fix }: Blocker): InputIssue => ({ field, reason, message, ...(fix ? { fix } : {}) });
