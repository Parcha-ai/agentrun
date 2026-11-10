// The run-row reads the server makes, over the one store (design 2.1): the same answers the old per-run store gave — list
// the runs, read a run, a run by its origin key — from A's runs, agents, revisions and origins. The row's shape is the one
// the v2 API serves, nothing renamed: a run's state from A's state and an ended run's outcome, times ISO in UTC, a run's
// archive its own or its agent's, and where an imported run came from. A run that has not ended shows the spend booked so
// far (read from its journal, the same figure the cap holds it to), since cost_usd is written only at the end; an ended run
// shows its stored cost. These reads carry no secret text; the server's view layer cuts what it serves (an error, a review,
// the rows) by the run's handed sign-ins.
import type { Context } from "@earendil-works/chord";
import type { ImportedFrom, RunRow, Store } from "../store/store.js";
import { spentOverStore } from "./cap.js";

/** A revision's kind, as the row names it. */
export type RevisionKind = "agentic" | "workflow";
/** The run state the v2 API serves, as the old store kept it: a non-terminal run is 'running' (the live view refines its
 *  status); an escalated run finished its work and waits for a person. */
export type RunReadState = "running" | "completed" | "failed" | "stopped" | "escalated";

/** A run as the list and the read answer it (the old RunRow): an unset optional field is absent, never null. */
export interface RunRowView {
  readonly id: string;
  readonly agent: string;
  readonly revision: string;
  readonly kind: RevisionKind;
  readonly state: RunReadState;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly costUsd?: number;
  readonly summary?: string;
  readonly archivedAt?: string;
  readonly importedFrom?: ImportedFrom;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

/** A run's v2 state from A's state and an ended run's outcome: an escalation reads 'escalated', a plain completion
 *  'completed'; stopped and failed are their own; queued, running and parked read 'running'. */
export function runReadState(run: RunRow): RunReadState {
  return stateOf(run);
}
function stateOf(run: RunRow): RunReadState {
  switch (run.state) {
    case "ended":
      return run.outcome === "escalated" ? "escalated" : "completed";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return "running"; // queued | running | parked
  }
}

/** A run row as the server serves it, with its agent's archive time (for the coalesce), its revision's kind, and its cost
 *  (the booked-so-far spend for a run not ended, else its stored cost). */
function viewOf(run: RunRow, agentArchivedAt: number | null, kind: RevisionKind, cost: number | null): RunRowView {
  const archivedAt = run.archivedAt ?? agentArchivedAt;
  return {
    id: run.id,
    agent: run.agentId,
    revision: run.revisionId,
    kind,
    state: stateOf(run),
    startedAt: isoOf(run.startedAt),
    ...(run.endedAt !== null ? { endedAt: isoOf(run.endedAt) } : {}),
    ...(cost !== null ? { costUsd: cost } : {}),
    ...(run.summary !== null ? { summary: run.summary } : {}),
    ...(archivedAt !== null ? { archivedAt: isoOf(archivedAt) } : {}),
    ...(run.importedFrom !== null ? { importedFrom: { source: run.importedFrom.source, session: run.importedFrom.session } } : {}),
  };
}

/** A per-call reader of agents' archive times and revisions' kinds (each looked up once) and a run's cost. */
function joins(store: Store, context: Context) {
  const agentArchived = new Map<string, number | null>();
  const kinds = new Map<string, RevisionKind>();
  return {
    async of(run: RunRow): Promise<RunRowView> {
      if (!agentArchived.has(run.agentId)) agentArchived.set(run.agentId, (await store.agents.get(run.agentId))?.archivedAt ?? null);
      if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, ((await store.agents.revision(run.revisionId))?.kind as RevisionKind) ?? "agentic");
      // A run that has not ended shows the spend booked so far (the cap's own reading over the journal, the figure it holds
      // the run to), since cost_usd is written only at the end; an ended run shows its stored cost.
      const cost = runReadState(run) === "running" ? await spentOverStore(store, run.id, context) : run.costUsd;
      return viewOf(run, agentArchived.get(run.agentId)!, kinds.get(run.revisionId)!, cost);
    },
  };
}

/** The runs, newest first; `agent` and `revision` narrow it. Archived runs are listed too (the server filters them), with
 *  the archive time coalesced onto each row, and a not-ended run's cost its booked-so-far spend. */
export async function listRuns(store: Store, filter: { agent?: string; revision?: string }, context: Context): Promise<RunRowView[]> {
  const runs = await store.runs.list({
    ...(filter.agent !== undefined ? { agentId: filter.agent } : {}),
    ...(filter.revision !== undefined ? { revisionId: filter.revision } : {}),
  });
  const join = joins(store, context);
  const views: RunRowView[] = [];
  for (const run of runs) views.push(await join.of(run));
  return views;
}

/** One run with its agent's name; undefined for an unknown run. */
export async function readRun(store: Store, runId: string, context: Context): Promise<(RunRowView & { agentName: string }) | undefined> {
  const run = await store.runs.get(runId);
  if (!run) return undefined;
  const agent = await store.agents.get(run.agentId);
  const view = await joins(store, context).of(run);
  return { ...view, agentName: agent?.name ?? run.agentId };
}

/** The run started under origin `key`, with the fingerprint recorded then (as the old runOfOrigin answered it); undefined
 *  when no run was started under the key. */
export async function runOfOrigin(store: Store, key: string): Promise<{ runId: string; existing: { fingerprint?: string } } | undefined> {
  const found = await store.runOfOrigin(key);
  if (!found) return undefined;
  return { runId: found.runId, existing: found.fingerprint === null ? {} : { fingerprint: found.fingerprint } };
}
