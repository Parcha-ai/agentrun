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
import { AssistantEntry, defineDoc, type EntryRecord } from "@earendil-works/pi-durable";

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
