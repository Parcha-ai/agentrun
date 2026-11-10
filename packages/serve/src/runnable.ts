// What keeps a revision from running on this host, checked when a definition is saved and again before each run, so
// the two cannot drift. A blocker no setting of this host fixes (a tool it does not bind, a model pi-ai does not know,
// no instructions, a workflow needing what it does not give) refuses the save, 422 by field; one a setting fixes (a
// provider's key, a default model, a tier's model) saves as a warning. Either refuses a run, 409 agent_not_runnable.
import { WORKFLOW_ADAPTERS } from "./runner/workflow-adapters.js";
import { DECISION_ADAPTER, decisionModelsNamed, providerMissing, providersNamed } from "./decisions.js";
import { REPLAY } from "./host-tools.js";
import { type InputIssue, sentence } from "./errors.js";
import { DEFAULT_HARNESS, HARNESSES, type HarnessCapability, harnessOffers } from "./harness.js";
import { builtinHarness, harnessOf, onAdapter } from "./harness-table.js";
import { chooseModel } from "./model.js";
import { llmTiers, MODEL_NODES, type ModelRef, nodeTiers, type Tier, unpricedModels, workflowNodes } from "./model.js";
import type { BoxOffer } from "./boxes.js";
import { boxAvailability, newAgentPlace, placeFix, RUN_BOXES } from "./place.js";
import { allows, BOUND_TOOLS, CALL_TOOLS, grantedTools, missingEnv, NODE_TOOLS, toolOf, workflowTools } from "./tools.js";
import { DENIED, isUnavailable, NO_PARALLEL_KEY, type Pickable, planeFor, type ToolSettingsMap, whyUnavailable } from "./tool-plane.js";
import { denyPlace, permissionFrom, permissionOf } from "./tool-gate.js";
import { approvalsOf } from "./approvals.js";
import { PARALLEL_KEY_ENV } from "./decisions.js";
import { keyNeeded } from "./key-words.js";
import { wireName } from "./catalog.js";
import { mcpHeaderProblem, mcpNameOf } from "./mcp-gateway.js";
import type { McpTool } from "@parcha/agentrun-kernel";

/** The harnesses an agent's MCP tools run on here. */
export const MCP_HARNESSES: readonly string[] = HARNESSES.filter((id) => builtinHarness(id)!.mcp);

/** A revision's body as it is saved or stored. `unnamed`: its `place` is the one a revision that names none resolves to
 *  (place.ts defaultPlaceOf), not one it names. `computer`: its computer setting (computer-setting.ts), when it has one. */
export type RevisionShape =
  | { kind: "agentic"; instructions: string; tools?: readonly string[]; model?: string; harness?: string; place?: { mode: string; box?: string }; computer?: { kind: string; provider?: string }; unnamed?: true; toolSettings?: ToolSettingsMap; approvals?: "never" }
  | { kind: "workflow"; workflow: unknown; tools?: readonly string[]; harness?: string; place?: { mode: string; box?: string }; unnamed?: true; toolSettings?: ToolSettingsMap; approvals?: "never" };

/** One thing that keeps a revision from running here. `host`: a setting of this host could fix it. `tool` (one it does
 *  not bind), `missing` (a bound tool's unset variables), `adapter`, `decision` (a decision provider's unset key), `codeNodes`
 *  (code nodes this server does not run), `shell` (a shell or executor call), `tier`, `harness`, `box` (the place's,
 *  which this server does not have) and `denied` (a tool a workflow's call node calls that is set to deny) name it for a
 *  run's 409 details; `notGrantable` a tool no setup makes grantable (a known MCP meta tool, mcp-meta.ts), with why. */
export type Blocker = InputIssue & { host: boolean; tool?: string; notGrantable?: { tool: string; reason: string }; missing?: { tool: string; vars: string[] }; adapter?: string; decision?: { provider: string; needs: string[] }; codeNodes?: true; shell?: true; tier?: string; harness?: string; box?: string; denied?: string; asks?: string; unpriced?: true };

/**
 * The model `harness` runs an agentic revision on here: `ref`, its own `provider/model-id`, or with none this host's
 * default for that harness. `why`: the model itself is the problem (`host`, a setting of this host could fix it);
 * `refused`: the harness runs here but refuses that model. Undefined when claude-agent does not run here: its model is
 * its own, and the harness says why. A save, a run and capabilities' `harnesses[].default_model` all ask this, so they
 * cannot drift.
 */
export async function harnessModel(env: NodeJS.ProcessEnv, harness: string, ref: string | undefined, available: boolean): Promise<{ model: ModelRef } | { why: string; host: boolean } | { refused: string } | undefined> {
  // Its entry chooses (harness-table.ts): one whose model is its own (its facts' ownModel: claude-agent's, never routed
  // through the other harnesses' gateway) is none where it does not run here; one on the Responses API takes the run's
  // usual model, but an OpenAI model it reaches through OpenRouter alone is OpenRouter's (provider.ts modelOn); pi's is
  // its own. A test's stand-in chooses as its table entry says.
  const entry = harnessOf(env, harness);
  const chosen = entry ? await entry.model(env, ref, available) : await chooseModel(env, ref, "default", harness);
  if (chosen === undefined || "why" in chosen) return chosen;
  // The harness runs here; whether it runs this model (the revision's, or the default) is checked on it.
  if (entry?.facts && available) {
    const { harnessReason } = await import("./adapters.js");
    const refused = await harnessReason(harness, env, { model: chosen.model, models: { getModel: () => undefined } });
    if (refused !== undefined) return { refused };
  }
  return { model: chosen.model };
}

/** The reason a warning gives: the revision runs once this host has what it names. */
export const NOT_SET_UP = "not_set_up_here";
/** How a capped run on a model with no price is made to run: the price, where AgentRun starts, or no cap. */
const PRICE_FIX = "Set AGENT_MODEL_PRICE (USD per million input,output,cacheRead tokens) where AgentRun starts, or run without a spend cap.";

/** Set to 1 (`--allow-code-nodes`), this server runs workflows' `code` nodes: in the run's process, through the DSL's
 *  `new Function` transform, which is no sandbox. Off by default. */
export const CODE_NODES_ENV = "AGENTRUN_SERVE_CODE_NODES";

/** What keeps `revision` from running in `env` under the server's tool `settings` (tool-plane.ts). `boxes`: what this
 *  server's box registry set up at its start (boxes.ts); none, every box is unavailable. `offers`: the harnesses' offers
 *  the server already holds (its reading); none given, they are probed here. `computerReady`: whether an agent's computer
 *  setting can be had here now, or its refusal (resolve-computer.ts computerReadiness); none given, the box check. */
export async function blockersOf(env: NodeJS.ProcessEnv, revision: RevisionShape, settings: ToolSettingsMap = {}, { capped = false, boxes = [], offers, mcp, decisionPrice, computerReady }: { capped?: boolean; boxes?: readonly BoxOffer[]; offers?: readonly HarnessCapability[]; mcp?: (server: string) => readonly (McpTool & { grantable?: false; reason?: string })[] | undefined; decisionPrice?: (model: string) => Promise<unknown>; computerReady?: (setting: { kind: string; provider?: string }) => Promise<{ readonly ok: true } | { readonly refused: string; readonly box?: string }> } = {}): Promise<Blocker[]> {
  const out: Blocker[] = [];
  /** A web tool its run would resolve unavailable (tool-plane.ts): a warning at save, a 409 at a run, never another
   *  provider in its place. One set to deny is not: its run starts, and the gate refuses each call. */
  const unavailable = (field: string, tools: readonly string[], tool: string) => {
    const resolved = planeFor(env, { tools, harness, ...(revision.kind === "workflow" ? { workflow: true as const } : {}), ...(revision.kind === "agentic" && revision.model ? { model: revision.model } : {}), ...(revision.toolSettings ? { overrides: revision.toolSettings } : {}), ...(revision.approvals === "never" ? { approvals: "never" as const } : {}) }, settings, { capped })[tool as Pickable];
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
  // An agent with a computer setting is checked by the claim's own answers (resolve-computer.ts computerReadiness: the
  // provider and its kind, the mode's mount, its keys), not as a box; one with only an old place keeps the box check.
  else if (revision.kind === "agentic" && revision.computer && computerReady) {
    const ready = await computerReady(revision.computer);
    if ("refused" in ready) out.push({ field: "definition.computer", reason: NOT_SET_UP, message: ready.refused, host: true, ...(ready.box ? { box: ready.box } : {}) });
  } else if (place && place.mode !== "runner") {
    const box = boxAvailability(boxes).find((b) => b.id === place.box);
    // A box's reason says what to do, with no full stop of its own: the sentence ends in one, whatever the reason ends in.
    if (!box?.available) out.push({ field: "definition.place", reason: NOT_SET_UP, message: sentence(`This agent's place is ${place.mode} on ${place.box ?? "no box"}, and this server cannot run it there: ${box?.reason ?? "that is not a box this server has"}`), host: true, ...(place.box ? { box: place.box } : {}) });
  }
  /** A shell on the runner: a box this server runs in is the fix; with none, why it has none (capabilities'
   *  default_reason) and both ways out, fixing that or keeping the agent on the runner without the shell. */
  const shellOnRunner = (tool: string, field: string, named: boolean): Blocker => {
    const where = named ? "this agent's place is the runner" : "this agent names no place, so it runs on the runner";
    const box = boxAvailability(boxes).find((b) => RUN_BOXES.includes(b.id) && b.available);
    if (box) return { field, reason: "not_an_option", message: `${tool} runs only in a box, and ${where}, which has no shell: give it a sandbox place.`, fix: placeFix({ mode: "sandbox", box: box.id }), host: false, tool };
    const fresh = newAgentPlace(boxes);
    const why = "reason" in fresh ? fresh.reason : "no box runs execute in is available here";
    return { field, reason: "not_an_option", message: `${tool} runs only in a box, and ${where}, which has no shell, and ${why}. Do that, or keep this agent on the runner: name "place": {"mode": "runner"} and remove "${tool}" from definition.tools.`, fix: `Remove "${tool}" from definition.tools.`, host: false, tool };
  };
  // A harness's own MCP client may drop or retype a shape of a tool's schema (its facts' schemaProblems, measured on its
  // pinned build): that would offer the model another tool than the one granted, so its grant is refused here, at the
  // save. A bound or a format it only strips is not: the server still checks it, and its error reaches the model.
  const schemaProblems = revision.kind === "agentic" ? harnessOf(env, harness)?.facts?.schemaProblems : undefined;
  /** What keeps the grant of `tool`, an `mcp:` name, from running here (the first thing), at `field`; undefined when
   *  nothing does. A remote MCP server's tool runs when its saved snapshot lists it, on a harness that binds them; a
   *  workflow's nodes bind none. The one check of an MCP grant, for an agentic revision's tools and for every tool a
   *  workflow grants (grantedTools). */
  const mcpGrant = (field: string, tool: string): Blocker | undefined => {
    const named = mcpNameOf(tool);
    const saved = named && mcp?.(named.server);
    const listed = saved && saved.map((t) => t.name);
    const listedTool = saved && named ? saved.find((t) => t.name === named.tool) : undefined;
    const schema = listedTool?.inputSchema;
    const declared = schema ? mcpHeaderProblem(schema) : undefined;
    // Refused here, not missing at the run (schemaProblems above).
    const dropped = schema && named && schemaProblems ? schemaProblems(`mcp__${named.server}__${named.tool}`, schema)[0] : undefined;
    if (!named) return { field, reason: "not_an_option", message: `${tool} is not an MCP tool's name: mcp:<server>/<tool>, the server's name in lowercase letters, digits and -.`, host: false, tool };
    // claude-agent's own tools are its MCP server `hands`: a remote server of that name could never be called there.
    if (named.server === "hands") return { field, reason: "not_an_option", message: `${tool} names the MCP server hands, a name the harnesses keep for their own tools: save the server under another name.`, host: false, tool };
    // A meta tool runs other actions by name: a grant of it could not name the action (mcp-meta.ts). Refused before
    // the harness's check, since no host setup makes it grantable.
    if (listedTool?.grantable === false) return { field, reason: "not_an_option", message: `${tool} can't be granted: ${listedTool.reason}`, host: false, notGrantable: { tool, reason: listedTool.reason! } };
    // A workflow's nodes bind no MCP tool here (app.ts): its run would go without it, so its grant is refused.
    if (revision.kind === "workflow") return { field, reason: "not_an_option", message: `${tool}: a workflow's nodes don't bind MCP tools here yet; grant it to an agentic agent.`, host: false, tool };
    if (!MCP_HARNESSES.includes(harness)) return { field, reason: NOT_SET_UP, message: `${tool} runs on ${MCP_HARNESSES.slice(0, -1).join(", ")} and ${MCP_HARNESSES.at(-1)} here; on ${harness} MCP tools are not bound yet.`, host: true, tool };
    if (!listed) return { field, reason: "not_an_option", message: `No MCP server ${named.server} is saved on this server: add it in Settings → MCP servers first.`, host: false, tool };
    if (!listed.includes(named.tool)) return { field, reason: "not_an_option", message: `The MCP server ${named.server} has no tool ${named.tool}; its tools are ${listed.join(", ") || "none"}.`, host: false, tool };
    if (dropped) return { field, reason: "not_an_option", message: `The MCP server ${named.server}'s tool ${named.tool} cannot be offered on ${harness}: ${dropped.replace(/^mcp__\S+: /, "")}.`, host: false, tool };
    if (declared) return { field, reason: "not_an_option", message: `The MCP server ${named.server}'s tool ${named.tool} declares a header it cannot send: ${declared}.`, host: false, tool };
    if (wireName(tool) !== `mcp__${named.server}__${named.tool}`) return { field, reason: "not_an_option", message: `${tool} is too long: mcp__${named.server}__${named.tool} must be at most 52 characters, the budget every harness's tool names share.`, host: false, tool };
    return undefined;
  };
  if (revision.kind === "agentic") {
    if (!revision.instructions.trim()) out.push({ field: "definition.instructions", reason: "too_short", message: "definition.instructions is empty: an agentic revision needs instructions.", host: false });
    (revision.tools ?? []).forEach((tool, index) => {
      if (tool.startsWith("mcp:")) {
        const blocker = mcpGrant(`definition.tools[${index}]`, tool);
        if (blocker) out.push(blocker);
        return;
      }
      if (!allows(BOUND_TOOLS, tool)) out.push({ field: `definition.tools[${index}]`, reason: "not_an_option", message: `agentrun-serve binds the tools ${BOUND_TOOLS.join(", ")}; ${tool} is not one of them.`, host: false, tool });
      // A shell runs only in a box: no place, or the runner, has none.
      else if (toolOf(tool)!.sandboxOnly && (place?.mode ?? "runner") === "runner") out.push(shellOnRunner(tool, `definition.tools[${index}]`, !!place && !revision.unnamed));
      // Its writes into work/ go by path from this machine, and a box's command could swap a link in on their way.
      else if (toolOf(tool)!.runnerOnly && place?.mode === "sandbox") out.push({ field: `definition.tools[${index}]`, reason: "not_an_option", message: `${tool} does not run in a sandbox place yet: it saves files into the run's work/ from this server, outside the box, and a command in the box could point those writes elsewhere on this server. Give it to an agent whose place is the runner.`, fix: `Remove "${tool}" from definition.tools.`, host: false, tool });
      // Another harness gets the host tools only (host-tools.ts: the file tools, web_fetch, web_search and
      // monid's): any other tool this host binds, ask_person among them, is pi's here and refuses the run, never runs
      // without it.
      else if (onAdapter(env, harness) && !(tool in REPLAY)) out.push({ field: `definition.tools[${index}]`, reason: NOT_SET_UP, message: `${tool} runs on pi here; on ${harness} it is not bound yet.`, host: true, tool });
      else {
        unset(`definition.tools[${index}]`, tool);
        unavailable(`definition.tools[${index}]`, revision.tools ?? [], tool);
      }
    });
    const resolved = await harnessModel(env, harness, revision.model, offer?.available === true);
    if (!resolved) return out;
    if ("why" in resolved) out.push({ field: "definition.model", reason: resolved.host ? NOT_SET_UP : "not_an_option", message: resolved.why, host: resolved.host });
    else if ("refused" in resolved) out.push({ field: revision.model ? "definition.model" : "definition.harness", reason: NOT_SET_UP, message: resolved.refused, host: true, harness });
    // Under a cap, a model serve has no price for (unpricedModels: a gateway id no price names and the catalog does not
    // list) cannot be kept to it: the run is refused now, never started and refused at its first request.
    else if (capped) for (const id of await unpricedModels(env, revision.model, ["default"], harness)) out.push({ field: "definition.model", reason: NOT_SET_UP, message: `The model ${id} has no price here, so a run's spend cap cannot be kept on it.`, fix: PRICE_FIX, host: true, unpriced: true });
    return out;
  }
  // Every MCP tool a workflow grants, at its top level or on a node, is held to the one check (mcpGrant): refused at the
  // save, never a workflow whose run goes without it or cannot launch.
  const granted = await grantedTools(revision);
  for (const tool of granted.filter((name) => name.startsWith("mcp:"))) {
    const index = (revision.tools ?? []).indexOf(tool);
    const blocker = mcpGrant(index >= 0 ? `definition.tools[${index}]` : "definition.workflow", tool);
    if (blocker) out.push(blocker);
  }
  // A workflow's model nodes run on pi here; on another harness they are not bound yet, and never run on pi instead.
  if (onAdapter(env, harness)) out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `A workflow runs on pi here; on ${harness} its model nodes are not bound yet.`, host: true, harness });
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
    // An MCP tool is said once, by mcpGrant above.
    if (tool.startsWith("mcp:")) continue;
    if (!allows(NODE_TOOLS, tool)) out.push({ field: "definition.workflow", reason: "not_an_option", message: `A workflow's model nodes get the tools ${NODE_TOOLS.join(", ")} here; this workflow also names ${tool}.`, host: false, tool });
  }
  for (const tool of named.calls) {
    if (tool.startsWith("mcp:")) continue;
    if (!allows(CALL_TOOLS, tool)) out.push({ field: "definition.workflow", reason: "not_an_option", message: `A workflow's call nodes run the tools ${CALL_TOOLS.join(", ")} here; this workflow also calls ${tool}.`, host: false, tool });
    // A call node is the author's own step, and it cannot wait for an approval: one that calls a tool set to deny, or to
    // ask (which it could never get), would be refused mid-run (app.ts runEffect), so the run never starts.
    // Under approvals "never" (the agent runs unattended) a tool set to ask is allowed, so its call node runs; a deny never lifts.
    else if (permissionOf(tool, settings as never, (revision.toolSettings ?? {}) as never, approvalsOf(revision.approvals)) === "ask") out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `This workflow's call node calls ${tool}, which is set to ask, and a workflow's call node can't wait for an approval: set it to allow for this agent.`, host: true, asks: tool });
    else if (permissionOf(tool, settings as never, (revision.toolSettings ?? {}) as never, approvalsOf(revision.approvals)) === "deny") out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `This workflow's call node calls ${tool}, which is set to deny ${denyPlace(permissionFrom(tool, settings as never, (revision.toolSettings ?? {}) as never).from)}.`, host: true, denied: tool });
  }
  for (const tool of new Set([...named.nodes.filter((name) => allows(NODE_TOOLS, name)), ...named.calls.filter((name) => allows(CALL_TOOLS, name))])) {
    unset("definition.workflow", tool);
    unavailable("definition.workflow", granted, tool);
  }
  const tiers = llmTiers(nodes, nodeTiers(nodes));
  for (const tier of tiers) {
    const chosen = await chooseModel(env, undefined, tier);
    if ("why" in chosen) out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: chosen.why, host: true, tier });
  }
  // Under a cap, as an agentic run's model is (above): each model a workflow's model nodes and `llm` calls run on, by
  // their tier, has a price here, and each OpenRouter Decisions model a decision pins is priced in OpenRouter's catalog
  // (decisionPrice: the server's read of it); else its run is refused now, never started and stopped at that node.
  if (capped) {
    const modelNode = (node: Record<string, unknown>) => (MODEL_NODES as readonly unknown[]).includes(node.node) || (node.node === "artifact" && ["markdown", "report"].includes(String(node.type)));
    const tierOf = (value: unknown): Tier => (typeof value === "string" ? (value as Tier) : "default");
    /** The labels of the nodes that run on `tier`: model nodes by their tier, `llm` calls by theirs. */
    const onTier = (tier: Tier) => nodes.filter((node) => (modelNode(node) && tierOf(node.tier) === tier)
      || (node.node === "call" && node.tool === "llm" && tierOf((node.args as { tier?: unknown } | undefined)?.tier) === tier)).map((node) => String(node.label));
    const unpriced = new Map<string, string[]>();
    for (const tier of tiers) for (const id of await unpricedModels(env, undefined, [tier], harness)) unpriced.set(id, [...new Set([...(unpriced.get(id) ?? []), ...onTier(tier)])]);
    for (const [id, labels] of unpriced) {
      out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `The model ${id} has no price here, so a run's spend cap cannot be kept on it. This workflow's ${labels.length === 1 ? "node" : "nodes"} ${labels.join(", ")} ${labels.length === 1 ? "runs" : "run"} on it.`, fix: PRICE_FIX, host: true, unpriced: true });
    }
    for (const { label, provider, model } of decisionModelsNamed(nodes)) {
      if (provider !== "openrouter" || !decisionPrice) continue;
      // A catalog that cannot be read is no price, said as such: the start is refused, and the next one reads it again.
      const price = await decisionPrice(model).then((value) => ({ value }), () => undefined);
      if (!price) {
        out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `OpenRouter's catalog could not be read, so the price of the decision model ${model} is not known and a run's spend cap cannot be kept on it. This workflow's node ${label} asks it.`, fix: "Try the run again once OpenRouter's catalog answers, or run without a spend cap.", host: true, unpriced: true });
        continue;
      }
      if (price.value) continue;
      out.push({ field: "definition.workflow", reason: NOT_SET_UP, message: `The decision model ${model} has no price in OpenRouter's catalog, so a run's spend cap cannot be kept on it. This workflow's node ${label} asks it.`, fix: "Pick a Decisions model OpenRouter's catalog prices, or run without a spend cap.", host: true, unpriced: true });
    }
  }
  return out;
}

/** A blocker as a field issue, for a 422 or a warning. */
export const issueOf = ({ field, reason, message, fix }: Blocker): InputIssue => ({ field, reason, message, ...(fix ? { fix } : {}) });
