// A tool-call budget: an agent's `max_tool_calls`, held by the run's tool gate on pi. Each conversation of the run (the
// root, and any conversation a tool opens) may make that many tool calls; past it, every call is refused before its
// intent with one fixed text that tells the model to answer now from what it has. The refusal is not counted, and the
// run is never ended by it: the model's next answer is the turn's.
//
// The count is read from the conversation's committed entries, never kept in memory, so a restart or a moved claim counts
// the same calls: the tool calls of its assistant entries before this one, oldest first. The read stops at the budget: no
// refusal can come before the budget's last allowed call, so every call it counts is one that was let through, and a
// check never reads past them however long the run goes on. A call of the same round whose result has not landed yet
// counts as made: a round's calls are counted in the order the model gave them, so a round that crosses the line runs
// its first calls up to it and the rest are refused.
//
// The cap's wrap-up, the same refusal for money: a run with a cap whose spend, plus what its requests and paid steps
// still out hold at their worst case, leaves too little to keep back one typical step and one final answer (reserveFor)
// has every model-issued tool call refused before
// its intent, in WRAP_UP_TEXT, on every harness and in every conversation of the run (a `subagent` spawn is a call too).
// Nothing in flight is cut, and model requests are not touched: each conversation answers from what it has, under the
// cap, which stays the last line. The figure is read from the run's committed booking records at each call (the cap's
// own: a request still out counts at its hold and bound, one a lost claim cut the same), so a restart or a moved claim
// reads the same figure, and a raise of the cap ends the wrap-up from its next call.
import { AssistantEntry, defineDoc, type EntryRecord } from "@earendil-works/pi-durable";
import { KINDS } from "./runner/journal-kinds.js";
import { WORKFLOW_FIRST_CALL } from "./runner/workflow-first.js";

/** A conversation's own budget, narrower than the run's (a subagent call's `max_tool_calls`, runner/subagent.ts): written
 *  in the commit that makes the conversation, so a restart reads the same one, and held by the gate with the run's. */
export const ConversationToolBudget = defineDoc<{ toolCalls?: number }>({ kind: "agentrun.tool-budget", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({}), checkpointWhen: () => false });

/** The budget a conversation's calls are held to: the run's and its own, whichever is smaller (its own never widens the
 *  run's); absent, none. */
export const budgetOf = (run: number | undefined, own: number | undefined): number | undefined => (run === undefined ? own : own === undefined ? run : Math.min(run, own));

/** What a call past the budget reads: the same words every time, never a count the model could argue with. */
export const TOOL_BUDGET_TEXT = "Tool budget spent: this conversation has made every tool call it may. Don't call another tool: answer now, from what you have.";

type Part = { readonly type?: unknown; readonly id?: unknown };

/** The tool calls before `callId` once one more page of a conversation's entries (`entries`, oldest first) is read, from
 *  `count`, the earlier pages': `done` once the call is reached or the count is `upTo`, where a reader stops. The run's
 *  learned workflow, run first (runner/workflow-first.ts), is one of them: its call is the loop's, kept as a call start
 *  of its own on the root (no model content), before the agent's first turn, and counts as any call the model made. */
export function countCalls(entries: readonly EntryRecord[], callId: string, upTo: number, count = 0): { count: number; done: boolean } {
  for (const entry of entries) {
    if (entry.kind === KINDS.callStart && (entry.data as { callId?: unknown } | undefined)?.callId === WORKFLOW_FIRST_CALL) {
      if (callId === WORKFLOW_FIRST_CALL || count >= upTo) return { count, done: true };
      count++;
      continue;
    }
    if (!AssistantEntry.is(entry)) continue;
    const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Part[]) {
      if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
      if (part.id === callId || count >= upTo) return { count, done: true };
      count++;
    }
  }
  return { count, done: count >= upTo };
}

/** What a call reads once its run's cap is nearly taken: the same words every time, as the tool-call budget's. */
export const WRAP_UP_TEXT = "Budget nearly spent: stop calling tools and answer now from what you have.";

/** A main-model request's figures as the cap prices them (kernel cap requestFigures): its answer at its least, its step-0
 *  typical cost, and its worst (its full asked output). */
export type RequestFigures = { readonly leastUsd: number; readonly step0Usd: number; readonly worstUsd: number };

/** What a run keeps back of its cap so it can still answer: one typical step and one final answer at its least. The
 *  typical step is the run's own priced answers' typical cost (the wrap-up note's figure, kernel cap typicalCost; before
 *  any is priced, the step-0 cost of the request), the answer the cap's least for the main model's next request.
 *  Undefined when the request cannot be priced. The rule's one place: keeping back one final answer at its worst case
 *  instead would be `figures.worstUsd`, and a worst step and a least answer `figures.worstUsd + figures.leastUsd`. */
export const reserveFor = (figures: RequestFigures | undefined, typical: (step0Usd: number) => number): number | undefined =>
  figures === undefined ? undefined : typical(figures.step0Usd) + figures.leastUsd;

/** Whether a run under `capUsd` that has taken `takenUsd` wraps up. `takenUsd`: its spend and every step still out at its
 *  worst case, as the cap counts them (null: unknown). It wraps up once what it keeps back to answer (`reserveUsd`,
 *  reserveFor) no longer fits on top: in flight is reserved as it stands, so a fan-out keeps room for each conversation to
 *  answer, and a simple run uses its cap up to its last step and answer. No cap, a figure no one knows (the cap refuses
 *  the next request for that), or no reserve yet (no main-model request priced on this claim) is no. */
export const wrappingUp = (capUsd: number | undefined, takenUsd: number | null, reserveUsd: number | undefined): boolean =>
  capUsd !== undefined && takenUsd !== null && reserveUsd !== undefined && Number.isFinite(takenUsd) && Number.isFinite(reserveUsd) && takenUsd + reserveUsd > capUsd;
