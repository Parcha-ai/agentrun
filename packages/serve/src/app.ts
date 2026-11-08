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
import { mcpCredentials, withSecrets } from "./secrets.js";
import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { basename, join, resolve } from "node:path";
import { createRegistry, defineExtension, type Extension, type Harness, ProviderDoc, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { openStoreReader, type Revision, RUN_STORE_FILE, type RunRow } from "@parcha/pi-durable-agent";
import { RUN_RESUMED } from "@parcha/pi-durable-agent/timeline";
import { settleIn } from "./paid-calls.js";
import { type AppContext, type AppOptions, BARRIER, type BeforeResume, type DurableRun, syncNow, type SyncTarget } from "@parcha/pi-durable-disk";
import { AsyncLocalStorage } from "node:async_hooks";
import { BUDGET_HOLD_ENV, BUDGET_HOLD_MS, budgetWaits, type StepAt } from "./budget.js";
import { capBefore, capModels, capModeOf, capOf, costsIn, type CapRefusal, capRefusals, DECISION_COST, DECISION_HOLD, decisionSpentIn, runSpendNow, spentIn, wrapUpSentIn } from "./cap.js";
import { askedBefore, cappedDecisions } from "./decision-cap.js";
import { codingSource } from "./coding-tools.js";
import { cancelledIn, markRequests } from "./request-start.js";
import { decisionProvidersOf } from "./decisions.js";
import { dataOfRun, FOLLOW_UP_OPEN_ENV, readJson, RUN_META } from "./files.js";
import { adapterFor, claudeModel, claudePriceModel, codexModel, type ConfineChild, openRouterOnly, skillCheckOf, thinkingFor } from "./adapters.js";
import { PORT_PROVIDER, portModels } from "./port-models.js";
import type { SessionPort } from "@parcha/agentrun-kernel";
import { DEFAULT_HARNESS, FAUX_HARNESS_ENV } from "./harness.js";
import { adapterRun } from "./harness-app.js";
import { MCP_PIN, mcpGateway, mcpNameOf, type McpPin, mcpRegistrations } from "./mcp-gateway.js";
import { pinnedWorkflows, readPin, withLearned } from "./learning.js";
import { LEARNED_WORKFLOW_TOOL, learnedWorkflowTool } from "./learned-workflow.js";
import { completer } from "./llm.js";
import { searchOn } from "./hosted-search.js";
import { imageLoader } from "./pdf-pages.js";
import { EFFORT_ENV, FAUX_ENV, type ModelRef, llmTiers, nodeTiers, providerModels, runModels, type Tier, thinkingOf, workflowNodes } from "./model.js";
import { gated, liveView, nodeLog, readLiveView } from "./pause.js";
import { remotePlace, storedPlace } from "./place.js";
import { runBox, runBoxProvider } from "./run-box.js";
import { RUN_EPOCH_ENV } from "./run-holder.js";
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
/** A call node's effect its cap refused (cap.ts capRefusals): completed as held, with the refusal, sending nothing. The
 *  call waits for a raise past the driver (`failing`) and goes again as a new effect, never as the tool's own failure. */
const CAP_HELD = "agentrun_serve_cap_held";

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
  return { models: await providerModels(env), model: choice.model as ModelRef | undefined, byTier: new Map([["default", choice.model]]), unpriced: new Set<string>() };
}

/** codex's model (or opencode's, `harness`, on codex's route) and pi-ai's catalog that prices it, where it reaches OpenAI only through OpenRouter (codexModel: no
 *  OpenAI key needed); anywhere else, the run's usual models (runModels). */
async function codexModels(env: NodeJS.ProcessEnv, ref: string | undefined, harness: "codex" | "opencode" = "codex") {
  if (env[FAUX_HARNESS_ENV] || !openRouterOnly(harness, env)) return runModels(env, ref, ["default"], harness);
  const choice = await codexModel(env, ref, harness);
  if ("why" in choice) throw new Error(choice.why);
  return { models: await providerModels(env), model: choice.model as ModelRef | undefined, byTier: new Map([["default", choice.model]]), unpriced: new Set<string>() };
}

/** The run's row and its pinned revision, read from the store the run's directory sits in. */
function revisionOf(where: AppContext): { run: RunRow; revision: Revision } {
  const reader = openStoreReader(dataOfRun(where.root));
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
  // claude-agent's own model, as in production; on the faux harness too unless pi's faux model stands in (runnable.ts).
  const fauxModels = Boolean(env[FAUX_HARNESS_ENV] && env[FAUX_ENV]);
  const chosen = revision.kind === "agentic" && revision.body.harness === "claude-agent" && !fauxModels ? await claudeModels(env, revision.body.model) : revision.kind === "agentic" && (revision.body.harness === "codex" || revision.body.harness === "opencode") ? await codexModels(env, revision.body.model, revision.body.harness) : revision.kind === "agentic" ? await runModels(env, revision.body.model, ["default"], revision.body.harness) : await runModels(env, undefined, llmTiers(workflowNodeList, nodeTiers(workflowNodeList)));
  const { model, byTier } = chosen;
  // Read before the run opens its store: what it spent in earlier processes counts against its cap.
  const cap = capOf(process.env);
  const mode = capModeOf(process.env);
  // A run on another harness has one model route, its session's proxy: every model request of the run goes through it,
  // the harness's own and the run's beside them (a learned workflow's nodes, its `llm` call nodes, a call node's native
  // search), on the session's booking under the run's one cap (port-models.ts, harness-app.ts). The run's models are the
  // session's port then; on pi they are the run's own, each request marked as it leaves (request-start.ts) inside the cap:
  // a request the cap refuses never leaves, and gets a start mark of its own, which its error entry answers.
  const onHarness = revision.kind === "agentic" && Boolean(revision.body.harness) && revision.body.harness !== DEFAULT_HARNESS;
  // claude-agent's run is capped at the price of whoever bills it (claudeProvider's priceModel), as its adapter prices it.
  const priced = onHarness && revision.body.harness === "claude-agent" && !fauxModels ? claudePriceModel(env, model!) : model;
  /** The session's port, once the harness's run is made (adapterRun): read at each request. */
  let sessionPort: ((label: string) => SessionPort | undefined) | undefined;
  const marked = onHarness ? undefined : await markRequests(chosen.models, cancelledIn(where.root));
  // The wrap-up on pi (cap.ts WrapUp): near its cap the run's own model is told once, under this cap, to finish. Not on
  // another harness: its guard tells the harness's model (harness-app.ts). Nor on a workflow run, whose model nodes each
  // deliver a record their node's instructions ask for: a step its cap has no room for waits for a raise instead (budget.ts).
  const storeFile = join(where.store, RUN_STORE_FILE);
  const wrapUp = cap === undefined || onHarness || !model || revision.kind === "workflow" ? undefined : { model: model.modelId, costs: costsIn(storeFile, model.modelId), sent: wrapUpSentIn(storeFile, cap), record: marked!.wrapUp };
  // A workflow's decisions are its spend too, as the cap counted each in an earlier process (decision-cap.ts).
  const spentBefore = (() => {
    const spent = spentIn(storeFile);
    return spent === null || revision.kind !== "workflow" ? spent : spent + decisionSpentIn(storeFile);
  })();
  const models = onHarness
    ? await portModels(() => sessionPort?.(LEARNED_WORKFLOW_TOOL), priced ? (chosen.models.getModel(priced.provider, priced.modelId) as never) : undefined)
    : cap === undefined ? marked!.models : await capModels(marked!.models, cap, spentBefore, { unpriced: chosen.unpriced, refused: marked!.refused, mode, ...(wrapUp ? { wrapUp } : {}) });
  // web_search's own request to the model provider, when it resolves native, goes through the run's models (hosted-search.ts):
  // on another harness, the session's port, for a learned workflow's call node.
  searchOn(models as never);
  const thinkingLevel = thinkingOf(process.env, revision.kind === "agentic" ? revision.body.thinking : undefined);
  // The run's place, as its start resolved and kept it (serve.json): in a box, its coding tools run there (run-box.ts).
  const meta = await readJson(join(where.root, RUN_META));
  const place = storedPlace(meta?.place);
  const root = dataOfRun(where.root);
  // A remote box (Daytona) is the server's to make and seed, reached through its relay; Docker's is made here.
  // Its box carries the epoch of the claim this process was launched under (runs.ts launch): a box of an earlier one is
  // an earlier process's, destroyed before this one makes its own (run-box.ts fenceRunBoxes).
  const epoch = Number(process.env[RUN_EPOCH_ENV] ?? "0");
  const box = place.mode === "sandbox" ? runBox(remotePlace(place) ? { relay: root } : { provider: () => runBoxProvider(place, env, root) }, { id: run.id, root, dir: where.root, place, epoch: Number.isSafeInteger(epoch) ? epoch : 0 }) : undefined;
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
  // the run's models, as the run's own requests under its cap, each model node and `llm` call on the run's model of its
  // tier, else the run's own (the only one the run was made with, and handed the key of); on another harness, the
  // session's one model, through its proxy; the `llm` tool's completion for a call node that names it; its call nodes on
  // the agent's tools its run's plane resolves (the plane its harness and its tools read).
  const flows = revision.kind === "agentic" ? await pinnedWorkflows(where.root, await readPin(where.root)) : [];
  const learnedModel = (tier: unknown): ModelRef | undefined => (onHarness ? { provider: PORT_PROVIDER, modelId: "session" } : (byTier.get((tier as Tier | undefined) ?? "default") ?? byTier.get("default")));
  const learnedTool = flows.length && revision.kind === "agentic"
    ? learnedWorkflowTool({ workflows: flows, granted: revision.body.tools, plane: planeOf(process.env), policy: toolGate.policy, denyFrom: toolGate.denyFrom, env, work: where.work, models: models as never, modelOf: learnedModel, complete: completer(models as never, learnedModel, thinkingLevel) })
    : undefined;
  // The run's effort, as its thinking level reads it: its note on how to work follows the instructions on every harness
  // (effort-guidance.ts). None without an effort.
  const guidance = effortGuidance(process.env[EFFORT_ENV]);
  if (revision.kind === "agentic" && revision.body.harness && revision.body.harness !== DEFAULT_HARNESS) {
    const harness = revision.body.harness;
    // claude-agent, codex and opencode load the skills their adapter takes itself (skillCheckOf), and the prompt keeps only
    // the ones it would refuse; a faux harness's prompt names each skill and its file when the run reads its files (it
    // reads the SKILL.md when it fits), else keeps every skill whole (skills.ts).
    const check = !env[FAUX_HARNESS_ENV] ? await skillCheckOf(harness) : undefined;
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
    const make = (confine?: ConfineChild) => adapterFor(harness, env, { model: model!, models: chosen.models as never, unpriced: chosen.unpriced, ...(confine ? { confine } : {}), ...(native.length ? { skills: native } : {}) });
    // The run's cap, checked before each of the session's requests (the harness's and the run's own beside them): the
    // same ceiling rule as pi's (cap.ts), at the price `priced` names (above).
    const guard = await capBefore(cap, chosen.models.getModel(priced!.provider, priced!.modelId) as never, { listed: !chosen.unpriced.has(priced!.modelId), mode });
    // The cancel mark serve writes is read here too, as pi's model wrapper reads it (request-start.ts).
    // The run's stop record (serve.json, as serve saved it before a stop's abort): a turn it names is not resumed.
    const stopRecord = { ...(typeof meta?.stopped_at === "string" ? { stopped_at: meta.stopped_at } : {}), ...(typeof meta?.stopped_after === "number" ? { stopped_after: meta.stopped_after } : {}) };
    const { door, onOpen, port } = adapterRun(make, harness, spec, BACKGROUND, cap, learnedTool ? [...named, LEARNED_WORKFLOW_TOOL] : named, dir, guard, cancelledIn(where.root), where.work, coding.tools, stopRecord, toolGate, learnedTool ? [learnedTool] : []);
    // The run's own model requests beside the harness's go through the session's proxy, booked on its records (port-models.ts).
    sessionPort = port;
    // A paid host tool's settle goes to the run's root, as on pi (paid-calls.ts settleIn).
    return { models: {}, registry: createRegistry(), door, onOpen: async (durable: DurableRun) => ((runHarness = durable.harness), settleIn(rootRecordOf(durable.harness), durable.store), onOpen(durable)), beforeResume: markResumed } as unknown as AppOptions;
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
  // The gate reads its store before the run resumes (an agentic run's and a workflow's alike): the resume dispatches the
  // calls a crash cut, and a rerun of one it let through must find its mark (tool-gate.ts prime).
  // The run's store as a barrier takes it, and its harness, from the open's beforeResume: a task the open resumes (a turn or
  // a workflow a crash cut) runs before onOpen, and what it sends needs both. A workflow effect's admission is synced on
  // the store (workflowAdmit, below); a paid call's hold is synced on it and booked on the run's root (settleIn), a call
  // node's under its call (runEffect's ledger), and a priced MCP call's records go through the harness's commit.
  let journal: SyncTarget | undefined;
  const hooks = {
    conversationCreated: async (tx: Tx, conversation: { id: number }) => { for (const write of writes) await write(tx, conversation.id); },
    beforeResume: async (run: BeforeResume) => { journal = run.syncTarget; runHarness = run.harness; settleIn(rootRecordOf(run.harness), run.syncTarget); await toolGate.prime(run.harness, run.context, run.syncTarget); await markResumed(run); for (const settle of settles) await settle(run.harness); },
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
      settleIn(rootRecordOf(durable.harness), durable.store);
      marked!.open(durable);
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
  // Lock-free, as the server reads it: nothing made beside the store (a plain read leaves a -shm there).
  const earlier = await (async () => {
    try {
      return durableDecisions(join(where.store, RUN_STORE_FILE), { unlocked: true });
    } catch {
      return (await readLiveView(where.root))?.receipts ?? [];
    }
  })();
  const live = liveView(where.root, [...earlier]);
  // The `llm` tool's one completion: on the run's models (capped and marked as a model node's), its tier's model.
  const complete = completer(models as never, (tier) => byTier.get((tier as Tier | undefined) ?? "default"), thinkingLevel);
  // Under a cap: where a step the cap refuses for room waits for a raise (budget.ts), and the step each wait is for (a
  // model node's request knows no node of its own: it waits inside the node's step, `steps`).
  const spend = runSpendNow();
  const steps = new AsyncLocalStorage<StepAt>();
  /** The model nodes running: a model request whose step its async context lost waits as the one running, when one is. */
  const running = new Set<StepAt>();
  const stepNow = (): StepAt | undefined => steps.getStore() ?? (running.size === 1 ? [...running][0] : undefined);
  const holdMs = Number(process.env[BUDGET_HOLD_ENV]);
  const waits = spend ? budgetWaits(where.root, spend, { holdMs: Number.isFinite(holdMs) && holdMs > 0 ? holdMs : BUDGET_HOLD_MS, letGo: () => void process.kill(process.pid, "SIGTERM") }) : undefined;
  if (spend && waits) {
    // A model request's provider session names its node (the node runner's onNodeOpen, below); else the step its async
    // context gives.
    spend.wait = (refusal, signal, sessionId) => waits.wait(refusal, signal, stepNow(), sessionId);
    // Each paid check takes a raise made while the run works (cap.json), not only the next wait.
    spend.refresh = () => waits.refresh();
    spend.stopped = (refusal, sessionId) => waits.record(refusal, stepNow(), sessionId);
  }
  /** `fn`, a step of the run (a node, a call, a decision) named by its params, counted in flight for the pause's let-go. */
  const stepped = <F,>(fn: F, model = false): F => {
    if (!fn) return fn;
    // By its execution path: a model node's verify decision runs at its node's path, from pi-durable's scheduler drain,
    // whose async context is not the node's; its path says it is the node's work.
    const counted = waits ? waits.step(fn as never, (params: { executionPath?: string } | undefined) => params?.executionPath ?? null) : (fn as (params: unknown) => Promise<unknown>);
    return (async (params: { label?: string; node?: { label?: string }; executionPath?: string }) => {
      const at = { label: String(params?.label ?? params?.node?.label ?? ""), path: params?.executionPath ?? null };
      if (model) running.add(at);
      try {
        return await steps.run(at, () => counted(params as never));
      } finally {
        running.delete(at);
      }
    }) as F;
  };
  /** A model node that failed on a refusal no raise fixes (its model with no price, a spend no one knows: capModels
   *  recorded it, spend.stopped) fails as CapStop, as a call or a decision does, never as the node's own failure, which a
   *  collecting map would take for an item's and go on. */
  const capStopped = <F,>(fn: F): F => (fn && waits ? (async (params: { executionPath?: string }) => {
    try {
      return await (fn as (params: unknown) => Promise<unknown>)(params);
    } catch (error) {
      // A refusal kept with no path of its own is this node's only while it runs alone (stepped counts it running).
      throw waits.stopped(params?.executionPath, running.size === 1) ?? error;
    }
  }) as F : fn);
  // Each decision's hold under the cap, before its request is admitted, and its charge once it answers (decision-cap.ts).
  const capped = waits && decisionProviders ? cappedDecisions({
    providers: decisionProviders, waits, mode,
    book: async (data) => void (runHarness && (await rootRecordOf(runHarness)(DECISION_COST, data))),
    keep: async (data) => {
      if (!runHarness) throw new Error("the run's store is not open");
      await rootRecordOf(runHarness)(DECISION_HOLD, data);
    },
  }) : undefined;
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
      if (permission === "deny") throw new Error(deniedText(node.tool!, undefined, toolGate.denyFrom(node.tool!)));
      if (permission === "ask") throw new Error(`This ${node.tool} call needs a person's approval, which a workflow's call node cannot wait for; it was not run.`);
      // Booked in the run's store, through the harness beforeResume took: a call node a resumed workflow runs before onOpen
      // is booked as on a first run.
      const harness = runHarness;
      const ledger = harness ? { call: `${node.label}@${executionPath ?? ""}${item ? `#${item.index}` : ""}`, record: rootRecordOf(harness) } : undefined;
      // A refusal of the cap inside the effect (a paid request's, the `llm` call's) is the call's: it sent nothing, and
      // whatever the tool made of it, the effect completes as held (CAP_HELD), never as the tool's answer or failure.
      let refused: CapRefusal | undefined;
      const output = await capRefusals.run((refusal) => void (refused ??= refusal), () => effect(input, { signal, env, work: where.work, complete, ...(ledger ? { ledger } : {}) }))
        .catch((error: unknown) => { if (refused && !signal.aborted) return undefined; throw error; });
      if (refused) {
        log({ t: "effect.end", ...at, status: "failed", error: `spend cap: ${refused.words}`.slice(0, 65_536), at: new Date().toISOString() });
        return { [CAP_HELD]: { ...refused, heldAt: Date.now() } };
      }
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
   *  first run and on a resume that answers it from the receipt alike. A call its cap held (CAP_HELD) waits here, past
   *  the driver's admission, for a raise, and goes again as the driver's next effect at its path; held by a refusal no
   *  raise fixes, the run stops (CapStop). A resume answers each held effect from its receipt the same way, and a cap
   *  raised since sends the call at once. */
  const failing = (run: (params: never) => Promise<unknown>, holdPoll?: (executionPath: string, ms: number, hold: string) => void) => async (params: never) => {
    for (;;) {
      const value = await run(params);
      if (isObject(value) && typeof value[TOOL_FAILED] === "string") throw new EffectFailure(value[TOOL_FAILED], null, { code: null });
      if (!(isObject(value) && isObject(value[CAP_HELD]))) return value;
      const refusal = value[CAP_HELD] as unknown as CapRefusal;
      const { node, executionPath, signal } = params as { node: { label: string }; executionPath?: string; signal?: AbortSignal };
      const at = { label: node.label, path: executionPath ?? null };
      if (!waits) throw new Error(`call node "${node.label}": ${refusal.words}`);
      if (!refusal.room) waits.stop(refusal, at);
      if (!(await waits.wait(refusal, signal, at))) throw signal?.reason ?? new Error(`call node "${node.label}" was not sent: its wait for a raise ended`);
      // What it waited, from its refusal (a resume's included), is the call's own no more: its poll window moves back by
      // it (the driver's durable clock, once per hold), as its attempt's deadline does (deps.held).
      const heldAt = (value[CAP_HELD] as { heldAt?: unknown }).heldAt;
      if (typeof heldAt === "number" && executionPath) holdPoll?.(executionPath, Date.now() - heldAt, String(heldAt));
    }
  };
  /** A model node's agent: its tier's model, the tools it names, and the extensions they come from. */
  const nodeAgent = (node: { tier?: string; tools?: string[] }) => {
    const bindings = (node.tools ?? []).flatMap((name) => nodeTools.get(name) ?? []);
    return { model: byTier.get((node.tier as Tier | undefined) ?? "default")!, thinkingLevel, extensions: [...new Set([coding.extension, ...bindings.flatMap((b) => b.extensions), gatedTools])], tools: bindings.flatMap((b) => b.tools) };
  };
  // Under a cap, each node conversation's provider session (pi.provider's sessionId, which its every model request
  // carries) is told to the waits as that node's step: a request runs in whatever async context kicked pi's drain, a map
  // sibling's included, so its session says whose node it waits for and names.
  const nodes = nodeRunner({
    agent: (node) => nodeAgent(node) as never,
    ...(waits ? { onNodeOpen: async (node: { label?: string; executionPath?: string; conversationId: unknown }) => {
      const provider = runHarness ? await runHarness.snapshot(ProviderDoc, node.conversationId as never, BACKGROUND).catch(() => undefined) : undefined;
      if (typeof provider?.sessionId === "string") waits.session(provider.sessionId, { label: String(node.label ?? ""), path: node.executionPath ?? null });
    } } : {}),
  });
  /** The node log's starts and ends, from the workflow's events: what a graph shows of a node's timing. */
  const onEvent = (event: { type: string; detail?: unknown; executionPath?: string }) => {
    if ((event.type !== "node.start" && event.type !== "node.end") || typeof event.executionPath !== "string") return;
    const detail = (event.detail ?? {}) as { kind?: string; status?: string; duration_ms?: number; error?: unknown };
    log({ t: event.type, path: event.executionPath, kind: String(detail.kind ?? ""), at: new Date().toISOString(), ...(detail.status ? { status: detail.status } : {}), ...(typeof detail.duration_ms === "number" ? { duration_ms: detail.duration_ms } : {}), ...(detail.error !== undefined ? { error: String((detail.error as Error)?.message ?? detail.error).slice(0, 500) } : {}) });
  };
  const workflows = createWorkflowExtension({
    // Each workflow effect's admission is synced before it is dispatched (pi-durable-disk barriers.ts, workflowAdmit): the
    // driver's journal is the run's store, taken in beforeResume, so a workflow the open resumes, before onOpen, has it.
    options: () => ({ files: workspaceFiles(where.work), afterAdmit: async () => {
      if (!journal) throw new Error("the run's store is not open, so a workflow effect's admission cannot be made durable: it is not sent");
      await syncNow(journal, BARRIER.workflowAdmit);
    } }),
    run: ({ key, runtime, context, driver }) => {
      // Each typed question's receipt is a row of the run's store before its answer acts, and a resumed run takes an
      // answered one instead of asking again.
      const decisions = decisionRecovery({ key, runtime, context });
      live.driver(driver);
      const deps = withRecovery(driver, {
        runNode: nodes.on(taskScope(runtime), context).runNode, runEffect: runEffect as never,
        ...(decisionProviders ? { runJudge: (capped ? capped.settling(judgeFromProviders({ ...decisionProviders, loadImage })) : judgeFromProviders({ ...decisionProviders, loadImage })) as never, decisionProviders } : {}),
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
      // Under a cap, each decision is held before the driver admits it (a route the driver answers from what it decided
      // sends nothing), each step counts in flight, and a call node's deadline leaves out what it waited for a raise.
      // A request the driver answers from what an earlier process did (a route it decided, a request it admitted and that
      // did not fail, which escalates unsent) holds nothing and never waits for a raise (askedBefore).
      const judge = capped && deps.runJudge ? capped.before(deps.runJudge, (params) => askedBefore(driver as never, params)) : deps.runJudge;
      return { deps: {
        ...deps, runEffect: stepped(deps.runEffect && (failing(deps.runEffect as never, (path, ms, hold) => driver.holdPoll(path, ms, hold)) as never)), runNode: stepped(gate(capStopped(deps.runNode)), true), runJudge: stepped(gate(judge)), onEvent,
        ...(waits ? { held: (path: string) => waits.held(path) } : {}),
        recovery: { ...recovery, resume: (...args: Parameters<typeof recovery.resume>) => resume(args), decision: decisions.decision },
      } };
    },
  });
  registry.install(nodes.extension as unknown as Extension);
  registry.install(workflows.extension as unknown as Extension);
  const onOpen = async (durable: DurableRun) => {
    settleIn(rootRecordOf(durable.harness), durable.store);
    marked!.open(durable);
    const started = { runId: run.id, storePath: join(where.store, RUN_STORE_FILE), agentId: run.agent, revision: revision as Extract<Revision, { kind: "workflow" }> };
    const outcome = await startWorkflowRevision({ harness: durable.harness as never, workflows, context: BACKGROUND_CONTEXT, run: started, input, tools: inspectWorkflow(revision.body.workflow).requires.tools });
    live.stop();
    await letGo(durable.harness);
    await durable.setStatus(outcome.status === "complete" ? "done" : "failed", { workflow: outcome.status, ...(outcome.status === "refused" ? { code: outcome.code, message: outcome.message.slice(0, 500) } : {}) });
    await durable.release();
  };
  return { models, registry, ...hooks, ...(stops.length ? { wake } : {}), onOpen } as unknown as AppOptions;
}
