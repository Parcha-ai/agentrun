// A tool-call budget: an agent's `max_tool_calls`, held by the run's tool gate on pi. Each conversation of the run (the
// root, and any conversation a tool opens) may make that many tool calls; past it, every call is refused before its
// intent with one fixed text that tells the model to answer now from what it has. The refusal is not counted, and the
// run is never ended by it: the model's next answer is the turn's.
//
// The count is read from the conversation's committed entries, never kept in memory, so a restart or a moved claim counts
// the same calls: the tool calls of its assistant entries before this one, less those the budget refused (their results
// carry TOOL_BUDGET_SPENT in their details). A call of the same round whose result has not landed yet counts as made: a
// round's calls are counted in the order the model gave them, so a round that crosses the line runs its first calls up to
// it and the rest are refused.
import { AssistantEntry, type EntryRecord, ToolResultEntry } from "@earendil-works/pi-durable";

/** What a call past the budget reads: the same words every time, never a count the model could argue with. */
export const TOOL_BUDGET_TEXT = "Tool budget spent: this conversation has made every tool call it may. Don't call another tool: answer now, from what you have.";
/** The mark a budget refusal's result carries in its details (which the model never reads), so the count leaves it out. */
export const TOOL_BUDGET_SPENT = "agentrun.tool_budget_spent";

type Part = { readonly type?: unknown; readonly id?: unknown };
type ToolResult = { readonly toolCallId?: unknown; readonly details?: unknown };

/** The tool calls `entries` (one conversation's, oldest first) made before the call `callId`, not counting a call the
 *  budget refused. A call that is not among them (not committed yet) counts every call they hold. */
export function callsBefore(entries: readonly EntryRecord[], callId: string): number {
  const spent = new Set<string>();
  for (const entry of entries) {
    if (!ToolResultEntry.is(entry)) continue;
    const result = entry.model?.[0] as ToolResult | undefined;
    const details = result?.details;
    if (typeof result?.toolCallId === "string" && typeof details === "object" && details !== null && (details as Record<string, unknown>)[TOOL_BUDGET_SPENT] === true) spent.add(result.toolCallId);
  }
  let count = 0;
  for (const entry of entries) {
    if (!AssistantEntry.is(entry)) continue;
    const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Part[]) {
      if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
      if (part.id === callId) return count;
      if (!spent.has(part.id)) count++;
    }
  }
  return count;
}
