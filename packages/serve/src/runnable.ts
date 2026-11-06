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
import { keyNeeded } from "./key-words.js";
import { wireName } from "./catalog.js";
import { mcpHeaderProblem, mcpNameOf } from "./mcp-gateway.js";
import { type McpTool, toolSchemaProblems } from "@parcha/agentrun-kernel";

/** The harnesses an agent's MCP tools run on here. */
export const MCP_HARNESSES: readonly string[] = [DEFAULT_HARNESS, "claude-agent", "codex"];

/** A revision's body as it is saved or stored. */
export type RevisionShape =
  | { kind: "agentic"; instructions: string; tools?: readonly string[]; model?: string; harness?: string; place?: { mode: string; box?: string }; toolSettings?: ToolSettingsMap }
  | { kind: "workflow"; workflow: unknown; tools?: readonly string[]; harness?: string; place?: { mode: string; box?: string }; toolSettings?: ToolSettingsMap };

/** One thing that keeps a revision from running here. `host`: a setting of this host could fix it. `tool` (one it does
 *  not bind), `missing` (a bound tool's unset variables), `adapter`, `decision` (a decision provider's unset key), `codeNodes`
 *  (code nodes this server does not run), `shell` (a shell or executor call), `tier`, `harness`, `box` (the place's,
 *  which this server does not have) and `denied` (a tool a workflow's call node calls that is set to deny) name it for a
 *  run's 409 details. */
export type Blocker = InputIssue & { host: boolean; tool?: string; missing?: { tool: string; vars: string[] }; adapter?: string; decision?: { provider: string; needs: string[] }; codeNodes?: true; shell?: true; tier?: string; harness?: string; box?: string; denied?: string; asks?: string };

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

/** The Codex adapter's check of a tool's schema (codexToolProblems), loaded once from @parcha/agentrun-harness-codex; none
 *  where that package is not installed, where codex runs nothing anyway (its offer says why). */
let codexCheck: Promise<((name: string, schema: unknown) => string[]) | undefined> | undefined;
const codexToolCheck = () => (codexCheck ??= import("@parcha/agentrun-harness-codex").then((codex) => codex.codexToolProblems, () => undefined));

/** What keeps `revision` from running in `env` under the server's tool `settings` (tool-plane.ts). `boxes`: what this
 *  server's box registry set up at its start (boxes.ts); none, every box is unavailable. `offers`: the harnesses' offers
 *  the server already holds (its reading); none given, they are probed here. */
export async function blockersOf(env: NodeJS.ProcessEnv, revision: RevisionShape, settings: ToolSettingsMap = {}, { capped = false, boxes = [], offers, mcp }: { capped?: boolean; boxes?: readonly BoxOffer[]; offers?: readonly HarnessCapability[]; mcp?: (server: string) => readonly (McpTool & { grantable?: false; reason?: string })[] | undefined } = {}): Promise<Blocker[]> {
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
    if (vars.length) out.push({ field, reason: NOT_SET_UP, message: `The tool ${tool} needs ${keyNeeded(vars)}.`, host: true, missing: { tool, vars } });
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
    // Codex's own MCP client parses a tool's schema as it parses a host tool's, dropping or retyping what the adapter
    // refuses in a host tool (codexToolProblems): a grant of such a tool is refused here, at the save, in those words.
    const codexProblems = harness === "codex" && (revision.tools ?? []).some((tool) => tool.startsWith("mcp:")) ? await codexToolCheck() : undefined;
    (revision.tools ?? []).forEach((tool, index) => {
      // A remote MCP server's tool: one its saved snapshot lists, on a harness that binds them.
      if (tool.startsWith("mcp:")) {
        const field = `definition.tools[${index}]`;
        const named = mcpNameOf(tool);
        const saved = named && mcp?.(named.server);
        const listed = saved && saved.map((t) => t.name);
        const listedTool = saved && named ? saved.find((t) => t.name === named.tool) : undefined;
        const schema = listedTool?.inputSchema;
        const declared = schema ? mcpHeaderProblem(schema) : undefined;
        // On claude-agent the CLI drops a tool whose schema fails the kernel's check, or whose root holds anyOf, allOf or
        // oneOf (harness-claude's check, measured on the pinned CLI), without a word: refused here, not missing at the run.
        const dropped = schema && named && harness === "claude-agent" ? [...toolSchemaProblems(`mcp__${named.server}__${named.tool}`, schema), ...["anyOf", "allOf", "oneOf"].filter((key) => key in schema).map((key) => `/${key}: the Claude Agent CLI drops a tool whose root has ${key}`)][0] : schema && named && codexProblems ? codexProblems(`mcp__${named.server}__${named.tool}`, schema)[0] : undefined;
        if (!named) out.push({ field, reason: "not_an_option", message: `${tool} is not an MCP tool's name: mcp:<server>/<tool>, the server's name in lowercase letters, digits and -.`, host: false, tool });
        // claude-agent's own tools are its MCP server `hands`: a remote server of that name could never be called there.
        else if (named.server === "hands") out.push({ field, reason: "not_an_option", message: `${tool} names the MCP server hands, a name the harnesses keep for their own tools: save the server under another name.`, host: false, tool });
        // A meta tool runs other actions by name: a grant of it could not name the action (mcp-meta.ts). Refused before
        // the harness's check, since no host setup makes it grantable.
        else if (listedTool?.grantable === false) out.push({ field, reason: "not_an_option", message: `${tool} can't be granted: ${listedTool.reason}`, host: false, tool });
        else if (!MCP_HARNESSES.includes(harness)) out.push({ field, reason: NOT_SET_UP, message: `${tool} runs on ${MCP_HARNESSES.slice(0, -1).join(", ")} and ${MCP_HARNESSES.at(-1)} here; on ${harness} MCP tools are not bound yet.`, host: true, tool });
        else if (!listed) out.push({ field, reason: "not_an_option", message: `No MCP server ${named.server} is saved on this server: add it in Settings → MCP servers first.`, host: false, tool });
        else if (!listed.includes(named.tool)) out.push({ field, reason: "not_an_option", message: `The MCP server ${named.server} has no tool ${named.tool}; its tools are ${listed.join(", ") || "none"}.`, host: false, tool });
        else if (dropped) out.push({ field, reason: "not_an_option", message: `The MCP server ${named.server}'s tool ${named.tool} cannot be offered on ${harness}: ${dropped.replace(/^mcp__\S+: /, "")}.`, host: false, tool });
        else if (declared) out.push({ field, reason: "not_an_option", message: `The MCP server ${named.server}'s tool ${named.tool} declares a header it cannot send: ${declared}.`, host: false, tool });
        else if (wireName(tool) !== `mcp__${named.server}__${named.tool}`) out.push({ field, reason: "not_an_option", message: `${tool} is too long: mcp__${named.server}__${named.tool} must be at most 52 characters, the budget every harness's tool names share.`, host: false, tool });
        return;
      }
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
  // A workflow's own grants hold a known MCP meta tool to the same rule (mcp-meta.ts): refused at the save, never a
  // workflow that cannot launch.
  (revision.tools ?? []).forEach((tool, index) => {
    const named = tool.startsWith("mcp:") ? mcpNameOf(tool) : undefined;
    const listed = named ? mcp?.(named.server)?.find((t) => t.name === named.tool) : undefined;
    if (listed?.grantable === false) out.push({ field: `definition.tools[${index}]`, reason: "not_an_option", message: `${tool} can't be granted: ${listed.reason}`, host: false, tool });
  });
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
    // A call node is the author's own step, and it cannot wait for an approval: one that calls a tool set to deny, or to
    // ask (which it could never get), would be refused mid-run (app.ts runEffect), so the run never starts.
    // Held to its settings key: a legacy name (fetch_page) takes its capability's permission (web_fetch's), as the gate does.
    else if (permissionOf(capabilityOf(tool), settings as never, (revision.toolSettings ?? {}) as never) === "ask") out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `This workflow's call node calls ${capabilityOf(tool) === tool ? tool : `${tool} (${capabilityOf(tool)})`}, which is set to ask, and a workflow's call node can't wait for an approval: set it to allow for this agent.`, host: true, asks: capabilityOf(tool) });
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
