// The entry kinds the kernel writes into a run's journal for what a run did (its tool calls and messages), shared by the
// loops that write them (runner/loop.ts for the CLI harnesses), the one reader (runner/journal-reader.ts) and the
// conformance suite. A pi run's calls are pi's own tool tasks and its messages pi's entries; a CLI run's are these.
//
// The resume log: a CLI adapter's session (runner/sessions.ts) lives in a conversation of its own, named by an
// `agentrun.session.key` entry on the run's root conversation. Every entry inside a session's conversation is resume log
// only (kernel.submission, kernel.start, kernel.end, kernel.retry, kernel.blob, runner.response, runner.submit,
// runner.accepted, …): the reader skips every one of them, whatever its kind, and never reads it as a call or a message.
import type { MessageOrigin } from "@parcha/pi-durable-agent/timeline";
import { INTERRUPTED_TEXT } from "@parcha/agentrun-kernel/kernel";

export const KINDS = {
  /** A tool call about to run: written before it runs (and before the flush that precedes a side effect). */
  callStart: "agentrun.call.start",
  /** How it ended: written after it ran, or by recovery for a start with no end (replay-safe reruns and ends done;
   *  any other ends interrupted, and the model is told). */
  callEnd: "agentrun.call.end",
  /** A message: the person's, a steer, or the model's. */
  message: "agentrun.message",
  /** A pi input the person did not type (a trigger's message): pi's user entry under the host's kind, its `data.origin`
   *  the Timeline's attribution (pi-durable-agent's originMatcher reads a host's user entry's own origin). The model
   *  reads it as any message. */
  input: "agentrun.input",
  /** A tool call the gate asked a person about: the run parks on it. */
  ask: "agentrun.ask",
  /** The person's answer to an ask, written by the commit that takes the approve or deny row. */
  answer: "agentrun.answer",
  /** On the root conversation: a CLI adapter's session key and the conversation that holds its resume log. */
  sessionKey: "agentrun.session.key",
  /** The loop's end commit: how the run ended (ended, stopped, failed). Its commit carries the run row's patch and any
   *  command it takes; neither a call nor a message, so the reader passes over it. */
  end: "agentrun.end",
  /** A run parked at its cap: the cap refused a request for room (a raise would let it fit). Its data is the pending
   *  budget the run waits on a raise with; its commit carries the run parked, in the cap's words. Neither a call nor a
   *  message, so the reader passes over it. */
  budget: "agentrun.budget",
  /** A raise of the run's cap, taken: the cap it raised to, and the raise rows its commit takes (the kernel cap's
   *  takeRaises, all a claim found at once). A budget entry with a raise entry after it is answered. Neither a call nor a
   *  message, so the reader passes over it. */
  raise: "agentrun.raise",
  /** A workflow run paused by its person (a `pause` row): its commit takes the pause rows and carries the run parked in
   *  the pause's words; a step a pause held was never sent. A pause entry with no resume entry after it is in force.
   *  Neither a call nor a message, so the reader passes over it. */
  pause: "agentrun.pause",
  /** The resume of a paused workflow run (a `resume` row), taken: the workflow goes on from its journal. Neither a call nor
   *  a message, so the reader passes over it. */
  resume: "agentrun.resume",
  /** A CLI run's end-of-run turn (the loop's record): its prompt (`role: "person"`) and its answer (`role: "model"`, the
   *  text in `model` as pi's answer carries it), the entry and the answer of the submission its request id names, the
   *  same submission pi's adapter writes, so the step reads both alike. Neither a call nor a message: the reader passes
   *  over it, and the turn is never on the run's visible record. */
  endOfRunTurn: "agentrun.end-of-run.turn",
  /** A learning run's grade: the verdict and what it spent, written before its merge (a resumed run never asks again). */
  learningGraded: "agentrun.learning.graded",
  /** A learning run's merge: the new main and its commit, with the run's end. */
  learningMerged: "agentrun.learning.merged",
  /** Why a learning run merged nothing, with the run's end. */
  learningDropped: "agentrun.learning.dropped",
  /** The learning folder could not be reached: the run parks and tries again after a backoff. */
  learningUnavailable: "agentrun.learning.unavailable",
  /** A browser hand-over (pi-browser's browser_request_handoff), on the root. The run's browser host commits the ask, the
   *  whole of it (HandoverAsked); its answer is an entry too (HandoverAnswered): the person's (a browser_hand_back row
   *  the loop applies, taking the row in that commit), or the ask's expiry. The first answer for an ask is its answer. */
  handover: "agent.handover",
  /** A run waiting on the person: ask_person ended its turn. Its data is the ask_person call's id; its commit carries the
   *  run parked. A person's message after it answers it. Neither a call nor a message, so the reader passes over it.
   *  `inClaim: true` with `at` (ms): the run waits for the answer in its claim instead (adapter-loop waitInClaim), from
   *  `at`, its commit carrying the row's ASK_PERSON_WAITING summary; `answered: true` clears that summary. */
  personAsked: "agentrun.person.asked",
} as const;

/** The run row's summary while it waits on the person's answer to its question (ask_person), parked or in its claim: the
 *  view reads the question from the call, never from here, so the model's text is never copied into the row. The server
 *  tells run.needs_input for a run held in its claim by this summary (server.ts readEnds). */
export const ASK_PERSON_WAITING = "Waiting for your reply";

/** How a browser hand-over ended: the person's two answers, or its expiry. */
export type HandoverOutcome = "done" | "cancelled" | "expired";

/** A browser hand-over asked (KINDS.handover): the whole ask, as the server's reader needs it, the instruction again as
 *  `reason` (the timeline's words). */
export interface HandoverAsked {
  readonly state: "waiting";
  readonly id: string;
  readonly session: string;
  readonly instruction: string;
  readonly completion_condition: string;
  readonly asked_at: string;
  readonly expires_at: string;
  readonly reason?: string;
}

/** A browser hand-over answered (KINDS.handover): how, and when: the person's own time (their row's), or the expiry's
 *  when it lapsed first. `reason`: why, for the agent, when the run's cap ended it. */
export interface HandoverAnswered {
  readonly state: HandoverOutcome;
  readonly id: string;
  readonly session?: string;
  readonly at: string;
  readonly reason?: string;
}

/** A raise taken (KINDS.raise): the cap the run goes on under, and the raise rows taken with it. */
export interface RaiseData {
  readonly capUsd: number;
  readonly takes: readonly number[];
}

/** What a run parked at its cap waits on (the kernel cap's parkOf): its cap, what the cap counted as taken, the least the
 *  refused request needs, the least cap that sends it and the raise offered, in the run's money units (dollars). */
export interface BudgetData {
  /** `bound_usd`: the most a cache miss could have added to the refused step (the refusal's boundUsd; 0 when none), the
   *  budget card's overshoot bound. */
  readonly pending: { readonly kind: "budget"; readonly cap_usd: number; readonly spent_usd: number; readonly needs_usd: number; readonly least_cap_usd: number; readonly suggested_cap_usd: number; readonly bound_usd: number };
  /** The cap's words, as the run row's summary says them. */
  readonly words: string;
}

export interface CallStartData {
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  /** May run again after a crash (it changes nothing outside the run): the tool registry's own flag. */
  readonly replaySafe: boolean;
}

export type CallStatus = "done" | "failed" | "refused" | "interrupted";

export interface CallEndData {
  readonly callId: string;
  readonly status: CallStatus;
  readonly output?: unknown;
}

/** What a call that already ended answers when it is asked for again (a parked call's resume, a CLI's re-issue of its id):
 *  its recorded output; for one a crash cut with none, the kernel's words for an outcome not known (INTERRUPTED_TEXT);
 *  else that `tool`'s call ended so. An error unless it ended done. */
export function endedAnswer(tool: string, end: { status: CallStatus; output?: unknown }): { text: string; isError: boolean } {
  const text = typeof end.output === "string" ? end.output : end.status === "interrupted" ? INTERRUPTED_TEXT : `The ${tool} call ended ${end.status}.`;
  return { text, isError: end.status !== "done" };
}

export type MessageRole = "person" | "steer" | "model";

export interface MessageData {
  readonly role: MessageRole;
  readonly text: string;
  /** Who wrote a message the person did not type (a trigger's): the steer row's body.origin. */
  readonly origin?: MessageOrigin;
  /** A model message that ends a CLI turn its model's output limit cut (its adapter's turn_end): "length", with the cut
   *  answer's output tokens when known. The loop reads it as pi's stopReason (loop.ts cutLast). */
  readonly stopReason?: "length";
  readonly outputTokens?: number;
}

/** What an approval costs, as main's card shows it (tool-gate.ts ApprovalPrice): dollars, or "not metered". */
export type ApprovalPrice = number | "not metered";

/** A call the gate asked a person about: what main's approval card shows (tool-gate.ts ApprovalRequest). A parked call
 *  has no call.start yet, so its input is here. Optional for an ask written before these fields. */
export interface AskData {
  readonly callId: string;
  readonly tool: string;
  /** The call's input as the gate saw it; null when it had none. */
  readonly args?: unknown;
  /** When it was asked (ISO), from the loop's clock; a re-ask on a resume keeps the first. */
  readonly requestedAt?: string;
  /** Its approval price (the spec's approvalPrice); null when it has none. */
  readonly price?: ApprovalPrice | null;
}

/** How an ask was answered: approved, denied, or withdrawn (a stop or cancel while the call waited). */
export type AnswerDecision = "allow" | "deny" | "withdrawn";

export interface AnswerData {
  readonly callId: string;
  readonly approved: boolean;
  /** allow, deny, or withdrawn: main's resolved entry. Optional for an answer written before it. */
  readonly decision?: AnswerDecision;
  /** When it was answered (ISO), from the loop's clock (or the runner's, for an end it writes itself). */
  readonly answeredAt?: string;
  /** The person's words with their answer (a decline's reason): the model reads it with the refusal, and the resume row
   *  shows it. Absent when they gave none. */
  readonly note?: string;
  /** "message": a deny a person's message gave while the call waited (the message route's deny row), which its approval
   *  row reads as "Declined by your message". Absent for an answer given directly. */
  readonly by?: "message";
  /** The allow a stop overrode (main's ApprovalAnswer.superseded): the call was approved but had not finished when its
   *  run was stopped, so the stop withdrew it. Kept as it was given. */
  readonly superseded?: { readonly decision: "allow"; readonly answeredAt?: string };
}

/** Whether `entries` hold a call's finished result: an agentrun.call.end not cut (a CLI's call), or a pi.tool-result
 *  for it that pi did not write for an abort (pi's diagnostics code `aborted`). */
function finished(entries: readonly { readonly kind: string; readonly data?: unknown; readonly model?: unknown }[], callId: string): boolean {
  return entries.some((entry) => {
    if (entry.kind === KINDS.callEnd) return (entry.data as CallEndData).callId === callId && (entry.data as CallEndData).status !== "interrupted";
    if (entry.kind !== "pi.tool-result") return false;
    const result = (entry.model as { toolCallId?: unknown }[] | undefined)?.[0];
    const diagnostics = (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
    return result?.toolCallId === callId && !diagnostics.some((diagnostic) => diagnostic.code === "aborted");
  });
}

/** The withdrawn answers a stopped end writes in `entries`: for every call still waiting (an ask with no answer), and
 *  for every approved call that had not finished (no result, or one its abort wrote), which the stop overrides, keeping
 *  the allow it was given (main's supersede: an answer the run had not acted on to the end is withdrawn by the stop). A
 *  call that finished before the stop keeps its allow and its result. */
export function withdrawnAnswers(entries: readonly { readonly kind: string; readonly data?: unknown; readonly model?: unknown }[], answeredAt: string): AnswerData[] {
  const answers = new Map<string, AnswerData>();
  for (const entry of entries) if (entry.kind === KINDS.answer) answers.set((entry.data as AnswerData).callId, entry.data as AnswerData);
  const out: AnswerData[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== KINDS.ask) continue;
    const { callId } = entry.data as AskData;
    if (seen.has(callId)) continue;
    seen.add(callId);
    const given = answers.get(callId);
    if (!given) out.push({ callId, approved: false, decision: "withdrawn", answeredAt });
    else if (given.approved && given.decision !== "withdrawn" && !finished(entries, callId)) {
      out.push({ callId, approved: false, decision: "withdrawn", answeredAt, superseded: { decision: "allow", ...(given.answeredAt ? { answeredAt: given.answeredAt } : {}) } });
    }
  }
  return out;
}

export interface EndData {
  readonly state: "ended" | "stopped" | "failed";
  readonly summary?: string;
  /** How an ended run ended, set only for an escalation (the store's RunOutcome). */
  readonly outcome?: "completed" | "escalated";
  /** What the run cost, as its end knows it. */
  readonly costUsd?: number;
  /** The run's metrics (the old StoredMetrics JSON). */
  readonly metrics?: unknown;
  /** A completed workflow run's output: the value at its workflow's output path (readWorkflowRun's `output`, null when it
   *  has none), kept at its end as main's server kept it on the run (runs.ts workflowEnd), and served as result.output. */
  readonly output?: unknown;
}

export interface SessionKeyData {
  readonly key: string;
  /** The conversation whose entries are this session's resume log. */
  readonly conversation: number;
}
