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
// still out hold at their worst case, reaches WRAP_UP_SHARE of the cap has every model-issued tool call refused before
// its intent, in WRAP_UP_TEXT, on every harness and in every conversation of the run (a `subagent` spawn is a call too).
// Nothing in flight is cut, and model requests are not touched: each conversation answers from what it has, under the
// cap, which stays the last line. The figure is read from the run's committed booking records at each call (the cap's
// own: a request still out counts at its hold and bound, one a lost claim cut the same), so a restart or a moved claim
// reads the same figure, and a raise of the cap ends the wrap-up from its next call.
import { AssistantEntry, type EntryRecord } from "@earendil-works/pi-durable";

/** What a call past the budget reads: the same words every time, never a count the model could argue with. */
export const TOOL_BUDGET_TEXT = "Tool budget spent: this conversation has made every tool call it may. Don't call another tool: answer now, from what you have.";

type Part = { readonly type?: unknown; readonly id?: unknown };

/** The tool calls before `callId` once one more page of a conversation's entries (`entries`, oldest first) is read, from
 *  `count`, the earlier pages': `done` once the call is reached or the count is `upTo`, where a reader stops. */
export function countCalls(entries: readonly EntryRecord[], callId: string, upTo: number, count = 0): { count: number; done: boolean } {
  for (const entry of entries) {
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

/** The share of a run's cap at which it wraps up. Its spend and its holds together: a hold is a request's worst case,
 *  never its cost, so several requests out at once reach the line long before their spend does, and the quarter left
 *  above it is room for each conversation still working to answer. */
export const WRAP_UP_SHARE = 0.75;

/** Whether a run under `capUsd` that has taken `takenUsd` (its spend and what its steps still out hold, as the cap counts
 *  them; null: unknown) wraps up. No cap, or a figure no one knows (the cap refuses the next request for that), is no. */
export const wrappingUp = (capUsd: number | undefined, takenUsd: number | null): boolean =>
  capUsd !== undefined && takenUsd !== null && Number.isFinite(takenUsd) && takenUsd >= WRAP_UP_SHARE * capUsd;
