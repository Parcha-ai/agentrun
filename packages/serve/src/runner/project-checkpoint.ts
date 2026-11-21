/** The moved project's strict end hook: no effect dispatch while this runs, every tracked process stopped, then
 * actual backend folder sync and stable capture. A failed/uncertain step leaves an explicit receipt, never a pointer. */
import type { Claim, Store } from "../store/store.js";
import type { RunLaunch } from "../run-launch.js";
import type { RunTools } from "../workspace/run-tools.js";
import type { ClaimComputer } from "../workspace/computer-for-claim.js";
import { projectBaseline, projectCandidate, type ProjectCheckpoint, type ProjectUncertain } from "../source-sync/checkpoints.js";
import { commitSourceSnapshot, readSourceSnapshot } from "../source-sync/snapshots.js";
import { captureManagedProject, sourceSnapshotReader, sourceWorkspace, type SourceWorkspaceOptions } from "../source-sync/workspace.js";
import { withSourceIO } from "../source-sync/io.js";
import { held } from "./held.js";

export function runProjectCheckpoint(input: {
  store: Store; agentId: string; claim: Claim; launch: RunLaunch; tools: Pick<RunTools, "workspace" | "settleProject">; computer: ClaimComputer;
  workspace: SourceWorkspaceOptions; secrets(): Promise<readonly string[]>;
  /** Trusted host capability already holds durable ownership through its remote-call drain and this capture. */
  ioHeld?: true;
}) {
  const { store, agentId, claim, launch, tools, computer } = input;
  let stage: NonNullable<ProjectUncertain["stage"]> = "drain";
  const uncertain = (): ProjectUncertain => ({ version: 1, status: "uncertain", sourceId: launch.sourceProject!.sourceId,
    runId: claim.runId, epoch: claim.epoch, reason: ["read", "open", "capture", "commit", "cleanup"].includes(stage) ? "project_capture_failed" : "project_not_settled", stage });
  return {
    uncertain,
    async capture(signal: AbortSignal): Promise<ProjectCheckpoint> {
      signal.throwIfAborted();
      stage = "baseline";
      const baseline = await projectBaseline(store, claim.runId);
      if (!baseline || baseline.epoch >= claim.epoch) return { ...uncertain(), reason: "project_baseline_invalid" };
      // Existing-only immutable reads have no filesystem side effects. Refusals here need no unresolved writer
      // receipt; opening a writable backend, stopping programs and every later cleanup do require ownership.
      stage = "read";
      const reader = await sourceSnapshotReader(store, agentId, { ...input.workspace, signal });
      let original;
      try {
        original = await readSourceSnapshot(reader.workspace, baseline.digest);
      } finally { await reader.end(); }
      signal.throwIfAborted();
      // A later claim can finish this run while an old claim's backend request is still pending. The run's live row
      // therefore cannot protect these writes from deletion: keep independent durable ownership through cleanup.
      const capture = async () => {
        stage = "settle";
        const logs = await tools.settleProject();
        signal.throwIfAborted();
        stage = "sync";
        if (computer.computer && !computer.syncProject) throw new Error("The project's computer has no verified durable synchronization capability.");
        await computer.syncProject?.(signal);
        signal.throwIfAborted();
        stage = "open";
        // Preserve the exact storage selected by the baseline reader, rather than allocating on a different disk
        // if the agent's current disk metadata changes while capture is in progress.
        const cache = await sourceWorkspace(store, agentId, { ...input.workspace, signal }, reader.launchDisk ? { launch: { ...launch, archilDisk: reader.launchDisk } } : {});
        try {
          stage = "capture";
          const snapshot = await captureManagedProject(store, { agentId, runId: claim.runId, launch, workspace: tools.workspace, baseline: original, signal,
            secretValues: await input.secrets(), exclude: [
              { path: "inputs/message.md", recursive: false }, { path: ".agentrun/tmp", recursive: true }, { path: ".agentrun/output", recursive: true },
              ...(launch.sourceProject?.inputs ?? []).map(path => ({ path, recursive: false })), ...logs.map(path => ({ path, recursive: false })),
            ] }, { ...input.workspace, signal });
          signal.throwIfAborted(); stage = "commit";
          const digest = await commitSourceSnapshot(cache.workspace, snapshot);
          signal.throwIfAborted();
          return projectCandidate({ sourceId: baseline.sourceId, runId: claim.runId, epoch: claim.epoch, baselineRevision: baseline.revision, baselineDigest: baseline.digest, digest });
        } finally { try { await cache.end(); } catch (error) { stage = "cleanup"; throw error; } }
      };
      return input.ioHeld ? capture() : withSourceIO(store, agentId, "snapshot", capture);
    },
  };
}

/** The isolated child asks only for its host-bound checkpoint; it receives no store/cache/credential capability. */
export function projectCheckpointForRun(input: Parameters<typeof runProjectCheckpoint>[0], dispatched: () => void) {
  const host = input.workspace.sealKey === undefined ? held() : undefined;
  if (!host) return runProjectCheckpoint(input);
  return {
    capture: (signal: AbortSignal) => { dispatched(); return host.projectCheckpoint(signal); },
    uncertain: (): ProjectUncertain => ({ version: 1, status: "uncertain", sourceId: input.launch.sourceProject!.sourceId,
      runId: input.claim.runId, epoch: input.claim.epoch, reason: "project_not_settled", stage: "drain" }),
  };
}
