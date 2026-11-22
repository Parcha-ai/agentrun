/** Pre-admission project placement over injected private workspaces. No claim calls this function: a claim verifies
 * its completed receipt and leaves the run's current files alone. Checkpoint capture/publication is a separate step. */
import { createHash } from "node:crypto";
import type { NewRevision } from "../store/store.js";
import type { LaunchDisk, RunLaunch, SourceProjectLaunch } from "../run-launch.js";
import type { Workspace } from "../workspace/workspace.js";
import { readSourceSnapshot, seedSourceSnapshot, SnapshotError, type SeedPreparation } from "./snapshots.js";
import type { SourceIOReceipt } from "./io.js";
import { sourceSyncOf } from "./types.js";

export interface ProjectDestination {
  readonly workspace: Workspace;
  /** Private control, outside every workspace exposed to the run's tools. */
  readonly control: Workspace;
  readonly launchDisk?: LaunchDisk;
  readonly preparation: SeedPreparation;
  /** Release preparation resources; no claim/settling proof. undo remains usable afterward. */
  end(): Promise<void>;
  /** Only this exclusive unadmitted run; wait for pending writes and refuse an admitted run. */
  undo(): Promise<void>;
}
export interface ProjectPlacementOptions {
  hold(input: { agentId: string; runId: string }): Promise<SourceIOReceipt>;
  /** Existing-only readonly cache: opening/closing it must never allocate storage or dispatch a write. */
  snapshots(agentId: string): Promise<{ workspace: Workspace; end(): Promise<void> }>;
  destination(input: { agentId: string; runId: string; launch: RunLaunch }): Promise<ProjectDestination>;
  /** Copy already held local uploads before project seeding. Await every copy and hold cleanup; a failure has an
   * unknown write outcome and keeps ownership. Runs whose uploads were placed earlier do not call this capability. */
  placeUploads?(input: { runId: string; launch: RunLaunch; workspace: Workspace }): Promise<void>;
}
const hash = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

async function completeReceipt(control: Workspace, digest: string, inputs?: readonly string[]): Promise<string> {
  const stat = await control.stat("source-seed.json");
  if (!stat || stat.kind !== "file" || stat.size > 128 * 1024) throw new SnapshotError("unsafe_resume", "The project's private completion receipt is missing or invalid.");
  const bytes = await control.read("source-seed.json", { length: 128 * 1024 + 1 });
  if (bytes.length !== stat.size || bytes.length > 128 * 1024) throw new SnapshotError("unsafe_resume", "The project's completion receipt changed while it was read.");
  let marker: unknown;
  try { marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new SnapshotError("unsafe_resume", "The project's completion receipt is invalid."); }
  if (!marker || typeof marker !== "object" || Array.isArray(marker) || Object.keys(marker).length !== (inputs === undefined ? 3 : 4)
    || (marker as { version?: unknown }).version !== 1 || (marker as { digest?: unknown }).digest !== digest
    || (marker as { phase?: unknown }).phase !== "complete" || JSON.stringify((marker as { inputs?: unknown }).inputs) !== JSON.stringify(inputs)) throw new SnapshotError("unsafe_resume", "The project's completion receipt does not match its pinned snapshot.");
  return hash(bytes);
}

/** Verify a private marker only. Deliberately never verify/reset mutable project files from the original snapshot:
 * later claims and follow-ups must keep the run's own edits, additions and deletions. */
export async function verifySourceProject(control: Workspace, placed: SourceProjectLaunch): Promise<void> {
  if (await completeReceipt(control, placed.digest, placed.inputs) !== placed.receipt) throw new SnapshotError("unsafe_resume", "The project's private completion receipt does not match its launch.");
}

async function placedInputs(work: Workspace): Promise<string[]> {
  if (!await work.stat("inputs")) return [];
  const files: string[] = []; let visited = 0;
  const visit = async (path: string): Promise<void> => {
    if (++visited > 1024 || path.length > 4096) throw new SnapshotError("limit", "Placed upload paths exceed the project limit.");
    const entry = await work.stat(path);
    if (entry?.kind === "file") files.push(path);
    else if (entry?.kind === "dir") for (const child of await work.list(path)) await visit(`${path}/${child.name}`);
    else throw new SnapshotError("conflict", "Placed uploads must contain only regular files and directories.");
  };
  await visit("inputs");
  if (files.length > 20 || files.includes("inputs/message.md")) throw new SnapshotError("conflict", "Placed uploads conflict with the run's reserved message path or upload limit.");
  return files.sort();
}

/** The StartDeps.project adapter. It resolves exact immutable source bytes before opening a destination, restores
 * through that destination's explicit capabilities, and returns only after its private completion marker is durable. */
export function projectPlacement(options: ProjectPlacementOptions) {
  return {
    hold: options.hold,
    async place({ agentId, runId, revision, launch, hold }: { hold?: SourceIOReceipt; agentId: string; runId: string; revision: Pick<NewRevision, "id" | "kind" | "body">; launch: RunLaunch }): Promise<{ launch: RunLaunch; undo(): Promise<void>; admitted(): Promise<void> } | undefined> {
      const source = sourceSyncOf(revision.body);
      if (!source) return undefined;
      const ownership = hold ?? await options.hold({ agentId, runId });
      const stored = await options.snapshots(agentId).catch(async error => {
        // This opener is explicitly read-only. No destination allocation or write has been dispatched.
        await ownership.settled();
        throw error;
      });
      let destination: ProjectDestination | undefined, destinationStarted = false, uploadUncertain = false, seedStarted = false, preparationRolledBack = false;
      try {
        // Validate the whole source before destination allocation. seed reads it again while initializing; a corrupt
        // immutable store is refused rather than producing an admitted run with only some content.
        const snapshot = await readSourceSnapshot(stored.workspace, source.project);
        // These exact paths are owned by the run host: message placement and shell cleanup would otherwise replace or
        // remove authored source bytes after the seed was marked complete. Unrelated inputs/.agentrun siblings remain.
        const reserved = ["project/inputs/message.md", "project/.agentrun/tmp", "project/.agentrun/output"];
        if (snapshot.entries.some(entry => entry.role === "project" && reserved.some(path => entry.path === path || entry.path.startsWith(`${path}/`))))
          throw new SnapshotError("conflict", "The source project includes a path reserved for run inputs or shell scratch; move that content before starting this project.");
        destinationStarted = true;
        destination = await options.destination({ agentId, runId, launch });
        let prepared = launch;
        if (!launch.filesPlaced && launch.files?.length) {
          if (!options.placeUploads) throw new SnapshotError("prerequisite", "This moved project's uploads must be placed before project admission.");
          uploadUncertain = true;
          await options.placeUploads({ runId, launch, workspace: destination.workspace });
          uploadUncertain = false;
          prepared = { ...launch, filesPlaced: true };
        }
        const inputs = await placedInputs(destination.workspace);
        if (snapshot.entries.some(entry => entry.role === "project" && inputs.some(input => entry.path === `project/${input}`)))
          throw new SnapshotError("conflict", "A placed upload would replace an authored project file.");
        seedStarted = true;
        await seedSourceSnapshot({ snapshots: stored.workspace, destination: destination.workspace, control: destination.control,
          digest: source.project, beforeDispatch: true, exclusiveInitialization: true, preparation: destination.preparation });
        if (inputs.length) await destination.control.write("source-seed.json", JSON.stringify({ version: 1, digest: source.project, phase: "complete", inputs }));
        const receipt = await completeReceipt(destination.control, source.project, inputs.length ? inputs : undefined);
        const placed: SourceProjectLaunch = { version: 1, sourceId: source.id, baselineRevision: revision.id, digest: source.project, receipt, ...(inputs.length ? { inputs } : {}) };
        const own = destination;
        return { launch: { ...prepared, ...(own.launchDisk ? { archilDisk: own.launchDisk } : {}), sourceProject: placed }, admitted: () => ownership.settled(), undo: async () => {
          await own.undo();
          await ownership.settled();
        } };
      } catch (error) {
        preparationRolledBack = !destinationStarted;
        // Admission has not even been attempted. This preparation owns its rollback and waits for writes to settle.
        // A completed destination open can still be refused by read-only upload checks. Only confirmed rollback of
        // that pre-seed preparation is safe to release; an unanswered open or dispatched seed keeps its receipt.
        if (destination) try {
          await destination.undo();
          preparationRolledBack = !seedStarted && !uploadUncertain;
        } catch { /* an unknown rollback keeps the writer recorded */ }
        throw error;
      } finally {
        const closed = await Promise.allSettled([destination?.end(), stored.end()]);
        const failed = closed.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        if (preparationRolledBack) await ownership.settled();
      }
    },
  };
}
