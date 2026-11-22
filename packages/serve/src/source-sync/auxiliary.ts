/** Host-only admission of learning work. Every auxiliary project is a fresh copy of its reserved revision, never the
 * served run's mutable files or private placement marker. Its execution settles without publishing project changes. */
import { ApiError } from "../errors.js";
import { withAgentRepo } from "../learning.js";
import { resetAtOf } from "../learn/promote.js";
import { launchBody, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { withHeldFiles, type StartDeps } from "../runs-over-store.js";
import { canonical } from "../store/agent-body.js";
import type { RunRow, Store } from "../store/store.js";
import { beginSourceIO } from "./io.js";
import { projectPlacement } from "./projects.js";
import { sourceSyncOf } from "./types.js";
import { openRunPlacement, sourceSnapshotReader, type SourceWorkspaceOptions } from "./workspace.js";

export interface AuxiliaryRun {
  readonly agentId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly launch: RunLaunch;
  readonly sealed?: Uint8Array;
}
export type AuxiliaryAdmitter = (request: AuxiliaryRun) => Promise<{ readonly run: RunRow; readonly created: boolean }>;
const refused = (message: string): ApiError => new ApiError("agent_not_runnable", message);

/** Reuses ordinary placement's rollback/lost-commit rules. The deterministic receipt remains after an uncertain
 * preparation/admission; a retry cannot replace its writer. An existing admitted row is read before opening storage. */
export function auxiliaryAdmitter(store: Store, options: { data: string; project?: StartDeps["project"] }): AuxiliaryAdmitter {
  return async ({ agentId, runId, revisionId, launch, sealed }) => {
    if (Boolean(launch.audit) === Boolean(launch.replay) || launch.sourceProject || launch.files?.length)
      throw refused("Auxiliary learning needs its own audit or replay launch and a fresh project placement.");
    const revision = await store.agents.revision(revisionId);
    if (!revision || revision.agentId !== agentId) throw refused("The auxiliary run's reserved agent revision is unavailable.");
    const source = sourceSyncOf(revision.body);
    const admitted = async (): Promise<RunRow | undefined> => {
      const existing = await store.runs.get(runId);
      if (!existing) return;
      const kept = readLaunchBody((await store.runs.launch(runId)).body);
      const pin = kept?.sourceProject;
      const { sourceProject: _pin, ...plain } = kept ?? {};
      // Placement may pin the agent's disk when the original request named none; all other launch fields remain exact.
      const expected = { ...launch, ...(launch.archilDisk === undefined && kept?.archilDisk ? { archilDisk: kept.archilDisk } : {}) };
      if (existing.purgedAt !== null || existing.agentId !== agentId || existing.revisionId !== revisionId || !kept
        || canonical(launchBody(plain as RunLaunch)) !== canonical(launchBody(expected))
        || (source ? !pin || pin.sourceId !== source.id || pin.digest !== source.project || pin.baselineRevision !== revisionId : pin !== undefined))
        throw refused("The reserved auxiliary run ID already belongs to a different or unavailable launch.");
      return existing;
    };
    const existing = await admitted();
    if (existing) return { run: existing, created: false };
    if (source && !options.project) throw refused("This auxiliary learning run needs project placement before it can start.");
    return withAgentRepo(options.data, agentId, async () => {
      const existing = await admitted();
      if (existing) return { run: existing, created: false };
      const reset = await resetAtOf(store.settings, agentId);
      if (launch.learning && reset !== undefined && !(launch.learning.seededAt !== undefined && launch.learning.seededAt > reset))
        throw refused("The agent's learning was reset after this replay was reserved; its old seed cannot start a new check.");
      const project = options.project && { ...options.project, hold: () => beginSourceIO(store, agentId, "placement", `auxiliary:${runId}`) };
      const run = await withHeldFiles(store, { project }, runId, agentId, revision, launch,
        prepared => store.runs.create({ id: runId, agentId, revisionId }, { body: launchBody(prepared), ...(sealed ? { sealed } : {}) }));
      return { run, created: true };
    });
  };
}

/** Runner-side counterpart of the server's StartDeps.project. Only trusted host options enter this factory. */
export function sourceAuxiliaryAdmitter(store: Store, options: SourceWorkspaceOptions): AuxiliaryAdmitter {
  return auxiliaryAdmitter(store, { data: options.data, project: projectPlacement({
    hold: ({ agentId }) => beginSourceIO(store, agentId, "placement"),
    snapshots: agentId => sourceSnapshotReader(store, agentId, options),
    destination: target => openRunPlacement(store, target, options),
  }) });
}
