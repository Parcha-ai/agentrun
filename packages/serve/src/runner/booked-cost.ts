// A run's cost as the runner booked it: every paid request of every session of the run (its model requests, a workflow's
// decisions, its paid tool calls, a learning run's grade), each at the figure its runner.turn record was booked at, read
// back from the run's journal by the kernel's own reader (sessionSpendOf), the same records the run's cap is held to.
//
// A pi run's answers carry that booking themselves (adapters/pi.ts afterResponse sets each answer's cost from its
// request's), so its usage row, which sums its answers, is the booking already. The runs whose record carries no booked
// cost of its own read it here: a CLI harness's record (its model messages carry tokens, never a cost), a workflow's
// model nodes (pi-ai's answers for a model it has no price for: $0), and a learning run (no answer on its record at all).
import type { EntryLike } from "@parcha/pi-durable-agent/timeline";
import { RUNNER_RECORDS, sessionSpendOf, type SessionRecord } from "@parcha/agentrun-kernel";
import { TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { GRADE_SESSION, KINDS, WORKFLOW_SESSION } from "./journal-kinds.js";

/** What a run's sessions booked: `usd` when every paid request has its own figure, else null with the known part
 *  (`soFarUsd`) and how many have none (`unpriced`); `requests`, its paid model requests (a paid tool call's is a charge,
 *  `charges`); `spentUsd`, what the cap holds the run to (each request with no answer at its worst case; null unknown). */
export type BookedCost = { usd: number | null; soFarUsd: number; unpriced: number; requests: number; charges: number; spentUsd: number | null };

/** Each session of the run, by its key, with its records: the conversation the first entry of its key names on the root. */
function sessionsOf(entries: readonly EntryLike[]): Map<string, SessionRecord[]> {
  const conversations = new Map<number, string>();
  for (const entry of entries) {
    if (entry.kind !== KINDS.sessionKey) continue;
    const data = (entry.data ?? {}) as { key?: unknown; conversation?: unknown };
    const conversation = Number(data.conversation);
    if (typeof data.key === "string" && Number.isFinite(conversation) && ![...conversations.values()].includes(data.key)) conversations.set(conversation, data.key);
  }
  const sessions = new Map<string, SessionRecord[]>();
  for (const key of conversations.values()) sessions.set(key, []);
  for (const entry of entries) {
    const key = conversations.get(Number(entry.conversationId));
    if (key !== undefined && entry.kind !== KINDS.sessionKey) sessions.get(key)!.push({ kind: entry.kind, data: (entry.data ?? null) as SessionRecord["data"] });
  }
  return sessions;
}

/** Whether the run's record carries no booked cost of its own, so its cost is its booking (bookedCostOf): a CLI harness's
 *  record (`cli`, its loop's entries), a workflow's, or a learning run's. A pi run's answers carry theirs. */
export function costIsBooked(entries: readonly EntryLike[], cli: boolean): boolean {
  if (cli) return true;
  const keys = new Set(sessionsOf(entries).keys());
  return keys.has(WORKFLOW_SESSION) || keys.has(GRADE_SESSION);
}

/** What the run's sessions booked, from its journal's `entries` (every conversation's); undefined when it booked no paid
 *  request. `settled`: nothing is running, so a request with no answer was cut (its cost unknown); while the run goes on,
 *  one with no answer is in flight and counts in no figure but the cap's. `except`: sessions left out, by key. */
export function bookedCostOf(entries: readonly EntryLike[], options: { settled: boolean; except?: readonly string[] }): BookedCost | undefined {
  let soFarUsd = 0;
  let unpriced = 0;
  let requests = 0;
  let charges = 0;
  let spentUsd: number | null = 0;
  let any = false;
  for (const [key, records] of sessionsOf(entries)) {
    if (options.except?.includes(key)) continue;
    const read = sessionSpendOf(records);
    if (!read.turns.length && !read.answered.size) continue;
    any = true;
    const inFlight = options.settled ? 0 : read.turns.filter((turn) => !read.answered.has(turn)).length;
    soFarUsd += read.cost.soFarUsd;
    unpriced += Math.max(0, read.cost.unpriced - inFlight);
    // A paid tool call's request is a charge, as the timeline counts it: one whose hold was given back unused is none.
    if (key === TOOL_SESSION) charges += records.filter((r) => r.kind === RUNNER_RECORDS.turn && (r.data as { givenBack?: unknown } | null)?.givenBack !== true).length;
    else requests += read.turns.length;
    spentUsd = spentUsd === null || read.spentUsd === null ? null : spentUsd + read.spentUsd;
  }
  if (!any) return undefined;
  const known = Math.round(soFarUsd * 1e6) / 1e6;
  return { usd: unpriced > 0 ? null : known, soFarUsd: known, unpriced, requests, charges, spentUsd };
}
