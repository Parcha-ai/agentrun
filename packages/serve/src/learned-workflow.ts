// learned_workflow: a run of an agent that learned a workflow runs it as one tool call, on any harness. The tool is the
// run's when its pin names a learned workflow (learning.ts: one whose README sets no status, or `active`; a pending or
// retired one is never named), with no edit of the agent's definition; its description names each one and what it does,
// so the model needs no hint. A call checks the workflow again against the agent's own tools as its run has them (S1's
// checker, draftProblems, as at learn time: a call node on a tool the agent was not granted or its run resolves
// unavailable, a model node that names any tool, a code node or a shell or executor call is refused before any node
// runs, never after earlier ones spent), then runs it with the workflow DSL's runWorkflow:
//   - a model node (agent, decide, extract, report) on the run's model of its tier, else the run's own model (the one
//     model the run was made with and handed the key of: app.ts), in a fresh session of its own (agentrun-pi's host
//     runner), with no tool of its own;
//   - a call node `via: "tool"` on the tool table's effect, as a workflow revision's (app.ts), for a tool the agent has,
//     its paid requests booked under the tool's call (paid-calls.ts), each node's under a call of its own; web_search
//     where it resolves native on the provider's hosted search through the run's models (hosted-search.ts), on a harness
//     whose own search it is too (harness-app.ts gives that harness no host tool of the name).
// Each model request goes through the run's models as a side request (request-start.ts, cap.ts: under the run's cap,
// marked, and costed on the run's timeline as `learned_workflow`), so what the workflow spends is the run's cost. A call
// a crash cut off is never run again (`replay: "never"`): it is answered interrupted.
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { sideRequests } from "./cap.js";
import { draftProblems } from "./learn/index.js";
import { type LearnedWorkflow, workflowLine } from "./learning.js";
import type { ModelRef } from "./model.js";
import { type Ledger, ledgerOf } from "./paid-calls.js";
import { forModel } from "./result.js";
import type { Plane } from "./tool-plane.js";
import { allows, CALL_TOOLS, learnedWorkflowTools, toolOf } from "./tools.js";
import type { Complete } from "./llm.js";

export const LEARNED_WORKFLOW_TOOL = "learned_workflow";

/** The models a learned workflow's model nodes run on: the run's own (capped and marked: app.ts), as pi-ai's. */
type RunModels = {
  getModel(provider: string, id: string): unknown;
  getModels(): readonly unknown[];
  completeSimple(model: never, context: never, options?: never): Promise<unknown>;
};

export type LearnedWorkflowRun = {
  /** The learned workflows the run's pin names (pinnedWorkflows). */
  workflows: readonly LearnedWorkflow[];
  /** The tools the agent's revision grants: a workflow's call node may name only those a call node runs here
   *  (tools.ts learnedWorkflowTools), and of those, none `plane` resolves unavailable. */
  granted: readonly string[];
  /** The run's plane (tool-plane.ts planeOf), as its harness and its tools read it. */
  plane?: Plane;
  env: NodeJS.ProcessEnv;
  work: string;
  models: RunModels;
  /** The run's model a model node of `tier` runs on: the tier's, else the run's own. */
  modelOf(tier: string | undefined): ModelRef | undefined;
  /** The `llm` tool's completion, for a call node that names it. */
  complete?: Complete;
};

/** The most characters of a learned workflow's output its answer holds, monid's bound (monid.ts CLIP): within the
 *  host's result bound, which each CLI is told to pass whole (host-bounds.test). */
export const LEARNED_CLIP = 60_000;

/** `text`, a learned workflow's output as JSON, cut at LEARNED_CLIP characters (never inside a surrogate pair), saying
 *  so. */
export function learnedText(text: string): string {
  if (text.length <= LEARNED_CLIP) return text;
  const end = /[\uD800-\uDBFF]/.test(text[LEARNED_CLIP - 1] ?? "") ? LEARNED_CLIP - 1 : LEARNED_CLIP;
  return `${text.slice(0, end)}\n[the workflow's output is cut at ${end} of ${text.length} characters]`;
}

/** What a learned workflow's model node is refused with when it names a tool: it runs in a session of its own here.
 *  The check before the run refuses such a workflow first (draftProblems); this one holds should it not. */
export const NODE_TOOLS_REFUSED = "a learned workflow's model node runs without tools here";

/** The tool's description: what it does, and each workflow by name with the line its README says what it does with. */
export const learnedWorkflowDescription = (workflows: readonly LearnedWorkflow[]): string =>
  [
    "Run a workflow this agent learned, as one step: give its name and its input, a JSON object as the workflow's input",
    "schema says. It answers the workflow's output as JSON, or why it did not run. The workflows:",
    ...workflows.map(workflowLine),
  ].join("\n");

/** One model request as a pi-ai event stream, sent as a side request through `models.completeSimple`: marked and costed
 *  on the run's timeline under `learned_workflow`, and under the run's cap. */
async function sideStream(models: RunModels, model: unknown, context: object, options: object | undefined) {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const stream = createAssistantMessageEventStream();
  sideRequests.set(context, { label: LEARNED_WORKFLOW_TOOL, extraInputTokens: 0, maxFeeUsd: 0, feeUsd: () => 0 });
  void (async () => {
    try {
      const message = (await models.completeSimple(model as never, context as never, options as never)) as { stopReason?: string; errorMessage?: string };
      if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message } as never);
      else stream.push({ type: "done", reason: message.stopReason, message } as never);
      stream.end(message as never);
    } catch (error) {
      const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: String((error as Error)?.message ?? error), timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "error", reason: "error", error: failed } as never);
      stream.end(failed as never);
    }
  })();
  return stream;
}

/** The run's `learned_workflow` tool over `run.workflows`. */
export function learnedWorkflowTool(run: LearnedWorkflowRun): ToolRegistration {
  const names = run.workflows.map(({ name }) => name);
  return defineTool({
    name: LEARNED_WORKFLOW_TOOL,
    description: learnedWorkflowDescription(run.workflows),
    // Never run again after a crash (pi-durable's "unsafe"; a HostTool's "never": host-tools.ts REPLAY).
    replay: "unsafe",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "input"],
      properties: {
        name: { type: "string", enum: names, description: "The learned workflow to run." },
        input: { type: "object", description: "The workflow's input, as its input schema says." },
      },
    } as unknown as TSchema,
    execute: async (args, api, context) => {
      const { name, input } = (args ?? {}) as { name?: unknown; input?: unknown };
      const flow = run.workflows.find((workflow) => workflow.name === name);
      if (!flow) return forModel(`No learned workflow of this agent is named ${JSON.stringify(name)}. Its workflows: ${names.join(", ")}.`, { isError: true });
      const said = await runLearned(run, flow, input, context?.abortSignal, ledgerOf(api, context));
      return forModel(said.text, { isError: said.isError });
    },
  });
}

/** `flow` run on `input` for `run`: its output as JSON, or why it did not run. Never throws, but on an abort. `ledger`:
 *  the tool call's, which each call node's paid requests are booked under, as a call of its own within it. */
export async function runLearned(run: LearnedWorkflowRun, flow: LearnedWorkflow, input: unknown, signal?: AbortSignal, ledger?: Ledger): Promise<{ text: string; isError: boolean }> {
  const refuse = (why: string) => ({ text: `The learned workflow ${flow.name} was not run: ${why}`, isError: true });
  if (!input || typeof input !== "object" || Array.isArray(input)) return refuse("its input must be a JSON object");
  const dsl = await import("@parcha/agentrun-dsl");
  // Checked again at the call, against the agent's own tools as its run has them, before any node runs: what merged under
  // another revision may name one it has no more.
  const tools = learnedWorkflowTools(run.granted, run.plane);
  const problems = draftProblems(dsl, flow.workflow, tools);
  if (problems.length) return refuse(problems.map(({ detail }) => detail).join("; "));
  const doc = JSON.parse(flow.workflow);
  const { createPiHostRunner } = await import("@parcha/agentrun-pi");
  const runners = new Map<string, NonNullable<Parameters<typeof dsl.runWorkflow>[2]["runNode"]>>();
  const runnerFor = async (tier: string | undefined) => {
    const known = runners.get(tier ?? "default");
    if (known) return known;
    const ref = run.modelOf(tier);
    if (!ref) throw new Error("the run has no model for its model nodes");
    const model = run.models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`the model ${ref.provider}/${ref.modelId} is not known here`);
    const registry = { getAll: () => run.models.getModels() as never, streamSimple: (m: unknown, ctx: object, options?: object) => sideStream(run.models, m, ctx, options) as never };
    const runner = createPiHostRunner({ cwd: run.work, model: model as never, modelRegistry: registry as never }, { tools: [] });
    runners.set(tier ?? "default", runner);
    return runner;
  };
  const runNode = async (request: Parameters<NonNullable<Parameters<typeof dsl.runWorkflow>[2]["runNode"]>>[0]) => {
    if (request.tools?.length) throw new Error(`${NODE_TOOLS_REFUSED}: its node "${request.label}" names ${request.tools.join(", ")}`);
    // Its own signal, which the DSL ties to the call's (a sibling's failure, a deadline, the call's stop).
    return (await runnerFor(request.tier as string | undefined))(request);
  };
  const runEffect = async ({ node, input: given, signal: own, executionPath, item }: { node: { label: string; via: string; tool?: string }; input: Record<string, unknown>; signal: AbortSignal; executionPath?: string; item?: { index: number } }) => {
    const tool = node.via === "tool" ? node.tool : undefined;
    const effect = tool && allows(CALL_TOOLS, tool) && tools.includes(tool) ? toolOf(tool)?.effect : undefined;
    if (!effect) throw new Error(`call node "${node.label}": this agent runs no tool ${tool ?? `via ${node.via}`}`);
    // Its paid requests booked under the tool's call, as a call of its own: the node, its execution path, its item in a map.
    const booked = ledger ? { ledger: { call: `${ledger.call}/${node.label}@${executionPath ?? ""}${item ? `#${item.index}` : ""}`, record: ledger.record } } : {};
    return effect(given, { signal: own, env: run.env, work: run.work, ...(run.complete ? { complete: run.complete } : {}), ...booked });
  };
  try {
    const result = await dsl.runWorkflow(doc, input as Record<string, unknown>, { runNode: runNode as never, runEffect: runEffect as never, ...(signal ? { signal } : {}) } as never);
    if (result.status !== "complete") return refuse(`it ended ${result.status}`);
    return { text: learnedText(JSON.stringify(result.output ?? null)), isError: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { text: `The learned workflow ${flow.name} failed: ${String((error as Error)?.message ?? error).slice(0, 1000)}`, isError: true };
  }
}
