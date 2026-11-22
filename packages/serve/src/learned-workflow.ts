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
// the session's model proxy, under a side key (port-models.ts): the harness's
// own policy, provider, key and price, booked on the session's records labelled `learned_workflow`.
// On the runner the tool `nests` (HostTool.nests): each MCP node is a call of its own nested in the workflow's, asked at
// the gate as its tool, so one approval card for the call names every MCP action set to ask that it can make, with its
// arguments' shape (learnedAskShown), and the approval passes exactly those. A call a park or a crash cut off runs again
// from its start: each node answers what it answered the first time (NestedCalls.memo), each recorded MCP call from its
// record, never sent twice.
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { TSchema } from "typebox";
import { defineTool, ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import { registerLabel, registerOutcome } from "./timeline/index.js";
import { LEARNED_NODES, LEARNED_NODES_MAX, type LearnedEnded, type LearnedNode, type LoopRow } from "./learned-nodes.js";
import { draftProblems, LEARNED_MAX_TURNS } from "./learn/index.js";
import { repickLabels, repickSiteOf } from "./learn/check.js";
import { capState, REPICK_MARK, repickMarked } from "./learn/repick.js";
import { decisionsAsked, deniedDecisionWords } from "./learn/workflow-draft.js";
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
import { isMcpName } from "./tool-names.js";
import type { Complete } from "./llm.js";
import type { SearchOn } from "./web-search.js";
import type { Workspace } from "./workspace/workspace.js";
import type { DecisionProvider } from "@parcha/agentrun-dsl";
import type { JsonValue, NestedCalls, Refusal } from "@parcha/agentrun-kernel";
import type { RunDecisions } from "@parcha/agentrun-kernel/kernel/cap";
import { workflowNodes } from "./model.js";
import { type ReplayCalls, SKIPPED_WRITE, toolWord, unmarkedWords } from "./learn/replay-calls.js";

/** What a learned_workflow call's approval card says of its MCP actions' arguments: a `{name}` in one is filled in as
 *  the workflow runs. */
export const LEARNED_MCP_ARGUMENTS = "each {name} is filled in while the workflow runs, from its input or an earlier step";

/** An MCP action of a learned workflow: a call node's tool (`mcp:<server>/<tool>`) and its arguments as the workflow
 *  writes them (their shape: values, and the `{name}`s filled in as it runs). */
export type LearnedAction = { readonly tool: string; readonly args: unknown };

/** The most bytes of the card its MCP fields may take: the card's preview is cut at ARGS_PREVIEW_BYTES (2 KB), and its
 *  braces and the call's name follow them. */
const LEARNED_ASK_CARD_BYTES = ARGS_PREVIEW_BYTES - 128;

/** What a learned_workflow call's card shows of the MCP actions set to ask that the workflow can call: how their
 *  arguments are filled in, then each action with its arguments' shape, as many as the card's preview shows whole
 *  (LEARNED_ASK_CARD_BYTES). The card leads with these (the call's own input after them), so they are never cut behind a
 *  long input. An action past the bound is not named, so its call asks on its own as it runs, never approved unseen; and
 *  since an approval passes by tool (learnedApprovedTools), a tool with any action past the bound is not named at all. */
export function learnedAskShown(asks: readonly LearnedAction[]): Record<string, unknown> {
  const shown: LearnedAction[] = [];
  for (const action of asks) {
    if (Buffer.byteLength(JSON.stringify({ mcp_arguments: LEARNED_MCP_ARGUMENTS, mcp_calls: [...shown, action] }), "utf8") > LEARNED_ASK_CARD_BYTES) break;
    shown.push(action);
  }
  const cut = new Set(asks.slice(shown.length).map((action) => action.tool));
  return { mcp_arguments: LEARNED_MCP_ARGUMENTS, mcp_calls: shown.filter((action) => !cut.has(action.tool)) };
}

/** The fields of a learned_workflow call's card that only the gate writes (learnedAskShown): one of the same name in the
 *  call's input, which the model wrote, is never shown on its card. */
export const LEARNED_CARD_FIELDS: ReadonlySet<string> = new Set(["mcp_arguments", "mcp_calls"]);

/** The MCP tools an approval card names (learnedAskShown's `mcp_calls`, read from the card a person approved): a call
 *  nested in the approved one whose tool is among them passes its ask. None for a card that named none. */
export const learnedApprovedTools = (card: unknown): ReadonlySet<string> => {
  const named = card && typeof card === "object" ? (card as { mcp_calls?: unknown }).mcp_calls : undefined;
  return new Set(Array.isArray(named) ? named.flatMap((one) => (one && typeof one === "object" && typeof one.tool === "string" ? [one.tool as string] : [])) : []);
};

/** The MCP actions a learned workflow's call nodes name (`via: "tool"`, `tool: "mcp:<server>/<tool>"`), each with its
 *  arguments as written, once per distinct pair; none for one that does not read. The run's gate asks about them before
 *  the workflow's call runs (adapter-run-spec.ts). */
export async function learnedMcpCalls(workflow: string): Promise<LearnedAction[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(workflow);
  } catch {
    return [];
  }
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  try {
    const seen = new Map<string, LearnedAction>();
    for (const node of workflowNodes(doc, inspectWorkflow(doc as never))) {
      if (node.node !== "call" || node.via !== "tool" || typeof node.tool !== "string" || !isMcpName(node.tool)) continue;
      const action = { tool: node.tool, args: node.args ?? {} };
      seen.set(JSON.stringify(action), action);
    }
    return [...seen.values()];
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
  /** The run's MCP tools: each catalog name (`mcp:<server>/<tool>`) the claim's pin holds, which its revision grants, to
   *  the name the session's tools hold it by. A call node may name one of these; it runs as a call nested in the
   *  workflow's (`nestedOf`). */
  mcpTools?: ReadonlyMap<string, string>;
  /** The session's tools as calls nested in the learned_workflow call of this id (NestedCalls, the harness's for a tool
   *  that `nests`): an MCP node runs as one, asked at the gate as its own tool with the arguments the workflow resolved
   *  (its deny, its argument pins, its ask: one the approved card named passes, any other parks for a person), recorded
   *  and booked on the run's one ledger as its own call. None: an MCP node is never sent. */
  nestedOf?: (callId: string) => NestedCalls | undefined;
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
/** What a re-pick's pass over the pages is refused with, unsent, when its state cannot fit learning.repick_max_chars. */
export const REPICK_STATE_REFUSED = "a quote re-pick's pass over the pages is not sent past its cap";

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
 *  cap: booked by the session's proxy, labelled by the side key it goes under. */
async function sideStream(models: RunModels, model: unknown, context: object, options: object | undefined) {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const stream = createAssistantMessageEventStream();
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

/** The steps a learned workflow ran, as one line after its words: each node's label, kind and status. */
const stepsLine = (nodes: readonly LearnedNode[]): string =>
  nodes.length ? `\nIts steps: ${nodes.map(({ label, kind, status }) => `${label} (${kind}) ${status}`).join("; ")}.` : "";

/** What a learned workflow that escalated says to whoever takes the job on: the step that handed it back and its own
 *  words for why, the steps it ran, and what it had found (its state's top-level fields, each whole or named by its
 *  size). An escalate is a handback, never a failure of the run: the agent finishes the job from here. */
export function handedBackText(name: string, escalation: { kind: string; stage: string; summary: string; label?: string }, state: Record<string, unknown>, nodes: readonly LearnedNode[]): string {
  const at = escalation.label ? ` at its step "${escalation.label}"` : "";
  const why = escalation.summary?.trim() || escalation.kind;
  const fields = Object.entries(state ?? {}).filter(([key]) => !key.startsWith("$")).slice(0, HANDBACK_FIELDS).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
    return `- ${key}: ${text.length > HANDBACK_VALUE ? `(${text.length} characters)` : text}`;
  });
  return [`The learned workflow ${name} handed the job back${at}: ${why}${stepsLine(nodes)}`, ...(fields.length ? ["What it had:", ...fields] : [])].join("\n");
}

/** The run's `learned_workflow` tool over `run.workflows`. */
export function learnedWorkflowTool(run: LearnedWorkflowRun): ToolRegistration {
  const names = run.workflows.map(({ name }) => name);
  return defineTool({
    name: LEARNED_WORKFLOW_TOOL,
    description: learnedWorkflowDescription(run.workflows),
    // Registered by itself, never run again after a crash (pi-durable's "unsafe"). On the runner its HostTool nests
    // (adapter-run-spec.ts learnedWorkflowHostTool), and runs again whole, each node answered as it was the first time.
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
      const ledger = ledgerOf(api.callId);
      // Which of its nodes ran, kept beside the call in the run's journal (LEARNED_NODES), for its timeline row; a trace
      // that can't be kept never fails the call. A call stopped part way keeps the nodes that ended before it stopped,
      // written outside the stopped call's context, and still ends as a stop.
      const trace: LearnedNode[] = [];
      // Every loop's exit (`loops`, uncapped too: a quote re-pick is a loop's second pass, which the run's metrics count).
      const loops: LoopRow[] = [];
      // A replay's write the recording did not have (learn/replay-calls.ts) rides on the same entry, ran a node or not; so
      // does how the workflow ended (`ended`, LearnedEnded), the one thing a replay's outcome reads (workflow-first.ts
      // pathMetrics): a replay run keeps its entry whatever ran, so a refusal before any node is read as one.
      const keep = (signal: Context, ended?: LearnedEnded) => {
        const skipped = run.replay?.skipped;
        // A loop's exit counts too: a loop over an empty map ends no node, yet its row is the run's (metrics `loops`).
        if (!trace.length && !loops.length && !skipped && !(run.replay && ended)) return undefined;
        return api.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: LEARNED_NODES, data: { call: ledger.call, workflow: flow.name, nodes: trace, ...(loops.length ? { loops } : {}), ...(skipped ? { replay_skipped: skipped } : {}), ...(ended ? { ended } : {}) } as never })), signal).catch(() => undefined);
      };
      let said: Awaited<ReturnType<typeof runLearned>>;
      try {
        said = await runLearned(run, flow, input, context?.abortSignal, ledger, trace, run.nestedOf?.(api.callId), loops);
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
 *  added as it ends, the caller's to keep when the call is aborted (and so throws) part way. `nested`: the session's tools as calls nested in this one, which its MCP nodes run as; and the values its first run
 *  fixed (`memo`), so a rerun of the call (after a park, a crash) goes on from what its model, decision and call nodes
 *  answered then, its MCP calls with the arguments they were asked and approved with, each recorded one answered from its
 *  record, never sent twice. `loops`: where each loop's exit is added (LoopRow), never capped. */
export async function runLearned(run: LearnedWorkflowRun, flow: LearnedWorkflow, input: unknown, signal?: AbortSignal, ledger?: Ledger, nodes: LearnedNode[] = [], nested?: NestedCalls, loops: LoopRow[] = []): Promise<{ text: string; isError: boolean; nodes: LearnedNode[]; ended: LearnedEnded }> {
  const refuse = (why: string) => ({ text: `The learned workflow ${flow.name} was not run: ${why}`, isError: true, nodes, ended: "failed" as const });
  if (!input || typeof input !== "object" || Array.isArray(input)) return refuse("its input must be a JSON object");
  const dsl = await import("@parcha/agentrun-dsl");
  // Checked again at the call, against the agent's own tools as its run has them, before any node runs: what merged under
  // another revision may name one it has no more.
  // The tools the gate allows now; one set to ask or deny is refused in the words a workflow revision's call node is.
  // A run handed no gate (a caller past the types) runs nothing: a tool is never allowed for want of a policy.
  if (typeof run.policy !== "function" || typeof run.denyFrom !== "function") return refuse("its run gave no tool policy for its call nodes");
  const { tools, gated, deniedBy } = learnedDraftTools(run.granted, run.policy, run.plane, run.denyFrom);
  // The run's MCP tools, held to the same gate: one set to deny is refused in its words before any node runs; one set to
  // allow or ask may be named, each call of it asked at the gate as it runs (a call nested in this one): one set to ask
  // that the call's approved card named passes, any other waits for a person. One the run's pin does not hold is no tool
  // of the run at all.
  for (const name of run.mcpTools?.keys() ?? []) {
    const setting = run.policy(name);
    if (setting === "allow" || setting === "ask") tools.push(name);
    else {
      gated[name] = setting;
      if (setting === "deny") deniedBy[name] = run.denyFrom(name) as DenyFrom;
    }
  }
  const problems = draftProblems(dsl, flow.workflow, tools, gated, deniedBy, decisionsOf(run, dsl, flow.workflow));
  if (problems.length) return refuse(problems.map(({ detail }) => detail).join("; "));
  const doc = JSON.parse(flow.workflow);
  // Its quote re-pick loops (check.ts repickLabels): their exits are the run's re-picks (LoopRow `repick`).
  const repickAt = repickLabels(doc);
  // The re-pick's pass over the run's pages (learning.repick, learn/repick.ts), by its label as the run gives it, with the
  // most characters of state it sends: its prompt state is cut to that (capState), its longest strings first; the
  // workflow's state, which the quote check after it reads, stays whole.
  const pages = repickMarked(repickSiteOf(doc));
  // The marker's key is the host's: an input holding it would pick the re-pick's pass (or fail its route), whatever the
  // input's schema says of it, so such an input is refused before anything runs.
  if (pages && Object.hasOwn(input as object, REPICK_MARK)) return refuse(`its input holds "${REPICK_MARK}", the key its quote re-pick keeps its pass under`);
  // What a node answered the first time this call ran it, in every rerun of the call (`nested.memo`, by `key`): a rerun
  // after a park or a crash goes on from the same answers, so its MCP calls are asked with the arguments a person saw,
  // and never does a node's work again: `work` is called only while no answer is recorded, so a model's request or a paid
  // decision is made and booked once. A throw of `work` (a cap's refusal, a stop) records nothing: the next run calls it
  // again. Kept boxed, so an answer of undefined is recorded too. Run with no nested calls (main's process, a test's
  // registration), a node's answer is its own.
  // A node the DSL runs again at the same place (each check of a poll, each attempt of a retry) gets a key of its own for
  // each answer recorded there: the key itself, then `-1`, `-2`. The count moves only once an answer is recorded
  // (`answered`), so an attempt that recorded nothing (a throw of `fixed`'s work) leaves its key to the next attempt, and
  // a rerun, reading the same answers in the same order, reaches the same keys. Only one node runs at one place, so no
  // other node's runs move the count.
  const seen = new Map<string, number>();
  const at = (key: string): string => (seen.get(key) ? `${key}-${seen.get(key)}` : key);
  const answered = (key: string): void => void seen.set(key, (seen.get(key) ?? 0) + 1);
  const fixed = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    if (!nested) return work();
    const box = (await nested.memo(at(key), async () => JSON.parse(JSON.stringify({ value: await work() })) as JsonValue)) as { value?: T };
    answered(key);
    return box.value as T;
  };
  const judged = run.decisions ? await learnedJudge(run, run.decisions) : undefined;
  const runJudge = judged && nested
    ? (async (params: Parameters<typeof judged>[0]) => {
        const at = params as { label?: string; executionPath?: string; item?: { index: number }; decisionId?: string };
        return fixed(`judge:${at.decisionId ?? nestedKey(String(at.label ?? ""), at.executionPath, at.item)}`, () => judged(params));
      }) as typeof judged
    : judged;
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
    const cap = request.label === pages?.label ? pages.cap : undefined;
    const user = cap === undefined ? request.user : capState(request.user, cap);
    // A state past the cap with every string cut to nothing is never sent: the node fails and the re-pick hands back.
    if (user === undefined) throw new Error(`${REPICK_STATE_REFUSED}: its node "${request.label}" holds more than learning.repick_max_chars (${cap}) characters of state with every string cut`);
    const sent = user === request.user ? request : { ...request, user };
    // Its own signal, which the DSL ties to the call's (a sibling's failure, a deadline, the call's stop).
    return fixed(`node:${nestedKey(request.label, request.executionPath, request.item)}`, async () => (await runnerFor(request.tier as string | undefined))(sent));
  };
  type EffectRequest = { node: { label: string; via: string; tool?: string }; input: Record<string, unknown>; signal: AbortSignal; executionPath?: string; item?: { index: number } };
  const liveEffect = async ({ node, input: given, signal: own, executionPath, item }: EffectRequest) => {
    const tool = node.via === "tool" ? node.tool : undefined;
    // Its call id under the workflow's call: the node, its execution path, its item in a map. Its paid requests are booked
    // under it, as a call of its own.
    const callId = `${ledger?.call ?? LEARNED_WORKFLOW_TOOL}/${node.label}@${executionPath ?? ""}${item ? `#${item.index}` : ""}`;
    if (tool && isMcpName(tool)) {
      // An MCP tool of the run, as a call nested in this one (`nested`): asked at the gate as its own tool with the
      // arguments the workflow resolved (its deny, its argument pins, its ask: one the approved card named passes, any
      // other parks the run for a person), then recorded, flushed and booked on the run's one ledger as its own call. On
      // the node's own signal too, so a sibling's failure or the node's deadline cuts it at the server.
      const name = run.mcpTools?.get(tool);
      if (!name || !nested) throw new Error(`call node "${node.label}": this agent runs no tool ${tool}`);
      // Every answer of a nested call is recorded, an error's too, so each moves the count.
      const key = nestedKey(node.label, executionPath, item);
      const answer = await nested.call(name, given, at(key), own);
      answered(key);
      if (answer.refused || answer.isError || answer.interrupted) throw new Error(answer.text);
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
    const booked = ledger ? { ledger: { ...ledger, call: callId } } : {};
    return effect(given, { signal: own, env: run.env, work: run.work, ...(run.complete ? { complete: run.complete } : {}), ...(run.search ? { search: run.search } : {}), ...booked });
  };
  // A replay run's call nodes through the replay's rules (learn/replay-calls.ts); a live one runs as above, gate and all.
  const replay = run.replay;
  // An MCP node's answer is its nested call's record; any other call node's is fixed as a model node's is.
  const runEffect = async (request: EffectRequest) => {
    const tool = request.node.via === "tool" ? request.node.tool : undefined;
    const work = () => (replay && tool ? replay.call({ label: request.node.label, tool }, request.input, () => liveEffect(request)) : liveEffect(request));
    return tool && isMcpName(tool) ? work() : fixed(`effect:${nestedKey(request.node.label, request.executionPath, request.item)}`, work);
  };
  // A replay's write with no recording stops the whole workflow there: nothing after it runs.
  const stopped = replay ? (signal ? AbortSignal.any([signal, replay.stop]) : replay.stop) : signal;
  const skippedWords = () => {
    const skipped = replay?.skipped;
    const why = skipped?.unmarked ? `${unmarkedWords([toolWord(skipped.tool)])}; the graded run's recording has no call of it with these arguments` : `a write, and the graded run's recording has no call of it with these arguments, so it ${SKIPPED_WRITE}`;
    return skipped ? { text: `The learned workflow ${flow.name} was not replayed on this input: its step "${skipped.step}" calls ${skipped.tool}, ${why}. Nothing was sent.${stepsLine(nodes)}`, isError: true, nodes, ended: "failed" as const } : undefined;
  };
  // Each node as it ends, by the DSL's own event: what the call's timeline row shows of it.
  const onEvent = (event: { type: string; label: string; detail?: unknown; executionPath?: string }) => {
    if (event.type === "loop.exited") {
      const detail = (event.detail ?? {}) as { reason?: unknown; iterations?: unknown };
      if (typeof detail.iterations === "number") loops.push({ node: String(event.label), iterations: detail.iterations, met: detail.reason === "condition_met", ...(repickAt.has(String(event.label)) ? { repick: true as const } : {}) });
      return;
    }
    if (event.type !== "node.end" || nodes.length >= LEARNED_NODES_MAX) return;
    const detail = (event.detail ?? {}) as { kind?: unknown; status?: unknown; duration_ms?: unknown };
    const ran = typeof event.executionPath === "string" ? ranOn.get(event.executionPath) : undefined;
    nodes.push({ label: String(event.label), kind: String(detail.kind ?? ""), status: String(detail.status ?? ""), duration_ms: typeof detail.duration_ms === "number" ? detail.duration_ms : 0, ...ran });
  };
  try {
    const judging = runJudge && run.decisions ? { runJudge, decisionProviders: run.decisions.providers } : {};
    const result = await dsl.runWorkflow(doc, input as Record<string, unknown>, { runNode: runNode as never, runEffect: runEffect as never, onEvent, ...judging, ...(stopped ? { signal: stopped } : {}) } as never);
    const skipped = skippedWords();
    if (skipped) return skipped;
    if (result.status === "escalated") return { text: learnedText(handedBackText(flow.name, result.escalation, result.state, nodes)), isError: true, nodes, ended: "escalated" };
    if (result.status !== "complete") return refuse(`it ended ${(result as { status: string }).status}`);
    return { text: learnedText(learnedOutput(result.output)), isError: false, nodes, ended: "complete" };
  } catch (error) {
    if (signal?.aborted) throw error;
    const skipped = skippedWords();
    if (skipped) return skipped;
    return { text: `The learned workflow ${flow.name} failed: ${String((error as Error)?.message ?? error).slice(0, 1000)}${stepsLine(nodes)}`, isError: true, nodes, ended: "failed" };
  }
}

/** A node's key among the calls and values of its learned_workflow call (NestedCalls: `<callId>/<key>`), the same in
 *  every rerun of the call: its label, then a digest of its label, its execution path and its item in a map, which no
 *  other node shares. Only letters, digits, `_` and `-`, so a `/` of its path never reads as another level of nesting
 *  and its call id passes whole through a URL (an approval's). */
const nestedKey = (label: string, executionPath: string | undefined, item: { index: number } | undefined): string =>
  `${label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}-${createHash("sha256").update(JSON.stringify([label, executionPath ?? "", item?.index ?? null])).digest("hex").slice(0, 16)}`;

/** The draft check's decisions for `run` (learn/workflow-draft.ts DraftDecisions): its providers, and the gate's setting of each
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
