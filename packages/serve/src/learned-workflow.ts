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
//   - a decision node (judge, pick, sift, a route by question, an ask predicate, a verify: LS-07), on a run handed its
//     decisions (`run.decisions`: its decision providers on its own keys, and the adapter loop's ledger.decisions on
//     the run's one cap), asked of the provider it names, else the run's default, held to the run's gate under that
//     provider's id as a call node's tool is by its name; each admitted on the run's cap before it is sent, priced as a
//     workflow agent's decision is (runner/workflow-spec.ts decisionJudge), settled at what it charged, and one the cap
//     has no room for never sent, the run paused on the cap's refusal (ledger.pause). A run handed none runs no
//     decision node: the check refuses it before any node runs.
// Each model request is a request on the run's one route, so what the workflow spends is the run's cost, under its cap:
// on pi the run's models, as a side request (request-start.ts, cap.ts: marked, and costed on the run's timeline as
// `learned_workflow`); on another harness the session's model proxy, under a side key (port-models.ts): the harness's
// own policy, provider, key and price, booked on the session's records labelled `learned_workflow`. A call a crash cut
// off is never run again (`replay: "never"`): it is answered interrupted.
import type { TSchema } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { registerLabel, registerOutcome } from "@parcha/pi-durable-agent/timeline";
import { sideRequests } from "./cap.js";
import { draftProblems, LEARNED_MAX_TURNS } from "./learn/index.js";
import { decisionsAsked, gatedDecisionWords } from "./learn/skills.js";
import { type LearnedWorkflow, workflowLine } from "./learning.js";
import type { ModelRef } from "./model.js";
import { type Ledger, ledgerOf } from "./paid-calls.js";
import { forModel } from "./result.js";
import type { Plane } from "./tool-plane.js";
import { deniedText, type SettingFrom } from "./tool-gate.js";
import { allows, CALL_TOOLS, learnedDraftTools, toolOf } from "./tools.js";
import type { Complete } from "./llm.js";
import type { DecisionProvider } from "@parcha/agentrun-dsl";
import type { Refusal } from "@parcha/agentrun-kernel";
import type { RunDecisions } from "@parcha/agentrun-kernel/kernel/cap";

export const LEARNED_WORKFLOW_TOOL = "learned_workflow";

/** The most of a learned workflow's output its result line shows, and the longest value it shows as written. */
const LINE_MAX = 120;
const VALUE_MAX = 60;

/** One line of a learned workflow's output for its row: an object's fields as `name value`, each value whole or, when
 *  longer than VALUE_MAX, only as its size, and whole fields only until LINE_MAX. Nothing is ever cut inside a value:
 *  the timeline redacts the line as it says it (its summary's words), and its redactor matches a held value only whole,
 *  so a cut value could leave a prefix it would not find. Newlines are flattened, so the one line it keeps holds every
 *  field. An output already cut for the model (learnedText) says so. */
export function outputLine(text: string): string | undefined {
  const clipped = /\n\[the workflow's output is cut at (\d+) of (\d+) characters\]$/.exec(text);
  if (clipped) return `its output is long, cut at ${clipped[1]} of ${clipped[2]} characters`;
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    return undefined;
  }
  const said = (value: unknown): string => {
    const flat = (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).replace(/\s+/g, " ").trim();
    return flat.length > VALUE_MAX ? `(${flat.length} characters)` : flat;
  };
  if (!output || typeof output !== "object" || Array.isArray(output)) return said(output);
  const fields: string[] = [];
  let length = 0;
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    const field = `${key} ${said(value)}`;
    if (fields.length && length + 2 + field.length > LINE_MAX) {
      fields.push("…");
      break;
    }
    fields.push(field);
    length += (fields.length > 1 ? 2 : 0) + field.length;
  }
  return fields.length ? fields.join(", ") : undefined;
}

// The timeline's words for a learned workflow's call: the workflow it ran (its name), and, once it returns, its output.
registerLabel(LEARNED_WORKFLOW_TOOL, (a) => (typeof a.name === "string" && a.name ? `Ran the learned workflow ${a.name}` : "Ran a learned workflow"), undefined, { name: "Run a learned workflow" });
registerOutcome(LEARNED_WORKFLOW_TOOL, (result) => {
  const line = outputLine(result.text);
  return line === undefined ? undefined : { failed: false, text: line };
});

/** The models a learned workflow's model nodes run on, as pi-ai's: on pi the run's own (capped and marked: app.ts), on
 *  another harness the session's port (port-models.ts). */
type RunModels = {
  getModel(provider: string, id: string): unknown;
  getModels(): readonly unknown[];
  completeSimple(model: never, context: never, options?: never): Promise<unknown>;
};

export type LearnedWorkflowRun = {
  /** The run's learned workflows (learning.ts chooseWorkflows): on the server those its pin names (pinnedWorkflows), on
   *  the runner those its claim's seed lay chose (runner/learning-seed.ts). */
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
  /** The run's gate's permission of a tool now (tool-gate.ts RunGate policy): a call node's tool set to ask or deny is
   *  refused before any node runs, and asked again as each call node runs, a composed workflow's inner ones too, so one
   *  set to either since the call began is refused there, never run. Required: a learned workflow never runs a tool
   *  on a default of allow (#2153). */
  policy: (tool: string) => string;
  /** Where the gate's permission of a tool was set (tool-gate.ts RunGate denyFrom), so a refusal names it: this agent's
   *  settings or this server's. */
  denyFrom: (tool: string) => SettingFrom;
  /** Reads the gate's settings again (a runner's are in its store, read anew at each of its gate's decisions), awaited as
   *  each call node runs, before `policy` is asked: a tool set to deny since the call began is then refused. None: the
   *  gate reads its settings live (main's process). */
  refresh?: () => Promise<void>;
  /** The run's decisions (LS-07): its decision providers (decisions.ts decisionProvidersIn over the run's keys) and the
   *  one a node that names none is asked of; `book`, the run's decisions on its one cap (the adapter loop's
   *  ledger.decisions: DECISION_SESSION); `pause`, the run's pause on a refusal of that cap (ledger.pause), so its next
   *  request is refused in the cap's words and the run parks there. None: a decision node is refused before any node
   *  runs. */
  decisions?: {
    readonly providers: { readonly providers: Readonly<Record<string, DecisionProvider>>; readonly default: string };
    readonly book: RunDecisions;
    readonly pause?: (refusal: Refusal) => Promise<void>;
  };
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

/** One model request as a pi-ai event stream, sent through `models.completeSimple` as the run's own request, under its
 *  cap: on pi marked and costed on the run's timeline under `learned_workflow` (sideRequests), on another harness booked
 *  by the session's proxy, labelled by the side key it goes under. */
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
  // The tools the gate allows now; one set to ask or deny is refused in the words a workflow revision's call node is.
  // A run handed no gate (a caller past the types) runs nothing: a tool is never allowed for want of a policy.
  if (typeof run.policy !== "function" || typeof run.denyFrom !== "function") return refuse("its run gave no tool policy for its call nodes");
  const { tools, gated, deniedBy } = learnedDraftTools(run.granted, run.policy, run.plane, run.denyFrom);
  const problems = draftProblems(dsl, flow.workflow, tools, gated, deniedBy, decisionsOf(run, dsl, flow.workflow));
  if (problems.length) return refuse(problems.map(({ detail }) => detail).join("; "));
  const doc = JSON.parse(flow.workflow);
  const runJudge = run.decisions ? await learnedJudge(run, run.decisions) : undefined;
  // agentrun-pi's root loads its host runner and @earendil-works/pi-coding-agent, an optional peer of agentrun-pi: serve
  // depends on it (package.json) so an installed server has it, not only this repository.
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
    const runner = createPiHostRunner({ cwd: run.work, model: model as never, modelRegistry: registry as never }, { tools: [], maxTurns: LEARNED_MAX_TURNS });
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
    // The gate's one rule, read as each call node runs, as a workflow revision's call node reads it (app.ts runEffect):
    // a tool set to deny since the call began is refused in the gate's words, one set to ask too, since a call node
    // cannot wait for an approval. Neither runs.
    await run.refresh?.();
    const permission = run.policy(tool!);
    if (permission === "deny") throw new Error(deniedText(tool!, undefined, run.denyFrom(tool!)));
    if (permission === "ask") throw new Error(`This ${tool} call needs a person's approval, which a workflow's call node cannot wait for; it was not run.`);
    // Its paid requests booked under the tool's call, as a call of its own: the node, its execution path, its item in a map.
    const booked = ledger ? { ledger: { call: `${ledger.call}/${node.label}@${executionPath ?? ""}${item ? `#${item.index}` : ""}`, record: ledger.record } } : {};
    return effect(given, { signal: own, env: run.env, work: run.work, ...(run.complete ? { complete: run.complete } : {}), ...booked });
  };
  try {
    const judging = runJudge && run.decisions ? { runJudge, decisionProviders: run.decisions.providers } : {};
    const result = await dsl.runWorkflow(doc, input as Record<string, unknown>, { runNode: runNode as never, runEffect: runEffect as never, ...judging, ...(signal ? { signal } : {}) } as never);
    if (result.status !== "complete") return refuse(`it ended ${result.status}`);
    return { text: learnedText(JSON.stringify(result.output ?? null)), isError: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { text: `The learned workflow ${flow.name} failed: ${String((error as Error)?.message ?? error).slice(0, 1000)}`, isError: true };
  }
}

/** The draft check's decisions for `run` (learn/skills.ts DraftDecisions): its providers, and the gate's setting of each
 *  provider `text` asks (its id as the settings key) where it is not allow, with where a deny was set. None when the run
 *  was handed no decisions, or `text` does not parse (the check refuses it then). */
function decisionsOf(run: LearnedWorkflowRun, dsl: Parameters<typeof decisionsAsked>[0], text: string) {
  if (!run.decisions) return undefined;
  const { providers } = run.decisions;
  const gated: Record<string, string> = {};
  // A deny comes from a layer or the default, never from approvals (learnedDraftTools' rule).
  const deniedBy: Record<string, "agent" | "server" | "default"> = {};
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { providers: providers.providers, default: providers.default };
  }
  for (const { provider } of decisionsAsked(dsl, doc, providers.default)) {
    const setting = run.policy(provider);
    if (setting === "allow") continue;
    gated[provider] = setting;
    if (setting === "deny") deniedBy[provider] = run.denyFrom(provider) as "agent" | "server" | "default";
  }
  return { providers: providers.providers, default: providers.default, gated, deniedBy };
}

/** A learned workflow's judge (the DSL's runJudge) for `run`: its providers' judge (judgeFromProviders), each decision
 *  first held to the run's gate as it is asked (a provider set to ask or deny since the call began is refused, never
 *  sent, as a call node's tool is at its effect), then admitted on the run's one cap and settled at what it charged
 *  (decisionJudge, as a workflow agent's decision is). A refusal of the cap pauses the run (`decisions.pause`): the
 *  decision node fails with the cap's words, and nothing is sent. */
async function learnedJudge(run: LearnedWorkflowRun, decisions: NonNullable<LearnedWorkflowRun["decisions"]>) {
  const [{ judgeFromProviders }, { decisionJudge }] = await Promise.all([import("@parcha/agentrun-dsl"), import("./runner/workflow-spec.js")]);
  type Judge = ReturnType<typeof judgeFromProviders>;
  const inner = judgeFromProviders({ providers: decisions.providers.providers, default: decisions.providers.default });
  const capped = decisionJudge<Judge>(inner, {
    getCap: () => decisions.book,
    providers: decisions.providers as never,
    park: (refusal) => {
      void decisions.pause?.({ refuse: refusal.message, forGood: refusal.forGood, code: "spend_cap_reached", ...(refusal.figures ? { figures: refusal.figures as never } : {}) });
    },
  });
  return (async (params: Parameters<Judge>[0]) => {
    const provider = params.provider ?? decisions.providers.default;
    await run.refresh?.();
    const setting = run.policy(provider);
    if (setting !== "allow") throw new Error(gatedDecisionWords(provider, setting, setting === "deny" ? (run.denyFrom(provider) as "agent" | "server" | "default") : undefined, "decision", params.label));
    return capped(params);
  }) as Judge;
}
