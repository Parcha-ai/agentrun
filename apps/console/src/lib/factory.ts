import type { FactoryCard } from "@/components/AgentFactoryBoard";
import type { Client } from "./client";
import { cost, runEnded, runTitle } from "./format";
import { isEscalated, NO_MESSAGES, runState } from "./runState";
import type { FactoryRun, FactoryScope } from "./v2";

/** Bounds work per refresh while letting a large fleet be read further explicitly. */
export const FACTORY_PAGE_BATCH = 5;
export const FACTORY_POLL_MS = 10_000;

export async function readFactoryScope(client: Pick<Client, "listFactoryRuns">, scope: FactoryScope, pages: number, signal: AbortSignal) {
  const runs = new Map<string, FactoryRun>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const result = await client.listFactoryRuns(scope, cursor, signal);
    // An older server can ignore a query parameter. Its recent history is not a fleet projection.
    if (result.scope !== scope || result.runs.some((run) => !run.factory)) {
      throw new Error("This server does not provide the Agent Factory projection. Update the server to show active sessions.");
    }
    for (const run of result.runs) runs.set(run.run_id, run);
    cursor = result.next_cursor;
    if (!cursor) break;
    if (seen.has(cursor)) throw new Error("The server repeated a page cursor. Refresh to read the remaining sessions.");
    seen.add(cursor);
  }
  return { runs: [...runs.values()], hasMore: cursor !== null };
}

function attention(run: FactoryRun): string | null {
  const pending = run.pending;
  if (pending?.kind === "question") return pending.question;
  if (pending?.kind === "approval") return `Approval requested: ${pending.tool}`;
  if (pending?.kind === "budget") return pending.said;
  if (pending?.kind === "browser" || pending?.kind === "computer") return pending.instruction;
  if (run.review) return run.review.reason;
  if (run.status === "failed" && run.error) return run.error.message;
  if (isEscalated(run.status, run.error)) return run.error?.message ?? "Open the run to review its escalation.";
  if (run.status === "input_required") return run.state === "idle" ? "Stopped; open the run to continue." : "Open the run to answer.";
  return null;
}

/** Cancellation is optimistic in /v2: the runner can still be withdrawing effects until its end is recorded. */
const settled = (run: FactoryRun) => runEnded(run.status) && run.ended_at !== null;
const needsEndedAttention = (run: FactoryRun) => run.status === "failed" || !!run.review || isEscalated(run.status, run.error);

/** Both scope queries can straddle an end or reopen. A committed watermark taken inside each run's snapshot orders
 * those observations; wall clocks and query start times cannot. Classify the newest observation independently of
 * the query that found it, so a run that ends between selection and projection is still visible exactly once. */
export function reconcileFactoryRuns(active: readonly FactoryRun[], review: readonly FactoryRun[]) {
  const latest = new Map<string, FactoryRun>();
  const version = (run: FactoryRun) => {
    const value = run.factory?.lifecycle_version;
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("The server did not report a valid session lifecycle version. Refresh after updating the server.");
    return BigInt(value);
  };
  for (const run of [...active, ...review]) {
    const incoming = version(run);
    const held = latest.get(run.run_id);
    if (!held || incoming > version(held)) latest.set(run.run_id, run);
    else if (incoming === version(held) && (run.status !== held.status || run.state !== held.state || run.ended_at !== held.ended_at)) {
      throw new Error("A session changed while its status was being read. Refresh to reconcile its current activity.");
    }
  }
  const runs = [...latest.values()];
  return { active: runs.filter((run) => !settled(run)), review: runs.filter((run) => settled(run) && needsEndedAttention(run)) };
}

/** Links come only from the server's structured launch/trigger provenance, never task text or a result's prose. */
function github(run: FactoryRun): Pick<FactoryCard, "repo" | "githubLinks"> {
  const work = run.factory?.github;
  if (!work || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(work.repository) || work.repository.split("/").some((p) => p === "." || p === "..")) {
    return { repo: null, githubLinks: [] };
  }
  const base = `https://github.com/${work.repository.split("/").map(encodeURIComponent).join("/")}`;
  const links = [{ label: work.repository, url: base }];
  if (Number.isSafeInteger(work.issue) && work.issue! > 0) links.push({ label: `Issue #${work.issue}`, url: `${base}/issues/${work.issue}` });
  if (Number.isSafeInteger(work.pull_request) && work.pull_request! > 0) links.push({ label: `PR #${work.pull_request}`, url: `${base}/pull/${work.pull_request}` });
  return { repo: work.repository, githubLinks: links };
}

/** A view over reported execution facts; it never interprets a title as a workflow stage or a merge outcome. */
export function factoryCards(runs: readonly FactoryRun[], agentName: (id: string) => string, review = false): FactoryCard[] {
  const cards: FactoryCard[] = [];
  for (const run of runs) {
    if (run.imported_from || !run.factory) continue;
    const ended = settled(run);
    if (review ? !ended || !needsEndedAttention(run) : ended) continue;
    const factory = run.factory;
    const state = runState(run.status, run.state, run.kind, NO_MESSAGES, false, run.error, run.review, run.computer);
    const sourceOffline = factory.observation.status === "offline" || factory.observation.status === "revoked";
    const reason = attention(run);
    const lane: FactoryCard["lane"] = review ? "attention"
      : sourceOffline ? "unknown"
      : run.status === "input_required" ? "attention"
      : run.status === "cancelled" ? "waiting"
      : run.status === "queued" || run.status === "paused" || run.state !== "working" ? "waiting"
      : "working";
    const label = sourceOffline && !review ? "Activity unknown"
      : run.status === "cancelled" && !ended ? "Cancelling"
      : run.status === "working" && run.state === "idle" ? "Between turns"
      : run.status === "working" && run.state === "waiting" ? "Waiting"
      : state.label;
    const source = factory.source === "native" ? `Native · ${factory.runtime}` : factory.source === "sdk" ? `SDK · ${factory.runtime}` : factory.runtime;
    const observation = sourceOffline ? `Source ${factory.observation.status}; last reported state: ${state.label.toLowerCase()}.`
      : factory.observation.status === "unreported" ? "Connection freshness is not reported by this source."
      : null;
    const card: FactoryCard = {
      id: run.run_id, runId: run.run_id, agentName: agentName(run.agent_id) || run.agent_id,
      title: runTitle(run), lane, stateLabel: label, sourceLabel: source,
      controlLabel: factory.control === "managed" ? "Managed" : "Observed",
      ...github(run), activityAt: factory.last_activity_at,
      reason: [reason, observation].filter(Boolean).join(" ") || null,
      costLabel: cost(run.cost, { ended }),
    };
    cards.push(card);
    if (!review) for (const child of factory.children) {
      if (child.status !== "active") continue;
      cards.push({
        ...card, id: `${run.run_id}:child:${child.id}`, agentName: child.label || `Child ${child.id}`,
        title: "Reported child agent", parentLabel: `${card.agentName} · ${run.run_id}`,
        lane: sourceOffline ? "unknown" : "working", stateLabel: sourceOffline ? "Activity unknown" : "Reported active",
        // A parent report is not a child's heartbeat, price, permission or GitHub delivery claim.
        activityAt: null, costLabel: "Cost not separately reported", controlLabel: "Observed",
        reason: "Reported by the parent run; GitHub context is the parent's. Open its timeline for child activity and controls.",
      });
    }
  }
  return cards;
}
