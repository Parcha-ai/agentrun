// The app `pi-durable-disk run --app` loads for each run serve starts. It reads the run's revision from the agent store
// (`<data>/store.sqlite`, the run being `<data>/runs/<id>`) and runs it on the model model.ts chooses:
//   - agentic: the root agent with the revision's instructions and skills, and the tools it names of the workspace's
//     file tools and `ask_person`, which ends the agent's turn until the person answers;
//   - workflow: the revision's workflow, started with startWorkflowRevision of @parcha/pi-durable-agent/workflow on
//     agentrun-pi's durable workflow task, each model node on the host's model of its tier with the file tools it names. When the
//     workflow ends the app writes the run's final status, with the outcome, and releases the run. The server carries
//     it back once this process has exited: this process holds the run's store until then.
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { basename, join, resolve } from "node:path";
import type { TSchema } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type Extension, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { openStoreReader, type Revision, RUN_STORE_FILE, type RunRow } from "@parcha/pi-durable-agent";
import { ArchilCodingTools, type AppContext, type AppOptions, type DurableRun } from "@parcha/pi-durable-disk";
import { capModels, capOf, spentIn } from "./cap.js";
import { readJson, RUN_META } from "./files.js";
import { adapterFor } from "./adapters.js";
import { DEFAULT_HARNESS } from "./harness.js";
import { adapterRun } from "./harness-app.js";
import { nodeTiers, runModels, type Tier, thinkingOf } from "./model.js";
import { isObject, skillNames } from "./validate.js";

export const ASK_TOOL = "ask_person";
/** The tool names a definition may name here. `bash` is not bound: a local run gets no shell on this machine. */
export const BOUND_TOOLS = ["read", "write", "edit", ASK_TOOL] as const;
/** The tools a workflow's model node may name: the file tools. */
export const NODE_TOOLS = ["read", "write", "edit"] as const;
/** The workflow adapters this host gives a run: model nodes only. */
export const WORKFLOW_ADAPTERS = ["runNode"] as const;

/** What the result of `ask_person` says; the person's page shows the question as a waiting row. */
export const asked = (question: string) => `Asked the person: ${question.slice(0, 500)}. Waiting for their answer.`;

export const askPerson = defineTool({
  name: ASK_TOOL,
  description: "Ask the person who started this run a question you cannot answer yourself. Call it alone. It ends your turn; the person's reply comes as their next message.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { question: { type: "string", minLength: 1, description: "The question, in one or two plain sentences." } },
    required: ["question"],
  } as unknown as TSchema,
  replay: "safe",
  execute: async (args) => {
    const { question } = args as { question: string };
    // Both keys: pi-durable 1.1 reads a result's `content`, 1.2 and later its `output`; either alone reaches the other
    // as an empty result.
    const said = [{ type: "text" as const, text: asked(question) }];
    return { content: said, output: said, details: { question }, control: { terminate: true } } as unknown as ToolExecutionResult;
  },
});

/** The revision's instructions, then each skill's `<name>/SKILL.md` from the run's workspace, by name. */
export async function promptOf(instructions: string, skillFiles: Iterable<string>, work: string): Promise<string> {
  const skills = await Promise.all(
    skillNames(skillFiles).map(async (name) => `<skill name="${name}">\n${(await readFile(join(work, ".agents", "skills", ...name.split("/"), "SKILL.md"), "utf8")).trim()}\n</skill>`),
  );
  return [instructions.trim(), ...(skills.length ? ["Your skills follow. Use the one that fits the step you are on.", ...skills] : [])].join("\n\n");
}

// pi-durable-disk's types name the pi-durable it resolves, which a build at another pi version (the pi-floor legs) can
// hold apart from this package's own: the options cross that boundary as values, typed on this side.
const CodingTools = ArchilCodingTools as unknown as Extension;

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
  const chosen = revision.kind === "agentic" ? await runModels(process.env, revision.body.model) : await runModels(process.env, undefined, nodeTiers(revision.body.workflow));
  const { model, byTier } = chosen;
  // Read before the run opens its store: what it spent in earlier processes counts against its cap.
  const cap = capOf(process.env);
  const models = cap === undefined ? chosen.models : await capModels(chosen.models, cap, spentIn(join(where.store, RUN_STORE_FILE)));
  const thinkingLevel = thinkingOf(process.env, revision.kind === "agentic" ? revision.body.thinking : undefined);
  const registry = createRegistry();
  registry.install(CodingTools);
  const fileTools = new Map((CodingTools.tools ?? []).map((tool) => [tool.name, tool] as const));
  if (revision.kind === "agentic" && revision.body.harness && revision.body.harness !== DEFAULT_HARNESS) {
    const instructions = await promptOf(revision.body.instructions, Object.keys(revision.body.skills), where.work);
    const spec = { key: `run:${run.id}`, label: run.agent, system: [instructions], context: "fresh" as const };
    // ask_person stays pi's (runnable.ts refuses a run that names it here); the file tools are pi's own.
    const named = revision.body.tools.filter((name) => name !== ASK_TOOL);
    const { door, onOpen } = adapterRun(await adapterFor(revision.body.harness, process.env), spec, BACKGROUND, cap, named);
    return { models: {}, registry: createRegistry(), door, onOpen } as unknown as AppOptions;
  }
  if (revision.kind === "agentic") {
    registry.install(defineExtension({ name: "person", tools: [askPerson] }));
    const bound = new Map<string, ToolRegistration>([...fileTools, [ASK_TOOL, askPerson as ToolRegistration]]);
    const tools = revision.body.tools.map((name) => {
      const tool = (BOUND_TOOLS as readonly string[]).includes(name) ? bound.get(name) : undefined;
      if (!tool) throw new Error(`the revision names the tool ${name}, which agentrun-serve does not bind (it binds ${BOUND_TOOLS.join(", ")})`);
      return tool;
    });
    const instructions = await promptOf(revision.body.instructions, Object.keys(revision.body.skills), where.work);
    return { models, registry, root: { agent: { model, thinkingLevel, instructions, tools } } } as unknown as AppOptions;
  }
  const meta = await readJson(join(where.root, RUN_META));
  const input = isObject(meta?.input) ? meta.input : {};
  const [{ BACKGROUND_CONTEXT }, { createWorkflowExtension, nodeRunner, taskScope }, { workspaceFiles }, { startWorkflowRevision }] = await Promise.all([
    import("@earendil-works/chord/context"),
    import("@parcha/agentrun-pi/durable"),
    import("@parcha/agentrun-dsl/recovery"),
    import("@parcha/pi-durable-agent/workflow"),
  ]);
  const nodes = nodeRunner({
    agent: (node) => ({ model: byTier.get((node.tier as Tier | undefined) ?? "default")!, thinkingLevel, extensions: [CodingTools], tools: (node.tools ?? []).flatMap((name) => (NODE_TOOLS as readonly string[]).includes(name) && fileTools.has(name) ? [fileTools.get(name)!] : []) }) as never,
  });
  const workflows = createWorkflowExtension({
    options: () => ({ files: workspaceFiles(where.work) }),
    run: ({ runtime, context }) => ({ adapters: { runNode: nodes.on(taskScope(runtime), context).runNode }, durableNodes: true }),
  });
  registry.install(nodes.extension as unknown as Extension);
  registry.install(workflows.extension as unknown as Extension);
  const onOpen = async (durable: DurableRun) => {
    const started = { runId: run.id, storePath: join(where.store, RUN_STORE_FILE), agentId: run.agent, revision: revision as Extract<Revision, { kind: "workflow" }> };
    const outcome = await startWorkflowRevision({ harness: durable.harness as never, workflows, context: BACKGROUND_CONTEXT, run: started, input, tools: NODE_TOOLS });
    await durable.setStatus(outcome.status === "complete" ? "done" : "failed", { workflow: outcome.status, ...(outcome.status === "refused" ? { code: outcome.code, message: outcome.message.slice(0, 500) } : {}) });
    await durable.release();
  };
  return { models, registry, onOpen } as unknown as AppOptions;
}
