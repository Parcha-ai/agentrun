// The run-row reads the server makes, over the one store (design 2.1): the same answers the old per-run store gave — list
// the runs, read a run, a run by its origin key — from A's runs, agents, revisions and origins. The row's shape is the one
// the v2 API serves, nothing renamed: a run's state from A's state and an ended run's outcome, times ISO in UTC, a run's
// archive its own or its agent's, and where an imported run came from. These reads carry no secret text; the server's view
// layer cuts what it serves (an error, a review, the rows) by the run's handed sign-ins.
import type { ImportedFrom, RunRow, Store } from "../store/store.js";

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

/** A run row as the server serves it, with its agent's archive time (for the coalesce) and its revision's kind. */
function viewOf(run: RunRow, agentArchivedAt: number | null, kind: RevisionKind): RunRowView {
  const archivedAt = run.archivedAt ?? agentArchivedAt;
  return {
    id: run.id,
    agent: run.agentId,
    revision: run.revisionId,
    kind,
    state: stateOf(run),
    startedAt: isoOf(run.startedAt),
    ...(run.endedAt !== null ? { endedAt: isoOf(run.endedAt) } : {}),
    ...(run.costUsd !== null ? { costUsd: run.costUsd } : {}),
    ...(run.summary !== null ? { summary: run.summary } : {}),
    ...(archivedAt !== null ? { archivedAt: isoOf(archivedAt) } : {}),
    ...(run.importedFrom !== null ? { importedFrom: run.importedFrom } : {}),
  };
}

/** A per-call reader of agents' archive times and revisions' kinds, each looked up once. */
function joins(store: Store) {
  const agentArchived = new Map<string, number | null>();
  const kinds = new Map<string, RevisionKind>();
  return {
    async of(run: RunRow): Promise<RunRowView> {
      if (!agentArchived.has(run.agentId)) agentArchived.set(run.agentId, (await store.agents.get(run.agentId))?.archivedAt ?? null);
      if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, ((await store.agents.revision(run.revisionId))?.kind as RevisionKind) ?? "agentic");
      return viewOf(run, agentArchived.get(run.agentId)!, kinds.get(run.revisionId)!);
    },
  };
}

/** The runs, newest first; `agent` and `revision` narrow it. Archived runs are listed too (the server filters them), with
 *  the archive time coalesced onto each row. */
export async function listRuns(store: Store, filter: { agent?: string; revision?: string } = {}): Promise<RunRowView[]> {
  const runs = await store.runs.list({
    ...(filter.agent !== undefined ? { agentId: filter.agent } : {}),
    ...(filter.revision !== undefined ? { revisionId: filter.revision } : {}),
  });
  const join = joins(store);
  const views: RunRowView[] = [];
  for (const run of runs) views.push(await join.of(run));
  return views;
}

/** One run with its agent's name; undefined for an unknown run. */
export async function readRun(store: Store, runId: string): Promise<(RunRowView & { agentName: string }) | undefined> {
  const run = await store.runs.get(runId);
  if (!run) return undefined;
  const agent = await store.agents.get(run.agentId);
  const view = await joins(store).of(run);
  return { ...view, agentName: agent?.name ?? run.agentId };
}

/** The run started under origin `key`, with the fingerprint recorded then (as the old runOfOrigin answered it); undefined
 *  when no run was started under the key. */
export async function runOfOrigin(store: Store, key: string): Promise<{ runId: string; existing: { fingerprint?: string } } | undefined> {
  const found = await store.runOfOrigin(key);
  if (!found) return undefined;
  return { runId: found.runId, existing: found.fingerprint === null ? {} : { fingerprint: found.fingerprint } };
}
