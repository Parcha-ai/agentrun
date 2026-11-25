// A run's learned workflow calls, each from its own record: the learned_workflow tool keeps one entry beside each call
// it ends (learned-nodes.ts LEARNED_NODES: the workflow, its digest, who called it, how it ended, the nodes that ran),
// whoever called it, the platform before the agent's first turn (WORKFLOW_FIRST_CALL) or the agent itself. A run's
// metrics keep the calls as `workflow_calls` (workflow-first.ts pathMetrics), which the ledger row and the money rule
// read: a run the platform served first counts on that workflow's served side alone, one only the agent called on the
// side of each workflow it ran (workflow-first.ts costLineOf), and a call refused before any node ran on none.
import { type WorkflowCall, type WorkflowCallOutcome, WORKFLOW_CALLERS, type WorkflowCaller } from "../learning-cost.js";
import { learnedCallEntries } from "../learned-nodes.js";
import type { EntryLike } from "../timeline/index.js";
import { type CallStartData, KINDS } from "./journal-kinds.js";
import { callCostOf } from "./metrics.js";
import { WORKFLOW_FIRST, WORKFLOW_FIRST_CALL } from "./workflow-first.js";

type CallRecord = { readonly call?: unknown; readonly workflow?: unknown; readonly digest?: unknown; readonly caller?: unknown; readonly ended?: unknown; readonly refused?: unknown };
const dataOf = (entry: EntryLike) => (entry.data ?? {}) as CallRecord;
const callIdOf = (entry: EntryLike): string | undefined => {
  const id = (entry.data as { callId?: unknown } | undefined)?.callId;
  return typeof id === "string" ? id : undefined;
};

/** How a call's record says it ended (LearnedEnded) in WorkflowCall's words: none said is a call stopped or thrown. */
const outcomeOf = (ended: unknown): WorkflowCallOutcome => (ended === "complete" ? "answered" : ended === "escalated" ? "handed_back" : "failed");

/** Whether call `id` is `callId` itself or a call nested in it (`callId/...`). */
const within = (id: string, callId: string) => id === callId || id.startsWith(`${callId}/`);

/** The toolCall ids a pi answer (`pi.assistant`, its message the entry's model[0]) asked for: pi keeps no call start of
 *  a tool the model called, only the answer that asked for it and the tool result after. */
const piCallsOf = (entry: EntryLike): string[] => {
  if (entry.kind !== "pi.assistant") return [];
  const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content.flatMap((block: { type?: unknown; id?: unknown }) => (block?.type === "toolCall" && typeof block.id === "string" ? [block.id] : [])) : [];
};
const piResultOf = (entry: EntryLike): string | undefined => {
  const id = entry.kind === "pi.tool-result" ? (entry.model?.[0] as { toolCallId?: unknown } | undefined)?.toolCallId : undefined;
  return typeof id === "string" ? id : undefined;
};

/** What call `callId` booked (runner/metrics.ts callCostOf), over the window from its start (its call start entry, or on
 *  pi the answer that asked for it) to the later of its end (its call end, or pi's tool result) and its record
 *  (`recordAt`); null when the window is not its alone: no start, a pi answer that asked for another call beside it, or
 *  another call (none of its own) started within it or still open at its start (a nesting tool's, or the call it runs
 *  inside, is its own). Never a guess: a cost that can't be told apart is unknown. */
function callUsdOf(entries: readonly EntryLike[], callId: string, recordAt: number): number | null {
  const started = entries.findIndex((entry) => entry.kind === KINDS.callStart && callIdOf(entry) === callId);
  const asked = started < 0 ? entries.findIndex((entry) => piCallsOf(entry).includes(callId)) : -1;
  const from = started >= 0 ? started : asked;
  if (from < 0 || from > recordAt) return null;
  if (asked >= 0 && piCallsOf(entries[asked]!).length > 1) return null;
  const start = (started >= 0 ? entries[from]!.data : {}) as CallStartData;
  const to = Math.max(recordAt, entries.findLastIndex((entry) => (entry.kind === KINDS.callEnd && callIdOf(entry) === callId) || piResultOf(entry) === callId));
  // A call that holds this one (a nesting tool's: its id a prefix of this one's, or the harness's own call it runs in).
  const holds = (id: string) => callId.startsWith(`${id}/`) || start.parent === id || start.parentCallId === id;
  const open = new Set<string>();
  for (let at = 0; at < from; at++) {
    const entry = entries[at]!;
    const id = callIdOf(entry);
    if (id === undefined) continue;
    if (entry.kind === KINDS.callStart) open.add(id);
    else if (entry.kind === KINDS.callEnd) open.delete(id);
  }
  if ([...open].some((id) => !holds(id))) return null;
  for (let at = from + 1; at <= to; at++) {
    const entry = entries[at]!;
    const id = callIdOf(entry);
    if (entry.kind === KINDS.callStart && id !== undefined && !within(id, callId)) return null;
  }
  return callCostOf(entries, callId, from, to);
}

/** Each learned workflow call run `entries` show (every conversation's, in log order: store-reads/journal.ts runEntries),
 *  in the order the calls first kept a record, from the record that counts for each (a call run again after a park or a
 *  crash keeps one each time: learnedCallEntries): its workflow, digest and caller, how it ended, and what it booked (callUsdOf). The
 *  platform's call ends as the run's WORKFLOW_FIRST entry says (its answer shaped, or taken back to the agent); one a
 *  crash cut before its record was kept is that entry's alone, its cost unknown. A call its record says was refused
 *  before any node ran (`refused`) is `refused`, whoever called it. A record that names no digest or caller is left out. */
export function workflowCallsOf(entries: readonly EntryLike[]): WorkflowCall[] {
  // The record that counts for each call (learned-nodes.ts learnedCallEntries): a rerun refused before any node ran leaves
  // the attempt that ran standing, as the call's timeline row does.
  const newest = new Map([...learnedCallEntries(entries)].filter(([, at]) => {
    const data = dataOf(entries[at]!);
    return typeof data.workflow === "string" && typeof data.digest === "string" && WORKFLOW_CALLERS.includes(data.caller as WorkflowCaller);
  }));
  const served = entries.findLast((entry) => entry.kind === WORKFLOW_FIRST && ["answered", "handed_back"].includes(String((entry.data as { outcome?: unknown } | undefined)?.outcome)))?.data as { workflow?: unknown; digest?: unknown; outcome: "answered" | "handed_back" } | undefined;
  const calls = [...newest].map(([call, at]): WorkflowCall => {
    const data = dataOf(entries[at]!);
    // Refused before any node ran (its record's `refused`): it ran nothing, whatever the run did after.
    const outcome = data.refused === true ? "refused" : call === WORKFLOW_FIRST_CALL && served ? served.outcome : outcomeOf(data.ended);
    return { workflow: data.workflow as string, digest: data.digest as string, caller: data.caller as WorkflowCaller, outcome, usd: callUsdOf(entries, call, at) };
  });
  if (served && !newest.has(WORKFLOW_FIRST_CALL) && typeof served.workflow === "string" && typeof served.digest === "string") {
    calls.unshift({ workflow: served.workflow, digest: served.digest, caller: "platform", outcome: served.outcome, usd: null });
  }
  return calls;
}
