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
import { createRegistry, type Extension, type Harness, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { openStoreReader, type Revision, RUN_STORE_FILE, type RunRow } from "@parcha/pi-durable-agent";
import type { AppContext, AppOptions, BeforeResume, DurableRun } from "@parcha/pi-durable-disk";
import { readJson, RUN_META } from "./files.js";
import { nodeTiers, runModels, type Tier, thinkingOf } from "./model.js";
import { CodingTools, type ToolHost, toolOf } from "./tools.js";
import { isObject, skillNames } from "./validate.js";

/** The workflow adapters this host gives a run: model nodes only. */
export const WORKFLOW_ADAPTERS = ["runNode"] as const;

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
  const { models, model, byTier } = revision.kind === "agentic" ? await runModels(process.env, revision.body.model) : await runModels(process.env, undefined, nodeTiers(revision.body.workflow));
  const thinkingLevel = thinkingOf(process.env, revision.kind === "agentic" ? revision.body.thinking : undefined);
  const registry = createRegistry();
  registry.install(CodingTools);
  // Each tool the revision names is bound once, from the table: its extensions installed here, its documents written in
  // each conversation's creating commit, and what it settles at open done before anything resumes.
  const writes: Array<(tx: Tx, conversationId: number) => void | Promise<void>> = [];
  const settles: Array<(harness: Harness) => void | Promise<void>> = [];
  const host: ToolHost = { where, env: process.env, install: (extension) => registry.install(extension), onConversation: (write) => void writes.push(write), beforeResume: (settle) => void settles.push(settle) };
  const bound = new Map<string, Promise<readonly ToolRegistration[]>>();
  const bind = (name: string, nodes = false): Promise<readonly ToolRegistration[]> => {
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
  if (revision.kind === "agentic") {
    const tools = (await Promise.all(revision.body.tools.map((name) => bind(name)))).flat();
    const instructions = await promptOf(revision.body.instructions, Object.keys(revision.body.skills), where.work);
    return { models, registry, ...hooks, root: { agent: { model, thinkingLevel, instructions, tools } } } as unknown as AppOptions;
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
  const nodeTools = new Map<string, readonly ToolRegistration[]>();
  for (const name of inspectWorkflow(revision.body.workflow).requires.tools) nodeTools.set(name, await bind(name, true));
  const nodes = nodeRunner({
    agent: (node) => ({ model: byTier.get((node.tier as Tier | undefined) ?? "default")!, thinkingLevel, extensions: [CodingTools], tools: (node.tools ?? []).flatMap((name) => nodeTools.get(name) ?? []) }) as never,
  });
  const workflows = createWorkflowExtension({
    options: () => ({ files: workspaceFiles(where.work) }),
    run: ({ runtime, context }) => ({ adapters: { runNode: nodes.on(taskScope(runtime), context).runNode }, durableNodes: true }),
  });
  registry.install(nodes.extension as unknown as Extension);
  registry.install(workflows.extension as unknown as Extension);
  const onOpen = async (durable: DurableRun) => {
    const started = { runId: run.id, storePath: join(where.store, RUN_STORE_FILE), agentId: run.agent, revision: revision as Extract<Revision, { kind: "workflow" }> };
    const outcome = await startWorkflowRevision({ harness: durable.harness as never, workflows, context: BACKGROUND_CONTEXT, run: started, input, tools: [...nodeTools.keys()] });
    await durable.setStatus(outcome.status === "complete" ? "done" : "failed", { workflow: outcome.status, ...(outcome.status === "refused" ? { code: outcome.code, message: outcome.message.slice(0, 500) } : {}) });
    await durable.release();
  };
  return { models, registry, ...hooks, onOpen } as unknown as AppOptions;
}
