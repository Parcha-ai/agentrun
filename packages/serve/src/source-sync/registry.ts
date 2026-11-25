/** Source ownership survives Move. Snapshot bytes commit first; these small rows publish their digests under the
 * connector's revocation guards. Managed revisions carry the cutover receipt, so a crash cannot restore native work. */
import { createHash, randomBytes } from "node:crypto";
import { getAgent, type AgentEntry } from "../agents-store.js";
import { uuidv7 } from "../ids.js";
import { ApiError } from "../errors.js";
import type { SourceSnapshot, SourceSnapshotBlocker } from "../native/source-snapshot-types.js";
import { canonical, isObject, type AgenticBody } from "../store/agent-body.js";
import { ActiveRuns, RevisionMoved, type McpGuard, type NewRevision, type SettingsGuard, type Store } from "../store/store.js";
import { sourceSyncOf } from "./types.js";

export const sourceKey = (agentId: string): string => `source-sync.agent.${agentId}`;
export type SourceIdentity = SourceSnapshot["source"];
export interface SourceRecord {
  readonly version: 1;
  readonly id: string;
  readonly agent_id: string;
  readonly source: SourceIdentity;
  readonly connection?: { readonly connector_id: string; readonly target_id: string };
  readonly capture_revision: string;
  readonly generation: string;
  readonly enabled: boolean;
  readonly sequence: number;
  readonly snapshot?: string;
  readonly attempt?: { readonly digest: string; readonly code?: SourceFailureCode; readonly blockers: readonly SourceSnapshotBlocker[] };
}
export interface SourceAuthority {
  readonly source: SourceIdentity;
  readonly connection?: SourceRecord["connection"];
  /** The actual source credential/target rows, including generation and owner disconnect predicates. */
  readonly guards: readonly SettingsGuard[];
  readonly captureRevision: string;
}
export interface SourcePreparation {
  readonly revision: NewRevision;
  /** Destination credential/tool generations checked again in the cutover transaction. */
  readonly guards?: readonly SettingsGuard[];
  readonly mcpGuards?: readonly McpGuard[];
}
export interface SourceSyncOptions {
  /** Authority is checked on every operation, also after Move. It must never be inferred from a path or title. */
  authorize(agentId: string, operation: "grant" | "push" | "move"): Promise<SourceAuthority>;
  /** Validates all bytes/paths/digests and commits an immutable complete manifest before returning. */
  persist(agentId: string, snapshot: SourceSnapshot): Promise<void>;
  read(agentId: string, digest: string): Promise<SourceSnapshot>;
  /** Resolves the actual managed tools, policies, model access and workspace. Refusal leaves execution at its source. */
  prepare(entry: AgentEntry, snapshot: SourceSnapshot): Promise<SourcePreparation>;
  /** Exercise real destination file/Git/mode preparation before cutover, without admitting or running a task. */
  verifyDestination?(entry: AgentEntry, snapshot: SourceSnapshot, prepared: SourcePreparation): Promise<void>;
}
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const generation = (): string => randomBytes(24).toString("base64url");
const busy = (): ApiError => new ApiError("precondition_failed", "The source or agent changed while syncing. Read its current status and try again.");
const matches = (a: SourceIdentity, b: SourceIdentity): boolean => canonical(a) === canonical(b);
export const SOURCE_FAILURES = {
  unsupported_platform: "This source needs a supported snapshot reader for its operating system.",
  source_changed: "The source changed while it was being read. Sync will retry a complete version.",
  source_unavailable: "The source setup could not be read. Check the source connection and its approved folders.",
  snapshot_too_large: "This project exceeds the supported snapshot size. Select a smaller complete project.",
} as const;
export type SourceFailureCode = keyof typeof SOURCE_FAILURES;
/** The coupled settings group: a source update never combines new tool policy with unrelated managed settings. */
export function configurationDigest(body: unknown): string {
  if (!isObject(body)) throw new TypeError("a configuration is a revision body");
  const { sourceSync: _source, ...configuration } = body;
  return hash(configuration);
}
const projectDigest = (snapshot: SourceSnapshot): string => hash({ project: snapshot.project, skills: snapshot.skills,
  entries: snapshot.entries.filter(entry => entry.role === "project" || entry.role === "skill").sort((a, b) => a.path.localeCompare(b.path)) });

export class SourceSync {
  constructor(readonly store: Store, readonly options: SourceSyncOptions) {}

  async get(agentId: string): Promise<SourceRecord | undefined> {
    return await this.store.settings.get(sourceKey(agentId)) as SourceRecord | undefined;
  }

  private async entry(agentId: string): Promise<AgentEntry> {
    const entry = await getAgent(this.store, agentId);
    if (!entry?.revision || entry.agent.purgedAt || entry.agent.archivedAt || entry.agent.externalRef) throw new ApiError("not_found", "Choose an active connected agent owned by this server.");
    return entry;
  }

  private async authorized(agentId: string, operation: "grant" | "push" | "move", record?: SourceRecord): Promise<SourceAuthority> {
    const authority = await this.options.authorize(agentId, operation);
    if (record && !matches(record.source, authority.source)) throw new ApiError("forbidden", "This source does not own the agent's sync connection.");
    if (record && canonical(record.connection ?? null) !== canonical(authority.connection ?? null)) throw new ApiError("forbidden", "A different connector owns this agent's sync connection.");
    if (!authority.guards.length) throw new TypeError("source authority requires a durable revocation guard");
    const capture = await this.store.agents.revision(authority.captureRevision);
    if (!capture || capture.agentId !== agentId) throw new ApiError("forbidden", "The source capture revision does not belong to this agent.");
    return authority;
  }

  /** Called only after the source explicitly grants configuration/project export. A new grant defaults to on. */
  async grant(agentId: string): Promise<SourceRecord> {
    await this.entry(agentId);
    const authority = await this.authorized(agentId, "grant");
    const candidate: SourceRecord = { version: 1, id: hash({ agentId, source: authority.source }), agent_id: agentId,
      source: authority.source, ...(authority.connection ? { connection: authority.connection } : {}), capture_revision: authority.captureRevision, generation: generation(), enabled: true, sequence: -1 };
    const record = await this.store.settings.putIfAbsent(sourceKey(agentId), candidate) as SourceRecord;
    if (!matches(record.source, authority.source) || canonical(record.connection ?? null) !== canonical(authority.connection ?? null)) throw new ApiError("forbidden", "This agent already has a different authorized source.");
    // Merely inserting an unpublished grant cannot move execution. Every publish and cutover rechecks authority in
    // its write transaction, including a revocation which raced this first registration.
    return record;
  }

  /** The signed-in owner's switch. The record is retained so disconnect can never turn a moved agent native again. */
  async setEnabled(agentId: string, enabled: boolean): Promise<SourceRecord> {
    await this.entry(agentId);
    for (let tries = 0; tries < 8; tries++) {
      const record = await this.get(agentId);
      if (!record) throw new ApiError("not_found", "Connect this agent's source before enabling sync.");
      if (record.enabled === enabled) return record;
      // Re-enabling needs a fresh source grant. Owner disable is always available, including while its source is offline.
      const authority = enabled ? await this.authorized(agentId, "grant", record) : undefined;
      const next = { ...record, enabled, generation: generation(), sequence: -1 };
      if (await this.store.settings.replaceIf(sourceKey(agentId), record, next, undefined, authority?.guards)) return next;
    }
    throw busy();
  }

  async publish(agentId: string, input: { generation: string; sequence: number; snapshot: SourceSnapshot }): Promise<SourceRecord> {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new ApiError("input_invalid", "A source snapshot needs a non-negative sequence.");
    let record = await this.get(agentId);
    if (!record) throw new ApiError("forbidden", "This source has no configuration sync grant.");
    const authority = await this.authorized(agentId, "push", record);
    const check = (row: SourceRecord): void => {
      if (!row.enabled || row.generation !== input.generation) throw new ApiError("forbidden", "Source sync is off or its grant changed.");
      if (!matches(row.source, input.snapshot.source)) throw new ApiError("forbidden", "The snapshot belongs to a different source target.");
      if (input.sequence < row.sequence) throw busy();
      if (input.sequence === row.sequence && row.attempt?.digest !== input.snapshot.digest) throw busy();
    };
    check(record);
    if (input.sequence === record.sequence) return record;
    // The persistence boundary validates even an incomplete manifest; it never makes an incomplete version movable.
    await this.options.persist(agentId, input.snapshot);
    for (let tries = 0; tries < 8; tries++) {
      check(record);
      if (input.sequence === record.sequence) return record;
      const next: SourceRecord = { ...record, sequence: input.sequence,
        ...(input.snapshot.complete && !input.snapshot.blockers.length ? { snapshot: input.snapshot.digest } : {}),
        attempt: { digest: input.snapshot.digest, blockers: input.snapshot.blockers } };
      if (await this.store.settings.replaceIf(sourceKey(agentId), record, next, undefined, authority.guards)) return next;
      record = await this.get(agentId) ?? (() => { throw busy(); })();
    }
    throw busy();
  }

  private guard(record: SourceRecord): SettingsGuard {
    return { key: sourceKey(record.agent_id), fields: { id: record.id, generation: record.generation,
      enabled: true, snapshot: record.snapshot, sequence: record.sequence } };
  }

  /** A source failure is a fixed server-owned message, never a path, exception dump or credential-bearing text. */
  async failed(agentId: string, input: { generation: string; sequence: number; code: SourceFailureCode }): Promise<SourceRecord> {
    if (!Object.hasOwn(SOURCE_FAILURES, input.code) || !Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new ApiError("input_invalid", "Supply a supported source failure code and sequence.");
    for (let tries = 0; tries < 8; tries++) {
      const record = await this.get(agentId);
      if (!record || !record.enabled || record.generation !== input.generation) throw new ApiError("forbidden", "Source sync is off or its grant changed.");
      const authority = await this.authorized(agentId, "push", record);
      if (input.sequence < record.sequence || input.sequence === record.sequence && record.attempt?.code !== input.code) throw busy();
      if (input.sequence === record.sequence) return record;
      const next: SourceRecord = { ...record, sequence: input.sequence, attempt: { digest: hash(input), code: input.code,
        blockers: [{ code: input.code, message: SOURCE_FAILURES[input.code] }] } };
      if (await this.store.settings.replaceIf(sourceKey(agentId), record, next, undefined, authority.guards)) return next;
    }
    throw busy();
  }

  /** One atomic ownership cutover. Retrying after an uncertain response returns the same managed agent. */
  async move(agentId: string, expected?: { snapshot: string }): Promise<AgentEntry> {
    const entry = await this.entry(agentId);
    const record = await this.get(agentId);
    if (!record) throw new ApiError("agent_not_runnable", "Connect this agent's source and sync its setup first.");
    const moved = sourceSyncOf(entry.revision!.body);
    // The caller's reviewed digest is checked against the same record that apply fences in its
    // revision transaction, including a publication that races destination preparation.
    if (expected && (record.snapshot !== expected.snapshot || moved?.id === record.id && moved.snapshot !== expected.snapshot)) throw busy();
    if (moved?.id === record.id) return entry;
    const authority = await this.authorized(agentId, "move", record);
    return await this.apply(entry, record, authority, true);
  }

  /** A source push only changes an already moved agent when its managed configuration still matches our baseline. */
  async reconcile(agentId: string): Promise<"unchanged" | "applied" | "conflict"> {
    const entry = await this.entry(agentId), record = await this.get(agentId), binding = sourceSyncOf(entry.revision!.body);
    if (!record?.enabled || !binding || binding.id !== record.id || !record.snapshot || binding.snapshot === record.snapshot) return "unchanged";
    if (await this.conflicts(entry, record)) return "conflict";
    const authority = await this.authorized(agentId, "move", record);
    await this.apply(entry, record, authority, false);
    return "applied";
  }

  /** Project edits and their authored skill closure form one group. A source update cannot publish new skill metadata
   * while silently retaining older script bytes, nor replace the files a managed run changed. */
  async conflicts(entry: AgentEntry, record: SourceRecord): Promise<boolean> {
    const binding = sourceSyncOf(entry.revision?.body);
    if (!binding || !record.snapshot || binding.snapshot === record.snapshot) return false;
    if (configurationDigest(entry.revision!.body) !== binding.configuration) return true;
    if (binding.project === binding.snapshot) return false;
    const [before, after] = await Promise.all([this.options.read(entry.agent.id, binding.snapshot), this.options.read(entry.agent.id, record.snapshot)]);
    return projectDigest(before) !== projectDigest(after);
  }

  /** Explicit owner resolution, pinned to the version shown. Old managed files remain in immutable history. */
  async useSource(agentId: string, expected: { revision: string; snapshot: string }): Promise<AgentEntry> {
    const entry = await this.entry(agentId), record = await this.get(agentId);
    if (!record || entry.revision!.id !== expected.revision || record.snapshot !== expected.snapshot) throw busy();
    if (!sourceSyncOf(entry.revision!.body)) throw new ApiError("input_invalid", "Move this agent before resolving source updates.");
    return this.apply(entry, record, await this.authorized(agentId, "move", record), true);
  }

  private async apply(entry: AgentEntry, record: SourceRecord, authority: SourceAuthority, moving: boolean): Promise<AgentEntry> {
    if (!record.enabled || !record.snapshot) throw new ApiError("agent_not_runnable", "Sync a complete setup before moving this agent.");
    if (record.attempt?.blockers.length) throw new ApiError("agent_not_runnable", record.attempt.blockers.map(item => item.message).join(" "));
    const snapshot = await this.options.read(entry.agent.id, record.snapshot);
    if (!snapshot.complete || snapshot.blockers.length || snapshot.digest !== record.snapshot || !matches(snapshot.source, record.source)) throw new ApiError("agent_not_runnable", "The source snapshot is incomplete or does not match its published manifest. Sync again.");
    const prepared = await this.options.prepare(entry, snapshot);
    await this.options.verifyDestination?.(entry, snapshot, prepared);
    const body = prepared.revision.body as AgenticBody;
    if (prepared.revision.kind !== "agentic" || !isObject(body) || body.native || body.sdk || body.cli_learning) throw new TypeError("Move prepares an independent managed agentic revision");
    const previous = sourceSyncOf(entry.revision!.body);
    const next: NewRevision = { ...prepared.revision, id: uuidv7(), body: { ...body, sourceSync: {
      id: record.id, snapshot: record.snapshot,
      // A separately published managed project checkpoint is a server edit. Configuration sync must not reset it.
      project: !moving && previous?.project !== previous?.snapshot ? previous!.project : record.snapshot,
      configuration: configurationDigest(body),
    } } };
    try {
      await this.store.agents.addRevision({ ...next, agentId: entry.agent.id, ifCurrent: entry.revision!.id,
        ...(moving ? { ifNoActiveRuns: true as const } : {}), settingsGuards: [this.guard(record), ...authority.guards, ...(prepared.guards ?? [])], mcpGuards: prepared.mcpGuards });
    } catch (error) {
      if (error instanceof ActiveRuns) throw new ApiError("agent_not_runnable", "Finish this agent's active runs before moving it to AgentRun.");
      if (error instanceof RevisionMoved) throw busy();
      throw error;
    }
    return (await this.entry(entry.agent.id));
  }
}
