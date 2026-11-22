/** An owner acknowledges specific unresolved run receipts, never every past/future failure. Candidate bytes and
 * receipts remain available for inspection; this choice only permits later runs to use the current saved project. */
import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import { canonical } from "../store/agent-body.js";
import type { Store } from "../store/store.js";
import { projectCheckpointStatuses } from "./checkpoints.js";

export const checkpointAckPrefix = (agentId: string): string => `source-sync.checkpoint.${agentId}.`;
const key = (agentId: string, runId: string): string => checkpointAckPrefix(agentId) + createHash("sha256").update(runId).digest("hex");
type Reader = typeof projectCheckpointStatuses;
export type ProjectReceipt = { run_id: string; entry_id: number; attempt_epoch?: never } | { run_id: string; entry_id: null; attempt_epoch: number };
export type ProjectIssue = ProjectReceipt & { status: "pending" | "conflict" | "uncertain"; reason?: string };
const identity = (row: ProjectReceipt): string => canonical([row.run_id, row.entry_id, row.attempt_epoch ?? null]);
export async function unresolvedProjects(store: Store, agentId: string, read: Reader = projectCheckpointStatuses): Promise<ProjectIssue[]> {
  const latest = new Map<string, Awaited<ReturnType<Reader>>[number]>();
  for (const row of await read(store, agentId)) {
    const before = latest.get(row.runId);
    // The projection emits a missing-end row only for the latest terminal claim, after every earlier real end.
    if (!before || row.entryId === null || before.entryId !== null && before.entryId < row.entryId) latest.set(row.runId, row);
  }
  const unresolved: ProjectIssue[] = [];
  for (const row of latest.values()) {
    if (row.status === "published") continue;
    if (row.entryId === null && (!Number.isSafeInteger(row.attemptEpoch) || row.attemptEpoch! < 1)) throw new Error("The missing project checkpoint has no claim identity.");
    const receipt: ProjectReceipt = row.entryId === null ? { run_id: row.runId, entry_id: null, attempt_epoch: row.attemptEpoch! } : { run_id: row.runId, entry_id: row.entryId };
    const issue: ProjectIssue = { ...receipt, status: row.status, ...(row.reason ? { reason: row.reason } : {}) };
    if (canonical(await store.settings.get(key(agentId, row.runId)) ?? null) !== canonical(issue)) unresolved.push(issue);
  }
  return unresolved.sort((a, b) => a.run_id.localeCompare(b.run_id));
}

export async function acknowledgeProjects(store: Store, agentId: string, receipts: unknown, read: Reader = projectCheckpointStatuses): Promise<void> {
  if (!Array.isArray(receipts) || !receipts.length || receipts.length > 1000 || receipts.some(row => !row || typeof row !== "object"
    || Object.keys(row).some(name => !["run_id", "entry_id", "attempt_epoch"].includes(name)) || typeof row.run_id !== "string"
    || (row.entry_id === null ? !Number.isSafeInteger(row.attempt_epoch) || row.attempt_epoch < 1
      : !Number.isSafeInteger(row.entry_id) || row.entry_id < 1 || row.attempt_epoch !== undefined))) {
    throw new ApiError("input_invalid", "Choose the unresolved run receipts you reviewed.");
  }
  const wanted = new Set(receipts.map(identity));
  if (wanted.size !== receipts.length) throw new ApiError("input_invalid", "Choose each run receipt once.");
  const issues = await unresolvedProjects(store, agentId, read);
  const selected = issues.filter(row => wanted.has(identity(row)));
  if (selected.length !== wanted.size || selected.some(row => row.status === "pending")) throw new ApiError("precondition_failed", "The project receipts changed. Refresh and review them before continuing.");
  for (const issue of selected) await store.settings.put(key(agentId, issue.run_id), issue);
}

export async function requireSavedProject(store: Store, agentId: string): Promise<void> {
  const issues = await unresolvedProjects(store, agentId);
  if (issues.length) throw new ApiError("agent_not_runnable", "A prior run's project changes were not saved as the current project. Review its receipts on the agent page before starting another run.", { details: { project_issues: issues } });
}
