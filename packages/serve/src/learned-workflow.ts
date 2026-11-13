// learned_workflow: a run of an agent that learned a workflow runs it as one tool call, on any harness. The tool is the
// run's when its pin names a learned workflow (learning.ts: one whose README sets no status, or `active`; a pending or
// retired one is never named), with no edit of the agent's definition; its description names each one and what it does,
// so the model needs no hint. A call checks the workflow again against the agent's own tools as its run has them (S1's
// checker, draftProblems, as at learn time: a call node on a tool the agent was not granted or its run resolves
// unavailable, a model node that names any tool, a code node or a shell or executor call is refused before any node
// runs, never after earlier ones spent), then runs it with the workflow DSL's runWorkflow:
//   - a model node (agent, decide, extract, report) on the run's model of its tier, else the run's own model (the one
//     model the run was made with and handed the key of: app.ts), in a fresh session of its own (the host
//     runner, workflow/host-session.ts), with no tool of its own;
//   - a call node `via: "tool"` on the tool table's effect, as a workflow revision's (app.ts), for a tool the agent has,
//     its paid requests booked under the tool's call (paid-calls.ts), each node's under a call of its own; web_search
//     where it resolves native on the provider's hosted search through the run's models (hosted-search.ts), on a harness
//     whose own search it is too (harness-app.ts gives that harness no host tool of the name).
//   - a decision node (judge, pick, sift, a route by question, an ask predicate, a verify: LS-07), on a run handed its
//     decisions (`run.decisions`: its decision providers on its own keys, and the adapter loop's ledger.decisions on
//     the run's one cap), asked of the provider it names, else the run's default, held to the run's gate under that
//     provider's bare id (tool-plane.ts DECISION_PROVIDER_KEYS: allow or deny), refused only on deny; each admitted on the run's cap before it is sent, priced as a
//     workflow agent's decision is (runner/workflow-spec.ts decisionJudge), settled at what it charged, and one the cap
//     has no room for never sent, the run paused on the cap's refusal (ledger.pause). A run handed none runs no
//     decision node: the check refuses it before any node runs.
// Each model request is a request on the run's one route, so what the workflow spends is the run's cost, under its cap:
// on pi the run's models, as a side request (request-start.ts, cap.ts: marked, and costed on the run's timeline as
// `learned_workflow`); on another harness the session's model proxy, under a side key (port-models.ts): the harness's
// own policy, provider, key and price, booked on the session's records labelled `learned_workflow`. A call a crash cut
// off is never run again (`replay: "never"`): it is answered interrupted.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { TSchema } from "typebox";
import { defineTool, ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import { registerLabel, registerOutcome } from "./timeline/index.js";
import { sideRequests } from "./cap.js";
import { type GuardRow, LEARNED_NODES, LEARNED_NODES_MAX, type LearnedEnded, type LearnedNode } from "./learned-nodes.js";
import { guardJevOn, guardLine, rowOf, stepGuard } from "./runner/step-guard.js";
import { draftProblems, LEARNED_MAX_TURNS } from "./learn/index.js";
import { decisionsAsked, deniedDecisionWords } from "./learn/skills.js";
import { DEFAULT_DECISION_PROVIDER } from "./decisions.js";
import { type LearnedWorkflow, workflowLine } from "./learning.js";
import type { ModelRef } from "./model.js";
import { type Ledger, ledgerOf } from "./paid-calls.js";
import { PORT_PROVIDER } from "./port-models.js";
import { forModel } from "./result.js";
import type { Plane } from "./tool-plane.js";
import { ARGS_PREVIEW_BYTES, deniedText, type SettingFrom } from "./tool-gate.js";
import type { DenyFrom } from "./refusal-words.js";
import { allows, CALL_TOOLS, learnedDraftTools, toolOf, workflowTools } from "./tools.js";
import type { Complete } from "./llm.js";
import type { SearchOn } from "./web-search.js";
import type { Workspace } from "./workspace/workspace.js";
import type { DecisionProvider } from "@parcha/agentrun-dsl";
import type { Refusal } from "@parcha/agentrun-kernel";
import type { RunDecisions } from "@parcha/agentrun-kernel/kernel/cap";
import { hostCalls } from "./host-calls.js";
import { workflowNodes } from "./model.js";
import { type ReplayCalls, SKIPPED_WRITE } from "./learn/replay-calls.js";

/** What a learned_workflow call's approval card says of its MCP calls' arguments: the workflow decides them as it runs. */
export const LEARNED_MCP_ARGUMENTS = "decided by the workflow while it runs, from its input and its earlier steps";

/** What a learned_workflow call's card shows of the MCP tools set to ask that the workflow can call: that their arguments
 *  are the workflow's to decide, then every one of them by name. The card leads with these (the call's own input after
 *  them), so they are never cut behind a long input. */
export const learnedAskShown = (asks: readonly string[]): Record<string, unknown> => ({ mcp_arguments: LEARNED_MCP_ARGUMENTS, mcp_calls: [...asks] });

/** The most bytes of the card those fields may take: the card's preview is cut at ARGS_PREVIEW_BYTES (2 KB), and its
 *  braces and the call's name follow them. A workflow whose ask-gated MCP tools would not all show is refused, never
 *  approved by a person who could not see what they approved. */
export const LEARNED_ASK_CARD_BYTES = ARGS_PREVIEW_BYTES - 128;

/** Whether every MCP tool set to ask that the workflow can call fits on its card (learnedAskShown, LEARNED_ASK_CARD_BYTES). */
export const learnedAskFits = (asks: readonly string[]): boolean => Buffer.byteLength(JSON.stringify(learnedAskShown(asks)), "utf8") <= LEARNED_ASK_CARD_BYTES;

/** The MCP tools a person's approval of a learned_workflow call covers: exactly those its card named (learnedAskShown's
 *  `mcp_calls`, read from the card they approved, host-calls.ts HostCalls.approved). None when no person approved it,
 *  or the card named none. A tool set to ask that the card did not name (one set to ask after the card was shown) is
 *  never run under that approval. */
export const learnedApprovedTools = (card: Readonly<Record<string, unknown>> | undefined): ReadonlySet<string> =>
  new Set(Array.isArray(card?.mcp_calls) ? card.mcp_calls.filter((name): name is string => typeof name === "string") : []);

/** An MCP tool's catalog name, `mcp:<server>/<tool>`: a call node that names one runs it through the run's own MCP. */
const MCP_TOOL = /^mcp:[^/]+\/.+$/;

/** The MCP tools a learned workflow's call nodes name (`via: "tool"`, `tool: "mcp:<server>/<tool>"`), each once; none for
 *  one that does not read. The run's gate asks about them before the workflow's call runs (adapter-run-spec.ts). */
export async function learnedMcpTools(workflow: string): Promise<string[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(workflow);
  } catch {
    return [];
  }
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  try {
    return workflowTools(workflowNodes(doc, inspectWorkflow(doc as never))).calls.filter((tool) => MCP_TOOL.test(tool));
  } catch {
    return [];
  }
}

/** A call node's MCP result as the workflow's value: its text as JSON when it parses, else `{ text }`. */
const mcpValue = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

export const LEARNED_WORKFLOW_TOOL = "learned_workflow";

/** The most of a learned workflow's output its result line shows, and the longest value it shows as written. */
const LINE_MAX = 120;
const VALUE_MAX = 60;

/** One line of a learned workflow's output for its row: an object's fields as `name value`, and a text output (learnedOutput
 *  hands one back as it is, #2412) its lines, each value or line whole or, when longer than VALUE_MAX, only as its size,
 *  and whole ones only until LINE_MAX. Nothing is ever cut inside a value or a line: the timeline redacts the line as it
 *  says it (its summary's words), and its redactor matches a held value only whole, so a cut one could leave a prefix it
 *  would not find. Newlines are flattened, so the one line it keeps holds every part. An output already cut for the
 *  model (learnedText) says so. */
export function outputLine(text: string): string | undefined {
  const clipped = /\n\[the workflow's output is cut at (\d+) of (\d+) characters\]$/.exec(text);
  if (clipped) return `its output is long, cut at ${clipped[1]} of ${clipped[2]} characters`;
  const said = (value: unknown): string => {
    const flat = (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).replace(/\s+/g, " ").trim();
    return flat.length > VALUE_MAX ? `(${flat.length} characters)` : flat;
  };
  /** `parts` whole, joined by `by`, until LINE_MAX: then an ellipsis. */
  const joined = (parts: readonly string[], by: string): string | undefined => {
    const kept: string[] = [];
    let length = 0;
    for (const part of parts) {
      if (kept.length && length + by.length + part.length > LINE_MAX) {
        kept.push("…");
        break;
      }
      kept.push(part);
      length += (kept.length > 1 ? by.length : 0) + part.length;
    }
    return kept.length ? kept.join(by) : undefined;
  };
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    // Text, as it is: its lines that hold words.
    return joined(text.split("\n").filter((line) => line.trim()).map(said), " / ");
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) return said(output);
  return joined(Object.entries(output as Record<string, unknown>).map(([key, value]) => `${key} ${said(value)}`), ", ");
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
  /** The run's learned workflows (learning.ts chooseWorkflows): those its claim's seed lay chose
   *  (runner/learning-seed.ts). */
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
  /** The session's model as a person reads it, the id the run's route names it by: what a node's trace says it ran on
   *  (its `model`) when modelOf answers with the session's own port (PORT_PROVIDER), whose model id names no model. A
   *  ref of another provider (a tier's own model) is named by its model id. */
  modelName?(tier: string | undefined): string | undefined;
  /** The `llm` tool's completion, for a call node that names it. */
  complete?: Complete;
  /** The run's models a call node's native web_search goes through (EffectRun.search): on the runner, the session's
   *  port. */
  search?: SearchOn;
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
  /** The run's own Workspace (on the runner: its local folder in Mode 1, its folder on the run's disk in Mode 2), which
   *  a decision node's images are read through. Absent: the local folder at `work`. */
  workspace?: Workspace;
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
  /** The run's MCP tools by catalog name (`mcp:<server>/<tool>`): those the claim's pin holds, which its revision grants.
   *  A call node may name one of these; it runs through the run's own MCP, as the loop wrapped it (host-calls.ts). */
  mcpTools?: readonly string[];
  /** The gate's whole decision of an MCP node's call with its arguments, as the run's own call of the tool gets it
   *  (RunGate.decide: deny, argument pins, ask, no approver). Required for an MCP node: one with none is never sent. */
  decide?: (tool: string, args: unknown) => Promise<"allow" | "ask" | { deny: string }>;
  /** A replay run's (runner/promotion.ts): its call nodes go through the replay's rules (learn/replay-calls.ts: a read
   *  live through a cache seeded from the graded run's recorded calls, a write only ever answered from that recording),
   *  and a write the recording does not have stops the workflow there, skipped. Absent: every call node runs live. */
  replay?: ReplayCalls;
};

/** The most characters of a learned workflow's output its answer holds, monid's bound (monid.ts CLIP): within the
 *  host's result bound, which each CLI is told to pass whole (host-bounds.test). */
export const LEARNED_CLIP = 60_000;

/** `text`, a learned workflow's output as its tool hands it back (learnedOutput), cut at LEARNED_CLIP characters (never inside a surrogate pair), saying
 *  so. */
export function learnedText(text: string): string {
  if (text.length <= LEARNED_CLIP) return text;
  const end = /[\uD800-\uDBFF]/.test(text[LEARNED_CLIP - 1] ?? "") ? LEARNED_CLIP - 1 : LEARNED_CLIP;
  return `${text.slice(0, end)}\n[the workflow's output is cut at ${end} of ${text.length} characters]`;
}

/** What a learned workflow's model node is refused with when it names a tool: it runs in a session of its own here.
 *  The check before the run refuses such a workflow first (draftProblems); this one holds should it not. */
export const NODE_TOOLS_REFUSED = "a learned workflow's model node runs without tools here";

/** The tool's description, sent with every model request of the run, so it holds what a model needs to call it right and
 *  no more: one line of what the tool does (one call, by name, a JSON input with the listed fields, `*` marking a required
 *  one; what it answers: a text output as it is, to reply with unchanged, since a model handed it otherwise writes its own
 *  reply around it and a format the workflow's last node wrote is lost, #2412), then each workflow on a line of its own
 *  (workflowLine): its name, its input's fields and the line its README says what it does with. */
export const learnedWorkflowDescription = (workflows: readonly LearnedWorkflow[]): string =>
  [
    "Runs a learned workflow in one call, by name, on a JSON input: fields below (* required). Text output: reply with it unchanged. Else JSON, or why it did not run.",
    ...workflows.map(workflowLine),
  ].join("\n");

/** A learned workflow's output as its tool hands it back: its text when it is text, a string or an object of one string
 *  field (a node's record of one field, as a last node that writes the answer gives it), so the lines its last node wrote
 *  reach the model as lines; else JSON. */
export function learnedOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const values = Object.values(output);
    if (values.length === 1 && typeof values[0] === "string") return values[0];
  }
  return JSON.stringify(output ?? null);
}

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

/** The most of a state's fields a handback names, and the longest value it shows whole: a longer one is named by its
 *  size, never cut mid-value, so the run's redactor still finds a held value in what it shows. */
const HANDBACK_FIELDS = 20;
const HANDBACK_VALUE = 2_000;

/** The steps a learned workflow ran, as one line after its words: each node's label, kind and status; then the guards of
 *  those steps, and any check that handed back on a step past the trace's cap (`guards`: every check of the call). */
const stepsLine = (nodes: readonly LearnedNode[], guards: readonly GuardRow[] = []): string => {
  const shown = nodes.flatMap(({ guard }) => (guard ? [guard] : []));
  const lines = [...shown, ...guards.filter((row) => row.escalated && !shown.includes(row))].map(guardLine);
  return (nodes.length ? `\nIts steps: ${nodes.map(({ label, kind, status }) => `${label} (${kind}) ${status}`).join("; ")}.` : "") + (lines.length ? `\nIts guards: ${lines.join("; ")}.` : "");
};

/** What a learned workflow that escalated says to whoever takes the job on: the step that handed it back and its own
 *  words for why, the steps it ran, and what it had found (its state's top-level fields, each whole or named by its
 *  size). A guard that fails is a handback, never a failure of the run: the agent finishes the job from here. */
export function handedBackText(name: string, escalation: { kind: string; stage: string; summary: string; label?: string }, state: Record<string, unknown>, nodes: readonly LearnedNode[], guards: readonly GuardRow[] = []): string {
  const at = escalation.label ? ` at its step "${escalation.label}"` : "";
  const why = escalation.summary?.trim() || escalation.kind;
  const fields = Object.entries(state ?? {}).filter(([key]) => !key.startsWith("$")).slice(0, HANDBACK_FIELDS).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
    return `- ${key}: ${text.length > HANDBACK_VALUE ? `(${text.length} characters)` : text}`;
  });
  return [`The learned workflow ${name} handed the job back${at}: ${why}${stepsLine(nodes, guards)}`, ...(fields.length ? ["What it had:", ...fields] : [])].join("\n");
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
        // No words of their own: the description says what each is, and the parameters go with every request too.
        name: { type: "string", enum: names },
        input: { type: "object" },
      },
    } as unknown as TSchema,
    execute: async (args, api, context) => {
      const { name, input } = (args ?? {}) as { name?: unknown; input?: unknown };
      const flow = run.workflows.find((workflow) => workflow.name === name);
      if (!flow) return forModel(`No learned workflow of this agent is named ${JSON.stringify(name)}. Its workflows: ${names.join(", ")}.`, { isError: true });
      const ledger = ledgerOf(api, context);
      // Which of its nodes ran, kept beside the call in the run's journal (LEARNED_NODES), for its timeline row, and every
      // guard check it made (`guards`, uncapped: the run's metrics, B4's replay and refit read each); a trace that can't
      // be kept never fails the call. A call stopped part way keeps the nodes and checks that ended before it stopped,
      // written outside the stopped call's context, and still ends as a stop.
      const trace: LearnedNode[] = [];
      const guards: GuardRow[] = [];
      // A replay's write the recording did not have (learn/replay-calls.ts) rides on the same entry, ran a node or not; so
      // does how the workflow ended (`ended`, LearnedEnded), the one thing a replay's outcome reads (workflow-first.ts
      // pathMetrics): a replay run keeps its entry whatever ran, so a refusal before any node is read as one.
      const keep = (signal: Context, ended?: LearnedEnded) => {
        const skipped = run.replay?.skipped;
        if (!trace.length && !guards.length && !skipped && !(run.replay && ended)) return undefined;
        return api.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: LEARNED_NODES, data: { call: ledger.call, workflow: flow.name, nodes: trace, ...(guards.length ? { guards } : {}), ...(skipped ? { replay_skipped: skipped } : {}), ...(ended ? { ended } : {}) } as never })), signal).catch(() => undefined);
      };
      let said: Awaited<ReturnType<typeof runLearned>>;
      try {
        said = await runLearned(run, flow, input, context?.abortSignal, ledger, trace, guards);
      } catch (error) {
        await keep(BACKGROUND_CONTEXT);
        throw error;
      }
      await keep(context, said.ended);
      return forModel(said.text, { isError: said.isError });
    },
  });
}

/** `flow` run on `input` for `run`: its output as its tool hands it back (learnedOutput), or why it did not run, and each of its nodes that ran (at most
 *  LEARNED_NODES_MAX), none for one refused before any node ran. Never throws, but on an abort. `ledger`: the tool call's,
 *  which each call node's paid requests are booked under, as a call of its own within it. `nodes`: where each node is
 *  added as it ends, the caller's to keep when the call is aborted (and so throws) part way. `guards`: where every guard
 *  check is added as it is made, never capped (a map's checks past the trace's cap too), the caller's to keep likewise. */
export async function runLearned(run: LearnedWorkflowRun, flow: LearnedWorkflow, input: unknown, signal?: AbortSignal, ledger?: Ledger, nodes: LearnedNode[] = [], guards: GuardRow[] = []): Promise<{ text: string; isError: boolean; nodes: LearnedNode[]; ended: LearnedEnded }> {
  const refuse = (why: string) => ({ text: `The learned workflow ${flow.name} was not run: ${why}`, isError: true, nodes, ended: "failed" as const });
  if (!input || typeof input !== "object" || Array.isArray(input)) return refuse("its input must be a JSON object");
  const dsl = await import("@parcha/agentrun-dsl");
  // Checked again at the call, against the agent's own tools as its run has them, before any node runs: what merged under
  // another revision may name one it has no more.
  // The tools the gate allows now; one set to ask or deny is refused in the words a workflow revision's call node is.
  // A run handed no gate (a caller past the types) runs nothing: a tool is never allowed for want of a policy.
  if (typeof run.policy !== "function" || typeof run.denyFrom !== "function") return refuse("its run gave no tool policy for its call nodes");
  const { tools, gated, deniedBy } = learnedDraftTools(run.granted, run.policy, run.plane, run.denyFrom);
  // The run's MCP tools, held to the same gate: one set to allow may be named, and one set to ask only when a person
  // approved this call with a card that named it (its ask is the call's own: adapter-run-spec.ts adapterRunGate); one set
  // to deny is refused in its words. One the run's pin does not hold is no tool of the run at all.
  const approved = learnedApprovedTools(hostCalls()?.approved);
  for (const name of run.mcpTools ?? []) {
    const setting = run.policy(name);
    if (setting === "allow" || (setting === "ask" && approved.has(name))) tools.push(name);
    else {
      gated[name] = setting;
      if (setting === "deny") deniedBy[name] = run.denyFrom(name) as DenyFrom;
    }
  }
  const problems = draftProblems(dsl, flow.workflow, tools, gated, deniedBy, undefined, decisionsOf(run, dsl, flow.workflow));
  if (problems.length) return refuse(problems.map(({ detail }) => detail).join("; "));
  const doc = JSON.parse(flow.workflow);
  const runJudge = run.decisions ? await learnedJudge(run, run.decisions) : undefined;
  // The host runner loads @earendil-works/pi-coding-agent and pi-agent-core, serve's own dependencies (package.json).
  const { createPiHostRunner } = await import("./workflow/host-session.js");
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
  // Each model node's model and tier by its execution path, as it runs: its node.end (the same path) puts them on its
  // trace. Never by its label, which a workflow may repeat. Only a model node runs here: a call node never has one.
  const ranOn = new Map<string, { model: string; tier?: string }>();
  const runNode = async (request: Parameters<NonNullable<Parameters<typeof dsl.runWorkflow>[2]["runNode"]>>[0]) => {
    if (request.tools?.length) throw new Error(`${NODE_TOOLS_REFUSED}: its node "${request.label}" names ${request.tools.join(", ")}`);
    const tier = typeof request.tier === "string" ? request.tier : undefined;
    const ref = run.modelOf(tier);
    const model = !ref ? undefined : ref.provider === PORT_PROVIDER ? (run.modelName?.(tier) ?? undefined) : ref.modelId;
    if (model && typeof request.executionPath === "string") ranOn.set(request.executionPath, { model, ...(tier ? { tier } : {}) });
    // Its own signal, which the DSL ties to the call's (a sibling's failure, a deadline, the call's stop).
    return (await runnerFor(request.tier as string | undefined))(request);
  };
  type EffectRequest = { node: { label: string; via: string; tool?: string }; input: Record<string, unknown>; signal: AbortSignal; executionPath?: string; item?: { index: number } };
  const liveEffect = async ({ node, input: given, signal: own, executionPath, item }: EffectRequest) => {
    const tool = node.via === "tool" ? node.tool : undefined;
    // Its call id under the workflow's call: the node, its execution path, its item in a map. Its paid requests are booked
    // under it, as a call of its own.
    const callId = `${ledger?.call ?? LEARNED_WORKFLOW_TOOL}/${node.label}@${executionPath ?? ""}${item ? `#${item.index}` : ""}`;
    if (tool && MCP_TOOL.test(tool)) {
      // An MCP tool of the run, through the run's own MCP as the loop wrapped it (its flush, its booking on the run's one
      // ledger, a CLI's record, the stop's abort), after the gate's rule read again now, as the harness's own call is.
      const send = (run.mcpTools ?? []).includes(tool) && run.decide ? hostCalls()?.mcp(tool) : undefined;
      if (!send || !run.decide) throw new Error(`call node "${node.label}": this agent runs no tool ${tool}`);
      // The gate's whole decision of this call with the arguments the workflow resolved, as the harness's own call of the
      // tool gets it: its deny, its argument pins (a messaging tool held to one channel), its ask, or no one to approve.
      // The call's approval lifts only an ask, never a pin or a deny, and only for a tool its card named: one set to ask
      // since the card was shown was never approved.
      await run.refresh?.();
      const verdict = await run.decide(tool, given);
      if (typeof verdict === "object") throw new Error(verdict.deny);
      const card = hostCalls()?.approved;
      if (verdict === "ask" && !learnedApprovedTools(card).has(tool)) {
        throw new Error(card ? `This ${tool} call needs a person's approval, and the approval given for this learned workflow did not cover it: its card did not name ${tool}. It was not run.` : `This ${tool} call needs a person's approval, which was not given for this call; it was not run.`);
      }
      const answer = await send(given, { callId, signal: own });
      if (answer.isError) throw new Error(answer.text);
      return mcpValue(answer.text);
    }
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
    const booked = ledger ? { ledger: { call: callId, record: ledger.record } } : {};
    return effect(given, { signal: own, env: run.env, work: run.work, ...(run.complete ? { complete: run.complete } : {}), ...(run.search ? { search: run.search } : {}), ...booked });
  };
  // A replay run's call nodes through the replay's rules (learn/replay-calls.ts); a live one runs as above, gate and all.
  const replay = run.replay;
  const runEffect = (request: EffectRequest) => {
    const tool = request.node.via === "tool" ? request.node.tool : undefined;
    return replay && tool ? replay.call({ label: request.node.label, tool }, request.input, () => liveEffect(request)) : liveEffect(request);
  };
  // A replay's write with no recording stops the whole workflow there: nothing after it runs.
  const stopped = replay ? (signal ? AbortSignal.any([signal, replay.stop]) : replay.stop) : signal;
  const skippedWords = () => {
    const skipped = replay?.skipped;
    return skipped ? { text: `The learned workflow ${flow.name} was not replayed on this input: its step "${skipped.step}" calls ${skipped.tool}, a write, and the graded run's recording has no call of it with these arguments, so it ${SKIPPED_WRITE}. Nothing was sent.${stepsLine(nodes, guards)}`, isError: true, nodes, ended: "failed" as const } : undefined;
  };
  // Its step guards (runner/step-guard.ts): a guard's Jev is a decision of the call, on the run's decisions (its judge,
  // its gate, its one cap); a run with no Jev provider has no Jev signal, so a guard that reads one hands back.
  const jevProvider = run.decisions?.providers.providers.jev;
  const guardStep = stepGuard(runJudge && jevProvider ? guardJevOn(runJudge, jevProvider) : undefined);
  // Each guard's check by its step's execution path, as the DSL decided it: kept in `guards` at once (what the run's
  // metrics read), and its node.end (the same path) puts it on the step's trace, where the timeline and a hand-back say it.
  const guarded = new Map<string, GuardRow>();
  // Each node as it ends, by the DSL's own event: what the call's timeline row shows of it.
  const onEvent = (event: { type: string; label: string; detail?: unknown; executionPath?: string }) => {
    if (event.type === "guard.evaluated") {
      const row = rowOf(String(event.label), event.detail);
      if (row) {
        guards.push(row);
        guarded.set(event.executionPath ?? String(event.label), row);
      }
      return;
    }
    if (event.type !== "node.end" || nodes.length >= LEARNED_NODES_MAX) return;
    const detail = (event.detail ?? {}) as { kind?: unknown; status?: unknown; duration_ms?: unknown };
    const ran = typeof event.executionPath === "string" ? ranOn.get(event.executionPath) : undefined;
    const guard = guarded.get(event.executionPath ?? String(event.label));
    nodes.push({ label: String(event.label), kind: String(detail.kind ?? ""), status: String(detail.status ?? ""), duration_ms: typeof detail.duration_ms === "number" ? detail.duration_ms : 0, ...ran, ...(guard ? { guard } : {}) });
  };
  try {
    const judging = runJudge && run.decisions ? { runJudge, decisionProviders: run.decisions.providers } : {};
    const result = await dsl.runWorkflow(doc, input as Record<string, unknown>, { runNode: runNode as never, runEffect: runEffect as never, guardStep, onEvent, ...judging, ...(stopped ? { signal: stopped } : {}) } as never);
    const skipped = skippedWords();
    if (skipped) return skipped;
    if (result.status === "escalated") return { text: learnedText(handedBackText(flow.name, result.escalation, result.state, nodes, guards)), isError: true, nodes, ended: "escalated" };
    if (result.status !== "complete") return refuse(`it ended ${(result as { status: string }).status}`);
    return { text: learnedText(learnedOutput(result.output)), isError: false, nodes, ended: "complete" };
  } catch (error) {
    if (signal?.aborted) throw error;
    const skipped = skippedWords();
    if (skipped) return skipped;
    return { text: `The learned workflow ${flow.name} failed: ${String((error as Error)?.message ?? error).slice(0, 1000)}${stepsLine(nodes, guards)}`, isError: true, nodes, ended: "failed" };
  }
}

/** The draft check's decisions for `run` (learn/skills.ts DraftDecisions): its providers, and the gate's setting of each
 *  provider `text` asks (its bare id as the settings key) where it is not allow, with where a deny was set. A run handed
 *  no decisions (its claim was handed no key: none named, or each denied) has no provider, so a decision node is refused
 *  in the gate's words when its provider is denied, else as one the host does not have; never asked. */
function decisionsOf(run: LearnedWorkflowRun, dsl: Parameters<typeof decisionsAsked>[0], text: string) {
  const providers = run.decisions?.providers ?? { providers: {}, default: DEFAULT_DECISION_PROVIDER };
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
 *  first held to the run's gate as it is asked (a provider set to deny since the call began is refused, never sent, as
 *  a call node's tool is at its effect; deny alone refuses, the rule the runner hands a claim its keys by), then admitted on the run's one cap and settled at what it charged
 *  (decisionJudge, as a workflow agent's decision is). A refusal of the cap pauses the run (`decisions.pause`): the
 *  decision node fails with the cap's words, and nothing is sent. */
async function learnedJudge(run: LearnedWorkflowRun, decisions: NonNullable<LearnedWorkflowRun["decisions"]>) {
  const [{ judgeFromProviders }, { decisionJudge }, { imageLoader }] = await Promise.all([import("@parcha/agentrun-dsl"), import("./runner/workflow-spec.js"), import("./pdf-pages.js")]);
  type Judge = ReturnType<typeof judgeFromProviders>;
  // A decision node's images (a page drawn by pdf_pages, a screenshot, an upload) are read through the run's own Workspace
  // (Mode 2: its folder on the run's disk, never the runner's local path), as a workflow agent's are (pdf-pages.ts
  // imageLoader).
  const inner = judgeFromProviders({ providers: decisions.providers.providers, default: decisions.providers.default, loadImage: imageLoader(run.workspace ?? run.work) });
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
    if (run.policy(provider) === "deny") throw new Error(deniedDecisionWords(provider, run.denyFrom(provider) as "agent" | "server" | "default", "decision", params.label));
    return capped(params);
  }) as Judge;
}
