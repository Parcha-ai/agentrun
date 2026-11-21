/** Project publication is a separate CAS after the run's committed terminal receipt. A failed or lost publication
 * never reruns a model/tool or rewrites the project's baseline; a later explicit reconciliation retries the same immutable candidate. */
import { createHash } from "node:crypto";
import { readLaunchBody } from "../run-launch.js";
import { canonical } from "../store/agent-body.js";
import { AgentArchived, AgentDeleting, AgentPurged, RevisionMoved, type NewRevision, type RevisionRow, type Store } from "../store/store.js";
import { sourceSyncOf } from "./types.js";

export interface ProjectCandidate {
  readonly version: 1; readonly status: "candidate"; readonly sourceId: string; readonly runId: string; readonly epoch: number;
  readonly baselineRevision: string; readonly baselineDigest: string; readonly revision: string; readonly digest: string;
}
export interface ProjectUncertain {
  readonly version: 1; readonly status: "uncertain"; readonly sourceId: string; readonly runId: string; readonly epoch: number;
  readonly reason: "project_not_settled" | "project_capture_failed" | "project_baseline_invalid";
  /** Fixed internal diagnostic only; never exception text, source paths or credential values. */
  readonly stage?: "drain" | "settle" | "sync" | "baseline" | "read" | "open" | "capture" | "commit" | "cleanup";
}
export type ProjectCheckpoint = ProjectCandidate | ProjectUncertain;
export interface ProjectCheckpointStatus {
  readonly runId: string; readonly entryId: number; readonly status: "published" | "pending" | "conflict" | "uncertain";
  readonly revision?: string; readonly digest?: string; readonly reason?: string;
}
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
export function projectCandidate(input: Omit<ProjectCandidate, "version" | "status" | "revision">): ProjectCandidate {
  const revision = `project-${createHash("sha256").update(canonical(input)).digest("hex")}`;
  return { version: 1, status: "candidate", ...input, revision };
}
function candidateOf(value: unknown): ProjectCandidate | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as ProjectCandidate;
  if (row.version !== 1 || row.status !== "candidate" || !hex(row.sourceId) || !hex(row.baselineDigest) || !hex(row.digest)
    || !id(row.runId) || !id(row.baselineRevision) || !Number.isSafeInteger(row.epoch) || row.epoch < 1) return;
  const { sourceId, runId, epoch, baselineRevision, baselineDigest, digest } = row;
  return projectCandidate({ sourceId, runId, epoch, baselineRevision, baselineDigest, digest }).revision === row.revision ? row : undefined;
}

/** Returns the immutable chain a run itself wrote, rooted at its admission pin. Later owner/source edits are never
 * adopted as that run's baseline. A conflicting predecessor remains a conflict for all its descendants. */
export async function projectBaseline(store: Store, runId: string): Promise<{ sourceId: string; revision: string; digest: string; epoch: number } | undefined> {
  const run = await store.runs.get(runId), launch = readLaunchBody((await store.runs.launch(runId))?.body);
  const placed = launch?.sourceProject;
  if (!run || !placed || placed.baselineRevision !== run.revisionId) return;
  const initial = await store.agents.revision(run.revisionId), binding = sourceSyncOf(initial?.body);
  if (!initial || initial.agentId !== run.agentId || binding?.id !== placed.sourceId || binding.project !== placed.digest) return;
  let baseline = { sourceId: placed.sourceId, revision: placed.baselineRevision, digest: placed.digest, epoch: 0 };
  for (const row of await store.runs.projectCheckpoints({ agentId: run.agentId, runId })) {
    const candidate = candidateOf(row.checkpoint);
    if (candidate && candidate.runId === runId && candidate.sourceId === baseline.sourceId && candidate.epoch > baseline.epoch && candidate.epoch <= run.epoch
      && candidate.baselineRevision === baseline.revision && candidate.baselineDigest === baseline.digest)
      baseline = { sourceId: baseline.sourceId, revision: candidate.revision, digest: candidate.digest, epoch: candidate.epoch };
  }
  return baseline;
}

/** Reports committed receipts without moving a revision or writing any state. A pending candidate can still lose
 * its baseline before an explicit reconciliation. Callers choose the latest entry per run for an owner decision. */
export function projectCheckpointStatuses(store: Store, agentId: string): Promise<ProjectCheckpointStatus[]> {
  return processCheckpoints(store, agentId, {}, false);
}
export function reconcileProjectCheckpoints(store: Store, agentId: string, options: { runId?: string } = {}): Promise<ProjectCheckpointStatus[]> {
  return processCheckpoints(store, agentId, options, true);
}
async function processCheckpoints(store: Store, agentId: string, options: { runId?: string }, publish: boolean): Promise<ProjectCheckpointStatus[]> {
  const rows = await store.runs.projectCheckpoints({ agentId, ...options }), results: ProjectCheckpointStatus[] = [];
  const chains = new Map<string, { sourceId: string; revision: string; digest: string; epoch: number }>();
  const pending = new Map<string, RevisionRow>();
  for (const row of rows) {
    const uncertain = (reason: string): ProjectCheckpointStatus => ({ runId: row.runId, entryId: row.entryId, status: "uncertain", reason });
    const candidate = candidateOf(row.checkpoint), run = await store.runs.get(row.runId);
    if (!run || run.agentId !== agentId || run.revisionId !== row.revisionId) { results.push(uncertain("project_not_settled")); continue; }
    let chain = chains.get(row.runId);
    if (!chain) {
      const placed = readLaunchBody((await store.runs.launch(row.runId))?.body)?.sourceProject;
      const initial = await store.agents.revision(row.revisionId), binding = sourceSyncOf(initial?.body);
      if (!placed || placed.baselineRevision !== row.revisionId || binding?.id !== placed.sourceId || binding.project !== placed.digest) { results.push(uncertain("project_baseline_invalid")); continue; }
      chain = { sourceId: placed.sourceId, revision: placed.baselineRevision, digest: placed.digest, epoch: 0 };
    }
    if (!candidate) {
      const receipt = row.checkpoint as Partial<ProjectUncertain> | null;
      const reason = receipt?.version === 1 && receipt.status === "uncertain" && receipt.runId === row.runId && receipt.sourceId === chain.sourceId
        && Number.isSafeInteger(receipt.epoch) && receipt.epoch! >= 1 && receipt.epoch! <= run.epoch
        && (receipt.reason === "project_not_settled" || receipt.reason === "project_capture_failed" || receipt.reason === "project_baseline_invalid")
        ? receipt.reason : "project_not_settled";
      results.push(uncertain(reason)); continue;
    }
    if (candidate.runId !== row.runId || candidate.sourceId !== chain.sourceId || candidate.baselineRevision !== chain.revision
      || candidate.baselineDigest !== chain.digest || candidate.epoch <= chain.epoch || candidate.epoch > run.epoch) { results.push(uncertain("project_baseline_invalid")); continue; }
    chains.set(row.runId, { sourceId: candidate.sourceId, revision: candidate.revision, digest: candidate.digest, epoch: candidate.epoch });
    const status = (state: "published" | "pending" | "conflict"): ProjectCheckpointStatus => ({ runId: row.runId, entryId: row.entryId, status: state, revision: candidate.revision, digest: candidate.digest });
    const baseline = await store.agents.revision(candidate.baselineRevision) ?? pending.get(candidate.baselineRevision), binding = sourceSyncOf(baseline?.body);
    if (!baseline || baseline.agentId !== agentId || binding?.id !== candidate.sourceId || binding.project !== candidate.baselineDigest) { results.push(status("conflict")); continue; }
    const next: NewRevision = { id: candidate.revision, kind: baseline.kind, body: { ...(baseline.body as object), sourceSync: { ...binding, project: candidate.digest } },
      ...(baseline.skills === null ? {} : { skills: baseline.skills }), ...(baseline.package ? { package: baseline.package } : {}),
      ...(baseline.mcpPin === null ? {} : { mcpPin: baseline.mcpPin }), ...(baseline.monidPin ? { monidPin: baseline.monidPin } : {}), note: "Project checkpoint from a completed run." };
    const matches = async (): Promise<boolean> => {
      const saved = await store.agents.revision(candidate.revision);
      return !!saved && saved.agentId === agentId && saved.parent === candidate.baselineRevision && saved.kind === next.kind
        && canonical(saved.body) === canonical(next.body) && canonical(saved.skills) === canonical(next.skills ?? null)
        && canonical(saved.package) === canonical(next.package ?? null) && canonical(saved.mcpPin) === canonical(next.mcpPin ?? null) && canonical(saved.monidPin) === canonical(next.monidPin ?? null);
    };
    if (await matches()) { results.push(status("published")); continue; }
    if (!publish) {
      const agent = await store.agents.get(agentId);
      if (agent && agent.archivedAt === null && agent.purgedAt === null && (agent.currentRevision === candidate.baselineRevision || pending.has(candidate.baselineRevision))) {
        pending.set(candidate.revision, { ...baseline, id: candidate.revision, parent: candidate.baselineRevision, body: next.body });
        results.push(status("pending"));
      } else results.push(status("conflict"));
      continue;
    }
    try { await store.agents.addRevision({ ...next, agentId, ifCurrent: candidate.baselineRevision }); results.push(status("published")); }
    catch (error) {
      // The response may be lost after commit, or another reconciler may have saved the same exact candidate.
      if (await matches()) results.push(status("published"));
      else if (error instanceof RevisionMoved || error instanceof AgentArchived || error instanceof AgentDeleting || error instanceof AgentPurged) results.push(status("conflict"));
      else throw error;
    }
  }
  return results;
}

/** Compose after ordinary resource cleanup. If the process dies before this callback, pre-start reconciliation
 * reads the same committed candidate; neither path repeats capture or a model/tool action. */
export function projectRunEnded(store: Store, next?: (claim: { readonly runId: string; readonly epoch: number }) => Promise<void>) {
  return async (claim: { readonly runId: string; readonly epoch: number }): Promise<void> => {
    await next?.(claim);
    const run = await store.runs.get(claim.runId);
    if (!run || run.purgedAt !== null || !sourceSyncOf((await store.agents.revision(run.revisionId))?.body)) return;
    await reconcileProjectCheckpoints(store, run.agentId, { runId: run.id });
  };
}
