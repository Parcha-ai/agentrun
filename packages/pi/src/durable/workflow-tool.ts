// The agentrun tool for a pi-durable session. describe, inspect, dry-run, save, load and list do what the coding-agent
// extension's tool does, through the same module (../workflow-tool.ts); run starts the workflow as one background task
// of the calling conversation through createWorkflowExtension, from the tool's own invocation, and answers with its
// outcome, writing the run's progress to the tool's running output as it goes. The draft a conversation inspected is a
// document of the session, so a reopened session keeps it. Code nodes run only through the host's code executor.
import { defineDocFamily, defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { WORKFLOW_NODE_KINDS, type AuthorHostAddendum, type Workflow, type WorkflowDeps } from "@parcha/agentrun-dsl";
import { canonicalHash } from "@parcha/agentrun-dsl/recovery";
import { extensionStructuralLimits, WorkflowExtensionService } from "../extension-service.js";
import { modelJson } from "../presentation.js";
import { WorkflowStore } from "../workflow-store.js";
import { progressLines, WorkflowObservation } from "../workflow-view.js";
import { authoringReferences, describeTools, dryRunDraft, inspectCandidate, workflowToolParameters, type WORKFLOW_TOOL_ACTIONS } from "../workflow-tool.js";
import { toolResult } from "./pi-versions.js";
import { createWorkflowExtension, type WorkflowTaskHost } from "./task.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type WorkflowEvent = Parameters<NonNullable<WorkflowDeps["onEvent"]>>[0];
/** The tool's arguments, as its parameters admit them. pi-ai keeps its own copy of typebox, so they are not inferred. */
type ToolArgs = { action: (typeof WORKFLOW_TOOL_ACTIONS)[number]; name?: string; digest?: string; workflow?: Record<string, unknown>; input?: Record<string, unknown> };

/** What a pi-durable session adds to the workflow language, rendered for describe's `authoring.host`. */
export const DURABLE_HOST_ADDENDUM: AuthorHostAddendum = Object.freeze({
  name: "pi-durable session",
  nodeKinds: WORKFLOW_NODE_KINDS.filter((kind) => kind !== "artifact"),
  rules: [
    "Call agentrun with action describe first, then inspect the complete workflow with its input, then dry-run it (action dry-run, without a workflow argument), then run without a workflow argument.",
    "A dry run runs the inspected workflow on synthetic values, or the input you give it, with no model, Jev or tool call. Its status is passed, not_run (a check could not run; skipped says why, and it proves nothing) or failed (problems say why). Report not_run as not run, never as passed.",
    "Use exactly the tools describe returns. A call uses via tool with one of them. Shell and executor calls and artifact delivery are unavailable.",
    "Code nodes run only through the host's code executor. Without one, a dry run of a workflow with code is not_run and a run of it is refused.",
    "A run is a pi-durable task of this conversation: it continues after the session reopens, and the run action answers with its outcome once it ends. Running the same draft on the same input again reaches that run: a live one is waited for, a finished one answers with its outcome, and its effects are not made again.",
    "Save keeps a named revision of the inspected definition, not its input. Load replaces the draft with a saved revision and checks it against this host's tools. List shows the saved revisions.",
    "The structural limits describe returns bound node count, map concurrency and parallel branches.",
  ],
});

export type WorkflowToolHost = {
  /** The project whose saved workflows save, load and list keep: `<projectDir>/.pi/agentrun/workflows`, the store the
   *  coding-agent extension keeps for its working directory. */
  projectDir: string;
  /** The tools a workflow may call, as describe lists them. Inspect admits only these names. */
  tools?: readonly { name: string; description?: string; parameters: unknown; resultSchema?: unknown }[];
  /** What a run's task runs with: `createWorkflowExtension`'s host. */
  task: WorkflowTaskHost;
  /** The host's code executor. Without it no code node runs: a dry run of a draft with code is not_run, and a run of
   *  one is refused before it starts. Given, a run's task runs its code nodes through it. */
  runCode?: WorkflowDeps["runCode"];
  /** The SOP text for workflows that name sections. */
  sop?: string;
  /** The tool's name, `agentrun` by default: the agent definition lists it. */
  name?: string;
};

/** The draft a conversation last inspected or loaded, and its input. */
type Draft = { workflow: Json; input: { [key: string]: Json } };
const DraftDoc = defineDocFamily<Draft, null>({ kind: "agentrun.draft", version: 1, scope: "session", family: true, initial: () => ({ workflow: null, input: {} }) });
const json = <T = Json>(value: unknown): T => (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T;
const answer = (value: unknown) => toolResult([{ type: "text", text: modelJson(value) }], { details: json(value) });

/** The tool, and the workflow task its runs are: install `extension` (it carries both) and list the tool's name in the
 *  agent definition. `workflow` reads and stops runs from the host's side. */
export function createWorkflowTool(host: WorkflowToolHost): { extension: Extension; workflow: ReturnType<typeof createWorkflowExtension> } {
  const names = (host.tools ?? []).map((tool) => tool.name);
  const checker = () => new WorkflowExtensionService({ allowedTools: names });
  const store = () => new WorkflowStore(host.projectDir);

  // A run's events reach the tool call that started it, while both live in this process.
  const listeners = new Map<string, Set<(event: WorkflowEvent) => void>>();
  const listen = (key: string, listener: (event: WorkflowEvent) => void) => {
    const set = listeners.get(key) ?? new Set();
    listeners.set(key, set.add(listener));
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
  };
  const given = { ...(host.runCode ? { runCode: host.runCode } : {}), ...(host.sop === undefined ? {} : { sop: host.sop }) };
  const workflow = createWorkflowExtension({
    ...host.task,
    run: async (invocation) => {
      const parts = await host.task.run(invocation);
      const tee = (own: WorkflowDeps["onEvent"]) => (event: WorkflowEvent) => {
        own?.(event);
        for (const listener of listeners.get(invocation.key) ?? []) listener(event);
      };
      return "deps" in parts
        ? { ...parts, deps: { ...given, ...parts.deps, onEvent: tee(parts.deps.onEvent) } }
        : { ...parts, adapters: { ...given, ...parts.adapters, onEvent: tee(parts.adapters.onEvent) } };
    },
  });

  const tool = defineTool({
    name: host.name ?? "agentrun",
    description: "Compose and run AgentRun workflows in this session. Describe lists the tools a workflow may call and the language. Inspect validates a complete workflow and keeps it as this conversation's draft. Dry-run checks the draft on synthetic values (or the given input) with no model, Jev or tool call. Run starts the draft as a durable task of this conversation and answers with its outcome. Save, load and list keep named definition revisions.",
    parameters: workflowToolParameters() as unknown as ToolRegistration["parameters"],
    executionMode: "sequential",
    async execute(given, api, context) {
      const args = given as ToolArgs;
      const key = String(api.conversationId);
      const held = async () => {
        const draft = await api.snapshot(DraftDoc, key, context);
        return draft && draft.workflow !== null ? draft : undefined;
      };
      const keep = (candidate: unknown, input: Record<string, unknown>) => api.commit(async (tx) => {
        const draft = await tx.doc(DraftDoc, key, null);
        draft.workflow = json(candidate);
        draft.input = json(input);
        return undefined;
      }, context);
      const needDraft = async (action: string) => {
        if (args.workflow !== undefined) throw new Error(`Inspect the workflow first with action inspect, then ${action} without a workflow argument.`);
        const draft = await held();
        if (!draft) throw new Error(`Inspect a workflow first, then ${action} it.`);
        return draft;
      };
      switch (args.action) {
        case "describe":
          return answer({ tools: describeTools(host.tools ?? []), structuralLimits: { ...extensionStructuralLimits }, authoring: authoringReferences(DURABLE_HOST_ADDENDUM) });
        case "inspect": {
          const draft = await held();
          const candidate = args.workflow ?? draft?.workflow;
          if (candidate === undefined) throw new Error("No workflow yet. Pass the complete workflow to inspect.");
          // Without input, the input is not checked, as the coding-agent tool's inspect does; the draft keeps none.
          const input = args.input ?? (args.workflow === undefined ? draft?.input : undefined);
          const { tree } = inspectCandidate(checker(), candidate, input);
          await keep(candidate, input ?? {});
          return answer({ preview: tree, workflow: candidate, input: input ?? {} });
        }
        case "dry-run": {
          const draft = await needDraft("dry-run");
          const dryRun = await dryRunDraft(draft.workflow, {
            ...(args.input === undefined ? {} : { input: args.input }), ...(host.sop === undefined ? {} : { sop: host.sop }),
            ...(host.runCode ? { runCode: host.runCode } : {}),
          });
          return answer({ dryRun });
        }
        case "save": {
          const draft = await needDraft("save");
          return answer(await store().save(args.name ?? "", draft.workflow));
        }
        case "list":
          return answer({ workflows: await store().list() });
        case "load": {
          const saved = await store().load(args.name ?? "", args.digest);
          const { tree } = inspectCandidate(checker(), saved.workflow, args.input);
          await keep(saved.workflow, args.input ?? {});
          return answer({ preview: tree, workflow: saved.workflow, input: args.input ?? {}, saved: { name: saved.name, digest: saved.digest } });
        }
        case "run": {
          const draft = await needDraft("run");
          const input = args.input ?? draft.input;
          const { inspection } = inspectCandidate(checker(), draft.workflow, input);
          const code = inspection.nodes.filter((node) => node.kind === "code").map((node) => JSON.stringify(node.label));
          if (code.length && !host.runCode) throw new Error(`Code node${code.length === 1 ? "" : "s"} ${code.join(", ")}: this host runs code only through its own executor and gave none, so the workflow does not run here. Nothing ran.`);
          if (inspection.requires.sopSections.length && host.sop === undefined) throw new Error(`The workflow needs SOP text for ${inspection.requires.sopSections.map((name) => JSON.stringify(name)).join(", ")}, and this host supplies none. Nothing ran.`);
          // One run per draft and input in a conversation: a run asked for again (after a restart, say) reaches the same
          // task, so its effects happen once. A live run is attached to, and a finished one answers with its outcome.
          const runKey = `agentrun:${api.conversationId}:${inspection.sha256}:${canonicalHash(input)}`;
          const observation = new WorkflowObservation();
          let shown = "";
          const stop = listen(runKey, (event) => {
            observation.record(event as never);
            const text = progressLines(observation.data).join(" · ");
            if (text !== shown) { shown = text; api.output(`${text}\n`); }
          });
          try {
            const run = await workflow.start(api, { key: runKey, workflow: draft.workflow as unknown as Workflow, input }, context, { conversationId: Number(api.conversationId), background: true });
            const outcome = await run.wait(context);
            return answer({ run: { key: runKey, taskId: run.taskId, started: run.started }, outcome, progress: progressLines(observation.data) });
          } finally { stop(); }
        }
      }
    },
  });

  return { extension: defineExtension({ name: "agentrun.tool", tools: [tool], tasks: workflow.extension.tasks }), workflow };
}
