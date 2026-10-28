// The app `pi-durable-disk run --app` loads for each run serve starts. It reads the run's revision from the agent store
// (`<data>/store.sqlite`, the run being `<data>/runs/<id>`) and runs it on the model model.ts chooses:
//   - agentic: the root agent with the revision's instructions and skills, and the tools it names, bound from the
//     closed table in tools.ts;
//   - workflow: the revision's workflow, started with startWorkflowRevision of @parcha/pi-durable-agent/workflow on
//     agentrun-pi's durable workflow task, each model node on the host's model of its tier with the tools it names of the
//     table's node tools. When the
//     workflow ends the app writes the run's final status, with the outcome, and releases the run. The server carries
//     it back once this process has exited: this process holds the run's store until then.
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createRegistry, type Extension, type Harness, type Tx } from "@earendil-works/pi-durable";
import { openStoreReader, type Revision, RUN_STORE_FILE, type RunRow } from "@parcha/pi-durable-agent";
import type { AppContext, AppOptions, BeforeResume, DurableRun } from "@parcha/pi-durable-disk";
import { capModels, capOf, spentIn } from "./cap.js";
import { cancelledIn, markRequests } from "./request-start.js";
import { readJson, RUN_META } from "./files.js";
import { nodeTiers, runModels, type Tier, thinkingOf, workflowNodes } from "./model.js";
import { CodingTools, type ToolBinding, type ToolHost, toolOf, workflowTools } from "./tools.js";
import { isObject, skillNames } from "./validate.js";

/** The workflow adapters this host gives a run: model nodes, and calls `via: "tool"` to the table's tools. */
export const WORKFLOW_ADAPTERS = ["runNode", "runEffect"] as const;

/** The revision's instructions, then each skill's `<name>/SKILL.md` from the run's workspace, by name. */
export async function promptOf(instructions: string, skillFiles: Iterable<string>, work: string): Promise<string> {
  const skills = await Promise.all(
    skillNames(skillFiles).map(async (name) => `<skill name="${name}">\n${(await readFile(join(work, ".agents", "skills", ...name.split("/"), "SKILL.md"), "utf8")).trim()}\n</skill>`),
  );
  return [instructions.trim(), ...(skills.length ? ["Your skills follow. Use the one that fits the step you are on.", ...skills] : [])].join("\n\n");
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
  const workflowNodeList = revision.kind === "workflow" ? workflowNodes(revision.body.workflow, (await import("@parcha/agentrun-dsl")).inspectWorkflow(revision.body.workflow)) : [];
  const chosen = revision.kind === "agentic" ? await runModels(process.env, revision.body.model) : await runModels(process.env, undefined, nodeTiers(workflowNodeList));
  const { model, byTier } = chosen;
  // Read before the run opens its store: what it spent in earlier processes counts against its cap.
  const cap = capOf(process.env);
  // Each request is marked as it leaves (request-start.ts), inside the cap: a request the cap refuses never leaves.
  const marked = await markRequests(chosen.models, cancelledIn(where.root));
  const models = cap === undefined ? marked.models : await capModels(marked.models, cap, spentIn(join(where.store, RUN_STORE_FILE)));
  const thinkingLevel = thinkingOf(process.env, revision.kind === "agentic" ? revision.body.thinking : undefined);
  const registry = createRegistry();
  registry.install(CodingTools);
  // Each tool the revision names is bound once, from the table: its extensions installed here, its documents written in
  // each conversation's creating commit, what it settles done before anything resumes, and what it lets go done before
  // the run is released.
  const writes: Array<(tx: Tx, conversationId: number) => void | Promise<void>> = [];
  const settles: Array<(harness: Harness) => void | Promise<void>> = [];
  const stops: Array<(harness: Harness) => void | Promise<void>> = [];
  const host: ToolHost = {
    where, env: process.env, install: (extension) => registry.install(extension),
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
    beforeResume: async ({ harness }: BeforeResume) => { for (const settle of settles) await settle(harness); },
  };
  // A SIGTERM lets the run go: what a tool holds is let go there, then the wake is recorded as pi-durable-disk records it
  // by default (sleeping, due at `at`).
  const wake = async (durable: DurableRun, at: number | null) => {
    await letGo(durable.harness);
    await durable.setStatus("sleeping", { reason: "drained" }, { wakeAt: at === null ? null : new Date(at).toISOString() });
  };
  if (revision.kind === "agentic") {
    const tools = (await Promise.all(revision.body.tools.map((name) => bind(name)))).flatMap((binding) => binding.tools);
    const instructions = await promptOf(revision.body.instructions, Object.keys(revision.body.skills), where.work);
    return { models, registry, ...hooks, ...(stops.length ? { wake } : {}), root: { agent: { model, thinkingLevel, instructions, tools } }, onOpen: async (durable: DurableRun) => marked.open(durable) } as unknown as AppOptions;
  }
  const meta = await readJson(join(where.root, RUN_META));
  const input = isObject(meta?.input) ? meta.input : {};
  const [{ BACKGROUND_CONTEXT }, { createWorkflowExtension, nodeRunner, taskScope }, { inspectWorkflow }, { workspaceFiles }, { startWorkflowRevision }] = await Promise.all([
    import("@earendil-works/chord/context"),
    import("@parcha/agentrun-pi/durable"),
    import("@parcha/agentrun-dsl"),
    import("@parcha/agentrun-dsl/recovery"),
    import("@parcha/pi-durable-agent/workflow"),
  ]);
  const nodeTools = new Map<string, ToolBinding>();
  for (const name of workflowTools(workflowNodeList).nodes) nodeTools.set(name, await bind(name, true));
  /** A call node `via: "tool"`: the table's tool by name, its interpolated args in, what its `out` schema checks out. */
  const runEffect = async ({ node, input, signal }: { node: { label: string; via: string; tool?: string }; input: Record<string, unknown>; signal: AbortSignal }) => {
    const effect = node.via === "tool" && node.tool ? toolOf(node.tool)?.effect : undefined;
    if (!effect) throw new Error(`call node "${node.label}": agentrun-serve runs no tool ${node.tool ?? `via ${node.via}`}`);
    return effect(input, { signal, env: process.env });
  };
  /** A model node's agent: its tier's model, the tools it names, and the extensions they come from. */
  const nodeAgent = (node: { tier?: string; tools?: string[] }) => {
    const bindings = (node.tools ?? []).flatMap((name) => nodeTools.get(name) ?? []);
    return { model: byTier.get((node.tier as Tier | undefined) ?? "default")!, thinkingLevel, extensions: [...new Set([CodingTools, ...bindings.flatMap((b) => b.extensions)])], tools: bindings.flatMap((b) => b.tools) };
  };
  const nodes = nodeRunner({ agent: (node) => nodeAgent(node) as never });
  const workflows = createWorkflowExtension({
    options: () => ({ files: workspaceFiles(where.work) }),
    run: ({ runtime, context }) => ({ adapters: { runNode: nodes.on(taskScope(runtime), context).runNode, runEffect: runEffect as never }, durableNodes: true }),
  });
  registry.install(nodes.extension as unknown as Extension);
  registry.install(workflows.extension as unknown as Extension);
  const onOpen = async (durable: DurableRun) => {
    marked.open(durable);
    const started = { runId: run.id, storePath: join(where.store, RUN_STORE_FILE), agentId: run.agent, revision: revision as Extract<Revision, { kind: "workflow" }> };
    const outcome = await startWorkflowRevision({ harness: durable.harness as never, workflows, context: BACKGROUND_CONTEXT, run: started, input, tools: inspectWorkflow(revision.body.workflow).requires.tools });
    await letGo(durable.harness);
    await durable.setStatus(outcome.status === "complete" ? "done" : "failed", { workflow: outcome.status, ...(outcome.status === "refused" ? { code: outcome.code, message: outcome.message.slice(0, 500) } : {}) });
    await durable.release();
  };
  return { models, registry, ...hooks, ...(stops.length ? { wake } : {}), onOpen } as unknown as AppOptions;
}
