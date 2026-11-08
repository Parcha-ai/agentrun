// The entry kinds the kernel writes into a run's journal for what a run did (its tool calls and messages), shared by the
// loops that write them (runner/loop.ts for the CLI harnesses), the one reader (runner/journal-reader.ts) and the
// conformance suite. A pi run's calls are pi's own tool tasks and its messages pi's entries; a CLI run's are these.
//
// The resume log: a CLI adapter's session (runner/sessions.ts) lives in a conversation of its own, named by an
// `agentrun.session.key` entry on the run's root conversation. Every entry inside a session's conversation is resume log
// only (kernel.submission, kernel.start, kernel.end, kernel.retry, kernel.blob, runner.response, runner.submit,
// runner.accepted, …): the reader skips every one of them, whatever its kind, and never reads it as a call or a message.

export const KINDS = {
  /** A tool call about to run: written before it runs (and before the flush that precedes a side effect). */
  callStart: "agentrun.call.start",
  /** How it ended: written after it ran, or by recovery for a start with no end (replay-safe reruns and ends done;
   *  any other ends interrupted, and the model is told). */
  callEnd: "agentrun.call.end",
  /** A message: the person's, a steer, or the model's. */
  message: "agentrun.message",
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
} as const;

/** A raise taken (KINDS.raise): the cap the run goes on under, and the raise rows taken with it. */
export interface RaiseData {
  readonly capUsd: number;
  readonly takes: readonly number[];
}

/** What a run parked at its cap waits on (the kernel cap's parkOf): its cap, what the cap counted as taken, the least the
 *  refused request needs, the least cap that sends it and the raise offered, in the run's money units (dollars). */
export interface BudgetData {
  readonly pending: { readonly kind: "budget"; readonly cap_usd: number; readonly spent_usd: number; readonly needs_usd: number; readonly least_cap_usd: number; readonly suggested_cap_usd: number };
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

export type MessageRole = "person" | "steer" | "model";

export interface MessageData {
  readonly role: MessageRole;
  readonly text: string;
}

export interface AskData {
  readonly callId: string;
  readonly tool: string;
}

export interface AnswerData {
  readonly callId: string;
  readonly approved: boolean;
}

export interface EndData {
  readonly state: "ended" | "stopped" | "failed";
  readonly summary?: string;
}

export interface SessionKeyData {
  readonly key: string;
  /** The conversation whose entries are this session's resume log. */
  readonly conversation: number;
}
