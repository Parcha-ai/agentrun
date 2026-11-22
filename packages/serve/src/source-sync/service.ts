/** Source HTTP operations share one registry and the same private storage as managed run placement. */
import { getAgent, type AgentEntry } from "../agents-store.js";
import { ApiError } from "../errors.js";
import { nativeOf } from "../native/binding.js";
import { RemoteConnectors } from "../native/remote.js";
import type { SourceSnapshot, SourceSnapshotBlocker } from "../native/source-snapshot-types.js";
import type { Store } from "../store/store.js";
import { SourcePreparationError } from "./prepare.js";
import { sourceToolConnections } from "./destination.js";
import { SourceSync, type SourcePreparation, type SourceSyncOptions } from "./registry.js";
import { commitSourceSnapshot, readSourceSnapshot, validateSourceSnapshot, SnapshotError } from "./snapshots.js";
import { sourceSyncOf } from "./types.js";
import { sourceSnapshotReader, sourceWorkspace, type SourceWorkspaceOptions } from "./workspace.js";
import { unresolvedProjects, type ProjectIssue } from "./checkpoint-gate.js";
import { withSourceIO } from "./io.js";

export const SOURCE_BODY_BYTES = 128 * 1024 * 1024;
export interface SourceStatus {
  readonly enabled: boolean;
  readonly moved: boolean;
  readonly state: "needs_connection" | "paused" | "syncing" | "needs_attention" | "ready" | "moved" | "conflict";
  readonly blockers: readonly SourceSnapshotBlocker[];
  readonly snapshot?: string;
  readonly current_snapshot?: string;
  readonly connection?: { readonly connector_id: string; readonly target_id: string };
  readonly files?: number;
  readonly bytes?: number;
  readonly skills?: number;
  readonly tools?: number;
  readonly tool_connections?: Awaited<ReturnType<typeof sourceToolConnections>>;
  readonly project_issues?: readonly ProjectIssue[];
}

export function sourceService(store: Store, workspace: SourceWorkspaceOptions,
  prepare: (entry: AgentEntry, snapshot: SourceSnapshot) => Promise<SourcePreparation>, verifyDestination?: SourceSyncOptions["verifyDestination"], localAuthorize?: SourceSyncOptions["authorize"]) {
  const withWorkspace = async <T>(agentId: string, call: (work: Awaited<ReturnType<typeof sourceWorkspace>>["workspace"]) => Promise<T>): Promise<T> => {
    const opened = await sourceWorkspace(store, agentId, workspace);
    try { return await call(opened.workspace); } finally { await opened.end(); }
  };
  const sync = new SourceSync(store, {
    authorize: async (agentId) => {
      const record = await sync.get(agentId), entry = await getAgent(store, agentId);
      const connection = record?.connection ?? nativeOf(entry?.revision?.body)?.remote;
      if (!connection) {
        if (localAuthorize) return localAuthorize(agentId, "move");
        throw new ApiError("agent_not_runnable", "Enable source sync from this agent's connector before moving it.");
      }
      const found = await new RemoteConnectors(store).syncAuthority(connection.connector_id, connection.target_id);
      if (found.agentId !== agentId) throw new ApiError("forbidden", "This connector belongs to another agent.");
      return found.authority;
    },
    persist: async (agentId, snapshot) => {
      validateSourceSnapshot(snapshot);
      if (snapshot.complete && !snapshot.blockers.length) await withSourceIO(store, agentId, "snapshot", () => withWorkspace(agentId, async work => { await commitSourceSnapshot(work, snapshot); }));
    },
    read: async (agentId, digest) => {
      const opened = await sourceSnapshotReader(store, agentId, workspace);
      try { return await readSourceSnapshot(opened.workspace, digest); } finally { await opened.end(); }
    },
    prepare,
    verifyDestination,
  });
  return {
    sync,
    forConnector(broker: RemoteConnectors, connectorId: string, targetId: string) {
      // An adopted CLI profile has no native binding. Its first grant uses the signed, durable target association;
      // subsequent operations resolve the same connection from the stored source row.
      return new SourceSync(store, { ...sync.options, authorize: async agentId => {
        const current = await broker.syncAuthority(connectorId, targetId);
        if (current.agentId !== agentId) throw new ApiError("forbidden", "This source target changed its agent association.");
        return current.authority;
      } });
    },
    async status(agentId: string): Promise<SourceStatus> {
      const entry = await getAgent(store, agentId);
      if (!entry?.revision || entry.agent.purgedAt || entry.agent.archivedAt) throw new ApiError("not_found", "Choose an active connected agent.");
      const record = await sync.get(agentId), binding = sourceSyncOf(entry.revision.body);
      if (!record) return { enabled: false, moved: false, state: "needs_connection", ...(nativeOf(entry.revision.body)?.remote ? { connection: nativeOf(entry.revision.body)!.remote } : {}), blockers: [{ code: "source_consent", message: "Enable sync on this agent's source connection to bring its setup to AgentRun." }] };
      const moved = binding?.id === record.id;
      const common = { enabled: record.enabled, moved, ...(record.snapshot ? { snapshot: record.snapshot } : {}),
        ...(binding ? { current_snapshot: binding.snapshot } : {}), ...(record.connection ? { connection: record.connection } : {}) };
      const projectIssues = moved ? await unresolvedProjects(store, agentId) : [];
      if (projectIssues.length) return { ...common, state: "needs_attention", project_issues: projectIssues,
        blockers: [{ code: "project_not_saved", message: "A run’s project changes need review before another run can start. Its files and receipts are retained." }] };
      if (!record.enabled) return { ...common, state: "paused", blockers: [] };
      if (record.attempt?.blockers.length) return { ...common, state: "needs_attention", blockers: record.attempt.blockers };
      if (!record.snapshot) return { ...common, state: "syncing", blockers: [] };
      if (moved && await sync.conflicts(entry, record)) {
        return { ...common, state: "conflict", blockers: [{ code: "managed_changes", message: "Files or settings changed on both the source and AgentRun. Choose which version to keep before applying this update." }] };
      }
      let snapshot: SourceSnapshot;
      try { snapshot = await sync.options.read(agentId, record.snapshot); }
      catch (error) {
        if (error instanceof SnapshotError) return { ...common, state: "needs_attention", blockers: [{ code: `snapshot_${error.code}`, message: error.message }] };
        throw error;
      }
      const sizes = { files: snapshot.entries.filter(item => item.type === "file").length, bytes: snapshot.entries.reduce((sum, item) => sum + item.bytes, 0), skills: snapshot.skills.length, tools: snapshot.configuration.tools.length,
        tool_connections: await sourceToolConnections(store, agentId, snapshot) };
      try {
        await sync.options.authorize(agentId, "move");
        if (moved && binding.snapshot === record.snapshot) return { ...common, ...sizes, state: "moved", blockers: [] };
        await prepare(entry, snapshot);
        return { ...common, ...sizes, state: moved ? "moved" : "ready", blockers: [] };
      } catch (error) {
        if (error instanceof SourcePreparationError) return { ...common, ...sizes, state: "needs_attention", blockers: error.blockers };
        if (error instanceof ApiError && error.status < 500) return { ...common, ...sizes, state: "needs_attention", blockers: [{ code: error.code, message: error.message }] };
        throw error;
      }
    },
  };
}
