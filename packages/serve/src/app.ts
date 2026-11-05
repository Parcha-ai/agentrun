// The app `pi-durable-disk run --app` loads for each run serve starts. It reads the run's revision from the agent store
// (`<data>/store.sqlite`, the run being `<data>/runs/<id>`) and runs it on the model model.ts chooses:
//   - agentic: the root agent with the revision's instructions and skills, and the tools it names, bound from the
//     closed table in tools.ts;
//   - workflow: the revision's workflow, started with startWorkflowRevision of @parcha/pi-durable-agent/workflow on
//     agentrun-pi's durable workflow task, each model node on the host's model of its tier with the tools it names of the
//     table's node tools, and its typed questions on Jev or Parallel when the server hands this process the provider's key. When the
//     workflow ends the app writes the run's final status, with the outcome, and releases the run. The server carries
//     it back once this process has exited: this process holds the run's store until then.
// First: the secrets serve hands this process over a pipe, read and the pipe closed before anything else runs.
import { authContextOf, mcpCredentials, withSecrets } from "./secrets.js";
import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { basename, join, resolve } from "node:path";
import { createRegistry, defineExtension, type Extension, type Harness, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { openStoreReader, type Revision, RUN_STORE_FILE, type RunRow } from "@parcha/pi-durable-agent";
import { RUN_RESUMED } from "@parcha/pi-durable-agent/timeline";
import { settleIn } from "./paid-calls.js";
import type { AppContext, AppOptions, BeforeResume, DurableRun } from "@parcha/pi-durable-disk";
import { capBefore, capModels, capOf, spentIn } from "./cap.js";
import { codingSource } from "./coding-tools.js";
import { cancelledIn, markRequests } from "./request-start.js";
import { decisionProvidersOf } from "./decisions.js";
import { FOLLOW_UP_OPEN_ENV, readJson, RUN_META } from "./files.js";
import { adapterFor, claudeModel, claudePriceModel, claudeSkillCheck, codexModel, type ConfineChild, learnedRoute, learnedWorkflowsOff, openRouterOnly, thinkingFor } from "./adapters.js";
import { DEFAULT_HARNESS, FAUX_HARNESS_ENV } from "./harness.js";
import { adapterRun } from "./harness-app.js";
import { MCP_PIN, mcpGateway, mcpNameOf, type McpPin, mcpRegistrations } from "./mcp-gateway.js";
import { pinnedWorkflows, readPin, withLearned } from "./learning.js";
import { LEARNED_WORKFLOW_TOOL, learnedWorkflowTool } from "./learned-workflow.js";
import { completer } from "./llm.js";
import { searchOn } from "./hosted-search.js";
import { imageLoader } from "./pdf-pages.js";
import { EFFORT_ENV, type ModelRef, llmTiers, nodeTiers, runModels, type Tier, thinkingOf, workflowNodes } from "./model.js";
import { gated, liveView, nodeLog, readLiveView } from "./pause.js";
import { remotePlace, storedPlace } from "./place.js";
import { runBox, runBoxProvider } from "./run-box.js";
import { planeOf } from "./tool-plane.js";
import { ASK_TOOL, type ToolBinding, type ToolHost, toolOf, workflowTools } from "./tools.js";
import { promptOf, readsFiles, systemOf } from "./skills.js";
import { EnvironmentLine, environmentLine } from "./environment.js";
import { effortGuidance } from "./effort-guidance.js";
import { isObject } from "./validate.js";
import { mirrorWrites } from "./workspace.js";
import { deniedText, runGate } from "./tool-gate.js";

/** The workflow adapters this host gives every run: model nodes, and calls `via: "tool"` to the table's tools. Typed
 *  questions (`runJudge`) run too where the host sets a decision provider's key (decisions.ts). */
export const WORKFLOW_ADAPTERS = ["runNode", "runEffect"] as const;

/** A call node's tool failure, as the value its effect completed with (runEffect below). */
const TOOL_FAILED = "agentrun_serve_tool_failed";

/** A run's own commit of `kind` to its root, outside any one call's turn: a workflow call node's ledger, and every
 *  request's settle (paid-calls.ts settleIn). */
const rootRecordOf = (harness: Harness) => (kind: string, data: Record<string, string | number | null>) => harness.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data })), BACKGROUND);

export { promptOf };

/** A run's process that opens to go on with a run its last process left unfinished writes that on the root
 *  (RUN_RESUMED), so the run's timeline shows it from the store, which the settle's read keeps: after a crash (that
 *  process died holding the run, and left it `running`) or after the server stopped (it drained, `sleeping`). A first
 *  open, a follow-up's and a wake from a park get none. A run whose root conversation was never made writes nothing
 *  and opens as before: the root comes with a workflow run's task (its start) and with an agentic run's first message,
 *  so a process that died or drained before then left none. */
async function markResumed({ harness, context, generation, previous }: BeforeResume): Promise<void> {
  const drained = previous?.status === "sleeping" && isObject(previous.detail) && previous.detail.reason === "drained";
  const after = previous?.status === "running" ? "crash" : drained ? "server_stop" : undefined;
  // A follow-up's open, which the server names (FOLLOW_UP_OPEN_ENV): the run's turn had ended, and the record its last
  // process left is its server letting it go once it answered (a drain, as a server stop writes one), not cut work.
  if (process.env[FOLLOW_UP_OPEN_ENV] === "1") return;
  if (!after || !(await harness.conversation(ROOT_CONVERSATION_ID, context))) return;
  await harness.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: RUN_RESUMED, data: { after, generation, at: Date.now() } })), context);
}

/** claude-agent's model and pi-ai's catalog that prices it: its own settings, never the gateway's (adapters.ts). */
async function claudeModels(env: NodeJS.ProcessEnv, ref: string | undefined) {
  const choice = claudeModel(env, ref);
  if ("why" in choice) throw new Error(choice.why);
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  return { models: builtinModels({ authContext: authContextOf(env) }), model: choice.model as ModelRef | undefined, byTier: new Map([["default", choice.model]]), unpriced: new Set<string>() };
}

/** codex's model (or opencode's, `harness`, on codex's route) and pi-ai's catalog that prices it, where it reaches OpenAI only through OpenRouter (codexModel: no
 *  OpenAI key needed); anywhere else, the run's usual models (runModels). */
async function codexModels(env: NodeJS.ProcessEnv, ref: string | undefined, harness: "codex" | "opencode" = "codex") {
  if (env[FAUX_HARNESS_ENV] || !openRouterOnly(harness, env)) return runModels(env, ref, ["default"], harness);
  const choice = await codexModel(env, ref, harness);
  if ("why" in choice) throw new Error(choice.why);
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  return { models: builtinModels({ authContext: authContextOf(env) }), model: choice.model as ModelRef | undefined, byTier: new Map([["default", choice.model]]), unpriced: new Set<string>() };
}

/** The run's row and its pinned revision, read from the store the run's directory sits in. */
function revisionOf(where: AppContext): { run: RunRow; revision: Revision } {
  const reader = openStoreReader(resolve(where.root, "..", ".."));
  try {
    const id = basename(resolve(where.root));
    const run = reader.readRun(id);
    if (!run) throw new Error(`the agent store has no run ${id}`);
    return { run, revision: reader.readRevision(run.revision) };
  } finally {
    reader.close();
  }
}

export default async function app(where: AppContext): Promise<AppOptions> {
  const { run, revision } = revisionOf(where);
  // This process's reading of its environment, with its secrets: never a child's (secrets.ts).
  const env = withSecrets(process.env);
  const workflowNodeList = revision.kind === "workflow" ? workflowNodes(revision.body.workflow, (await import("@parcha/agentrun-dsl")).inspectWorkflow(revision.body.workflow)) : [];
  // codex's model as a save resolves it (codexModel): an OpenAI model it reaches through OpenRouter alone needs no OpenAI key.
  const chosen = revision.kind === "agentic" && revision.body.harness === "claude-agent" && !env[FAUX_HARNESS_ENV] ? await claudeModels(env, revision.body.model) : revision.kind === "agentic" && (revision.body.harness === "codex" || revision.body.harness === "opencode") ? await codexModels(env, revision.body.model, revision.body.harness) : revision.kind === "agentic" ? await runModels(env, revision.body.model, ["default"], revision.body.harness) : await runModels(env, undefined, llmTiers(workflowNodeList, nodeTiers(workflowNodeList)));
  const { model, byTier } = chosen;
  // Read before the run opens its store: what it spent in earlier processes counts against its cap.
  const cap = capOf(process.env);
  // Each request is marked as it leaves (request-start.ts), inside the cap: a request the cap refuses never leaves, and
  // gets a start mark of its own, which its error entry answers.
  const marked = await markRequests(chosen.models, cancelledIn(where.root));
  // On another harness these models carry only the run's own requests (a learned workflow's, a hosted search's), under
  // the run's one total, which the harness keeps (cap.ts capModels' `joined`): what they cost in earlier processes is
  // read here, as the harness's booking does not hold it.
  const joined = revision.kind === "agentic" && Boolean(revision.body.harness) && revision.body.harness !== DEFAULT_HARNESS;
  const models = cap === undefined ? marked.models : await capModels(marked.models, cap, spentIn(join(where.store, RUN_STORE_FILE), { sides: joined }), { unpriced: chosen.unpriced, refused: marked.refused, joined });
  // web_search's own request to the model provider, when it resolves native, goes through the run's models (hosted-search.ts):
  // on another harness too, for a learned workflow's call node.
  searchOn(models);
  const thinkingLevel = thinkingOf(process.env, revision.kind === "agentic" ? revision.body.thinking : undefined);
  // The run's place, as its start resolved and kept it (serve.json): in a box, its coding tools run there (run-box.ts).
  const meta = await readJson(join(where.root, RUN_META));
  const place = storedPlace(meta?.place);
  const root = resolve(where.root, "..", "..");
  // A remote box (Daytona) is the server's to make and seed, reached through its relay; Docker's is made here.
  const box = place.mode === "sandbox" ? runBox(remotePlace(place) ? { relay: root } : { provider: () => runBoxProvider(place, env, root) }, { id: run.id, root, dir: where.root, place }) : undefined;
  // What the run's host tools file in work/ is copied into a remote box too, which does not share this machine's work/.
  if (box?.mirror) mirrorWrites(where.work, box.mirror);
  const coding = codingSource(place, box);
  // Every tool call the run's model makes passes the run's tool gate (tool-gate.ts): pi's tools wrapped by name where the
  // registry composes each agent's, another harness's host tools in their call. An approved call runs on this coding
  // source, as the run's own would.
  const toolGate = runGate(where, run.id, revision);
  // Its remote MCP servers, as its first launch pinned them, with the credentials this launch handed it (mcp-gateway.ts).
  const pinned = (await readJson(join(where.root, MCP_PIN))) as McpPin | null;
  // Its records (a held ask, a priced call's mark and charge, an unpriced call's "not metered") go on the run's root, once
  // the run is open.
  let runHarness: Harness | undefined;
  const commit = () => runHarness && (<T>(change: (tx: unknown) => Promise<T>) => runHarness!.commit(change as never, BACKGROUND) as Promise<T>);
  const gateway = pinned && Object.keys(pinned).length ? mcpGateway({ pin: pinned, credentials: mcpCredentials(), work: () => where.work, commit, gate: toolGate }) : undefined;
  const registry = createRegistry();
  // An agentic run's system prompt starts with the date and the workspace (environment.ts). On pi it is a section,
  // installed first so it comes before every other extension's and the instructions.
  if (revision.kind === "agentic") registry.install(EnvironmentLine);
  registry.install(coding.extension);
  // What the run's agent learned goes into its instructions, and the skills it wrote join the revision's, the one path for
  // every harness (learning.ts).
  const learned = revision.kind === "agentic" ? await withLearned(where.root, where.work, revision.body.instructions, Object.keys(revision.body.skills)) : { instructions: "", skills: [] };
  // The workflows the agent learned that its run may run, as one tool (learned-workflow.ts), when its pin names any: on
  // the run's models, as side requests under its cap, each model node and `llm` call on the run's model of its tier,
  // else the run's own (the only one the run was made with, and handed the key of); the `llm` tool's completion for a
  // call node that names it; its call nodes on the agent's tools its run's plane resolves (the plane its harness and
  // its tools read).
  const flows = revision.kind === "agentic" ? await pinnedWorkflows(where.root, await readPin(where.root)) : [];
  // On claude-agent and codex, on the route the harness's own requests take (learnedRoute): on OpenRouter alone,
  // OpenRouter's name for the run's model, whose key the run holds, never the vendor's provider.
  const learnedHarness = revision.kind === "agentic" ? revision.body.harness : undefined;
  const learnedModel = (tier: unknown) => {
    const ref = byTier.get((tier as Tier | undefined) ?? "default") ?? byTier.get("default");
    return ref && learnedHarness && learnedHarness !== DEFAULT_HARNESS ? learnedRoute(learnedHarness, env, ref) : ref;
  };
  // A second guard beside the pin's (learning-run.ts): a run whose harness's requests go where a learned workflow's could
  // not follow gets no tool, whatever its pin says.
  const learnedTool = flows.length && revision.kind === "agentic" && !(await learnedWorkflowsOff(revision.body.harness, env, revision.body.model))
    ? learnedWorkflowTool({ workflows: flows, granted: revision.body.tools, plane: planeOf(process.env), policy: toolGate.policy, env, work: where.work, models: models as never, modelOf: learnedModel, complete: completer(models as never, learnedModel, thinkingLevel) })
    : undefined;
  // The run's effort, as its thinking level reads it: its note on how to work follows the instructions on every harness
  // (effort-guidance.ts). None without an effort.
  const guidance = effortGuidance(process.env[EFFORT_ENV]);
  if (revision.kind === "agentic" && revision.body.harness && revision.body.harness !== DEFAULT_HARNESS) {
    const harness = revision.body.harness;
    // claude-agent loads the skills its adapter takes itself (its Skill tool), and its prompt keeps only the ones it would
    // refuse; codex's prompt, and a faux harness's, name each skill and its file when the run reads its files (it reads
    // the SKILL.md when it fits), else keep every skill whole (skills.ts).
    const check = harness === "claude-agent" && !env[FAUX_HARNESS_ENV] ? await claudeSkillCheck() : undefined;
    const { system: instructions, native } = await systemOf(learned.instructions, learned.skills, where.work, check, { onDemand: readsFiles(revision.body.tools) });
    // The session's system prompt starts with the line, made as this process opens it: a run resumed on a later day is
    // opened with that day.
    const spec = { key: `run:${run.id}`, label: run.agent, system: [environmentLine(), instructions, guidance].filter((text): text is string => Boolean(text)), context: "fresh" as const, thinking: thinkingFor(harness, thinkingLevel), ...(gateway ? { mcp: gateway } : {}) };
    // ask_person stays pi's (runnable.ts refuses a run that names it here); the file tools are pi's own; the MCP tools
    // are the harness's own client's, at the session's proxy.
    const named = revision.body.tools.filter((name) => name !== ASK_TOOL && !mcpNameOf(name));
    // The harness's own files (its homes, its state) go in a private directory beside the workspace, never in it. It works
    // in the workspace itself (where.work), the directory the run's file tools confine to: a path the model builds from
    // its working directory is then one they take.
    const dir = join(where.root, "harness");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Built at the open: the harness's own process runs under the run's confinement, the prefix pi's commands get there.
    const make = (confine?: ConfineChild) => adapterFor(harness, env, { model: model!, models: chosen.models as never, ...(confine ? { confine } : {}), ...(native.length ? { skills: native } : {}) });
    // The run's cap, checked before each of the harness's requests: the same ceiling rule as pi's (cap.ts).
    // claude-agent's run is capped at the price of whoever bills it (claudeProvider's priceModel), as its adapter prices it.
    const priced = harness === "claude-agent" && !env[FAUX_HARNESS_ENV] ? claudePriceModel(env, model!) : model!;
    const guard = await capBefore(cap, chosen.models.getModel(priced.provider, priced.modelId) as never, { listed: !chosen.unpriced.has(priced.modelId) });
    // The cancel mark serve writes is read here too, as pi's model wrapper reads it (request-start.ts).
    // The run's stop record (serve.json, as serve saved it before a stop's abort): a turn it names is not resumed.
    const stopRecord = { ...(typeof meta?.stopped_at === "string" ? { stopped_at: meta.stopped_at } : {}), ...(typeof meta?.stopped_after === "number" ? { stopped_after: meta.stopped_after } : {}) };
    const { door, onOpen } = adapterRun(make, harness, spec, BACKGROUND, cap, learnedTool ? [...named, LEARNED_WORKFLOW_TOOL] : named, dir, guard, cancelledIn(where.root), where.work, coding.tools, stopRecord, toolGate, learnedTool ? [learnedTool] : []);
    // A paid host tool's settle goes to the run's root, as on pi (paid-calls.ts settleIn).
    // A learned workflow's model requests go through the run's models, marked on its store once it opens (markRequests).
    return { models: {}, registry: createRegistry(), door, onOpen: async (durable: DurableRun) => ((runHarness = durable.harness), settleIn(rootRecordOf(durable.harness)), learnedTool && marked.open(durable), onOpen(durable)), beforeResume: markResumed } as unknown as AppOptions;
  }
  // Each tool the revision names is bound once, from the table: its extensions installed here, its documents written in
  // each conversation's creating commit, what it settles done before anything resumes, and what it lets go done before
  // the run is released.
  const writes: Array<(tx: Tx, conversationId: number) => void | Promise<void>> = [];
  const settles: Array<(harness: Harness) => void | Promise<void>> = [];
  const stops: Array<(harness: Harness) => void | Promise<void>> = [];
  const host: ToolHost = {
    where, env, coding, install: (extension) => registry.install(extension),
    onConversation: (write) => void writes.push(write), beforeResume: (settle) => void settles.push(settle), beforeRelease: (stop) => void stops.push(stop),
  };
  const letGo = async (harness: Harness) => { for (const stop of stops) await stop(harness); };
  const bound = new Map<string, Promise<ToolBinding>>();
  const bind = (name: string, nodes = false): Promise<ToolBinding> => {
    const entry = toolOf(name);
    if (!entry || (nodes && !entry.nodes)) throw new Error(`the revision names the tool ${name}, which agentrun-serve does not bind${nodes ? " for a workflow's model node" : ""}`);
    let tools = bound.get(name);
    if (!tools) bound.set(name, (tools = entry.bind(host)));
    return tools;
  };
  const hooks = {
    conversationCreated: async (tx: Tx, conversation: { id: number }) => { for (const write of writes) await write(tx, conversation.id); },
    beforeResume: async (run: BeforeResume) => { await markResumed(run); for (const settle of settles) await settle(run.harness); },
  };
  // A SIGTERM lets the run go: what a tool holds is let go there, then the wake is recorded as pi-durable-disk records it
  // by default (sleeping, due at `at`).
  const wake = async (durable: DurableRun, at: number | null) => {
    await letGo(durable.harness);
    await durable.setStatus("sleeping", { reason: "drained" }, { wakeAt: at === null ? null : new Date(at).toISOString() });
  };
  if (revision.kind === "agentic") {
    const tools = (await Promise.all(revision.body.tools.filter((name) => !mcpNameOf(name)).map((name) => bind(name)))).flatMap((binding) => binding.tools);
    // The MCP tools pass the gate in the gateway (mcp-gateway.ts) and carry its mark (GATED_BY_GATEWAY), so the gate's
    // extension leaves exactly those; every other tool, any mcp__ name included, it wraps.
    const mcp = gateway ? mcpRegistrations(gateway) : [];
    if (mcp.length) registry.install(defineExtension({ name: "mcp", tools: mcp }));
    tools.push(...mcp);
    if (learnedTool) {
      registry.install(defineExtension({ name: "learned-workflow", tools: [learnedTool] }));
      tools.push(learnedTool);
    }
    registry.install(toolGate.extension(tools));
    // Each skill named with its file when the run reads its files (it reads the SKILL.md when it fits), else whole.
    const instructions = [await promptOf(learned.instructions, learned.skills, where.work, { onDemand: readsFiles(revision.body.tools) }), guidance].filter(Boolean).join("\n\n");
    // The calls that wait for a person's approval are read as the run opens, and their answers acted on from then.
    const onOpen = async (durable: DurableRun) => {
      runHarness = durable.harness;
      settleIn(rootRecordOf(durable.harness));
      marked.open(durable);
      await toolGate.load(durable, BACKGROUND, coding.tools, learnedTool ? [learnedTool] : []);
      toolGate.start();
    };
    return { models, registry, ...hooks, ...(stops.length ? { wake } : {}), root: { agent: { model, thinkingLevel, instructions, tools } }, onOpen } as unknown as AppOptions;
  }
  const input = isObject(meta?.input) ? meta.input : {};
  const [{ BACKGROUND_CONTEXT }, { createWorkflowExtension, decisionRecovery, durableDecisions, nodeRunner, taskScope }, { EffectFailure, inspectWorkflow, judgeFromProviders }, { withRecovery, workspaceFiles }, { startWorkflowRevision }, decisionProviders] = await Promise.all([
    import("@earendil-works/chord/context"),
    import("@parcha/agentrun-pi/durable"),
    import("@parcha/agentrun-dsl"),
    import("@parcha/agentrun-dsl/recovery"),
    import("@parcha/pi-durable-agent/workflow"),
    // The decision providers, holding the decision keys the server handed this process: in no environment a tool reads.
    decisionProvidersOf(process.env),
  ]);
  const nodeTools = new Map<string, ToolBinding>();
  for (const name of workflowTools(workflowNodeList).nodes) nodeTools.set(name, await bind(name, true));
  // A model node's tools pass the gate too; one set to ask is refused there, as no node can wait for a person. A call
  // node is the author's own step, which cannot wait for an approval: runnable.ts refuses a run whose call node calls a tool
  // set to deny or ask, and a tool set to either since is refused as its call node runs (runEffect).
  const gatedTools = toolGate.extension([...nodeTools.values()].flatMap((binding) => binding.tools));
  registry.install(gatedTools);
  // A decision node's images are files of the run's work directory (pdf_pages draws them there).
  const loadImage = imageLoader(where.work);
  const log = nodeLog(where.root);
  // The receipts earlier processes recorded, read before this one opens the store, which then holds it exclusively.
  const earlier = await (async () => {
    try {
      return durableDecisions(join(where.store, RUN_STORE_FILE));
    } catch {
      return (await readLiveView(where.root))?.receipts ?? [];
    }
  })();
  const live = liveView(where.root, [...earlier]);
  // The `llm` tool's one completion: on the run's models (capped and marked as a model node's), its tier's model.
  const complete = completer(models as never, (tier) => byTier.get((tier as Tier | undefined) ?? "default"), thinkingLevel);
  /** The run, once it opens: a call node's paid requests are booked in its store (paid-calls.ts). */
  let opened: DurableRun | undefined;
  /** A call node `via: "tool"`: the table's tool by name, its interpolated args in, what its `out` schema checks out. Its
   *  input and output go to the node log, and its paid requests are booked under the node's own call (its execution
   *  path, and its item in a map). */
  const runEffect = async ({ node, input, signal, executionPath, item }: { node: { label: string; via: string; tool?: string }; input: Record<string, unknown>; signal: AbortSignal; executionPath?: string; item?: { index: number } }) => {
    const effect = node.via === "tool" && node.tool ? toolOf(node.tool)?.effect : undefined;
    if (!effect) throw new Error(`call node "${node.label}": agentrun-serve runs no tool ${node.tool ?? `via ${node.via}`}`);
    const at = { path: executionPath ?? null, item: item?.index ?? null, tool: node.tool!, label: node.label };
    log({ t: "effect.start", ...at, input, at: new Date().toISOString() });
    try {
      // Its tool's permission now, the gate's one rule read as each call node runs (tool-gate.ts policy): a tool set to
      // deny since the run started is refused in the gate's words, and one set to ask too, since a call node cannot wait
      // for an approval. Neither runs.
      const permission = toolGate.policy(node.tool!);
      if (permission === "deny") throw new Error(deniedText(node.tool!));
      if (permission === "ask") throw new Error(`This ${node.tool} call needs a person's approval, which a workflow's call node cannot wait for; it was not run.`);
      const durable = opened;
      const ledger = durable ? { call: `${node.label}@${executionPath ?? ""}${item ? `#${item.index}` : ""}`, record: rootRecordOf(durable.harness) } : undefined;
      const output = await effect(input, { signal, env, work: where.work, complete, ...(ledger ? { ledger } : {}) });
      log({ t: "effect.end", ...at, status: "done", output, at: new Date().toISOString() });
      return output;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      // Whole up to 64 KB, so the server redacts it before it cuts it for the graph (graph-view.ts); a longer one is marked cut.
      log({ t: "effect.end", ...at, status: "failed", error: message.slice(0, 65_536), ...(message.length > 65_536 ? { error_truncated: true } : {}), at: new Date().toISOString() });
      // An abort (a cancel, the node's deadline) stays a throw: the driver keeps its effect unknown. A tool that failed on
      // its own (an unreadable PDF, a model's refusal) answered: its failure is the effect's outcome, completed, and is
      // thrown past the driver as the call node's typed failure (`failing`), which a collecting map ends that item on.
      if (signal.aborted || (error as Error)?.name === "AbortError") throw error;
      return { [TOOL_FAILED]: `call node "${node.label}": ${node.tool} failed: ${message.slice(0, 500)}` };
    }
  };
  /** `runEffect` past the driver: a tool's failure the driver recorded as its effect's outcome is thrown here, on the
   *  first run and on a resume that answers it from the receipt alike. */
  const failing = (run: (params: never) => Promise<unknown>) => async (params: never) => {
    const value = await run(params);
    if (isObject(value) && typeof value[TOOL_FAILED] === "string") throw new EffectFailure(value[TOOL_FAILED], null, { code: null });
    return value;
  };
  /** A model node's agent: its tier's model, the tools it names, and the extensions they come from. */
  const nodeAgent = (node: { tier?: string; tools?: string[] }) => {
    const bindings = (node.tools ?? []).flatMap((name) => nodeTools.get(name) ?? []);
    return { model: byTier.get((node.tier as Tier | undefined) ?? "default")!, thinkingLevel, extensions: [...new Set([coding.extension, ...bindings.flatMap((b) => b.extensions), gatedTools])], tools: bindings.flatMap((b) => b.tools) };
  };
  const nodes = nodeRunner({ agent: (node) => nodeAgent(node) as never });
  /** The node log's starts and ends, from the workflow's events: what a graph shows of a node's timing. */
  const onEvent = (event: { type: string; detail?: unknown; executionPath?: string }) => {
    if ((event.type !== "node.start" && event.type !== "node.end") || typeof event.executionPath !== "string") return;
    const detail = (event.detail ?? {}) as { kind?: string; status?: string; duration_ms?: number; error?: unknown };
    log({ t: event.type, path: event.executionPath, kind: String(detail.kind ?? ""), at: new Date().toISOString(), ...(detail.status ? { status: detail.status } : {}), ...(typeof detail.duration_ms === "number" ? { duration_ms: detail.duration_ms } : {}), ...(detail.error !== undefined ? { error: String((detail.error as Error)?.message ?? detail.error).slice(0, 500) } : {}) });
  };
  const workflows = createWorkflowExtension({
    options: () => ({ files: workspaceFiles(where.work) }),
    run: ({ key, runtime, context, driver }) => {
      // Each typed question's receipt is a row of the run's store before its answer acts, and a resumed run takes an
      // answered one instead of asking again.
      const decisions = decisionRecovery({ key, runtime, context });
      live.driver(driver);
      const deps = withRecovery(driver, {
        runNode: nodes.on(taskScope(runtime), context).runNode, runEffect: runEffect as never, ...(decisionProviders ? { runJudge: judgeFromProviders({ ...decisionProviders, loadImage }) as never, decisionProviders } : {}),
        recordDecision: async (receipt: Parameters<typeof decisions.recordDecision>[0], exchange: Parameters<typeof decisions.recordDecision>[1]) => {
          await decisions.recordDecision(receipt, exchange);
          live.receipt(receipt as unknown as Record<string, unknown>);
        },
      }, { durableNodes: true });
      const { recovery } = deps;
      if (!recovery) throw new Error("the workflow's recovery gave the run no recovery hooks");
      // The pause gate: each node's resume, which the interpreter awaits before it starts the node (before a call's deadline
      // is armed), and each model call and decision, outside the recovery: one waiting at it was never admitted, so a kill
      // while paused leaves nothing half asked.
      const gate = <F,>(fn: F): F => (fn ? gated(where.root, fn as never) : fn) as F;
      const resume = gated(where.root, (args: Parameters<typeof recovery.resume>) => recovery.resume(...args));
      return { deps: { ...deps, runEffect: deps.runEffect && (failing(deps.runEffect as never) as never), runNode: gate(deps.runNode), runJudge: gate(deps.runJudge), onEvent, recovery: { ...recovery, resume: (...args: Parameters<typeof recovery.resume>) => resume(args), decision: decisions.decision } } };
    },
  });
  registry.install(nodes.extension as unknown as Extension);
  registry.install(workflows.extension as unknown as Extension);
  const onOpen = async (durable: DurableRun) => {
    opened = durable;
    settleIn(rootRecordOf(durable.harness));
    marked.open(durable);
    const started = { runId: run.id, storePath: join(where.store, RUN_STORE_FILE), agentId: run.agent, revision: revision as Extract<Revision, { kind: "workflow" }> };
    const outcome = await startWorkflowRevision({ harness: durable.harness as never, workflows, context: BACKGROUND_CONTEXT, run: started, input, tools: inspectWorkflow(revision.body.workflow).requires.tools });
    live.stop();
    await letGo(durable.harness);
    await durable.setStatus(outcome.status === "complete" ? "done" : "failed", { workflow: outcome.status, ...(outcome.status === "refused" ? { code: outcome.code, message: outcome.message.slice(0, 500) } : {}) });
    await durable.release();
  };
  return { models, registry, ...hooks, ...(stops.length ? { wake } : {}), onOpen } as unknown as AppOptions;
}
