// SqliteStore: the Store (store.ts) on one SQLite file, through the one connection (connection.ts, on its worker thread).
// The only code with SQL in it, besides the schema and the run patch. The file is on local disk, never on Archil: one
// connection per process, and SQLite's one writer lock serializes the server's and every runner's commits. A unit of work
// with more than one statement is one transaction (connection.transaction, BEGIN IMMEDIATE): all of it or none of it.
// The domain code below (the SqliteStore class, storeOver) is written once for SQLite and Postgres (a Postgres store opens
// it on its own connection): what differs, and the locks Postgres's many writers take, is the connection's Dialect (store/dialect.ts).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backfillNativeCommandOwners, nativeCommandOwner, validConnectorId } from '../native-command-owner.js';
import { watchCommandsAt, wakeCommands } from "../command-wake.js";
import { claimFence, storeNow, type StoreNow } from "../fence.js";
import { JOURNAL_FIRST_ID, RunStorage } from "../journal/storage.js";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { COMMANDS_ONE_ANSWER, COMPUTER_INTERVALS, COMPUTER_INTERVALS_ADDED, COMPUTER_INTERVALS_RUN, DDL, diskUpgrade, HAND_BACKS, HAND_BACKS_AT, HAND_BACKS_KEPT_MS, HAND_BACKS_RUN, IMPORTED_TEMPLATES, listingUpgrade, MINTED_TOKENS, purgeUpgrade, relayUpgrade, NATIVE_COMMANDS_INDEX, PI_TABLE, PI_TABLES, REVISIONS_MCP_PIN, REVISIONS_MONID_PIN, RUN_ATTEMPTS, RUNNERS, RUNNERS_ADDED, RUNS_COST_UPPER_BOUND, RUNS_LABELS, SCHEMA_VERSION, SETTLED_LIST_STATUS, TRIGGERS_TEMPLATE_ID } from "../schema.js";
import {
  ActiveRuns, AgentArchived, AgentDeleting, AgentPurged, CommandTaken, ExternalBodyConflict, Fenced, RunFinal, RunPurged, RunsMadeFromLeft, SchemaVersionUnknown, STORE_WRITE_DEADLINE_MS, StoreAwaitsServer, StoreBusy, StoreConstraint, StoreFromEarlierVersion, TriggerFull, TriggersLeft, UPLOAD_PREFIX, type AgentRow, type Agents,
  type Claim, type Command, type FiringRow, type FiringStatus, type ImportRunInput, type Journal, type NewRevision, type RevisionRow, type RunRow, type Runs,
  type JournalReads, type KeptListing, type LaunchSealedWrite, type RunLabels, type UpdatedRun,
  type ReleasedState, type RunState, type SecureRewriteOptions, type Store, type StoreRole, type TemplatePackage, type Templates, type TriggerDef, type TriggerPatch, type TriggerRow, type Triggers, type TriggerScope,
  FINAL_STATES, MCP_REFRESH_CALL_MS, MCP_REFRESH_LEASE_MS, type Learning, type LearningProposal, type LearningSpend, type Live, type LiveRow, type LiveViewerRow, type LiveViewers, type Mcp, type McpCredentialMark, type McpPinRow, type McpRemoved, type McpServerRow, type McpServerWrite, type McpTokensMark, type McpOwnersMark,
  type McpOauth, type McpOauthPendingRow, type SealedKeyRow, type SealedKeys, type SealedSecretRow, type SealedSecrets, type Settings, type SettingRow, type TriggerSettingRow, type TriggerSettings, type Channels, type ChannelAttemptRow, type ChannelPostRow,
  RevisionMoved, SignInHandedTo, SignInMissing, type SignIns, type SignInRow, type SignInTombstoneRow, type ViewerKind,
  type AttemptCause, type ComputerIntervalRow, type ComputerIntervals, type RunAttemptRow, type RunAttempts, type ComputerLedger, type ComputerLedgerRow, type PairedComputerRow, type PairedComputers, RUN_CHANGES_PAGE, type RunChangeCursor,
  type ImportedTemplates, type MintedTokenRow, type MintedTokens, type SecureRewrite, type SettingsGuard, type McpGuard,
  RUNNER_ROWS_KEPT_MS, type RunnerRow, type Runners, tombstoneMetrics,
} from "../store.js";

/** The run a launch body is made from (Runs.madeFrom): the run whose input it replays (`replay.of`) or audits (`audit.of`). */
const madeOf = (body: unknown): string | undefined => {
  for (const link of ["replay", "audit"] as const) {
    const of = (body as Record<string, { of?: unknown } | null | undefined> | null)?.[link]?.of;
    if (typeof of === "string") return of;
  }
  return undefined;
};

/** The seq a run-change cursor names (Runs.changedSince): only a cursor this store handed back, a whole number. */
const seqOf = (cursor: RunChangeCursor): number => {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(cursor)) throw new TypeError(`${JSON.stringify(cursor)} is not a run-change cursor this store gave`);
  return Number(cursor);
};
import { cleanText, type Dialect, settledBody } from "../dialect.js";
import { inMemory } from "./memory.js";
import { Connection, DEFAULT_BUSY_TIMEOUT_MS, type SqliteExecutor, type SqliteValue, type Statement, type StoreConnection, type Tx } from "./connection.js";
import { applyRunPatch, EXACT_COST_USD, NOT_A_LEARNING_RUN, refuseLeftovers, REOPEN_SET, reopenableWhere, RUN_COLUMNS, runOf, SIGN_IN_HANDED_LOCK, type RunRecord } from "./run-patch.js";
import { launchDiskOf, readableJson,readLaunch, readLearningStarts, readSeededBefore, readUsageMetadata, writeLaunch, writeLaunchSealed } from "./run-launch.js";
import { canonical } from "../agent-body.js";
import { readProjectCheckpoints } from "./project-checkpoints.js";
import { aadOf, sealedAt } from "../seal.js";

/** Registry writers UPDATE/DELETE this same row, so a prepared cutover and a credential/catalog edit serialize. */
async function checkMcpGuards(tx: SqliteExecutor, d: Dialect, guards: readonly McpGuard[] = []): Promise<void> {
  const names = [...new Set(guards.map(guard => guard.name))].sort();
  for (const name of names) await d.lockRow(tx, "mcp_servers", "name", name);
  for (const guard of guards) {
    const row = await tx.get<{ url: string; auth: string; credential_changed_at: number | null; tools: string; sealed: Uint8Array | null }>(
      "SELECT url, auth, credential_changed_at, tools, sealed FROM mcp_servers WHERE name = ?", guard.name);
    const sameSealed = row !== undefined && (row.sealed === null || guard.sealed === null
      ? row.sealed === guard.sealed : Buffer.from(row.sealed).equals(Buffer.from(guard.sealed)));
    if (!row || row.url !== guard.url || row.auth !== guard.auth || row.credential_changed_at !== guard.credentialChangedAt
      || canonical(JSON.parse(row.tools)) !== canonical(guard.tools) || !sameSealed)
      throw new StoreConstraint("An MCP server changed before the revision was saved. Prepare its tools and credentials again.");
  }
}

/** Source authorization and admission share one transaction. Keep the settings locks before any agent/trigger/run
 * lock, in stable key order, so revocation either commits first and refuses admission or follows its completed write. */
async function checkSettingsGuards(tx: SqliteExecutor, guards: readonly SettingsGuard[] = [], message = "The source grant changed before the write committed.", alsoLock: readonly string[] = []): Promise<void> {
  const byKey = new Map<string, SettingsGuard[]>();
  for (const guard of guards) byKey.set(guard.key, [...(byKey.get(guard.key) ?? []), guard]);
  for (const key of [...new Set([...byKey.keys(), ...alsoLock])].sort((a, b) => a.localeCompare(b))) {
    const setting = await tx.get<{ value: string }>("UPDATE settings SET value = value WHERE key = ? RETURNING value", key);
    const value = setting === undefined ? undefined : JSON.parse(setting.value);
    if ((byKey.get(key) ?? []).some(guard => !value || Object.entries(guard.fields).some(([field, expected]) => JSON.stringify(value[field]) !== JSON.stringify(expected)))) {
      throw new StoreConstraint(message);
    }
  }
}

/** A claim's length when the caller names none. */
export const DEFAULT_LEASE_MS = 30_000;

/** The store's file in its data directory: only the store names it. */
export const STORE_FILE = "store.sqlite";

export type SqliteStoreOptions = (
  /** The data directory (the server's and every runner's): the store's file is STORE_FILE in it. */
  | { dataDir: string; file?: never }
  /** A store file named outright: the store's own tests. */
  | { file: string; dataDir?: never }
) & {
  /** Who opens it (StoreRole): the server sets the schema up and holds the owner lock; a runner only checks the version. */
  role?: StoreRole;
  /** The store's clock, in ms (Date.now): claimed_until and every row's time. */
  now?: () => number;
  /** How long a write waits for another process's lock before StoreBusy. */
  busyTimeoutMs?: number;
};

type AgentRecord = { id: string; name: string; description: string | null; current_revision: string | null; created_at: number; archived_at: number | null; external_ref: string | null; purged_at: number | null };
type RevisionRecord = { id: string; agent_id: string; parent_id: string | null; kind: string; body: string; skills: string | null; note: string | null; package: string | null; created_at: number; external_version: string | null; mcp_pin: string | null; monid_pin: string | null };
type CommandRecord = { id: number; run_id: string; kind: string; body: string; created_at: number; taken_at: number | null; refused: string | null; tries: number };
type TriggerRecord = {
  id: string; agent_id: string; name: string; enabled: number; source: string; target: string; next_at: number | null; last_run_id: string | null;
  catchup_window_s: number | null; failures_in_a_row: number; disabled: string | null; max_active_runs: number | null; created_at: number; updated_at: number;
  template_id: string | null;
};
type FiringRecord = {
  trigger_id: string; key: string; by: string | null; nominal_at: number | null; status: FiringStatus; at: number; run_id: string | null; reason: string | null;
  error: string | null; count: number | null; attempts: number; retry_at: number | null; payload: string | null; attrs: string | null; notified: number | null;
  catch_up: number | null; paused: number | null; shown: number | null; waits_on: string | null;
};
/** No audit's shadow run (learn/audit.ts SHADOW_PREFIX "audit."): the prefix compared as it is, which LIKE does not on
 *  SQLite (it folds case). */
const NOT_A_SHADOW_RUN = "substr(runs.id, 1, 6) <> 'audit.'";
/** A runner holds the run's claim at `now` (SQL), and the run is not over. */
const heldAt = (now: string) => `(runs.runner IS NOT NULL AND runs.claimed_until >= ${now} AND runs.state NOT IN ('ended', 'stopped', 'failed'))`;
/** The run's listing is behind at `now` (SQL; its parameters twice, `params`): built before the latest write that moved
 *  what its view shows, or while a runner held it and that claim has run out, or past the time an ask it waits on expires. */
const listingBehind = (now: string) => ({
  sql: `(runs.listing_mark < runs.list_mark OR (runs.listing_live = 1 AND NOT ${heldAt(now)}) OR (runs.listing_until IS NOT NULL AND runs.listing_until <= ${now}))`,
  params: (at: readonly SqliteValue[]): SqliteValue[] => [...at, ...at],
});
const FIRING_COLUMNS = "trigger_id, key, by, nominal_at, status, at, run_id, reason, error, count, attempts, retry_at, payload, attrs, notified, catch_up, paused, shown, waits_on";
/** A sent firing's retry_at is its startBy (settle's one exception), never a retry. */
const firingOf = (r: FiringRecord): FiringRow => ({
  triggerId: r.trigger_id, key: r.key, by: r.by ?? "manual", nominalAt: r.nominal_at ?? r.at, status: r.status, at: r.at, runId: r.run_id, reason: r.reason,
  error: r.error === null ? null : JSON.parse(r.error), count: r.count, attempts: r.attempts, retryAt: r.status === "sent" ? null : r.retry_at,
  startBy: r.status === "sent" ? r.retry_at : null, payload: r.payload,
  attrs: r.attrs === null ? null : JSON.parse(r.attrs), notified: r.notified === 1, catchUp: r.catch_up === 1, paused: r.paused === 1, shown: r.shown !== 0, waitsOn: r.waits_on,
});
/** The trigger's patch as columns: name -> [column, value]. */
const TRIGGER_PATCH: { [K in keyof TriggerPatch]-?: (value: NonNullable<TriggerPatch[K]> | null) => [string, SqliteValue] } = {
  agentId: (v) => ["agent_id", v],
  name: (v) => ["name", v],
  enabled: (v) => ["enabled", v ? 1 : 0],
  source: (v) => ["source", json(v)],
  target: (v) => ["target", json(v)],
  nextAt: (v) => ["next_at", v],
  catchupWindowS: (v) => ["catchup_window_s", v],
  failuresInARow: (v) => ["failures_in_a_row", v ?? 0],
  disabled: (v) => ["disabled", v === null ? null : json(v)],
  maxActiveRuns: (v) => ["max_active_runs", v],
  templateId: (v) => ["template_id", v],
};
/** `patch`'s columns, `updated_at` with them: the SET clause and its values. */
function triggerSet(patch: TriggerPatch, at: number): { set: string; params: SqliteValue[] } {
  const pairs = (Object.keys(patch) as (keyof TriggerPatch)[]).filter((k) => patch[k] !== undefined).map((k) => (TRIGGER_PATCH[k] as (v: unknown) => [string, SqliteValue])(patch[k] as unknown));
  pairs.push(["updated_at", at]);
  return { set: pairs.map(([column]) => `${column} = ?`).join(", "), params: pairs.map(([, value]) => value) };
}

const AGENT_COLUMNS = "id, name, description, current_revision, created_at, archived_at, external_ref, purged_at";
const REVISION_COLUMNS = "id, agent_id, parent_id, kind, body, skills, note, package, created_at, external_version, mcp_pin, monid_pin";
const COMMAND_COLUMNS = "id, run_id, kind, body, created_at, taken_at, refused, tries";
const TRIGGER_COLUMNS = "id, agent_id, name, enabled, source, target, next_at, last_run_id, catchup_window_s, failures_in_a_row, disabled, max_active_runs, created_at, updated_at, template_id";
const FINAL = FINAL_STATES.map((state) => `'${state}'`).join(", ");
/** Firing `f` (the alias) is one its launch hook's host took with no run yet, inside its start window: its startBy, kept in
 *  retry_at, not passed at the `?` it binds (the triggers' clock). It holds its trigger's room as a run in progress
 *  (activeRuns, waiting's free, held) and stays in the history (prune). */
const holdsRoom = (f: string): string => `(${f}.status = 'sent' AND ${f}.run_id IS NULL AND ${f}.retry_at IS NOT NULL AND ${f}.retry_at >= ?)`;
/** Firing `f` is one of its trigger's runs in progress: started with run `r` (the alias of its LEFT JOINed run) not ended,
 *  or holding the room (holdsRoom, its one `?`). */
const inProgress = (f: string, r: string): string => `((${f}.status = 'started' AND ${r}.state NOT IN (${FINAL})) OR ${holdsRoom(f)})`;
/** An ended run, not imported, whose stored cost is unknown: null with no bound beside it (cost_upper_bound 0, never NULL).
 *  What Runs.healCost writes over and Runs.costUnknown lists. */
const COST_UNKNOWN = `cost_usd IS NULL AND cost_upper_bound = 0 AND state IN (${FINAL}) AND imported_from IS NULL AND ended_at IS NOT NULL`;
/** Taken (Dialect.lockKey) by every insert of a run's command row, before it: the run's rows commit in id order, as
 *  SQLite's one writer commits them. On Postgres an id is taken at the insert and the row is seen at its commit, so two
 *  inserts at once could commit out of order, and a reader of the rows past the last id it handed on (the runner) would
 *  never see the lower one. */
const lockCommandsOf = (tx: Tx, runId: string): Promise<void> => tx.dialect.lockKey(tx, `commands:${runId}`);
/** The runs a runner may claim, at the deadlines' clock `n` (fence.ts storeNow), read five times: queued; running with no runner (released) or
 *  its claim run out, once its backoff (an interrupted run's) has passed; parked, once no claim holds it (a run parks
 *  under its claim and is released a few seconds later), with its wake_at passed, an untaken stop or cancel, or an untaken command
 *  that can answer it once its backoff (a failed resume's) has passed. A row marked `answers: false` (a trigger's
 *  follow-up message) answers no park: it waits, untaken, and its loop gets it after the person's answer wakes the run. */
const claimableIn = (d: Dialect, n: StoreNow): { sql: string; params: SqliteValue[] } => ({
  sql: `(state = 'queued'
  OR (state = 'running' AND (runner IS NULL OR claimed_until < ${n.sql}) AND (backoff_until IS NULL OR backoff_until <= ${n.sql}))
  OR (state = 'parked' AND (runner IS NULL OR claimed_until < ${n.sql}) AND (
    (wake_at IS NOT NULL AND wake_at <= ${n.sql})
    OR EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.taken_at IS NULL AND commands.kind IN ('stop', 'cancel'))
    OR ((backoff_until IS NULL OR backoff_until <= ${n.sql}) AND EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.taken_at IS NULL
      AND ${d.jsonNotFalse(readableJson(d, "commands.body"), ["answers"])})))))`,
  params: [...n.params, ...n.params, ...n.params, ...n.params, ...n.params],
});
/** What a claim sets: the next epoch, the runner and its lease (from `n`, the deadlines' clock, plus a lease in ms), running,
 *  no backoff. Binds the runner, `n`'s parameters, then the lease. */
const claimSet = (n: StoreNow): string => `epoch = epoch + 1, runner = ?, claimed_until = ${n.sql} + ?, state = 'running', backoff_until = NULL`;

/** A write under `claim` that keeps the run's epoch (a take, a retry, a pin; the journal's commit does the same): holds the
 *  run's row shared (dialect shareLock), so a write that moves the epoch waits for it and a renew never does, then checks
 *  the claim's fence on the store's clock read once the row is held. Fenced when the claim no longer holds the run.
 *  Returns that clock reading. */
async function underClaim(tx: Tx, claim: Claim, now: () => number): Promise<number> {
  await tx.run(`SELECT 1 FROM runs WHERE id = ?${tx.dialect.shareLock}`, claim.runId);
  const at = now();
  const fence = claimFence(claim, storeNow(tx.dialect, () => at));
  if ((await tx.get(`SELECT 1 AS held FROM runs WHERE ${fence.where}`, ...fence.params)) === undefined) throw new Fenced(claim.runId, claim.epoch);
  return at;
}

const agentOf = (r: AgentRecord): AgentRow => ({ id: r.id, name: r.name, description: r.description, currentRevision: r.current_revision, createdAt: r.created_at, archivedAt: r.archived_at, externalRef: r.external_ref, purgedAt: r.purged_at ?? null });
const revisionOf = (r: RevisionRecord): RevisionRow => ({
  id: r.id, agentId: r.agent_id, parent: r.parent_id, kind: r.kind, body: JSON.parse(r.body), skills: r.skills === null ? null : JSON.parse(r.skills),
  note: r.note, package: r.package === null ? null : (JSON.parse(r.package) as TemplatePackage), createdAt: r.created_at, externalVersion: r.external_version,
  mcpPin: r.mcp_pin === null ? null : JSON.parse(r.mcp_pin), monidPin: r.monid_pin === null ? null : JSON.parse(r.monid_pin),
});
const commandOf = (r: CommandRecord): Command => ({ id: r.id, runId: r.run_id, kind: r.kind, body: JSON.parse(r.body), createdAt: r.created_at, takenAt: r.taken_at, refused: r.refused, tries: r.tries });
const triggerOf = (r: TriggerRecord): TriggerRow => ({
  id: r.id, agentId: r.agent_id, name: r.name, enabled: r.enabled === 1, source: JSON.parse(r.source), target: JSON.parse(r.target), nextAt: r.next_at, lastRunId: r.last_run_id,
  catchupWindowS: r.catchup_window_s, failuresInARow: r.failures_in_a_row, disabled: r.disabled === null ? null : JSON.parse(r.disabled), maxActiveRuns: r.max_active_runs,
  createdAt: r.created_at, updatedAt: r.updated_at, templateId: r.template_id ?? null,
});
const json = (value: unknown): string => JSON.stringify(value ?? null);
/** A UTF-16 surrogate standing alone (in `u` mode a whole pair is one code point, so only a lone half matches). */
const LONE_SURROGATE = /[\ud800-\udfff]/u;
/** A run's labels as its column holds them: keys sorted, so the same labels are the same text; null for none. A key or value
 *  holding a lone surrogate is refused (TypeError), nothing written: JSON.stringify keeps it as a `\ud800` escape that
 *  Postgres' json check takes but json_each_text cannot decode, so every later label search scanning the run would fail. */
const labelsColumn = (labels: RunLabels | undefined): string | null => {
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (LONE_SURROGATE.test(key) || LONE_SURROGATE.test(value)) throw new TypeError(`a run's label ${JSON.stringify(key)} holds a lone UTF-16 surrogate: a label is whole Unicode characters`);
  }
  const keys = Object.keys(labels ?? {}).sort();
  return keys.length === 0 ? null : JSON.stringify(Object.fromEntries(keys.map((key) => [key, labels![key]])));
};
/** A revision's MCP pin as its column keeps it: JSON, or null for none. */
const pinText = (pin: unknown): string | null => (pin === undefined || pin === null ? null : JSON.stringify(pin));

type McpServerRecord = {
  name: string; url: string; auth: string; protocol: string | null; tools: string; prices: string; server_info: string | null; instructions: string | null; sealed: Uint8Array | null;
  refresh_holder: string | null; refresh_until: number | null; created_at: number; updated_at: number; listed_at: number | null; credential_changed_at: number | null; token_until: number | null;
};
const removedOf = (r: { url: string; sealed: Uint8Array | null } | undefined): McpRemoved | undefined => r && { url: r.url, sealed: r.sealed === null ? null : Uint8Array.from(r.sealed) };
type McpPinRecord = { run_id: string; mcp_pin: string; created_at: number };
const MCP_SERVER_COLUMNS = "name, url, auth, protocol, tools, prices, server_info, instructions, sealed, refresh_holder, refresh_until, created_at, updated_at, listed_at, credential_changed_at, token_until";
/** The columns of an MCP server row read at the deadlines' clock `n` (fence.ts storeNow) in the same statement: `read_at`,
 *  the clock the row's refresh lease and token end are judged by (mcpServerOf). Binds `n`'s parameters. */
const mcpServerColumnsAt = (n: StoreNow): string => `${MCP_SERVER_COLUMNS}, ${n.sql} AS read_at`;
/** The row as read at `at` (its read_at, the deadlines' clock: the database's on Postgres, the store's on SQLite): its
 *  refresh lease judged by that clock (refreshLapsed), the one leaseRefresh writes and grants it by, with its rule: a
 *  lease has run out once its refresh_until is before now; its token's time left (tokenLeftMs) by the same clock. */
const mcpServerOf = (r: McpServerRecord, at: number = Number((r as McpServerRecord & { read_at?: number }).read_at)): McpServerRow => ({
  name: r.name, url: r.url, auth: r.auth, protocol: r.protocol, tools: JSON.parse(r.tools), prices: JSON.parse(r.prices),
  serverInfo: r.server_info === null ? null : JSON.parse(r.server_info), instructions: r.instructions,
  sealed: r.sealed === null ? null : Uint8Array.from(r.sealed), refreshHolder: r.refresh_holder, refreshUntil: r.refresh_until,
  refreshLapsed: r.refresh_until !== null && r.refresh_until < at,
  tokenLeftMs: r.token_until === null ? null : r.token_until - at,
  tokenUntil: r.token_until === null ? null : Number(r.token_until),
  createdAt: r.created_at, updatedAt: r.updated_at, listedAt: r.listed_at, credentialChangedAt: r.credential_changed_at,
});
const mcpPinOf = (r: McpPinRecord): McpPinRow => ({ runId: r.run_id, body: JSON.parse(r.mcp_pin), pinnedAt: Number(r.created_at) });

type SettingRecord = { key: string; value: string; updated_at: number };
const settingOf = (r: SettingRecord): SettingRow => ({ key: r.key, value: JSON.parse(r.value), updatedAt: r.updated_at });
type SealedKeyRecord = { name: string; sealed: Uint8Array; updated_at: number };
const sealedKeyOf = (r: SealedKeyRecord): SealedKeyRow => ({ name: r.name, sealed: Uint8Array.from(r.sealed), updatedAt: r.updated_at });
type ComputerLedgerRecord = { provider: string; session_id: string; labels: string; detail: string; updated_at: number };
type ComputerIntervalRecord = { run_id: string; provider: string; provider_id: string; kind: string | null; gpu_type: string | null; gpu_count: number | string | null; cpus: number | string | null; memory_mb: number | string | null; disk_gb: number | string | null; started_at: number | string; kept: number | string; ended_at: number | string | null; booked_ms: number | string };
const orNull = (value: number | string | null): number | null => (value === null ? null : Number(value));
type RunAttemptRecord = { run_id: string; epoch: number | string; turn: number | string; attempt: number | string; cause: string | null; cut: string | null; runner: string; from_state: string; journal_from: number | string; claimed_at: number | string };
const attemptOf = (r: RunAttemptRecord): RunAttemptRow => ({
  runId: r.run_id, epoch: Number(r.epoch), turn: Number(r.turn), attempt: Number(r.attempt), cause: r.cause as AttemptCause | null, cut: r.cut as RunAttemptRow["cut"],
  runner: r.runner, from: r.from_state as RunState, journalFrom: Number(r.journal_from), claimedAt: Number(r.claimed_at),
});

const intervalOf = (r: ComputerIntervalRecord): ComputerIntervalRow => ({
  runId: r.run_id, provider: r.provider, providerId: r.provider_id, kind: r.kind, gpuType: r.gpu_type, gpuCount: orNull(r.gpu_count), cpus: orNull(r.cpus),
  memoryMb: orNull(r.memory_mb), diskGb: orNull(r.disk_gb), startedAt: Number(r.started_at), kept: Number(r.kept) === 1, endedAt: orNull(r.ended_at), bookedMs: Number(r.booked_ms),
});
const ledgerRowOf = (r: ComputerLedgerRecord): ComputerLedgerRow => ({ provider: r.provider, sessionId: r.session_id, labels: JSON.parse(r.labels), detail: JSON.parse(r.detail), updatedAt: r.updated_at });
type ImportedTemplateRecord = { id: string; source: string; sha: string; publisher: string; files: string; imported_at: number };
type PairedRecord = { id: string; name: string; hello: string; driver: string; labels: string; pairing_id: string; created_at: number; seen_at: number | null; revoked_at: number | null };
const pairedOf = (r: PairedRecord): PairedComputerRow => ({ id: r.id, name: r.name, hello: JSON.parse(r.hello), driver: r.driver, labels: JSON.parse(r.labels), pairingId: r.pairing_id, createdAt: r.created_at, seenAt: r.seen_at, revokedAt: r.revoked_at });
type MintedRecord = { machine: string; kind: string; os: string; arch: string; expires_at: number; revoked_at: number | null; created_at: number; runner: string | null; incarnation: string | null; run: string | null; refused: string | null };
const mintedOf = (r: MintedRecord): MintedTokenRow => ({ machine: r.machine, kind: r.kind, os: r.os, arch: r.arch, expiresAt: r.expires_at, revokedAt: r.revoked_at, createdAt: r.created_at, runner: r.runner, incarnation: r.incarnation, run: r.run, refused: r.refused });
type RunnerRecord = { runner: string; incarnation: string; refused: string | null; host: string | null; port: number | string | null; seen_at: number | string; version: string | null; slots: number | string | null };
const runnerOf = (r: RunnerRecord): RunnerRow => ({ runner: r.runner, incarnation: r.incarnation, refused: r.refused, host: r.host, port: r.port === null ? null : Number(r.port), seenAt: Number(r.seen_at), version: r.version, slots: r.slots === null ? null : Number(r.slots) });
type TriggerSettingRecord = { adapter: string; scope: string; field: string; sealed: string; updated_at: number };
const triggerSettingOf = (r: TriggerSettingRecord): TriggerSettingRow => ({ adapter: r.adapter, scope: r.scope, field: r.field, sealed: r.sealed, updatedAt: r.updated_at });
type McpOauthRecord = { state: string; server: string; sealed: Uint8Array; working: string | null; expires_at: number };
const mcpOauthOf = (r: McpOauthRecord): McpOauthPendingRow => ({ state: r.state, server: r.server, sealed: Uint8Array.from(r.sealed), working: r.working === null ? null : JSON.parse(r.working), expiresAt: r.expires_at });
type SignInRecord = { agent_id: string; provider: string; name: string; pointer_sealed: Uint8Array; saved_at: number; save: number; verified_at: number | null };
const SIGN_IN_COLUMNS = "agent_id, provider, name, pointer_sealed, saved_at, save, verified_at";
const signInOf = (r: SignInRecord): SignInRow => ({ agentId: r.agent_id, provider: r.provider, name: r.name, pointerSealed: Uint8Array.from(r.pointer_sealed), savedAt: r.saved_at, save: r.save, verifiedAt: r.verified_at });
type SignInTombstoneRecord = { agent_id: string; provider: string; pointer_sealed: Uint8Array; forgotten_at: number };
const signInTombstoneOf = (r: SignInTombstoneRecord): SignInTombstoneRow => ({ agentId: r.agent_id, provider: r.provider, pointerSealed: Uint8Array.from(r.pointer_sealed), forgottenAt: r.forgotten_at });

/** The store's schema version as the file holds it: null when the server has not set it up (no store_meta yet). */
async function versionOf(db: Connection): Promise<number | null> {
  const table = await db.get<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'store_meta'");
  if (!table) return null;
  return (await db.get<{ schema_version: number }>("SELECT schema_version FROM store_meta WHERE singleton = 1"))?.schema_version ?? null;
}

/** The files an earlier version kept at a data directory's top that this version no longer writes: its MCP servers,
 *  triggers, tool keys and trigger secrets (all in the store now), and the per-run door's token (the per-run door is
 *  gone). This version's own top-level files are not among them, so a directory holding them opens: .token and
 *  .server.json beside the store and its lock, a leftover box-image.json, and the files this version still keeps beside
 *  the store in the same format an earlier version did (the kept idempotency answers and the learning usage ledger),
 *  which an earlier version's copy of reads the same. A webhook config and outbox an earlier build kept beside the store
 *  (webhook.json, webhook-outbox.json) do not refuse the directory either: nothing reads them, and the webhook, now in
 *  the store, is set again. */
const EARLIER_ROOT_FILES = ["mcp-servers.json", "triggers.json", "tool-keys.json", "trigger-secrets.json", ".door-token"];

/** The columns a runner of this build needs that an earlier build of this same version may not have: the server adds each
 *  at its start (openSqliteStore), and a runner on a file without one waits for that server (StoreAwaitsServer, in `why`'s
 *  words; exit 3). store-schema reads the same list, so its report says "waits" where the runner would. */
export const SQLITE_RUNNER_NEEDS: readonly { readonly table: string; readonly columns: readonly string[]; readonly why: string }[] = [
  { table: "revisions", columns: ["mcp_pin", "monid_pin"], why: "install MCP and Monid revision metadata" },
  { table: "settings", columns: ["connector_id"], why: "add native command ownership metadata" },
  { table: "runs", columns: ["cost_upper_bound"], why: "add the bound beside each run's cost" },
  { table: "runs", columns: ["labels"], why: "add each run's labels" },
  { table: "triggers", columns: ["template_id"], why: "add each trigger's package mark" },
  { table: "runners", columns: ["host"], why: "keep each runner's word that it is there and its relay in one table (runners)" },
  { table: "runners", columns: Object.keys(RUNNERS_ADDED), why: "keep each runner's version and slots, and each hand-back (runners.version, runners.slots, hand_backs)" },
  { table: "hand_backs", columns: ["run_id"], why: "keep each runner's version and slots, and each hand-back (runners.version, runners.slots, hand_backs)" },
  { table: "run_attempts", columns: ["run_id"], why: "keep each claim's turn and attempt (run_attempts)" },
];

/** What a runner of this build waits for on a file of this version (SQLITE_RUNNER_NEEDS' first missing column's `why`),
 *  or undefined when it opens; `columnsOf` reads a table's columns. */
export async function runnerWaitsFor(columnsOf: (table: string) => Promise<ReadonlySet<string>> | ReadonlySet<string>): Promise<string | undefined> {
  for (const need of SQLITE_RUNNER_NEEDS) {
    const present = await columnsOf(need.table);
    if (need.columns.some((column) => !present.has(column))) return need.why;
  }
  return undefined;
}

/** The files an earlier version kept in a data directory, relative to it: its store (a STORE_FILE with tables and no
 *  store_meta row), agent homes (<agent>/agent.sqlite, agents/<agent>/agent.sqlite), run databases (runs/<run>/run.sqlite,
 *  disk/agents/<agent>/runs/<run>/run.sqlite), its settings files (EARLIER_ROOT_FILES) and its homes' sign-ins
 *  (homes/<home>/sign-ins/sign-ins.json). Read only: nothing is opened for writing or made. The store is read before
 *  this server holds its owner lock, so it waits `busyTimeoutMs` for another process's lock on it (isThisVersionsStore). */
export function earlierVersionIn(dataDir: string, busyTimeoutMs: number): string[] {
  if (!existsSync(dataDir)) return [];
  const found: string[] = [];
  // A path the server may not look into is not an earlier version's: that version wrote its files as the server's own
  // user. A disk mounted as the data directory has one such, lost+found (root's, mode 700).
  const stat = (path: string) => {
    try {
      return statSync(path, { throwIfNoEntry: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") return undefined;
      throw error;
    }
  };
  const isFile = (path: string) => stat(path)?.isFile() === true;
  // A directory linked in counts as one (stat follows the link), as the server's check of old homes reads them: an
  // earlier version's home or run kept elsewhere and linked in is still the earlier version's.
  const isDir = (path: string) => stat(path)?.isDirectory() === true;
  const dirsIn = (path: string) => {
    if (!isDir(path)) return [];
    try {
      return readdirSync(path).filter((name) => isDir(join(path, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") return [];
      throw error;
    }
  };
  const store = join(dataDir, STORE_FILE);
  if (isFile(store) && !isThisVersionsStore(store, busyTimeoutMs)) found.push(STORE_FILE);
  for (const name of EARLIER_ROOT_FILES) if (isFile(join(dataDir, name))) found.push(name);
  for (const home of dirsIn(join(dataDir, "homes"))) {
    const signIns = join("homes", home, "sign-ins", "sign-ins.json");
    if (isFile(join(dataDir, signIns))) found.push(signIns);
  }
  for (const agent of dirsIn(dataDir)) if (isFile(join(dataDir, agent, "agent.sqlite"))) found.push(join(agent, "agent.sqlite"));
  for (const agent of dirsIn(join(dataDir, "agents"))) if (isFile(join(dataDir, "agents", agent, "agent.sqlite"))) found.push(join("agents", agent, "agent.sqlite"));
  for (const run of dirsIn(join(dataDir, "runs"))) if (isFile(join(dataDir, "runs", run, "run.sqlite"))) found.push(join("runs", run, "run.sqlite"));
  for (const agent of dirsIn(join(dataDir, "disk", "agents"))) {
    for (const run of dirsIn(join(dataDir, "disk", "agents", agent, "runs"))) {
      const file = join("disk", "agents", agent, "runs", run, "run.sqlite");
      if (isFile(join(dataDir, file))) found.push(file);
    }
  }
  return found.sort();
}

/** Whether `file` is this version's store, or one with nothing in it yet: an earlier one has tables and no store_meta.
 *  Read before the owner lock is taken, so the server this one replaces may still have the file open: its close (the last
 *  connection's checkpoint) holds the file locked for a moment, and a read with no busy wait is refused "database is
 *  locked", which no replaced-server wait retries. It waits `busyTimeoutMs` for that lock, as the store's connection does. */
function isThisVersionsStore(file: string, busyTimeoutMs: number): boolean {
  const db = new DatabaseSync(file, { readOnly: true, timeout: busyTimeoutMs });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[];
    if (tables.length === 0) return true;
    if (!tables.some((table) => table.name === "store_meta")) return false;
    return db.prepare("SELECT schema_version FROM store_meta WHERE singleton = 1").get() !== undefined;
  } finally {
    db.close();
  }
}

/** Opens the store in `dataDir` (its file is STORE_FILE there), or at `file` (the store's own tests). As the server (the
 *  default): makes the data directory, takes the owner lock (StoreOwned when another server holds it) and, on a store with
 *  no schema yet, sets schema SCHEMA_VERSION up in one durable commit. As a runner: makes and sets up nothing. Either
 *  refuses a schema version this build does not know (SchemaVersionUnknown); a runner refuses no schema (or no data
 *  directory) too, and a store this build's server has yet to upgrade (StoreAwaitsServer). */
export async function openSqliteStore(options: SqliteStoreOptions): Promise<Store> {
  // No in-memory store: a caller that names neither place (an undefined passed through) is refused before anything is
  // opened or made, never left to open a path built from "undefined" (its owner lock in the working directory).
  if (options.dataDir === undefined && (options as { file?: string }).file === undefined) {
    throw new TypeError("A store is opened in its data directory (dataDir) or at its file (file): neither was given, so nothing was opened or made.");
  }
  const role = options.role ?? "server";
  let file: string;
  if (options.dataDir !== undefined) {
    // The server makes its data directory; a runner opens only one that is there. No migration: a directory an earlier
    // version wrote is refused before anything in it is opened or made.
    if (role === "server") {
      const earlier = earlierVersionIn(options.dataDir, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      if (earlier.length > 0) throw new StoreFromEarlierVersion(options.dataDir, earlier);
      mkdirSync(options.dataDir, { recursive: true });
    }
    else if (!existsSync(options.dataDir)) throw new SchemaVersionUnknown(join(options.dataDir, STORE_FILE), null, SCHEMA_VERSION);
    file = join(options.dataDir, STORE_FILE);
  } else {
    file = options.file;
  }
  const connection = await Connection.open(file, { owner: role === "server", ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }) });
  try {
    let found = await versionOf(connection);
    if (found === null && role === "server") {
      await connection.write([...DDL.map((sql) => ({ sql })), { sql: "INSERT INTO store_meta (singleton, schema_version) VALUES (1, ?) ON CONFLICT (singleton) DO NOTHING", params: [SCHEMA_VERSION] }], { full: true });
      found = await versionOf(connection);
    }
    // Version 11 (0.1.0-beta.44 and before) keeps no listing on a run's row: the server adds it (schema.ts listingUpgrade)
    // in one durable write once the columns an earlier build of 11 lacked are in, every run behind until its lister builds
    // it. Version 12 names no minting runner on a machine's token and keeps no runner's relay: the server adds them
    // (schema.ts relayUpgrade). Version 13 keeps no purge time on a run or an agent: the server adds them (schema.ts
    // purgeUpgrade). Version 14 keeps no disk on a run: the server adds it and writes each run's from its launch (schema.ts
    // diskUpgrade). A runner refuses 11 to 14 until that server has.
    const upgrading = found === 11 || found === 12 || found === 13 || found === 14;
    if (upgrading && role === "runner") throw new StoreAwaitsServer(`bring this store from version ${found} to ${SCHEMA_VERSION}`);
    if (found !== SCHEMA_VERSION && !upgrading) throw new SchemaVersionUnknown(file, found, SCHEMA_VERSION);
    const columns = new Set((await connection.all<{ name: string }>("SELECT name FROM pragma_table_info('revisions')")).map((column) => column.name));
    // Every column a runner of this build needs that an earlier build of this version may lack (SQLITE_RUNNER_NEEDS), read
    // at once: the same list store-schema reports from. Each check below says the same, where the server adds it.
    if (role === "runner") {
      const waits = await runnerWaitsFor(async (table) => new Set((await connection.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((column) => column.name)));
      if (waits !== undefined) throw new StoreAwaitsServer(waits);
    }
    if (role === "runner" && (!columns.has("mcp_pin") || !columns.has("monid_pin"))) throw new StoreAwaitsServer("install MCP and Monid revision metadata");
    const nativeOwners=(await connection.all<{name:string}>("PRAGMA table_info(settings)")).some(column=>column.name==='connector_id');
    if(!nativeOwners){
      if(role==='runner')throw new StoreAwaitsServer('add native command ownership metadata');
      await connection.write([{sql:'ALTER TABLE settings ADD COLUMN connector_id TEXT'}],{full:true});
    }
    // An earlier build of this version kept no bound beside a run's cost (schema.ts RUNS_COST_UPPER_BOUND): the server adds
    // it, every run it ended reading 0, and a runner, which writes it at each end, waits for that server.
    const runColumns = new Set((await connection.all<{ name: string }>("SELECT name FROM pragma_table_info('runs')")).map((column) => column.name));
    if (!runColumns.has("cost_upper_bound")) {
      if (role === "runner") throw new StoreAwaitsServer("add the bound beside each run's cost");
      await connection.write([{ sql: RUNS_COST_UPPER_BOUND }], { full: true });
    }
    // An earlier build of this version kept no labels on a run (schema.ts RUNS_LABELS): the server adds the column, nullable,
    // every run it started reading as given none. A runner reads each run through it, so it waits for that server.
    if (!runColumns.has("labels")) {
      if (role === "runner") throw new StoreAwaitsServer("add each run's labels");
      await connection.write([{ sql: RUNS_LABELS }], { full: true });
    }
    // An earlier build of this version kept no package mark on a trigger (schema.ts TRIGGERS_TEMPLATE_ID): the server adds
    // the column, nullable, every trigger made before reading as no package's. A runner reads each trigger through it, so
    // it waits for that server.
    if (!(await connection.all<{ name: string }>("SELECT name FROM pragma_table_info('triggers')")).some((column) => column.name === "template_id")) {
      if (role === "runner") throw new StoreAwaitsServer("add each trigger's package mark");
      await connection.write([{ sql: TRIGGERS_TEMPLATE_ID }], { full: true });
    }
    // An earlier build of version 13 kept each runner's relay in a table of its own (runner_relays), which the server's
    // open below drops for runners (schema.ts RUNNERS). A runner says it is there, and where its relay answers, through
    // runners alone, so it waits for that server.
    const runnerColumns = new Set((await connection.all<{ name: string }>("SELECT name FROM pragma_table_info('runners')")).map((column) => column.name));
    if (role === "runner" && !runnerColumns.has("host")) {
      throw new StoreAwaitsServer("keep each runner's word that it is there and its relay in one table (runners)");
    }
    // An earlier build of this version kept no runner's version and slots (schema.ts RUNNERS_ADDED) and no hand-backs
    // (HAND_BACKS): a runner writes both (its presence, its releases), so it waits for the server that adds them below.
    if (role === "runner" && (Object.keys(RUNNERS_ADDED).some((column) => !runnerColumns.has(column)) || (await connection.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hand_backs'")).length === 0)) {
      throw new StoreAwaitsServer("keep each runner's version and slots, and each hand-back (runners.version, runners.slots, hand_backs)");
    }
    // A claim writes its turn and attempt (schema.ts RUN_ATTEMPTS) in its own transaction: a runner waits for the server
    // that adds the table.
    if (role === "runner" && (await connection.all<{ name: string }>("SELECT name FROM pragma_table_info('run_attempts')")).length === 0) {
      throw new StoreAwaitsServer("keep each claim's turn and attempt (run_attempts)");
    }
    // The per-run viewer table was renamed browser_viewers → computer_viewers (schema.ts). Its rows are ephemeral, so none
    // migrate; the server drops a stale browser_viewers an earlier build of this version left, so none lingers beside it.
    // An earlier build of this version made no one-answer index on commands (schema.ts COMMANDS_ONE_ANSWER), or one that
    // counted refused answers: the server rebuilds it, so a second answer to one approval is refused on every store. A
    // store such a build left may hold two unrefused answers to one approval: the earliest stands (the one the runner
    // acted on) and each later one is refused in the same write, before the index, so the store opens. None is deleted.
    // An earlier build of this version pinned each run's MCP tools at its first claim (mcp_pins) and kept no pin on a
    // revision: the server adds revisions.mcp_pin (schema.ts REVISIONS_MCP_PIN) and drops mcp_pins. A revision saved
    // before has no MCP pin until its first managed run here pins it (Agents.pinOnce); no run's pin moves to a revision.
    // Monid pins are also nullable revision metadata; adding the column infers no pin from a historical body.
    if (role === "server") {
      await connection.write([
        ...(columns.has("mcp_pin") ? [] : [{ sql: REVISIONS_MCP_PIN }]),
        ...(columns.has("monid_pin") ? [] : [{ sql: REVISIONS_MONID_PIN }]),
        { sql: "DROP TABLE IF EXISTS mcp_pins" },
        { sql: "DROP TABLE IF EXISTS browser_viewers" },
        { sql: SECOND_ANSWERS_REFUSED, params: [(options.now ?? Date.now)()] },
        { sql: "DROP INDEX IF EXISTS commands_one_answer" },
        { sql: COMMANDS_ONE_ANSWER },
        // An earlier build of this version kept no imported template packages (schema.ts IMPORTED_TEMPLATES).
        { sql: IMPORTED_TEMPLATES },
        // Nor any hosted machine's minted token (schema.ts MINTED_TOKENS).
        { sql: MINTED_TOKENS },
        // Nor any runner's word that it is there (schema.ts RUNNERS), and it kept each runner's relay in runner_relays:
        // dropped, its rows heartbeats that each relay's runner writes again within its renewal, so none is copied.
        { sql: "DROP TABLE IF EXISTS runner_relays" },
        { sql: RUNNERS },
        // Nor any hand-back (schema.ts HAND_BACKS): a release before it kept none.
        { sql: HAND_BACKS },
        { sql: HAND_BACKS_AT },
        { sql: HAND_BACKS_RUN },
        // Nor any computer a run made (schema.ts COMPUTER_INTERVALS): a computer made before it has no row.
        { sql: COMPUTER_INTERVALS },
        { sql: COMPUTER_INTERVALS_RUN },
        // Nor any claim's turn and attempt (schema.ts RUN_ATTEMPTS): a claim made before it has no row.
        { sql: RUN_ATTEMPTS },
        { sql: NATIVE_COMMANDS_INDEX },
      ], { full: true });
      // A computer_intervals an earlier build of this version made has no disk or booked time (schema.ts
      // COMPUTER_INTERVALS_ADDED): each column added where missing, its rows' disk unknown (null) and booked time none.
      const intervalColumns = new Set((await connection.all<{ name: string }>("SELECT name FROM pragma_table_info('computer_intervals')")).map((column) => column.name));
      const missing = Object.entries(COMPUTER_INTERVALS_ADDED).filter(([column]) => !intervalColumns.has(column)).map(([, sql]) => ({ sql }));
      if (missing.length > 0) await connection.write(missing, { full: true });
      // A runners table an earlier build of this version made has no version or slots (schema.ts RUNNERS_ADDED): each added
      // where missing, every row's unknown (null) until its runner's next put.
      const runnersNow = new Set((await connection.all<{ name: string }>("SELECT name FROM pragma_table_info('runners')")).map((column) => column.name));
      const runnersMissing = Object.entries(RUNNERS_ADDED).filter(([column]) => !runnersNow.has(column)).map(([, sql]) => ({ sql }));
      if (runnersMissing.length > 0) await connection.write(runnersMissing, { full: true });
      await backfillNativeCommandOwners(connection);
      if (found === 11) {
        const present = new Set((await connection.all<{ name: string }>("SELECT name FROM pragma_table_info('runs')")).map((column) => column.name));
        await connection.write(listingUpgrade(present).map((sql) => ({ sql })), { full: true });
      }
      if (found === 11 || found === 12) {
        const minted = new Set((await connection.all<{ name: string }>("SELECT name FROM pragma_table_info('minted_tokens')")).map((column) => column.name));
        await connection.write(relayUpgrade(minted).map((sql) => ({ sql })), { full: true });
      }
      if (upgrading) {
        const named = async (table: string) => new Set((await connection.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((column) => column.name));
        if (found !== 14) await connection.write(purgeUpgrade(await named("runs"), await named("agents")).map((sql) => ({ sql })), { full: true });
        await connection.write(diskUpgrade(await named("runs")).map((sql) => ({ sql })), { full: true });
      }
    }
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
  const store = storeOver(connection, options.now ?? Date.now, inMemory(file) ? undefined : file);
  // A SQLite runner opens only its own version (the server upgrades the file in place at its start, never beside a
  // runner on another build): its floor is the version itself.
  const schemaState = async () => {
    const version = await versionOf(connection);
    return { version, runnerFloor: version, known: SCHEMA_VERSION };
  };
  return Object.assign(store, { schemaState });
}

/** Every unrefused approve or deny after the first for one approval of a run, refused with why (the open above). */
const SECOND_ANSWERS_REFUSED = `UPDATE commands SET taken_at = COALESCE(taken_at, ?), refused = 'a second answer to one approval: the first one stands'
  WHERE kind IN ('approve', 'deny') AND refused IS NULL AND json_extract(body, '$.approval') IS NOT NULL
    AND id NOT IN (SELECT MIN(id) FROM commands WHERE kind IN ('approve', 'deny') AND refused IS NULL AND json_extract(body, '$.approval') IS NOT NULL GROUP BY run_id, json_extract(body, '$.approval'))`;

/** How many released claims a store remembers, to refuse their journals. */
const RELEASED_KEPT = 1024;

/** The most claims one statement of renewMany renews. Its WHERE joins each claim's fence with OR, and each OR is one more
 *  level of the expression tree, whose depth SQLite bounds at 1,000 (SQLITE_MAX_EXPR_DEPTH: 997 claims already fail). 250
 *  stays a quarter of that, and a runner's 300 claims are still two statements on a database a few ms away. */
const RENEW_CHUNK = 250;
/** A claim as renewMany matches it to the rows its update returned: its run, epoch and runner, each string as the store
 *  writes text (cleanText: a NUL as U+FFFD), so a claim and the row the database wrote for it make one key. */
const renewKey = (runId: string, epoch: number, runner: string): string => `${cleanText(runId)}\u0000${epoch}\u0000${cleanText(runner)}`;

/** The key of a claim's one journal: its run and epoch. */
const journalKey = (claim: Pick<Claim, "runId" | "epoch">): string => `${claim.runId}\u0000${claim.epoch}`;

/** A statement under `claim`: one that changes no row means the run's epoch moved on, and the transaction rolls back. */
function fenced(claim: Claim, sql: string, params: readonly SqliteValue[]): Statement {
  return { sql, params, expect: { kind: "fenced", runId: claim.runId, epoch: claim.epoch } };
}

/** A channel post's columns, as channelPostOf reads them. */
const CHANNEL_POST_COLUMNS = "id, channel, run_id, moment, body, attempts, next_at, state, reason, claimed_until, claim, created_at";
type ChannelPostRecord = { id: string; channel: string; run_id: string | null; moment: string; body: string; attempts: number; next_at: number; state: ChannelPostRow["state"]; reason: string | null; claimed_until: number | null; claim: string | null; created_at: number };
const channelPostOf = (row: ChannelPostRecord): ChannelPostRow => ({
  id: row.id, channel: row.channel, runId: row.run_id, moment: row.moment, body: row.body, attempts: Number(row.attempts), nextAt: Number(row.next_at), state: row.state, reason: row.reason,
  claimedUntil: row.claimed_until === null ? null : Number(row.claimed_until), claim: row.claim, createdAt: Number(row.created_at),
});
type ChannelAttemptRecord = { try_id: string; post_id: string; moment: string; at: number; status_code: number | null; latency_ms: number; error: string | null; retry_at: number | null; redelivery: number };
const channelAttemptOf = (row: ChannelAttemptRecord): ChannelAttemptRow => ({
  tryId: row.try_id, postId: row.post_id, moment: row.moment, at: Number(row.at), statusCode: row.status_code === null ? null : Number(row.status_code), latencyMs: Number(row.latency_ms), error: row.error,
  retryAt: row.retry_at === null ? null : Number(row.retry_at), redelivery: Number(row.redelivery) === 1,
});
type ChannelToldRecord = { run_id: string; marker: string; at: number };

/** `connection` as one read-only snapshot: every read goes through `tx`, a write is refused, and a transaction opened
 *  inside it is the snapshot itself (Store.snapshot). */
function snapshotOf(connection: StoreConnection, tx: Tx): StoreConnection {
  return {
    dialect: connection.dialect,
    where: connection.where,
    get: (sql, ...params) => tx.get(sql, ...params),
    all: (sql, ...params) => tx.all(sql, ...params),
    write: () => Promise.reject(new Error("a store snapshot only reads")),
    // A transaction inside the snapshot reads through the same handle, and refuses what writes (SQLite's deferred BEGIN is
    // not read-only, so the refusal is here, as Postgres's read-only transaction makes it).
    transaction: (callback) => callback(readOnly(tx)),
    close: () => Promise.resolve(),
  };
}

function readOnly(tx: Tx): Tx {
  const refuse = () => Promise.reject(new Error("a store snapshot only reads"));
  return {
    dialect: tx.dialect,
    get: (sql, ...params) => tx.get(sql, ...params),
    all: (sql, ...params) => tx.all(sql, ...params),
    exec: refuse,
    run: refuse,
    runCounted: refuse,
    step: refuse,
  };
}

/** The Store over `connection`, on whichever database it is (SQLite here, Postgres in postgres/store.ts), on the store's
 *  clock `now` (ms), its identity `where` (Store.where). The opener sets the schema up and checks its version first.
 *  `file`: a SQLite store's database file, beside which secureRewrite keeps its marker (SCRUB_SUFFIX), and whose WAL a
 *  purge checkpoints. */
export function storeOver(connection: StoreConnection, now: () => number, file?: string): Store {
  return new SqliteStore(connection, now, undefined, file === undefined ? undefined : `${file}${SCRUB_SUFFIX}`);
}

/** How long a purge's checkpoint waits for another connection's reader or writer before it leaves the log to the next
 *  start's scrub: short, since every other request of the store's connection queues behind it. */
const PURGE_CHECKPOINT_BUSY_MS = 20;

/** A run's content in every table that keeps it by the run's id, gone: what a run's purge (Runs.purge) and its delete
 *  (Runs.remove) both drop. A table added for a run's content goes here, so neither path leaves it behind. */
async function dropRunContent(tx: SqliteExecutor, runId: string): Promise<void> {
  for (const table of PI_TABLES) await tx.run(`DELETE FROM ${table} WHERE run_id = ?`, runId);
  await tx.run("DELETE FROM commands WHERE run_id = ?", runId);
  await tx.run("DELETE FROM run_origins WHERE run_id = ?", runId);
  await tx.run("DELETE FROM run_launch WHERE run_id = ?", runId);
  await tx.run("DELETE FROM run_live WHERE run_id = ?", runId);
  await tx.run("DELETE FROM computer_viewers WHERE run_id = ?", runId);
  await tx.run("DELETE FROM channel_attempts WHERE post_id IN (SELECT id FROM channel_posts WHERE run_id = ?)", runId);
  await tx.run("DELETE FROM channel_posts WHERE run_id = ?", runId);
  await tx.run("DELETE FROM channel_told WHERE run_id = ?", runId);
  await tx.run("DELETE FROM trigger_conversations WHERE run_id = ?", runId);
  await tx.run("DELETE FROM run_changes WHERE run_id = ?", runId);
  await tx.run("DELETE FROM hand_backs WHERE run_id = ?", runId);
  // Its claims' attempts: what each cost is in its tombstone's money, and no read of a purged run splits it.
  await tx.run("DELETE FROM run_attempts WHERE run_id = ?", runId);
}

/** An agent's own rows no tombstone keeps (its learning, its saved sign-ins and their tombstones), gone: what an agent's
 *  purge (Agents.purge) and its delete (Agents.remove) both drop. */
async function dropAgentPrivate(tx: SqliteExecutor, agentId: string): Promise<void> {
  await tx.run("DELETE FROM learning WHERE agent_id = ?", agentId);
  await tx.run("DELETE FROM sign_ins WHERE agent_id = ?", agentId);
  await tx.run("DELETE FROM sign_in_tombstones WHERE agent_id = ?", agentId);
}

/** The suffix, after the database file's name, of the marker secureRewrite writes before a rewrite (and a purge before its
 *  transaction) and removes once no file of the store keeps the bytes they replaced: a start that finds it finishes the
 *  scrub. */
const SCRUB_SUFFIX = ".scrub";
/** How long the scrub's VACUUM waits, once its busy wait ran out on another connection's write, before its one retry. */
const VACUUM_RETRY_MS = 400;

/** The marker at `path`, written and synced (its directory too): before the rewrite or purge it marks changes a byte. */
function markScrub(path: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, "agentrun-serve: a rewrite of a secret this store kept in the clear, or a purge, may have left old bytes in the store's free pages or its WAL; the next start scrubs them and removes this file.\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** The store's domain code, written once for both databases: its SQL takes `?` parameters, and what a database says
 *  differently, or must lock where SQLite's one writer serializes, is the connection's Dialect (store/dialect.ts). */
class SqliteStore implements Store {
  readonly agents: Agents;
  readonly templates: Templates;
  readonly triggers: Triggers;
  readonly runs: Runs;
  readonly mcp: Mcp;
  readonly live: Live;
  readonly liveViewers: LiveViewers;
  readonly learning: Learning;
  readonly settings: Settings;
  readonly sealedKeys: SealedKeys;
  readonly computerLedger: ComputerLedger;
  readonly computerIntervals: ComputerIntervals;
  readonly runAttempts: RunAttempts;
  readonly pairedComputers: PairedComputers;
  readonly mintedTokens: MintedTokens;
  readonly runners: Runners;
  readonly importedTemplates: ImportedTemplates;
  readonly triggerSettings: TriggerSettings;
  readonly channels: Channels;
  readonly mcpOauth: McpOauth;
  readonly signIns: SignIns;
  readonly sealedSecrets: SealedSecrets;
  readonly #db: StoreConnection;
  readonly #now: () => number;
  /** The store this one is a snapshot of, or itself (Store.origin). */
  readonly origin: Store;
  /** Where this store's data is: its connection's (StoreConnection.where). */
  readonly where: string;
  /** The deadlines' clock now (fence.ts storeNow): the database's on Postgres, this store's clock bound on SQLite. */
  readonly #clock: () => StoreNow;
  /** Each claim's one journal, until it is closed. */
  readonly #journals = new Map<string, RunStorage>();
  /** Each run's claim this store released last (its epoch): journal() refuses that claim, or an older one, rather than
   *  hand out a journal that is Fenced at its first write. A newer claim of the run by this store drops it; at most
   *  RELEASED_KEPT are kept, the oldest dropped first. Past that cap journal() no longer refuses an old released claim,
   *  but nothing is written through it: release moved the run's epoch on, so the journal's first commit is Fenced by the
   *  epoch check in its own transaction. The map refuses early; the epoch is what guarantees it. */
  readonly #released = new Map<string, number>();
  /** secureRewrite's marker (SCRUB_SUFFIX): set on a SQLite store with a file, never on a snapshot. */
  readonly #scrubMarker: string | undefined;
  /** How many times a purge (#purging) or a rewrite (secureRewrite) wrote the marker. The marker has many writers: each
   *  removes it only when no other wrote it since the step that covers that writer's log (its own start, or the checkpoint
   *  it asked), so a marker is never removed without a checkpoint that truncated every writer's frames. */
  #scrubMarks = 0;

  constructor(db: StoreConnection, now: () => number, origin?: Store, scrubMarker?: string) {
    this.#db = db;
    this.#scrubMarker = scrubMarker;
    this.#now = now;
    this.origin = origin ?? this;
    this.where = db.where;
    const d = db.dialect;
    const clock = (): StoreNow => storeNow(d, now);
    this.#clock = clock;

    const insertAgent = (tx: SqliteExecutor, agent: { id: string; name: string; description?: string | null }, at: number) =>
      tx.run("INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?)", agent.id, agent.name, agent.description ?? null, at);
    /** Agent `agentId`'s row, held (a writer's row lock, as its purge takes it), or undefined when there is none; refused
     *  (AgentPurged) once it is purged: a write that waited on the purge's lock reads its purge time, and one that took the
     *  lock first commits before the purge reads anything. */
    const heldAgent = async (tx: SqliteExecutor, agentId: string) => {
      await d.lockRow(tx, "agents", "id", agentId);
      const agent = await tx.get<{ current_revision: string | null; archived_at: number | null; external_ref: string | null; purged_at: number | null }>(
        "SELECT current_revision, archived_at, external_ref, purged_at FROM agents WHERE id = ?", agentId,
      );
      if (agent && agent.purged_at != null) throw new AgentPurged(agentId, agent.archived_at, agent.purged_at);
      return agent;
    };
    const insertRevision = async (tx: SqliteExecutor, agentId: string, revision: NewRevision, at: number,
      { ifCurrent, ifNoActiveRuns, advance }: { ifCurrent?: string | null; ifNoActiveRuns?: true; advance?: false } = {}) => {
      // The parent is the agent's current revision now (null for its first): the agent must exist, which its first revision
      // (create) and a later one (addRevision, upgrade) both guarantee before this. Held (a writer's row lock), so two
      // revisions advanced at once, by this server or another on the same store, never both name the same parent, and
      // `ifCurrent` is compared with what no other writer can move until this commits. Never one of a purged agent.
      const agent = await heldAgent(tx, agentId);
      if (!agent) throw new StoreConstraint(`no agent ${agentId}`);
      if (ifCurrent !== undefined && agent.current_revision !== ifCurrent) throw new RevisionMoved(agentId, agent.current_revision);
      if (ifNoActiveRuns) {
        const active = await tx.all<{ id: string }>("SELECT id FROM runs WHERE agent_id = ? AND state IN ('queued', 'running', 'parked') ORDER BY id", agentId);
        if (active.length > 0) throw new ActiveRuns(agentId, active.map(({ id }) => id));
      }
      await tx.run("INSERT INTO revisions (id, agent_id, parent_id, kind, body, skills, note, package, created_at, mcp_pin, monid_pin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        revision.id, agentId, agent.current_revision, revision.kind, json(revision.body),
        revision.skills === undefined || revision.skills === null ? null : json(revision.skills),
        revision.note ?? null, revision.package === undefined ? null : json(revision.package), at, pinText(revision.mcpPin), pinText(revision.monidPin));
      if (advance !== false) await tx.run("UPDATE agents SET current_revision = ? WHERE id = ?", revision.id, agentId);
    };
    const writeScopes = async (tx: SqliteExecutor, triggerId: string, scopes: readonly TriggerScope[]) => {
      await tx.run("DELETE FROM trigger_scopes WHERE trigger_id = ?", triggerId);
      for (const { kind, scope } of scopes) await tx.run("INSERT INTO trigger_scopes (kind, scope, trigger_id) VALUES (?, ?, ?)", kind, scope, triggerId);
    };
    /** Refused (AgentArchived) when agent `agentId` is archived: read in the writing transaction, so an archive that
     *  commits first is seen, and one that commits after finds what this wrote. */
    const refuseArchived = async (tx: SqliteExecutor, agentId: string) => {
      if ((await tx.get<{ archived_at: number | null }>("SELECT archived_at FROM agents WHERE id = ?", agentId))?.archived_at != null) throw new AgentArchived(agentId);
    };
    /** Refused (AgentDeleting) when agent `agentId` is being deleted: another system's agent with an archive time, which
     *  only its delete writes (AgentDeleting). The agent's row is held first (a writer's row lock, as the archive's UPDATE
     *  takes it), so on Postgres a delete's archive that commits first is read here, and one that commits after waits for
     *  this run to be in the store, where the delete's listing of the agent's runs finds it. A purged agent is refused too
     *  (AgentPurged): it takes no run and no trigger. */
    const refuseDeleting = async (tx: SqliteExecutor, agentId: string, expectedCurrent?: string | null) => {
      const agent = await heldAgent(tx, agentId);
      if (agent?.archived_at != null && agent.external_ref != null) throw new AgentDeleting(agentId);
      if (expectedCurrent !== undefined) {
        if (!agent) throw new StoreConstraint(`no agent ${agentId}`);
        if (agent.current_revision !== expectedCurrent) throw new RevisionMoved(agentId, agent.current_revision);
      }
    };
    /** The runs whose launch is made from run `runId` (madeOf: a replay of its input, an audit's shadow), by id. Every
     *  launch is read (no index names its source): a purge's read, never a hot path. */
    const launchedFrom = async (ex: Pick<SqliteExecutor, "all">, runId: string): Promise<string[]> =>
      (await ex.all<{ id: string }>(
        `SELECT run_id AS id FROM run_launch WHERE (${d.jsonText(readableJson(d, "body"), ["replay", "of"])} = ? OR ${d.jsonText(readableJson(d, "body"), ["audit", "of"])} = ?) AND run_id <> ? ORDER BY run_id`,
        runId, runId, runId,
      )).map((row) => row.id);
    /** Inserts the trigger, or (on its name for the agent) changes it in place, keeping its id; then its scope rows, only
     *  while it is enabled. `insertOnly` (an apply's new agent): no ON CONFLICT, and the package check keeps the names
     *  distinct, so the store's one name per agent is never what refuses an apply (templates.apply below). */
    const upsertTrigger = async (tx: SqliteExecutor, agentId: string, trigger: TriggerDef, at: number, { insertOnly = false } = {}) => {
      const enabled = trigger.enabled !== false;
      const onName = insertOnly ? "" : `ON CONFLICT (agent_id, name) DO UPDATE SET enabled = excluded.enabled, source = excluded.source, target = excluded.target,
           next_at = excluded.next_at, catchup_window_s = excluded.catchup_window_s, disabled = NULL, updated_at = excluded.updated_at`;
      const row = await tx.get<{ id: string }>(
        `INSERT INTO triggers (id, agent_id, name, enabled, source, target, next_at, catchup_window_s, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ${onName} RETURNING id`,
        trigger.id, agentId, trigger.name, enabled ? 1 : 0, json(trigger.source), json(trigger.target), trigger.nextAt ?? null, trigger.catchupWindowS ?? null, at, at,
      );
      await writeScopes(tx, row!.id, enabled ? (trigger.scopes ?? []) : []);
    };

    // A running run whose sign_in_handed holds `hash` (handedHolderIn), or any running run handed a sign-in at all
    // (handedAnyIn): the reads forget, the view, the runner's bind and its output check make, over `runs` alone. By default
    // only a running run holds it; `settleMs` (a vendor's settle window, measured from the store clock `at`) also counts a
    // run that left running (ended or parked) less than that ago, so a new run does not save over a context write-back in
    // flight. `not` drops one run id (a bind's own, so a run is never its own blocker).
    const handedHolderIn = (
      tx: Pick<SqliteExecutor, "get">,
      hash: string,
      { not, settleMs = 0, now: at = { sql: d.bigintParam, params: [0] } }: { not?: string; settleMs?: number; now?: StoreNow } = {},
    ): Promise<{ id: string } | undefined> => {
      // The settle window on the deadlines' clock (the database's on Postgres), the one that stamped left_running_at.
      const settle = settleMs > 0 ? ` OR (left_running_at IS NOT NULL AND left_running_at > ${at.sql} - ?)` : "";
      // d.jsonArrayHas carries the hash's own `?`, so the hash comes last in the params.
      return tx.get<{ id: string }>(
        `SELECT id FROM runs WHERE sign_in_handed IS NOT NULL${not === undefined ? "" : " AND id != ?"}
           AND (state = 'running'${settle})
           AND ${d.jsonArrayHas("sign_in_handed")} LIMIT 1`,
        ...(not === undefined ? [] : [not]),
        ...(settleMs > 0 ? [...at.params, settleMs] : []),
        hash,
      );
    };
    const handedAnyIn = (tx: Pick<SqliteExecutor, "get">) =>
      tx.get<{ id: string }>(`SELECT id FROM runs WHERE state = 'running' AND sign_in_handed IS NOT NULL AND ${d.jsonArrayLength("sign_in_handed")} > 0 LIMIT 1`);

    this.agents = {
      put: async ({ id, name, description = null }) => {
        await db.transaction(async (tx) => {
          // Never a purged agent's name or description written back.
          await heldAgent(tx, id);
          await tx.run("INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description", id, name, description, now());
        });
      },
      create: async (agent, firstRevision) => {
        await db.transaction(async (tx) => {
          const at = now();
          await insertAgent(tx, agent, at);
          await insertRevision(tx, agent.id, firstRevision, at);
        });
      },
      get: async (id) => {
        const row = await db.get<AgentRecord>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`, id);
        return row && agentOf(row);
      },
      byExternal: async (ref) => {
        const row = await db.get<AgentRecord>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE external_ref = ?`, ref);
        return row && agentOf(row);
      },
      hasExternalVersion: async (agentId, version) => (await db.get<{ id: string }>("SELECT id FROM revisions WHERE agent_id = ? AND external_version = ?", agentId, version)) !== undefined,
      externalRevision: async (agentId, version) => {
        const row = await db.get<RevisionRecord>(`SELECT ${REVISION_COLUMNS} FROM revisions WHERE agent_id = ? AND external_version = ?`, agentId, version);
        return row && revisionOf(row);
      },
      list: async ({ archived = false, purged = false } = {}) =>
        (await db.all<AgentRecord>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"}${purged ? "" : " AND purged_at IS NULL"} ORDER BY created_at, id`)).map(agentOf),
      archive: async (id, archived, why) =>
        db.transaction(async (tx) => {
          const at = now();
          // A purged agent stays as its purge left it: archived, never unarchived.
          await heldAgent(tx, id);
          await tx.run("UPDATE agents SET archived_at = ? WHERE id = ?", archived ? at : null, id);
          if (!archived) return [];
          // Its triggers that are on, off in this same commit: a firing's fire reads the archive in its own transaction.
          const off = await tx.all<{ id: string; name: string }>(
            "UPDATE triggers SET enabled = 0, next_at = NULL, disabled = ?, updated_at = ? WHERE agent_id = ? AND enabled = 1 RETURNING id, name",
            why === undefined ? null : json(why), at, id,
          );
          for (const t of off) await writeScopes(tx, t.id, []);
          return off.map(({ id: triggerId, name }) => ({ id: triggerId, name })).sort((a, b) => a.name.localeCompare(b.name));
        }),
      addRevision: async ({ agentId, ifCurrent, description, ifNoActiveRuns, settingsGuards, mcpGuards, advance, ...revision }) => {
        await db.transaction(async (tx) => {
          await checkSettingsGuards(tx, settingsGuards);
          await checkMcpGuards(tx, d, mcpGuards);
          await insertRevision(tx, agentId, revision, now(), { ifCurrent, ifNoActiveRuns, advance });
          // Under the row lock insertRevision took, after its ifCurrent passed: the revision and the description, or neither.
          if (description !== undefined) await tx.run("UPDATE agents SET description = ? WHERE id = ?", description, agentId);
        });
      },
      setCurrent: async (agentId, revisionId) => {
        const changed = await db.transaction(async (tx) => {
          // Never a purged agent's: its current revision stays the one its runs' tombstones read.
          await heldAgent(tx, agentId);
          return tx.runCounted(
            "UPDATE agents SET current_revision = ? WHERE id = ? AND EXISTS (SELECT 1 FROM revisions WHERE id = ? AND agent_id = ?)",
            revisionId, agentId, revisionId, agentId,
          );
        });
        if (changed === 0) throw new StoreConstraint(`${revisionId} is not a revision of agent ${agentId}`);
      },
      revision: async (id) => {
        const row = await db.get<RevisionRecord>(`SELECT ${REVISION_COLUMNS} FROM revisions WHERE id = ?`, id);
        return row && revisionOf(row);
      },
      revisions: async (agentId) => (await db.all<RevisionRecord>(`SELECT ${REVISION_COLUMNS} FROM revisions WHERE agent_id = ? ORDER BY created_at, id`, agentId)).map(revisionOf),
      // Written only while the revision has none (the one place a revision changes after its save), then read back in the
      // same transaction: the pin that stood, this one or another first run's. Never on a purged agent's revision (its purge
      // cleared every pin): its agent's row held first, as the purge holds it, and none written once it is purged.
      pinOnce: async (revisionId, pin) => {
        const row = await db.transaction(async (tx) => {
          const of = await tx.get<{ agent_id: string }>("SELECT agent_id FROM revisions WHERE id = ?", revisionId);
          if (!of) return undefined;
          await d.lockRow(tx, "agents", "id", of.agent_id);
          if ((await tx.get<{ purged_at: number | null }>("SELECT purged_at FROM agents WHERE id = ?", of.agent_id))?.purged_at != null) return undefined;
          await tx.run("UPDATE revisions SET mcp_pin = ? WHERE id = ? AND mcp_pin IS NULL", pinText(pin), revisionId);
          return tx.get<{ mcp_pin: string | null }>("SELECT mcp_pin FROM revisions WHERE id = ?", revisionId);
        });
        return row?.mcp_pin == null ? null : JSON.parse(row.mcp_pin);
      },
      remove: async (agentId) => {
        await db.transaction(async (tx) => {
          await d.lockRow(tx, "agents", "id", agentId);
          if (await tx.get<{ id: string }>("SELECT id FROM runs WHERE agent_id = ? LIMIT 1", agentId)) throw new StoreConstraint(`agent ${agentId} still has runs: each is removed first (runs.remove)`);
          // A trigger is never removed with the agent: what it keeps outside its row (a registration upstream, its adapter
          // settings) goes only through the trigger engine. One made past the delete's listing (it is refused once the
          // agent is marked, triggers.create; this is read under the agent row's lock, which that refusal takes too)
          // keeps the agent for the next delete to remove whole.
          const left = await tx.all<{ id: string }>("SELECT id FROM triggers WHERE agent_id = ? ORDER BY id", agentId);
          if (left.length) throw new TriggersLeft(agentId, left.map((one) => one.id));
          await tx.run("DELETE FROM learning_proposals WHERE agent_id = ?", agentId);
          await dropAgentPrivate(tx, agentId);
          // Its revisions in one statement (a revision's parent is the same agent's, checked at the statement's end), the
          // agent's pointer at its current one cleared first.
          await tx.run("UPDATE agents SET current_revision = NULL WHERE id = ?", agentId);
          await tx.run("DELETE FROM revisions WHERE agent_id = ?", agentId);
          await tx.run("DELETE FROM agents WHERE id = ?", agentId);
        });
      },
      purge: (agentId) =>
        this.#purging(() => db.transaction(async (tx) => {
          await d.lockRow(tx, "agents", "id", agentId);
          const agent = await tx.get<{ purged_at: number | null }>("SELECT purged_at FROM agents WHERE id = ?", agentId);
          if (!agent || agent.purged_at !== null) return false;
          // Each run a tombstone first (Runs.purge): a run started past the delete's listing keeps the agent for the next one.
          const left = await tx.get<{ id: string }>("SELECT id FROM runs WHERE agent_id = ? AND purged_at IS NULL LIMIT 1", agentId);
          if (left) throw new StoreConstraint(`agent ${agentId} still has run ${left.id} not purged: each is purged first (runs.purge)`);
          const triggersLeft = await tx.all<{ id: string }>("SELECT id FROM triggers WHERE agent_id = ? ORDER BY id", agentId);
          if (triggersLeft.length) throw new TriggersLeft(agentId, triggersLeft.map((one) => one.id));
          await dropAgentPrivate(tx, agentId);
          // The answer a template apply kept under its key, which holds the agent as it was made.
          await tx.run(`DELETE FROM idempotency WHERE scope = 'templates.apply' AND ${d.jsonText("response", ["agentId"])} = ?`, agentId);
          // The uploads it was applied from, each gone unless another agent not purged was applied from it too: nothing
          // else owns one, and a server that serves no template route (API-only) could never remove it. Each is held by its
          // id, in order, before it is read: two purges of agents applied from one upload read it in turn, so the later
          // reads the earlier's purge (committed) and removes the upload. Only the package it was applied from goes, by its
          // sha too: a newer upload of the same name, which another deploy has yet to apply, stays.
          const packageId = (alias: string) => d.jsonText(`${alias}.package`, ["id"]);
          const applied = (await tx.all<{ id: string | null; sha: string | null }>(`SELECT DISTINCT ${packageId("r")} AS id, ${d.jsonText("r.package", ["sha"])} AS sha FROM revisions r WHERE r.agent_id = ? AND r.package IS NOT NULL`, agentId))
            .filter((row): row is { id: string; sha: string } => row.id !== null && row.id.startsWith(UPLOAD_PREFIX) && row.sha !== null)
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          for (const { id, sha } of applied) {
            await d.lockKey(tx, `imported_templates:${id}`);
            const kept = await tx.get<{ id: string }>(`SELECT r.id FROM revisions r JOIN agents a ON a.id = r.agent_id WHERE r.agent_id <> ? AND a.purged_at IS NULL AND ${packageId("r")} = ? LIMIT 1`, agentId, id);
            if (!kept) await tx.run("DELETE FROM imported_templates WHERE id = ? AND sha = ?", id, sha);
          }
          // Each revision's content; its id, kind, parent and time stay, which its runs' tombstones name.
          await tx.run("UPDATE revisions SET body = '{}', skills = NULL, package = NULL, note = NULL, mcp_pin = NULL, monid_pin = NULL WHERE agent_id = ?", agentId);
          // Its purge time last, in the same write as its name and description.
          await tx.run("UPDATE agents SET name = '', description = NULL, purged_at = ? WHERE id = ?", now(), agentId);
          return true;
        })),
    };

    this.templates = {
      apply: async (agent, revision, triggers, idempotencyKey) =>
        db.transaction(async (tx) => {
          if (idempotencyKey !== undefined) {
            // Two applies under one key at once: the second waits for the first, then reads its kept answer.
            await d.lockKey(tx, `templates.apply|${idempotencyKey}`);
            const kept = await tx.get<{ response: string }>("SELECT response FROM idempotency WHERE scope = 'templates.apply' AND key = ?", idempotencyKey);
            if (kept) return JSON.parse(kept.response) as { agentId: string; revisionId: string };
          }
          const at = now();
          await insertAgent(tx, agent, at);
          await insertRevision(tx, agent.id, revision, at);
          // A new agent has no triggers: a plain insert. UNIQUE (agent_id, name) cannot fire here by construction: a
          // package names each trigger once, compared trimmed as a trigger keeps its name (templates.ts readPackage), so
          // the names it is given are distinct once trimmed. A caller that passed two the same anyway is refused by the
          // constraint as a StoreConstraint, and this transaction writes nothing: never a part of an apply.
          for (const trigger of triggers) await upsertTrigger(tx, agent.id, trigger, at, { insertOnly: true });
          const result = { agentId: agent.id, revisionId: revision.id };
          if (idempotencyKey !== undefined) await tx.run("INSERT INTO idempotency (scope, key, response, at) VALUES ('templates.apply', ?, ?, ?)", idempotencyKey, json(result), at);
          return result;
        }),
      upgrade: async (agentId, revision, { upsert, remove }) => {
        await db.transaction(async (tx) => {
          const at = now();
          await insertRevision(tx, agentId, revision, at);
          for (const name of remove) await tx.run("DELETE FROM triggers WHERE agent_id = ? AND name = ?", agentId, name);
          for (const trigger of upsert) await upsertTrigger(tx, agentId, trigger, at);
        });
      },
    };

    this.triggers = {
      get: async (id) => {
        const row = await db.get<TriggerRecord>(`SELECT ${TRIGGER_COLUMNS} FROM triggers WHERE id = ?`, id);
        return row && triggerOf(row);
      },
      list: async (agentId) => (await db.all<TriggerRecord>(`SELECT ${TRIGGER_COLUMNS} FROM triggers WHERE agent_id = ? ORDER BY name`, agentId)).map(triggerOf),
      all: async () => (await db.all<TriggerRecord>(`SELECT ${TRIGGER_COLUMNS} FROM triggers ORDER BY created_at, id`)).map(triggerOf),
      create: async (t, scopes = []) => {
        const at = now();
        const row = await db.transaction(async (tx) => {
          // A trigger belongs to an agent the store holds: refused in words, never a bare foreign-key failure.
          if (!(await tx.get<{ id: string }>("SELECT id FROM agents WHERE id = ?", t.agentId))) throw new StoreConstraint(`no agent ${t.agentId}: a trigger belongs to an agent the store holds`);
          // None for an agent being deleted, off too: an off trigger may hold a registration upstream (Composio's) that
          // the delete, having listed the agent's triggers already, would never remove.
          await refuseDeleting(tx, t.agentId);
          if (t.enabled) await refuseArchived(tx, t.agentId);
          const made = await tx.get<TriggerRecord>(
            `INSERT INTO triggers (id, agent_id, name, enabled, source, target, next_at, catchup_window_s, max_active_runs, created_at, updated_at, template_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${TRIGGER_COLUMNS}`,
            t.id, t.agentId, t.name, t.enabled ? 1 : 0, json(t.source), json(t.target), t.nextAt, t.catchupWindowS, t.maxActiveRuns ?? null, at, at, t.templateId ?? null,
          );
          if (t.enabled) await writeScopes(tx, t.id, scopes);
          return made;
        });
        return triggerOf(row!);
      },
      update: async (id, patch, scopes, options) => {
        const { set, params } = triggerSet(patch, now());
        // A compare-and-set (options.ifUpdatedAt): no row is changed once the trigger was updated or deleted since that read.
        // Its source too (options.ifSource, compared as the JSON text the store wrote): one millisecond's writes share an
        // updated_at, never a source. Its agent too (options.ifAgent): none is changed once the trigger was moved to another.
        const unchanged = `${options?.ifUpdatedAt === undefined ? "" : " AND updated_at = ?"}${options?.ifSource === undefined ? "" : " AND source = ?"}${options?.ifAgent === undefined ? "" : " AND agent_id = ?"}`;
        const since = [...(options?.ifUpdatedAt === undefined ? [] : [options.ifUpdatedAt]), ...(options?.ifSource === undefined ? [] : [json(options.ifSource)]), ...(options?.ifAgent === undefined ? [] : [options.ifAgent])];
        const row = await db.transaction(async (tx) => {
          // Moved to another agent (its target re-aimed): one the store holds, refused in words otherwise.
          if (patch.agentId !== undefined && !(await tx.get<{ id: string }>("SELECT id FROM agents WHERE id = ?", patch.agentId))) throw new StoreConstraint(`no agent ${patch.agentId}: a trigger belongs to an agent the store holds`);
          // Never moved to an agent being deleted, off too, nor turned on for one: read (and its row held) before the
          // trigger's row is written, in the agent-then-trigger order its archive and its removal take.
          const to = patch.agentId ?? (await tx.get<{ agent_id: string }>("SELECT agent_id FROM triggers WHERE id = ?", id))?.agent_id;
          if (to !== undefined && (patch.agentId !== undefined || patch.enabled === true)) await refuseDeleting(tx, to);
          const changed = await tx.get<TriggerRecord>(`UPDATE triggers SET ${set} WHERE id = ?${unchanged} RETURNING ${TRIGGER_COLUMNS}`, ...params, id, ...since);
          // Never left on for an archived agent (turned on, or moved there on): the whole update is undone.
          if (changed?.enabled === 1) await refuseArchived(tx, changed.agent_id);
          // Scope rows only while it is on: turned off, it holds none; given scopes, they are its rows now.
          if (changed && (changed.enabled === 0 || scopes !== undefined)) await writeScopes(tx, id, changed.enabled === 1 ? (scopes ?? []) : []);
          return changed;
        });
        return row && triggerOf(row);
      },
      scoped: async (kind, scope) => (await db.all<{ trigger_id: string }>("SELECT trigger_id FROM trigger_scopes WHERE kind = ? AND scope = ?", kind, scope)).map((r) => r.trigger_id),
      remove: async (id, options) => {
        // On its agent's condition (options.ifAgent), compared in the same statement: one moved to another is left.
        const [done] = await db.write([options?.ifAgent === undefined ? { sql: "DELETE FROM triggers WHERE id = ?", params: [id] } : { sql: "DELETE FROM triggers WHERE id = ? AND agent_id = ?", params: [id, options.ifAgent] }]);
        return done!.changes > 0;
      },
      record: async (triggerId, firings, { patch, room } = {}) =>
        db.transaction(async (tx) => {
          const at = now();
          // The trigger's row held first, in every transaction that reads its firings to write them (record, settle,
          // message, prune, fire): one at a time per trigger, in one lock order.
          await d.lockRow(tx, "triggers", "id", triggerId);
          if (!(await tx.get<{ id: string }>("SELECT id FROM triggers WHERE id = ?", triggerId))) return undefined;
          if (room !== undefined && firings.some((f) => f.status === "due")) {
            const due = (await tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM trigger_firings WHERE trigger_id = ? AND status = 'due'", triggerId))!.n;
            if (due >= room) throw new TriggerFull(triggerId, due);
          }
          const created: boolean[] = [];
          for (const f of firings) {
            const n = await tx.runCounted(
              `INSERT INTO trigger_firings (trigger_id, key, by, nominal_at, status, at, reason, count, catch_up, payload, attrs, shown) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (trigger_id, key) DO NOTHING`,
              triggerId, f.key, f.by, f.nominalAt, f.status, at, f.reason ?? null, f.count ?? null, f.catchUp ? 1 : null, f.status === "due" ? (f.payload ?? null) : null,
              f.attrs === undefined ? null : json(f.attrs), f.shown === false ? 0 : 1,
            );
            created.push(n === 1);
          }
          if (patch) {
            const { set, params } = triggerSet(patch, at);
            await tx.run(`UPDATE triggers SET ${set} WHERE id = ?`, ...params, triggerId);
          }
          return { created };
        }),
      firing: async (triggerId, key) => {
        const row = await db.get<FiringRecord>(`SELECT ${FIRING_COLUMNS} FROM trigger_firings WHERE trigger_id = ? AND key = ?`, triggerId, key);
        return row && firingOf(row);
      },
      firings: async (triggerId) =>
        (await db.all<FiringRecord>(`SELECT ${FIRING_COLUMNS} FROM trigger_firings WHERE trigger_id = ? AND shown = 1 ORDER BY at DESC, ${d.firingOrder} DESC`, triggerId)).map(firingOf),
      settle: async (triggerId, key, change, streak) =>
        db.transaction(async (tx) => {
          const at = now();
          await d.lockRow(tx, "triggers", "id", triggerId);
          const was = await tx.get<FiringRecord>(`SELECT ${FIRING_COLUMNS} FROM trigger_firings WHERE trigger_id = ? AND key = ?`, triggerId, key);
          if (!was || (change.from !== undefined && was.status !== change.from)) return undefined;
          const settled = change.status !== undefined && change.status !== "due";
          // Out of due, a firing keeps no retry, wait, payload or attrs (unless keepAttrs), nor the reason its last try gave
          // (unless it gives one). One exception: a sent firing keeps its startBy in retry_at (firingOf reads it back as
          // startBy, never as a retry), so no migration adds a column for it. Each column is set once: Postgres refuses an
          // update that names one twice.
          const set: [string, SqliteValue][] = [];
          if (change.status !== undefined) set.push(["status", change.status]);
          if (settled) set.push(["retry_at", change.status === "sent" ? change.startBy ?? null : null], ["waits_on", null], ["payload", null], ["reason", change.reason ?? null], ["attempts", change.attempts ?? 0]);
          if (settled && !change.keepAttrs) set.push(["attrs", null]);
          if (!settled && change.reason !== undefined) set.push(["reason", change.reason]);
          if (change.runId !== undefined) set.push(["run_id", change.runId]);
          if (change.error !== undefined) set.push(["error", json(change.error)]);
          if (!settled && change.attempts !== undefined) set.push(["attempts", change.attempts]);
          if (!settled && change.retryAt !== undefined) set.push(["retry_at", change.retryAt]);
          if (!settled && change.waitsOn !== undefined) set.push(["waits_on", change.waitsOn]);
          if (change.notified !== undefined) set.push(["notified", change.notified ? 1 : 0]);
          let paused = false;
          const trigger = await tx.get<{ failures_in_a_row: number; enabled: number; last_run_id: string | null; target: string }>(
            "SELECT failures_in_a_row, enabled, last_run_id, target FROM triggers WHERE id = ?", triggerId,
          );
          const triggerSets: [string, SqliteValue][] = [];
          // Run ids are UUIDv7s, which sort by when the run started: a firing that finds an older run never takes a later
          // one's place as the trigger's last run.
          if (change.runId !== undefined && trigger && (JSON.parse(trigger.target) as { kind?: string }).kind === "start_run" && !(trigger.last_run_id && trigger.last_run_id > change.runId)) {
            triggerSets.push(["last_run_id", change.runId]);
          }
          if (streak && "reset" in streak) triggerSets.push(["failures_in_a_row", 0]);
          if (streak && "failure" in streak && trigger) {
            const failures = trigger.failures_in_a_row + 1;
            triggerSets.push(["failures_in_a_row", failures]);
            if (failures >= streak.pauseAt && trigger.enabled === 1) {
              paused = true;
              triggerSets.push(["enabled", 0], ["next_at", null], ["disabled", json({ at: new Date(at).toISOString(), reason: "auto_paused" })]);
              set.push(["paused", 1]);
            }
          }
          if (set.length) await tx.run(`UPDATE trigger_firings SET ${set.map(([c]) => `${c} = ?`).join(", ")} WHERE trigger_id = ? AND key = ?`, ...set.map(([, v]) => v), triggerId, key);
          if (triggerSets.length) {
            triggerSets.push(["updated_at", at]);
            await tx.run(`UPDATE triggers SET ${triggerSets.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`, ...triggerSets.map(([, v]) => v), triggerId);
          }
          if (paused) await writeScopes(tx, triggerId, []);
          const row = await tx.get<FiringRecord>(`SELECT ${FIRING_COLUMNS} FROM trigger_firings WHERE trigger_id = ? AND key = ?`, triggerId, key);
          return { firing: firingOf(row!), paused };
        }),
      pending: async () =>
        (await db.all<FiringRecord>(`SELECT ${FIRING_COLUMNS} FROM trigger_firings WHERE status = 'due' OR (status = 'failed' AND (notified IS NULL OR notified = 0)) ORDER BY at, ${d.firingOrder}`)).map(firingOf),
      message: async ({ triggerId, key }, runId, command, bound) => {
        const sent = await db.transaction(async (tx) => {
          const at = now();
          await d.lockRow(tx, "triggers", "id", triggerId);
          const firing = await tx.get<{ status: string }>("SELECT status FROM trigger_firings WHERE trigger_id = ? AND key = ?", triggerId, key);
          if (!firing || firing.status !== "due") return undefined;
          const waiting = (await tx.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM commands WHERE run_id = ? AND taken_at IS NULL AND ${d.jsonText(readableJson(d, "body"), ["origin", "trigger_id"])} = ?`, runId, triggerId,
          ))!.n;
          const clear = "retry_at = NULL, waits_on = NULL, payload = NULL, attrs = NULL, attempts = 0";
          if (waiting >= bound.max) {
            await tx.run(`UPDATE trigger_firings SET status = 'skipped', reason = ?, ${clear} WHERE trigger_id = ? AND key = ?`, bound.reason, triggerId, key);
            return { skipped: bound.reason };
          }
          // As command(): the run row read under the share lock, so a message never lands on a run whose end is in flight
          // or written, where it would wait untaken; a final run takes none (RunFinal) and the firing stays as it was.
          await lockCommandsOf(tx, runId);
          const row = await tx.get<{ id: number }>(`INSERT INTO commands (run_id, kind, body, created_at) SELECT id, ?, ?, ? FROM runs WHERE id = ? AND state NOT IN (${FINAL})${d.shareLock} RETURNING id`, command.kind, json(command.body), at, runId);
          if (!row) throw new RunFinal(runId);
          await tx.run(`UPDATE trigger_firings SET status = 'sent', run_id = ?, reason = NULL, ${clear} WHERE trigger_id = ? AND key = ?`, runId, triggerId, key);
          await tx.run("UPDATE triggers SET failures_in_a_row = 0, updated_at = ? WHERE id = ?", at, triggerId);
          return { sent: true as const, commandId: row!.id };
        });
        if (sent !== undefined && "sent" in sent) wakeCommands(this.where, { runId, what: "written" });
        return sent;
      },
      waiting: async (clockNow) =>
        (await db.all<FiringRecord & { free: number | boolean }>(
          `SELECT ${FIRING_COLUMNS.split(", ").map((c) => `f.${c}`).join(", ")},
             (SELECT COUNT(*) FROM trigger_firings s LEFT JOIN runs r ON r.id = s.run_id
               WHERE s.trigger_id = f.trigger_id AND ${inProgress("s", "r")}) < COALESCE(t.max_active_runs, 1) AS free
           FROM trigger_firings f JOIN triggers t ON t.id = f.trigger_id
           WHERE f.status = 'due' AND f.waits_on IS NOT NULL ORDER BY f.at, f.${d.firingOrder}`,
          clockNow,
        // A comparison reads 1 on SQLite and true on Postgres.
        )).map((r) => ({ ...firingOf(r), free: r.free === 1 || r.free === true })),
      soonest: async () => (await db.get<{ at: number | null }>("SELECT MIN(next_at) AS at FROM triggers WHERE enabled = 1 AND next_at IS NOT NULL"))?.at ?? null,
      activeRuns: async (triggerId, clockNow) =>
        (await db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM trigger_firings f LEFT JOIN runs r ON r.id = f.run_id WHERE f.trigger_id = ? AND ${inProgress("f", "r")}`, triggerId, clockNow,
        ))!.n,
      held: async (triggerId, clockNow) =>
        (await db.get<{ key: string }>(
          `SELECT f.key FROM trigger_firings f WHERE f.trigger_id = ? AND ${holdsRoom("f")} ORDER BY f.at DESC, f.${d.firingOrder} DESC LIMIT 1`, triggerId, clockNow,
        ))?.key,
      prune: async (triggerId, { history, dayMs, keepByKey, kept, now: clockNow }) =>
        db.transaction(async (tx) => {
          const at = now();
          await d.lockRow(tx, "triggers", "id", triggerId);
          // Past the newest `history` shown firings: never a due one, a failure not yet told, a started one whose run has
          // not ended, or a sent one its host may still start (holdsRoom). The rest leave the history: kept for their
          // key's day when a sender's key names them, else gone.
          const old = await tx.all<{ key: string; by: string | null }>(
            `SELECT f.key, f.by FROM trigger_firings f LEFT JOIN runs r ON r.id = f.run_id
             WHERE f.trigger_id = ? AND f.shown = 1 AND f.status != 'due' AND NOT (f.status = 'failed' AND (f.notified IS NULL OR f.notified = 0))
               AND NOT (f.status = 'started' AND r.id IS NOT NULL AND r.state NOT IN (${FINAL}))
               AND NOT ${holdsRoom("f")}
               AND f.key NOT IN (SELECT key FROM trigger_firings WHERE trigger_id = ? AND shown = 1 ORDER BY at DESC, ${d.firingOrder} DESC LIMIT ?)`,
            triggerId, clockNow, triggerId, history,
          );
          for (const { key, by } of old) {
            if (keepByKey(by ?? "manual")) await tx.run("UPDATE trigger_firings SET shown = 0, payload = NULL, attrs = NULL WHERE trigger_id = ? AND key = ?", triggerId, key);
            else await tx.run("DELETE FROM trigger_firings WHERE trigger_id = ? AND key = ?", triggerId, key);
          }
          await tx.run(
            `DELETE FROM trigger_firings WHERE trigger_id = ? AND shown = 0 AND at < ? AND status != 'due'
               AND NOT (status = 'started' AND run_id IN (SELECT id FROM runs WHERE state NOT IN (${FINAL})))`,
            triggerId, at - dayMs,
          );
          if (kept === undefined) return 0;
          // Past `kept` keys for the day, the oldest go first (a key's row, not its run: a started one's run has ended).
          return tx.runCounted(
            `DELETE FROM trigger_firings WHERE trigger_id = ? AND key IN (
               SELECT key FROM trigger_firings WHERE trigger_id = ? AND shown = 0 AND status != 'due'
                 AND NOT (status = 'started' AND run_id IN (SELECT id FROM runs WHERE state NOT IN (${FINAL})))
               ORDER BY at DESC, ${d.firingOrder} DESC ${d.limitAll} OFFSET ?)`,
            triggerId, triggerId, kept,
          );
        }),
      enable: async (triggerId, scopes) => {
        await db.transaction(async (tx) => {
          const on = await tx.get<{ agent_id: string }>("UPDATE triggers SET enabled = 1, disabled = NULL, updated_at = ? WHERE id = ? RETURNING agent_id", now(), triggerId);
          if (!on) throw new StoreConstraint(`no trigger ${triggerId}`);
          await refuseArchived(tx, on.agent_id);
          await writeScopes(tx, triggerId, scopes);
        });
      },
      disable: async (triggerId, why) => {
        await db.transaction(async (tx) => {
          if ((await tx.runCounted("UPDATE triggers SET enabled = 0, disabled = ?, updated_at = ? WHERE id = ?", why === undefined ? null : json(why), now(), triggerId)) === 0) {
            throw new StoreConstraint(`no trigger ${triggerId}`);
          }
          await writeScopes(tx, triggerId, []);
        });
      },
      fire: async (firing, run, { launch } = {}) =>
        this.#queued(await db.transaction(async (tx) => {
          const at = now();
          await checkSettingsGuards(tx, run.settingsGuards);
          // Match archive's agent -> trigger order. Preparation may have raced a trigger move; never start a run for
          // its former agent merely because that agent's admission guards still pass.
          await refuseDeleting(tx, run.agentId, run.expectedCurrent);
          await d.lockRow(tx, "triggers", "id", firing.triggerId);
          const trigger = await tx.get<{ agent_id: string }>("SELECT agent_id FROM triggers WHERE id = ?", firing.triggerId);
          if (!trigger) throw new StoreConstraint(`no trigger ${firing.triggerId}`);
          if (trigger.agent_id !== run.agentId) throw new StoreConstraint(`trigger ${firing.triggerId} no longer belongs to agent ${run.agentId}`);
          // Never a run of an archived agent: the archive's commit is read here, in the transaction that would start it.
          await refuseArchived(tx, run.agentId);
          const row = await tx.get<RunRecord>(`INSERT INTO runs (id, agent_id, revision_id, state, epoch, disk, started_at) VALUES (?, ?, ?, 'queued', 0, ?, ?) RETURNING ${RUN_COLUMNS}`, run.id, run.agentId, run.revisionId, launchDiskOf(launch), at);
          // The run's launch row lands with it, through the store's one writer, or neither does.
          if (launch) await writeLaunch(tx, run.id, launch, at);
          // The due firing the engine recorded becomes started; one not recorded yet is recorded started. A firing already
          // past due (started, or settled otherwise) is refused, and its run with it.
          const moved = await tx.runCounted(
            "UPDATE trigger_firings SET status = 'started', run_id = ?, retry_at = NULL, waits_on = NULL, payload = NULL, attrs = NULL, reason = NULL, attempts = 0 WHERE trigger_id = ? AND key = ? AND status = 'due'",
            run.id, firing.triggerId, firing.key,
          );
          if (moved === 0) {
            await tx.run(
              "INSERT INTO trigger_firings (trigger_id, key, by, nominal_at, status, at, run_id, catch_up) VALUES (?, ?, ?, ?, 'started', ?, ?, ?)",
              firing.triggerId, firing.key, firing.by ?? null, firing.nominalAt ?? null, at, run.id, firing.catchUp === undefined ? null : firing.catchUp ? 1 : 0,
            );
          }
          if ((await tx.runCounted("UPDATE triggers SET last_run_id = ?, failures_in_a_row = 0, updated_at = ? WHERE id = ?", run.id, at, firing.triggerId)) === 0) throw new StoreConstraint(`no trigger ${firing.triggerId}`);
          return runOf(row!);
        })),
    };

    this.runs = {
      create: async ({ id, agentId, revisionId, origin, labels, expectedCurrent, settingsGuards, startedAt }, launch) => {
        // sign_in_handed is not written here: the runner writes it at its claim (runs.update under the epoch fence).
        const insert = `INSERT INTO runs (id, agent_id, revision_id, state, epoch, labels, disk, started_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?) RETURNING ${RUN_COLUMNS}`;
        const labelled = labelsColumn(labels);
        // The run, its origin and its launch row in one transaction: the key -> run link holds even if the kept response
        // never lands, and a run never exists without the launch it was started with. Never a run of an agent being
        // deleted: its mark is read here, in the transaction that would start the run.
        return this.#queued(await db.transaction(async (tx) => {
          const at = now();
          await checkSettingsGuards(tx, settingsGuards);
          await refuseDeleting(tx, agentId, expectedCurrent);
          // A run made from another (a replay of its input, an audit's shadow) never of a purged one: its source's row
          // held as its purge holds it, so either this commits first and the purge finds it (RunsMadeFromLeft), or the
          // purge does and this reads its purge time.
          const of = launch ? madeOf(launch.body) : undefined;
          if (of !== undefined) {
            await d.lockRow(tx, "runs", "id", of);
            const source = await tx.get<{ purged_at: number | null }>("SELECT purged_at FROM runs WHERE id = ?", of);
            if (source && source.purged_at !== null) throw new RunPurged(of, id);
          }
          const row = await tx.get<RunRecord>(insert, id, agentId, revisionId, labelled, launchDiskOf(launch), startedAt ?? at);
          if (origin) await tx.run("INSERT INTO run_origins (key, run_id, fingerprint, created_at) VALUES (?, ?, ?, ?)", origin.key, id, origin.fingerprint ?? null, at);
          if (launch) await writeLaunch(tx, id, launch, at);
          return runOf(row!);
        }));
      },
      createInline: async ({ agent, revision, run, launch }) => {
        const insert = `INSERT INTO runs (id, agent_id, revision_id, state, epoch, labels, disk, started_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?) RETURNING ${RUN_COLUMNS}`;
        const made = await db.transaction(async (tx) => {
          const at = now();
          // Hold the external reference, so two first uses of the same expert serialize (SQLite's one writer already does).
          await d.lockKey(tx, `external:${agent.ref}`);
          // The agent, one per external reference: written on its first run, read on every later one.
          await tx.run(`${d.insertOrIgnore} INTO agents (id, name, description, created_at, external_ref) VALUES (?, ?, ?, ?, ?)${d.onConflictIgnore}`,
            agent.id, agent.name, agent.description ?? null, at, agent.ref);
          const mapped = (await tx.get<{ id: string; current_revision: string | null }>("SELECT id, current_revision FROM agents WHERE external_ref = ?", agent.ref))!;
          // An agent being deleted takes no run, nor a revision: the reference names it until its delete commits.
          await refuseDeleting(tx, mapped.id);
          // The revision, one per version: a version already stored keeps its body (a different body is refused); a new
          // version is written, made current, and brings the agent's name and description up to it (the source is the truth).
          const existing = await tx.get<{ id: string; body: string }>("SELECT id, body FROM revisions WHERE agent_id = ? AND external_version = ?", mapped.id, revision.version);
          let revisionId: string;
          if (existing) {
            if (canonical(JSON.parse(existing.body)) !== canonical(revision.body)) throw new ExternalBodyConflict(agent.ref, revision.version);
            revisionId = existing.id;
          } else {
            revisionId = revision.id;
            await tx.run("INSERT INTO revisions (id, agent_id, parent_id, kind, body, skills, note, package, external_version, created_at, mcp_pin, monid_pin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              revisionId, mapped.id, mapped.current_revision, revision.kind, json(revision.body),
              revision.skills === undefined || revision.skills === null ? null : json(revision.skills), revision.note ?? null, null, revision.version, at, pinText(revision.mcpPin), pinText(revision.monidPin));
            await tx.run("UPDATE agents SET current_revision = ?, name = ?, description = ? WHERE id = ?", revisionId, agent.name, agent.description ?? null, mapped.id);
          }
          // The run, its origin and its launch, in the same transaction as the agent and the revision.
          const row = await tx.get<RunRecord>(insert, run.id, mapped.id, revisionId, labelsColumn(run.labels), launchDiskOf(launch), at);
          if (run.origin) await tx.run("INSERT INTO run_origins (key, run_id, fingerprint, created_at) VALUES (?, ?, ?, ?)", run.origin.key, run.id, run.origin.fingerprint ?? null, at);
          await writeLaunch(tx, run.id, launch, at);
          return runOf(row!);
        });
        return this.#queued(made);
      },
      get: async (id) => {
        const row = await db.get<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, id);
        return row && runOf(row);
      },
      launch: (runId) => readLaunch(db, runId),
      usageMetadata: (runId, options) => readUsageMetadata(db, runId, options),
      projectCheckpoints: (filter) => readProjectCheckpoints(db, filter),
      learningStarts: (agentId) => readLearningStarts(db, agentId, NOT_A_LEARNING_RUN),
      seededBefore: (agentId, at) => readSeededBefore(db, agentId, at),
      list: async ({ agentId, revisionId, state, archived, labels, disk, limit, purged = false }) => {
        // A built-in learning run (a run's grade and merge, queued with its kept learning) is no run of a person's: no list,
        // count, stat or notice names it. A purged run is a tombstone: only the readers that sum or count ask for it.
        const where: string[] = [NOT_A_LEARNING_RUN, ...(purged ? [] : ["purged_at IS NULL"])];
        const params: SqliteValue[] = [];
        if (agentId !== undefined) (where.push("agent_id = ?"), params.push(agentId));
        if (revisionId !== undefined) (where.push("revision_id = ?"), params.push(revisionId));
        if (state !== undefined) (where.push("state = ?"), params.push(state));
        if (archived !== undefined) where.push(`archived_at IS ${archived ? "NOT NULL" : "NULL"}`);
        // Each label, key and value bound as parameters (never spliced into a JSON path), all of them held.
        for (const [key, value] of Object.entries(labels ?? {})) (where.push(d.jsonObjectHas("labels")), params.push(key, value));
        if (disk === null) where.push("disk IS NULL");
        else if (disk !== undefined) (where.push("disk = ?"), params.push(disk));
        const bounded = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0;
        if (bounded) params.push(limit);
        const rows = await db.all<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC${bounded ? " LIMIT ?" : ""}`, ...params);
        return rows.map(runOf);
      },
      // A list's page from the rows alone: filtered, ordered and cut to the page in the query, one read whatever the number
      // of runs, each row with its listing (schema.ts RUN_LISTING_COLUMNS) and its agent's archive time.
      listed: async ({ agentId, revisionId, labels, archived, status, going, after, limit, offset = 0 }) => {
        const n = clock();
        const behind = listingBehind(n.sql);
        // Neither a built-in learning run nor an audit's shadow run (learn/audit.ts SHADOW_PREFIX, matched as it is, case and all).
        const where: string[] = [`runs.${NOT_A_LEARNING_RUN}`, NOT_A_SHADOW_RUN];
        const params: SqliteValue[] = [];
        if (agentId !== undefined) (where.push("runs.agent_id = ?"), params.push(agentId));
        if (revisionId !== undefined) (where.push("runs.revision_id = ?"), params.push(revisionId));
        for (const [key, value] of Object.entries(labels ?? {})) (where.push(d.jsonObjectHas("runs.labels")), params.push(key, value));
        where.push(`COALESCE(runs.archived_at, agents.archived_at) IS ${archived ? "NOT NULL" : "NULL"}`, "runs.purged_at IS NULL");
        if (status !== undefined) (where.push("runs.list_status = ?"), params.push(status));
        // A run still going (no settled status on its row) whose listing is behind: its list_status may say what it was.
        if (going) (where.push(`(${SETTLED_LIST_STATUS}) IS NULL`, behind.sql), params.push(...behind.params(n.params)));
        if (after) (where.push("(runs.started_at < ? OR (runs.started_at = ? AND runs.id < ?))"), params.push(after.startedAt, after.startedAt, after.id));
        const rows = await db.all<RunRecord & { agent_archived_at: number | null; listing: string | null; list_status: string | null; list_mark: number; behind: number }>(
          `SELECT ${RUN_COLUMNS.split(", ").map((column) => `runs.${column}`).join(", ")}, agents.archived_at AS agent_archived_at, runs.listing, runs.list_status, runs.list_mark,
                  ${behind.sql} AS behind
             FROM runs JOIN agents ON agents.id = runs.agent_id WHERE ${where.join(" AND ")} ORDER BY runs.started_at DESC, runs.id DESC LIMIT ? OFFSET ?`,
          ...behind.params(n.params), ...params, limit + 1, offset,
        );
        return {
          rows: rows.slice(0, limit).map((row) => ({
            row: runOf(row), agentArchivedAt: row.agent_archived_at, listStatus: row.list_status, listMark: Number(row.list_mark), behind: Boolean(Number(row.behind)),
            listing: row.listing === null ? null : (JSON.parse(row.listing) as KeptListing),
          })),
          more: rows.length > limit,
        };
      },
      counts: async (agentId) => {
        const [row] = await db.all<{ count: number; live: number | null }>(
          `SELECT COUNT(*) AS count, SUM(CASE WHEN runs.state IN ('queued', 'running', 'parked')
               OR (runs.state = 'stopped' AND runs.outcome = 'stopped' AND runs.imported_from IS NULL AND revisions.kind = 'agentic') THEN 1 ELSE 0 END) AS live
             FROM runs JOIN revisions ON revisions.id = runs.revision_id
             WHERE runs.agent_id = ? AND ${NOT_A_SHADOW_RUN} AND runs.${NOT_A_LEARNING_RUN} AND runs.purged_at IS NULL`,
          agentId,
        );
        return { count: Number(row?.count ?? 0), live: Number(row?.live ?? 0) };
      },
      // The rows whose listing is behind, by the three ways one falls behind, each over its own partial index.
      behind: async ({ limit, offset = 0 }) => {
        const n = clock();
        const held = heldAt(n.sql);
        const rows = await db.all<{ id: string; mark: number; held: number }>(
          `SELECT id, list_mark AS mark, held FROM (
             SELECT id, list_mark, started_at, ${held} AS held FROM runs WHERE listing_mark < list_mark AND purged_at IS NULL
             UNION SELECT id, list_mark, started_at, ${held} AS held FROM runs WHERE listing_live = 1 AND NOT ${held}
             UNION SELECT id, list_mark, started_at, ${held} AS held FROM runs WHERE listing_until IS NOT NULL AND listing_until <= ${n.sql}
           ) AS behind ORDER BY held, started_at DESC, id DESC LIMIT ? OFFSET ?`,
          ...n.params, ...n.params, ...n.params, ...n.params, ...n.params, limit, offset,
        );
        return rows.map((row) => ({ id: row.id, mark: Number(row.mark), held: Boolean(Number(row.held)) }));
      },
      putListing: async (runId, mark, { item, cut, status, live, until, flags }) => {
        const [result] = await db.write([{
          sql: "UPDATE runs SET listing = ?, list_status = ?, listing_mark = ?, listing_live = ?, listing_until = ?, listing_flags = ? WHERE id = ? AND list_mark = ? RETURNING id",
          params: [json({ item, cut }), status, mark, live ? 1 : 0, until, flags, runId, mark],
        }]);
        return (result?.rows.length ?? 0) > 0;
      },
      listMark: async (runId) => {
        const row = await db.get<{ list_mark: number }>("SELECT list_mark FROM runs WHERE id = ?", runId);
        return row === undefined ? undefined : Number(row.list_mark);
      },
      // A heal of an ended run's unknown cost from its priced booking, as its end writes one (the bound beside the figure
      // with it, applyRunPatch): one conditional UPDATE, only over a null with no bound beside it (cost_upper_bound 0, the
      // column's no-bound value: it is never NULL), only at the end it was read at (a reopen or a later end moves ended_at
      // or the epoch), so it never overwrites a figure or a bound, whatever its caller read.
      healCost: async (runId, { epoch, endedAt }, { costUsd, costUpperBound }) => {
        if (!Number.isFinite(costUsd) || costUsd < 0) throw new TypeError(`a healed cost is a figure of $0 or more (got ${costUsd})`);
        const [result] = await db.write([{
          sql: `UPDATE runs SET cost_usd = ?, cost_upper_bound = ? WHERE id = ? AND ${COST_UNKNOWN} AND epoch = ? AND ended_at = ? RETURNING id`,
          params: [costUsd, costUpperBound ? 1 : 0, runId, epoch, endedAt],
        }]);
        return (result?.rows.length ?? 0) > 0;
      },
      // The runs healCost may write that the heal's rule (store-view.ts bookedCostOf, healOf) does not refuse by its
      // columns alone, so the start sweep never reads one that cannot heal again at each start: left out are a person's
      // stop of an agentic run (it reads running, stoppedByPerson), an agentic run whose launch names a native connection
      // (its end reads its own cost; a launch whose `native` is no connection is one no runner could read, so it booked
      // nothing either), and a run whose journal holds no runner.turn (no request booked with an answer: no figure to heal
      // to). Kept, and read at each start while their cost stays null: runs with a booked request whose booking still
      // gives no figure (a charge of no known cost, every request given back). Telling them apart is the booking rule
      // itself (turnCostOf over each turn's data), which no column holds.
      costUnknown: async ({ limit, after }) => {
        const agentic = "COALESCE((SELECT kind FROM revisions WHERE revisions.id = runs.revision_id), 'agentic') = 'agentic'";
        const rows = await db.all<{ id: string }>(
          `SELECT id FROM runs WHERE ${COST_UNKNOWN}
            AND NOT (state = 'stopped' AND COALESCE(outcome, '') = 'stopped' AND ${agentic})
            AND NOT (${agentic} AND EXISTS (SELECT 1 FROM run_launch WHERE run_launch.run_id = runs.id AND ${d.jsonText(readableJson(d, "run_launch.body"), ["native"])} IS NOT NULL))
            AND EXISTS (SELECT 1 FROM ${PI_TABLE.entries} AS entry WHERE entry.run_id = runs.id AND ${d.jsonText(readableJson(d, "entry.record"), ["kind"])} = ?)
            ${after === undefined ? "" : "AND id > ? "}ORDER BY id LIMIT ?`,
          RUNNER_RECORDS.turn, ...(after === undefined ? [] : [after]), limit,
        );
        return rows.map((row) => row.id);
      },
      relist: async ({ flags, agentId }) => {
        const [result] = await db.write([{
          sql: `UPDATE runs SET list_mark = list_mark + 1 WHERE listing_flags <> 0 AND (listing_flags & ?) <> 0${agentId === undefined ? "" : " AND agent_id = ?"} RETURNING id`,
          params: [flags, ...(agentId === undefined ? [] : [agentId])],
        }]);
        return result?.rows.length ?? 0;
      },
      // The run-change feed: the rows the runs_changed trigger wrote, each in its write's transaction, after the cursor's
      // seq. One writer numbers them in commit order, so the last one read is the watermark and the cursor is its seq. A
      // built-in learning run's changes are left out, as the run list leaves it out (NOT_A_LEARNING_RUN): its end is the
      // server's own work, never a person's run to tell of.
      changedSince: async (cursor, { limit } = {}) => {
        const after = cursor === undefined ? 0 : seqOf(cursor);
        const page = typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : RUN_CHANGES_PAGE;
        const rows = await db.all<{ seq: number; run_id: string; state: RunState; ended_at: number | null; epoch: number; runner: string | null }>(
          "SELECT seq, run_id, state, ended_at, epoch, runner FROM run_changes WHERE seq > ? AND run_id NOT IN (SELECT learning_run_id FROM learning_proposals WHERE learning_run_id IS NOT NULL) ORDER BY seq LIMIT ?",
          after,
          page,
        );
        const changes = rows.map((row) => ({ id: row.run_id, state: row.state, endedAt: row.ended_at, epoch: row.epoch, runner: row.runner }));
        return { changes, next: String(rows.length ? rows.at(-1)!.seq : after) };
      },
      // The last change's seq: with one writer, every change at or below it has committed (the watermark), and "0" with none.
      changesHead: async () => {
        const [row] = await db.all<{ head: number }>("SELECT COALESCE(MAX(seq), 0) AS head FROM run_changes");
        return String(row?.head ?? 0);
      },
      archive: async (runId, archived) => {
        // Archiving an archived run keeps its first time: a second archive is a no-op, never a new time.
        await db.write([archived ? { sql: "UPDATE runs SET archived_at = COALESCE(archived_at, ?) WHERE id = ?", params: [now(), runId] } : { sql: "UPDATE runs SET archived_at = NULL WHERE id = ?", params: [runId] }]);
      },
      every: async (agentId) =>
        (await db.all<{ id: string; state: RunState; runner: string | null; purged_at: number | null; disk: string | null }>("SELECT id, state, runner, purged_at, disk FROM runs WHERE agent_id = ? ORDER BY started_at, id", agentId))
          .map((row) => ({ id: row.id, state: row.state, runner: row.runner, purgedAt: row.purged_at ?? null, disk: row.disk ?? null })),
      madeFrom: async (runId) => {
        const learning = (await db.all<{ id: string }>(
          "SELECT DISTINCT learning_run_id AS id FROM learning_proposals WHERE run_id = ? AND learning_run_id IS NOT NULL AND learning_run_id <> ?",
          runId, runId,
        )).map((row) => row.id);
        return [...new Set([...(await launchedFrom(db, runId)), ...learning])].sort();
      },
      purge: (runId, kept) =>
        this.#purging(() => db.transaction(async (tx) => {
          // Held as a run's end holds it: a write under a claim of it is either in before this, or finds it final.
          await d.lockRow(tx, "runs", "id", runId, "update");
          const run = await tx.get<{ state: RunState; runner: string | null; metrics: string | null; purged_at: number | null }>("SELECT state, runner, metrics, purged_at FROM runs WHERE id = ?", runId);
          if (!run || run.purged_at !== null) return false;
          if (!(FINAL_STATES as readonly string[]).includes(run.state) || run.runner !== null) throw new StoreConstraint(`run ${runId} is ${run.state}${run.runner === null ? "" : ` under ${run.runner}'s claim`}: only a final run no runner holds is purged`);
          // A replay or shadow made from it after its purge read them (runs.create, under this row's lock) holds a copy of
          // its input: each is purged first.
          const left: string[] = [];
          for (const id of await launchedFrom(tx, runId)) {
            if ((await tx.get<{ purged_at: number | null }>("SELECT purged_at FROM runs WHERE id = ?", id))?.purged_at === null) left.push(id);
          }
          if (left.length) throw new RunsMadeFromLeft(runId, left);
          await dropRunContent(tx, runId);
          // What names it, let go: a trigger's last run, the firing that started it (its key and status kept, so it never
          // fires again; the event it was given, its payload and attributes, gone), a firing's wait behind it (the
          // trigger's room is read again, as for a run that ended), the run a machine's token was minted for.
          await tx.run("UPDATE triggers SET last_run_id = NULL WHERE last_run_id = ?", runId);
          await tx.run("UPDATE trigger_firings SET run_id = NULL, payload = NULL, attrs = NULL WHERE run_id = ?", runId);
          await tx.run("UPDATE trigger_firings SET waits_on = NULL WHERE waits_on = ?", runId);
          await tx.run("UPDATE minted_tokens SET run = NULL WHERE run = ?", runId);
          // Its kept learning: what its turn asked and answered and the proposal go; each row stays, with the proposal's
          // state alone, as the learning meter (learning.spend) and the list's leaving out of learning runs read it.
          for (const row of await tx.all<{ round: number; proposal: string }>("SELECT round, proposal FROM learning_proposals WHERE run_id = ?", runId)) {
            const state = (JSON.parse(row.proposal) as { state?: unknown } | null)?.state;
            await tx.run("UPDATE learning_proposals SET turn = '{}', proposal = ? WHERE run_id = ? AND round = ?", json(typeof state === "string" ? { state } : {}), runId, row.round);
          }
          // Its row's content, its metrics cut to their figures and names (tombstoneMetrics), with what its spend's readers
          // read from its journal folded in. Its outcome stays: a code (RunOutcome), never words.
          const metrics = tombstoneMetrics(run.metrics === null ? null : JSON.parse(run.metrics), kept);
          await tx.run("UPDATE runs SET summary = NULL, labels = NULL, sign_in_handed = NULL, metrics = ? WHERE id = ?", json(metrics), runId);
          // Its listing, and its purge time last: no list shows it, and no lister builds it again.
          await tx.run("UPDATE runs SET listing = NULL, list_status = NULL, listing_mark = list_mark, listing_live = 0, listing_until = NULL, listing_flags = 0, purged_at = ? WHERE id = ?", now(), runId);
          return true;
        })),
      remove: async (runId) => {
        await db.transaction(async (tx) => {
          // Held as a run's end holds it: a write under a claim of it is either in before this, or finds no row.
          await d.lockRow(tx, "runs", "id", runId, "update");
          const run = await tx.get<{ state: RunState }>("SELECT state FROM runs WHERE id = ?", runId);
          if (!run) return;
          if (!(FINAL_STATES as readonly string[]).includes(run.state)) throw new StoreConstraint(`run ${runId} is ${run.state}: only a final run is removed`);
          await dropRunContent(tx, runId);
          await tx.run("DELETE FROM learning_proposals WHERE run_id = ?", runId);
          // Its computers' usage, which a purge keeps (figures, no words).
          await tx.run("DELETE FROM computer_intervals WHERE run_id = ?", runId);
          await tx.run("DELETE FROM runs WHERE id = ?", runId);
        });
      },
      reopen: async (runId, { kind, body = null }, { launchSealed, endedAt } = {}) => {
        const command = await db.transaction(async (tx) => {
          // Never a run of an agent being deleted opened again (its mark, read in this transaction).
          const of = await tx.get<{ agent_id: string }>("SELECT agent_id FROM runs WHERE id = ?", runId);
          if (of) await refuseDeleting(tx, of.agent_id);
          // Back to running, released: the epoch, the journal, cost_usd and metrics stay (its next turn is booked on what it
          // spent); the end's own fields go. Only an agentic run that ended completed, not imported, not a learning run.
          const at = endedAt === undefined ? { sql: "", params: [] } : { sql: " AND ended_at = ?", params: [endedAt] };
          const reopened = await tx.runCounted(`UPDATE runs SET ${REOPEN_SET} WHERE id = ? AND ${reopenableWhere(d)}${at.sql}`, runId, ...at.params);
          if (reopened === 0) throw new RunFinal(runId);
          // The message's launch secrets, with it: the claim that runs its turn reads them.
          if (launchSealed) await writeLaunchSealed(tx, runId, launchSealed);
          await lockCommandsOf(tx, runId);
          const row = await tx.get<CommandRecord>(`INSERT INTO commands (run_id, kind, body, created_at) VALUES (?, ?, ?, ?) RETURNING ${COMMAND_COLUMNS}`, runId, kind, json(body), now());
          return commandOf(row!);
        });
        wakeCommands(this.where, { runId, what: "written" });
        return command;
      },
      wake: async (runId) => {
        // On the deadlines' clock (the database's on Postgres), as the claimable rule reads wake_at.
        const n = clock();
        const [result] = await db.write([{ sql: `UPDATE runs SET wake_at = ${n.sql} WHERE id = ? AND state = 'parked' RETURNING id`, params: [...n.params, runId] }]);
        return (result?.rows.length ?? 0) > 0;
      },
      claimable: async ({ limit } = {}) => {
        const claimable = claimableIn(d, clock());
        const bounded = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0;
        const rows = await db.all<{ id: string }>(`SELECT id FROM runs WHERE ${claimable.sql} ORDER BY started_at, id${bounded ? " LIMIT ?" : ""}`, ...claimable.params, ...(bounded ? [limit] : []));
        return rows.map((row) => row.id);
      },
      failUnclaimed: async (summary) => {
        // Queued is only ever written at a run's insert (epoch 0); a claim moves it to running and its epoch on. Each run
        // in a transaction of its own, fenced on that, so a claim that takes one meanwhile leaves it to its runner.
        const queued = await db.all<{ id: string }>("SELECT id FROM runs WHERE state = 'queued' AND epoch = 0 AND runner IS NULL ORDER BY started_at, id");
        const failed: string[] = [];
        for (const { id } of queued) {
          const ended = await db.transaction(async (tx) => {
            await d.lockRow(tx, "runs", "id", id, "update");
            const at = now();
            const n = storeNow(d, () => at);
            const row = await tx.get<{ id: string }>(
              `UPDATE runs SET state = 'failed', summary = ?, ended_at = ?, left_running_at = ${n.sql}, epoch = epoch + 1 WHERE id = ? AND state = 'queued' AND epoch = 0 AND runner IS NULL RETURNING id`,
              summary, at, ...n.params, id,
            );
            if (!row) return false;
            // As an end does: its untaken commands refused, its launch's secrets erased, in this same commit.
            await refuseLeftovers(tx, id, "failed", at, d);
            return true;
          });
          if (!ended) continue;
          failed.push(id);
          wakeCommands(this.where, { runId: id, what: "answered" });
        }
        return failed;
      },
      heldAt: async (runId) => {
        const n = clock();
        const row = await db.get<{ epoch: number | string }>(`SELECT epoch FROM runs WHERE id = ? AND runner IS NOT NULL AND claimed_until >= ${n.sql}`, runId, ...n.params);
        return row === undefined ? undefined : Number(row.epoch);
      },
      claimsOf: async (runner) => {
        const n = clock();
        const rows = await db.all<{ id: string; epoch: number | string; claimed_until: number | string }>(`SELECT id, epoch, claimed_until FROM runs WHERE runner = ? AND claimed_until >= ${n.sql}`, runner, ...n.params);
        return rows.map((row) => ({ runId: row.id, runner, epoch: Number(row.epoch), until: Number(row.claimed_until), from: "running" as const }));
      },
      claimMany: (runner, k,{ leaseMs = DEFAULT_LEASE_MS } = {}) => this.#claimRuns(runner, leaseMs, { k }),
      update: async (claim, patch, rows = {}) => {
        if (Array.isArray(rows) || typeof rows !== "object" || rows === null) throw new TypeError("runs.update's third argument is { also?, take?, signInSettleMs? }");
        const { also = [], take = [], signInSettleMs = 0 } = rows;
        const updated = await db.transaction(async (tx): Promise<UpdatedRun> => {
          // A run update may end the run, moving its epoch on: held against every write under the claim (dialect lockRow).
          await d.lockRow(tx, "runs", "id", claim.runId, "update");
          const at = now();
          const row = await applyRunPatch(tx, claim, patch, also, at, d, storeNow(d, () => at));
          for (const commandId of take) {
            if ((await tx.runCounted(`UPDATE commands SET taken_at = ?, ${settledBody(d)} WHERE id = ? AND run_id = ? AND taken_at IS NULL`, at, commandId, claim.runId)) === 0) {
              throw new CommandTaken(claim.runId, commandId);
            }
          }
          // An update that made the run final: its other untaken rows are refused in this transaction, after its own takes.
          await refuseLeftovers(tx, claim.runId, patch.state, at, d, patch.keepsEnd === true);
          // The bind's save lease, in this same transaction as the sign_in_handed write just made (applyRunPatch, under
          // SIGN_IN_HANDED_LOCK): this run saves unless another run already holds one of the handed pointers (a running run,
          // or — within signInSettleMs of leaving running, a vendor's settle window — one that left running less than that
          // ago). Excludes this run (it just wrote them), so a run is never its own blocker. Two binds of one sign-in in one
          // tick thus never both save.
          if (patch.signInHanded !== undefined && patch.signInHanded !== null && patch.signInHanded.length > 0) {
            let holder: { id: string } | undefined;
            for (const hash of patch.signInHanded) {
              holder = await handedHolderIn(tx, hash, { not: claim.runId, settleMs: signInSettleMs, now: storeNow(d, () => at) });
              if (holder) break;
            }
            return { ...row, save: holder === undefined };
          }
          return row;
        });
        // After the commit: the readers of this run's command answers in this process wake (a take, or the run gone final).
        if (take.length > 0 || patch.state === "ended" || patch.state === "stopped" || patch.state === "failed") wakeCommands(this.where, { runId: claim.runId, what: "answered" });
        return updated;
      },
    };

    /** The WHERE term of the API token's write over a saved row (McpTokensMark), its one `?` the source record's key: that
     *  setting still says the token saved this very row (`by` token, `of` the row's created_at). In the statement that
     *  writes or removes the row, so an owner's save, which drops the mark in the transaction that writes its row
     *  (dropTokensMark), never lands in between. */
    const recordJson = readableJson(d, "settings.value");
    const tokensMarked = `EXISTS (SELECT 1 FROM settings WHERE settings.key = ? AND ${d.jsonText(recordJson, ["by"])} = 'token' AND ${d.jsonValue(recordJson, ["of"])} = CAST(mcp_servers.created_at AS TEXT))`;

    /** A write of the saved server `name` that the token's mark decides (McpTokensMark, McpOwnersMark): one transaction that
     *  first holds the server's lock. SQLite's one writer holds it already; on Postgres it makes the token's statement wait
     *  for the owner's transaction to end, so the statement reads the record as that transaction left it (READ COMMITTED
     *  takes each statement's snapshot when it starts, after the lock). */
    const underMcpLock = <T>(name: string, work: (tx: Tx) => Promise<T>): Promise<T> => db.transaction(async (tx) => {
      await d.lockKey(tx, `mcp_servers:${name}`);
      return work(tx);
    });
    /** In the owner's write's transaction, once its row is written (McpOwnersMark): the record at `record` loses the token's
     *  marks (`by`, and `listed` where it saved it at a listed origin) when it still says the token saved that very row
     *  (`of` its created_at); the rest of it is kept, as mcp-sources.ts ownersRecord writes it. Any other record is left as
     *  it is. */
    const dropTokensMark = async (tx: Tx, { record }: McpOwnersMark, createdAt: number): Promise<void> => {
      const found = await tx.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", record);
      const value: unknown = found === undefined ? undefined : JSON.parse(found.value);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      const was = value as Record<string, unknown>;
      if (was.by !== "token" || was.of !== createdAt) return;
      const encoded = json(Object.fromEntries(Object.entries(was).filter(([field]) => field !== "by" && field !== "listed")));
      await tx.run("UPDATE settings SET value = ?, connector_id = ?, updated_at = ? WHERE key = ?", encoded, nativeCommandOwner(record, encoded), now(), record);
    };

    /** A server's write (Mcp.put), or with `expected` (Mcp.putIfCredential) only while the row's credential is still that:
     *  the statement's own WHERE compares it, so the comparison and the write are one statement. `tokens`: over a saved
     *  row, only while it still carries the token's mark, compared there too (a new row has none to carry). `owns`: the
     *  owner's write, dropping the token's mark in its transaction once the row is written. */
    const putServer = async (
      { name, url, auth, protocol = null, tools, prices = null, serverInfo = null, instructions = null, sealed = null, listedAt, updatedAt, credentialChangedAt, tokenLeftMs = null }: McpServerWrite,
      expected: McpCredentialMark | undefined,
      tokens?: McpTokensMark,
      owns?: McpOwnersMark,
    ): Promise<McpServerRow | undefined> => {
      const at = now();
      // The access token's end on the deadlines' clock (the database's on Postgres): the writer's measure of its life (a
      // duration, clock-free) laid on that clock's now (token_until), in the statement that writes it.
      const left = sealed !== null && typeof tokenLeftMs === "number" && Number.isFinite(tokenLeftMs) ? tokenLeftMs : null;
      const stamp = clock();
      // updated_at defaults to now (a save or a sign-in); a refresh passes the kept one so it is not read as an edit.
      // listed_at is the tools' listing time, now unless given.
      const updated = updatedAt ?? at;
      const listed = listedAt ?? at;
      // The credential's own time: now for a put that writes one, unless the caller says it kept the sealed one (its
      // time given back); null with none. A token refresh (keepRefreshed) never moves it.
      const credentialAt = sealed === null ? null : credentialChangedAt === undefined ? at : credentialChangedAt;
      const values = [url, auth, protocol, json(tools), json(prices), serverInfo === null ? null : json(serverInfo), instructions, sealed] as const;
      // Expected present: an UPDATE of that row while its credential is still the one expected (gone, or changed: no row).
      // Expected absent: an insert only (a row there: no row). Else the upsert. Either way RETURNING answers what it wrote.
      const statement = expected !== undefined && expected !== null
        ? {
          sql: `UPDATE mcp_servers SET url = ?, auth = ?, protocol = ?, tools = ?, prices = ?, server_info = ?, instructions = ?, sealed = ?, refresh_holder = NULL, refresh_until = NULL,
              updated_at = ?, listed_at = ?, credential_changed_at = ?, token_until = ${stamp.sql} + ${d.bigintParam}
            WHERE name = ? AND auth = ? AND sealed IS ${expected.sealed ? "NOT NULL" : "NULL"} AND ${expected.changedAt === null ? "credential_changed_at IS NULL" : "credential_changed_at = ?"}${tokens ? ` AND ${tokensMarked}` : ""}
            RETURNING ${mcpServerColumnsAt(stamp)}`,
          params: [...values, updated, listed, credentialAt, ...stamp.params, left, name, expected.auth, ...(expected.changedAt === null ? [] : [expected.changedAt]), ...(tokens ? [tokens.record] : []), ...stamp.params],
        }
        : {
          sql: `INSERT INTO mcp_servers (name, url, auth, protocol, tools, prices, server_info, instructions, sealed, created_at, updated_at, listed_at, credential_changed_at, token_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${stamp.sql} + ${d.bigintParam})
            ON CONFLICT (name) DO UPDATE SET url = excluded.url, auth = excluded.auth, protocol = excluded.protocol, tools = excluded.tools,
              prices = excluded.prices, server_info = excluded.server_info, instructions = excluded.instructions, sealed = excluded.sealed, refresh_holder = NULL, refresh_until = NULL, updated_at = excluded.updated_at, listed_at = excluded.listed_at, credential_changed_at = excluded.credential_changed_at, token_until = excluded.token_until
              ${expected === null ? "WHERE 1 = 0" : ""}
            RETURNING ${mcpServerColumnsAt(stamp)}`,
          params: [name, ...values, at, updated, listed, credentialAt, ...stamp.params, left, ...stamp.params],
        };
      const written = await writeMcpRow(name, statement, tokens, owns);
      return written && mcpServerOf(written);
    };

    /** `statement`, the write of server `name`'s row, answering the row it wrote (RETURNING): alone, or, when the token's mark
     *  decides it (`tokens`, `owns`), in one transaction under the server's lock (underMcpLock), the owner's dropping the
     *  mark once its row is written and only then. */
    const writeMcpRow = async (name: string, statement: Statement, tokens: McpTokensMark | undefined, owns: McpOwnersMark | undefined): Promise<McpServerRecord | undefined> => {
      if (!tokens && !owns) return (await db.write([statement]))[0]!.rows[0] as McpServerRecord | undefined;
      return underMcpLock(name, async (tx) => {
        const row = (await tx.step(statement)).rows[0] as McpServerRecord | undefined;
        if (row && owns) await dropTokensMark(tx, owns, mcpServerOf(row).createdAt);
        return row;
      });
    };

    const server = async (executor: Pick<SqliteExecutor, "get">, name: string) => {
      const at = clock();
      const row = await executor.get<McpServerRecord>(`SELECT ${mcpServerColumnsAt(at)} FROM mcp_servers WHERE name = ?`, ...at.params, name);
      return row && mcpServerOf(row);
    };
    this.mcp = {
      put: async (row) => (await putServer(row, undefined))!,
      putIfCredential: (row, expected, tokens, owns) => putServer(row, expected, tokens, owns),
      // One statement compares the row as read (its credential, address, auth type and last edit) and writes, as
      // keepRefreshed: no read between, so a refresh's keep never lands in a gap and is then written over, and a save with no
      // credential (the sealed column the same after it), whether it moved the row or only repriced it, is never written
      // back over: every save moves updated_at. The credential's columns and the refresh lease are not in its SET.
      rewrite: async ({ name, url, auth, protocol = null, tools, prices = null, serverInfo = null, instructions = null, listedAt, updatedAt }, seen, owns) => {
        const at = now();
        const stamp = clock();
        const row = await writeMcpRow(name, {
          sql: `UPDATE mcp_servers SET url = ?, auth = ?, protocol = ?, tools = ?, prices = ?, server_info = ?, instructions = ?, updated_at = ?, listed_at = ?
            WHERE name = ? AND ${d.nullSafeEquals("sealed")} AND url = ? AND auth = ? AND updated_at = ?
            RETURNING ${mcpServerColumnsAt(stamp)}`,
          params: [url, auth, protocol, json(tools), json(prices), serverInfo === null ? null : json(serverInfo), instructions, updatedAt ?? at, listedAt ?? at, name, seen.sealed, seen.url, seen.auth, seen.updatedAt, ...stamp.params],
        }, undefined, owns);
        return row && mcpServerOf(row);
      },
      remove: async (name) => {
        const [result] = await db.write([{ sql: "DELETE FROM mcp_servers WHERE name = ? RETURNING url, sealed", params: [name] }]);
        return removedOf(result!.rows[0] as { url: string; sealed: Uint8Array | null } | undefined);
      },
      removeIfCredential: async (name, expected, tokens) => {
        const statement = {
          sql: `DELETE FROM mcp_servers WHERE name = ? AND auth = ? AND sealed IS ${expected.sealed ? "NOT NULL" : "NULL"} AND ${expected.changedAt === null ? "credential_changed_at IS NULL" : "credential_changed_at = ?"}${tokens ? ` AND ${tokensMarked}` : ""} RETURNING url, sealed`,
          params: [name, expected.auth, ...(expected.changedAt === null ? [] : [expected.changedAt]), ...(tokens ? [tokens.record] : [])],
        };
        // The token's removal under the server's lock (underMcpLock): after an owner's write and its record, never between.
        const [result] = tokens ? [await underMcpLock(name, (tx) => tx.step(statement))] : await db.write([statement]);
        return removedOf(result!.rows[0] as { url: string; sealed: Uint8Array | null } | undefined);
      },
      servers: async () => {
        const at = clock();
        return (await db.all<McpServerRecord>(`SELECT ${mcpServerColumnsAt(at)} FROM mcp_servers ORDER BY name`, ...at.params)).map((row) => mcpServerOf(row));
      },
      server: (name) => server(db, name),
      stamp: async (name) => {
        const at = clock();
        const row = await db.get<{ url: string; auth: string; credential_changed_at: number | null; token_until: number | null; read_at: number }>(`SELECT url, auth, credential_changed_at, token_until, ${at.sql} AS read_at FROM mcp_servers WHERE name = ?`, ...at.params, name);
        return row && { url: row.url, auth: row.auth, credentialChangedAt: row.credential_changed_at === null ? null : Number(row.credential_changed_at), tokenLeftMs: row.token_until === null ? null : Number(row.token_until) - Number(row.read_at), tokenUntil: row.token_until === null ? null : Number(row.token_until) };
      },
      // The run's revision's, as its save pinned it: one row read, by the run's revision.
      pin: async (runId) => {
        const row = await db.get<McpPinRecord>("SELECT runs.id AS run_id, revisions.mcp_pin, revisions.created_at FROM runs JOIN revisions ON revisions.id = runs.revision_id WHERE runs.id = ? AND revisions.mcp_pin IS NOT NULL", runId);
        return row && mcpPinOf(row);
      },
      // The credential as read is compared by its bytes (`sealed IS ?`, NULL included): updated_at can repeat within a ms.
      leaseRefresh: async (name, { seen, holder, ms = MCP_REFRESH_LEASE_MS }) => {
        if (!(Number.isFinite(ms) && ms > MCP_REFRESH_CALL_MS)) {
          throw new RangeError(`a refresh lease must be longer than the refresh call's own deadline (${MCP_REFRESH_CALL_MS} ms), not ${ms} ms: it would lapse while its holder's call may still spend the token`);
        }
        return db.transaction(async (tx) => {
          // The lease is stamped and judged on the deadlines' clock (the database's on Postgres): one clock for every store
          // process, so a lease one runner holds is live to every other.
          const at = clock();
          const granted = await tx.runCounted(
            `UPDATE mcp_servers SET refresh_holder = ?, refresh_until = ${at.sql} + ? WHERE name = ? AND ${d.nullSafeEquals("sealed")} AND (refresh_until IS NULL OR refresh_until < ${at.sql})`,
            holder, ...at.params, ms, name, seen, ...at.params,
          );
          const row = await server(tx, name);
          if (!row) throw new StoreConstraint(`no MCP server ${name}: it is no longer saved`);
          return { leased: granted === 1, row };
        });
      },
      // One statement compares the credential and writes: no read between, so no other write lands in a gap. The lease is
      // cleared only by its own holder (a waiter that took a lapsed lease keeps it, and reads ours at its re-read).
      keepRefreshed: (name, { seen, sealed, holder, tokenLeftMs = null }) =>
        db.transaction(async (tx) => {
          const at = now();
          // The refreshed token's end on the deadlines' clock (token_until; the database's on Postgres), from the refresher's
          // measure of its life (a duration), laid on that clock in this statement.
          const left = typeof tokenLeftMs === "number" && Number.isFinite(tokenLeftMs) ? tokenLeftMs : null;
          const stamp = clock();
          const written = await tx.runCounted(
            `UPDATE mcp_servers SET sealed = ?, token_until = ${stamp.sql} + ${d.bigintParam},
              refresh_until = CASE WHEN refresh_holder = ? THEN NULL ELSE refresh_until END,
              refresh_holder = CASE WHEN refresh_holder = ? THEN NULL ELSE refresh_holder END,
              updated_at = ${d.greatest}(?, updated_at + 1)
             WHERE name = ? AND ${d.nullSafeEquals("sealed")}`,
            sealed, ...stamp.params, left, holder, holder, at, name, seen,
          );
          return { kept: written === 1, row: await server(tx, name) };
        }, { deadlineMs: STORE_WRITE_DEADLINE_MS, fromCall: true }),
      releaseRefresh: async (name, holder) => {
        await db.write([{ sql: "UPDATE mcp_servers SET refresh_holder = NULL, refresh_until = NULL WHERE name = ? AND refresh_holder = ?", params: [name, holder] }]);
      },
    };

    this.live = {
      // One transaction for the tick; each row written only under its run's current epoch and live lease (the SELECT finds
      // no run row for a stale or lapsed claim, so nothing is inserted or changed). The drop below stays on the epoch. The
      // run row is read under the share lock: a put never lands beside a run's end or a new claim still in flight.
      put: (rows) =>
        db.transaction(async (tx) => {
          const at = now();
          const written: string[] = [];
          const fenced: string[] = [];
          for (const { claim, state } of rows) {
            const fence = claimFence(claim, storeNow(d, () => at));
            const changed = await tx.runCounted(
              `INSERT INTO run_live (run_id, state, updated_at) SELECT id, ?, ? FROM runs WHERE ${fence.where}${d.shareLock}
                ON CONFLICT (run_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
              json(state), at, ...fence.params,
            );
            (changed > 0 ? written : fenced).push(claim.runId);
          }
          return { written, fenced };
        }),
      read: async (runIds) => {
        if (runIds.length === 0) return [];
        const rows = await db.all<{ run_id: string; state: string; updated_at: number }>(
          `SELECT run_id, state, updated_at FROM run_live WHERE run_id IN (${runIds.map(() => "?").join(", ")}) ORDER BY run_id`,
          ...runIds,
        );
        return rows.map((row): LiveRow => ({ runId: row.run_id, state: JSON.parse(row.state), updatedAt: row.updated_at }));
      },
      drop: async (claim) => {
        await db.write([{
          sql: `DELETE FROM run_live WHERE run_id = ? AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND epoch = ?${d.shareLock})`,
          params: [claim.runId, claim.runId, claim.epoch],
        }]);
      },
    };

    this.liveViewers = {
      // Under the claim's fence (its epoch and its lease, on the store's clock read in this transaction): the SELECT finds
      // no run row for a stale or lapsed claim, so nothing is inserted or changed, and the put answers false.
      put: (claim, viewer) =>
        db.transaction(async (tx) => {
          const at = now();
          const fence = claimFence(claim, storeNow(d, () => at));
          const changed = await tx.runCounted(
            `INSERT INTO computer_viewers (run_id, kind, tag, host, port, viewer_id, sealed, at, runner, epoch) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM runs WHERE ${fence.where}${d.shareLock}
              ON CONFLICT (run_id, kind, tag) DO UPDATE SET host = excluded.host, port = excluded.port, viewer_id = excluded.viewer_id, sealed = excluded.sealed, at = excluded.at, runner = excluded.runner, epoch = excluded.epoch`,
            viewer.kind, viewer.tag, viewer.host ?? null, viewer.port, viewer.id, viewer.sealed, at, claim.runner, claim.epoch, ...fence.params,
          );
          return changed > 0;
        }),
      // On the claim's epoch alone, as run_live's drop: a runner clearing its own rows after its lease ran out takes no
      // one else's. No kind clears the whole run; a kind with no tag that kind's rows; a kind and a tag that one row.
      drop: async (claim, kind, tag) => {
        const narrow = kind === undefined ? "" : tag === undefined ? " AND kind = ?" : " AND kind = ? AND tag = ?";
        const narrowParams = kind === undefined ? [] : tag === undefined ? [kind] : [kind, tag];
        await db.write([{
          sql: `DELETE FROM computer_viewers WHERE run_id = ?${narrow} AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND epoch = ?${d.shareLock})`,
          params: [claim.runId, ...narrowParams, claim.runId, claim.epoch],
        }]);
      },
      // The server's read: only the run's epoch, under a live lease on the store's clock, written by the run's runner.
      of: async (runId) => {
        const live = clock();
        const rows = await db.all<{ kind: ViewerKind; tag: string; host: string | null; port: number; viewer_id: string; sealed: Uint8Array; at: number; runner: string }>(
          `SELECT v.kind, v.tag, v.host, v.port, v.viewer_id, v.sealed, v.at, v.runner FROM computer_viewers v JOIN runs r ON r.id = v.run_id
            WHERE v.run_id = ? AND v.epoch = r.epoch AND r.claimed_until >= ${live.sql} AND v.runner = r.runner ORDER BY v.at DESC, v.tag`,
          runId, ...live.params,
        );
        return rows.map((row): LiveViewerRow => ({ kind: row.kind, tag: row.tag, ...(row.host !== null ? { host: row.host } : {}), port: row.port, id: row.viewer_id, sealed: new Uint8Array(row.sealed), at: row.at, runner: row.runner }));
      },
    };

    type ProposalRecord = { run_id: string; round: number; agent_id: string; turn: string; proposal: string; learning_run_id: string | null; created_at: number };
    const proposalOf = (row: ProposalRecord): LearningProposal => ({
      runId: row.run_id, round: Number(row.round), agentId: row.agent_id, turn: JSON.parse(row.turn), proposal: JSON.parse(row.proposal),
      ...(row.learning_run_id === null ? {} : { learningRunId: row.learning_run_id }), createdAt: row.created_at,
    });
    const PROPOSAL_COLUMNS = "run_id, round, agent_id, turn, proposal, learning_run_id, created_at";
    // A purged run's kept learning is its state alone (Runs.purge), for the learning meter: no reader of learning reads it.
    const NOT_PURGED = "NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = learning_proposals.run_id AND runs.purged_at IS NOT NULL)";
    this.learning = {
      // A round asked for, else the run's newest.
      proposal: async (runId, round) => {
        const row = round === undefined
          ? await db.get<ProposalRecord>(`SELECT ${PROPOSAL_COLUMNS} FROM learning_proposals WHERE run_id = ? AND ${NOT_PURGED} ORDER BY round DESC LIMIT 1`, runId)
          : await db.get<ProposalRecord>(`SELECT ${PROPOSAL_COLUMNS} FROM learning_proposals WHERE run_id = ? AND round = ? AND ${NOT_PURGED}`, runId, round);
        return row ? proposalOf(row) : undefined;
      },
      proposals: async (agentId, { limit = 100 } = {}) =>
        (await db.all<ProposalRecord>(
          `SELECT ${PROPOSAL_COLUMNS} FROM learning_proposals WHERE agent_id = ? AND ${NOT_PURGED} ORDER BY created_at DESC, run_id DESC, round DESC LIMIT ?`,
          agentId, limit,
        )).map(proposalOf),
      kept: async (agentId) => {
        const proposals = (await db.all<ProposalRecord>(`SELECT ${PROPOSAL_COLUMNS} FROM learning_proposals WHERE agent_id = ? AND ${NOT_PURGED} ORDER BY run_id, round`, agentId)).map(proposalOf);
        const learningRuns = (await db.all<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id IN (SELECT learning_run_id FROM learning_proposals WHERE agent_id = ? AND learning_run_id IS NOT NULL AND ${NOT_PURGED})`, agentId)).map(runOf);
        return { proposals, learningRuns };
      },
      spend: async ({ from, to }) => {
        type SpendRecord = { agent_id: string; proposal: string; created_at: number; learning_run_id: string | null; run_state: RunState | null; run_ended_at: number | null; run_cost_usd: number | null };
        const rows = await db.all<SpendRecord>(
          `SELECT lp.agent_id, lp.proposal, lp.created_at, lp.learning_run_id, lr.state AS run_state, lr.ended_at AS run_ended_at, ${EXACT_COST_USD("lr")} AS run_cost_usd
             FROM learning_proposals lp
             JOIN runs src ON src.id = lp.run_id
             LEFT JOIN runs lr ON lr.id = lp.learning_run_id
            WHERE src.imported_from IS NULL AND COALESCE(lr.ended_at, lp.created_at) >= ? AND COALESCE(lr.ended_at, lp.created_at) < ?
            ORDER BY COALESCE(lr.ended_at, lp.created_at), lp.run_id, lp.round`,
          from, to,
        );
        return rows.flatMap((row): LearningSpend[] => {
          // A proposal: once its learning run ended, failed or was stopped, its row's cost is the grade's spend (a stop
          // seen after a paid grade keeps it, learning-loop.ts).
          if (row.learning_run_id !== null) return row.run_state === "ended" || row.run_state === "failed" || row.run_state === "stopped" ? [{ agentId: row.agent_id, at: row.run_ended_at ?? row.created_at, costUsd: row.run_cost_usd }] : [];
          // Kept with no learning run: dropped before it was proposed (nothing graded), unless it is still a proposal.
          const kept = JSON.parse(row.proposal) as { state?: unknown } | null;
          return kept?.state === "proposed" ? [] : [{ agentId: row.agent_id, at: row.created_at, costUsd: 0 }];
        });
      },
    };

    this.settings = {
      get: async (key) => {
        const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
        return row === undefined ? undefined : JSON.parse(row.value);
      },
      put: async (key, value) => {
        const encoded=json(value);
        await db.write([{ sql: "INSERT INTO settings (key, value, connector_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, connector_id = excluded.connector_id, updated_at = excluded.updated_at", params: [key, encoded, nativeCommandOwner(key,encoded), now()] }]);
      },
      putIfAbsent: async (key, value, capacity) => {
        const encoded=json(value);
        if (capacity !== undefined) {
          if (typeof capacity.prefix !== "string" || !capacity.prefix || capacity.prefix.includes("\0") || !key.startsWith(capacity.prefix) || !Number.isSafeInteger(capacity.limit) || capacity.limit < 1)
            throw new TypeError("settings capacity requires a matching nonempty prefix and a positive safe integer limit");
          return db.transaction(async (tx) => {
            // SQLite holds its writer lock already; Postgres holds this schema's prefix lock until commit. The count
            // and insertion cannot interleave with another bounded insertion, even through an independent store handle.
            await d.lockKey(tx, `settings.capacity:${capacity.prefix}`);
            const existing = await tx.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
            if (existing !== undefined) return JSON.parse(existing.value);
            // Match Settings.all's literal prefix range: use the key index and never parse values or treat _/% as LIKE.
            const points = Array.from(capacity.prefix);
            let upper: string | undefined;
            for (let i = points.length - 1; i >= 0; i--) {
              const cp = points[i]!.codePointAt(0)!;
              if (cp < 0x10ffff) { upper = points.slice(0, i).join("") + String.fromCodePoint(cp + 1); break; }
            }
            const count = await tx.get<{ n: number }>(
              `SELECT count(*) AS n FROM settings WHERE key >= ?${upper === undefined ? "" : " AND key < ?"} AND substr(key, 1, length(?)) = ?`,
              capacity.prefix, ...(upper === undefined ? [] : [upper]), capacity.prefix, capacity.prefix,
            );
            if (Number(count?.n ?? 0) >= capacity.limit) return undefined;
            await tx.run("INSERT INTO settings (key, value, connector_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO NOTHING", key, encoded, nativeCommandOwner(key, encoded), now());
            const saved = await tx.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
            return saved === undefined ? undefined : JSON.parse(saved.value);
          });
        }
        await db.write([{ sql: "INSERT INTO settings (key, value, connector_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO NOTHING", params: [key, encoded, nativeCommandOwner(key,encoded), now()] }]);
        const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
        return row === undefined ? undefined : JSON.parse(row.value);
      },
      // `was` is compared as the JSON text put wrote: a row read and parsed gives the same text back, its keys in order.
      replaceIf: async (key, was, value, claim, guards) => {
        const encoded=json(value);
        if (claim || guards !== undefined) return db.transaction(async tx => {
          // Include the destination in the same sorted lock set. Source revocation and a publication's pointer move
          // are ordered in one transaction; when also claimed, settings precede the run's claim lock.
          if (guards !== undefined) await checkSettingsGuards(tx, guards, undefined, [key]);
          const at = claim ? await underClaim(tx, claim, now) : now();
          return await tx.runCounted("UPDATE settings SET value = ?, connector_id = ?, updated_at = ? WHERE key = ? AND value = ?", encoded, nativeCommandOwner(key,encoded), at, key, json(was)) === 1;
        });
        const [result] = await db.write([{ sql: "UPDATE settings SET value = ?, connector_id = ?, updated_at = ? WHERE key = ? AND value = ?", params: [encoded, nativeCommandOwner(key,encoded), now(), key, json(was)] }]);
        return result!.changes === 1;
      },
      removeIf: async (key, was) => {
        const [result] = await db.write([{ sql: "DELETE FROM settings WHERE key = ? AND value = ?", params: [key, json(was)] }]);
        return result!.changes === 1;
      },
      remove: async (key) => {
        await db.write([{ sql: "DELETE FROM settings WHERE key = ?", params: [key] }]);
      },
      all: async (filter) => {
        const clauses:string[]=[],params:string[]=[];
        if(filter?.connectorId!==undefined&&!validConnectorId(filter.connectorId))return [];
        if(filter){
          // Both stores order keys by bytes (Postgres settings.key is COLLATE C). This range also enables namespace indexes.
          const points=Array.from(filter.prefix);let upper:string|undefined;
          for(let i=points.length-1;i>=0;i--){const cp=points[i]!.codePointAt(0)!;if(cp<0x10ffff){upper=points.slice(0,i).join("")+String.fromCodePoint(cp+1);break;}}
          clauses.push("key >= ?");params.push(filter.prefix);
          if(upper!==undefined){clauses.push("key < ?");params.push(upper);}
          clauses.push("substr(key, 1, length(?)) = ?");params.push(filter.prefix,filter.prefix);
        }
        const selection=`SELECT key, value, updated_at FROM settings${clauses.length?` WHERE ${clauses.join(" AND ")}`:""}`;
        // Disjoint indexed branches: an OR lets SQLite choose a namespace scan over every connector's payload.
        // Null metadata is a legacy write racing setup; strict JS verification below never widens its owner.
        const query=filter?.connectorId===undefined?`${selection} ORDER BY key`:`${selection} AND connector_id = ? UNION ALL ${selection} AND connector_id IS NULL ORDER BY key`;
        const values=filter?.connectorId===undefined?params:[...params,filter.connectorId,...params];
        const rows=await db.all<SettingRecord>(query,...values);
        return rows.filter(row=>filter?.connectorId===undefined||nativeCommandOwner(row.key,row.value)===filter.connectorId).map(settingOf);
      },
    };

    this.sealedKeys = {
      get: async (name) => {
        const row = await db.get<{ sealed: Uint8Array }>("SELECT sealed FROM sealed_keys WHERE name = ?", name);
        return row === undefined ? undefined : Uint8Array.from(row.sealed);
      },
      put: async (name, sealed) => {
        await db.write([{ sql: "INSERT INTO sealed_keys (name, sealed, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at", params: [name, sealed, now()] }]);
      },
      replaceIf: async (name, was, sealed) => {
        const [result] = await db.write([{ sql: "UPDATE sealed_keys SET sealed = ?, updated_at = ? WHERE name = ? AND sealed = ?", params: [sealed, now(), name, was] }]);
        return result!.changes === 1;
      },
      remove: async (name) => {
        await db.write([{ sql: "DELETE FROM sealed_keys WHERE name = ?", params: [name] }]);
      },
      removeIf: async (name, was) => {
        const [result] = await db.write([{ sql: "DELETE FROM sealed_keys WHERE name = ? AND sealed = ?", params: [name, was] }]);
        return result!.changes === 1;
      },
      // The deadlines' clock (fence.ts storeNow): read from the database where the dialect names its clock (Postgres),
      // else the store's own.
      clock: async () => (d.nowSql ? Number((await db.get<{ now: string | number }>(`SELECT ${d.nowSql} AS now`))!.now) : now()),
      all: async () => (await db.all<SealedKeyRecord>("SELECT name, sealed, updated_at FROM sealed_keys ORDER BY name")).map(sealedKeyOf),
    };

    this.computerLedger = {
      put: async (provider, sessionId, labels, detail) => {
        await db.write([{ sql: "INSERT INTO computer_ledger (provider, session_id, labels, detail, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, session_id) DO UPDATE SET labels = excluded.labels, detail = excluded.detail, updated_at = excluded.updated_at", params: [provider, sessionId, JSON.stringify(labels), JSON.stringify(detail), now()] }]);
      },
      claim: async (provider, sessionId, labels, detail) => {
        const [result] = await db.write([{ sql: "INSERT INTO computer_ledger (provider, session_id, labels, detail, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, session_id) DO NOTHING", params: [provider, sessionId, JSON.stringify(labels), JSON.stringify(detail), now()] }]);
        return (result?.changes ?? 0) === 1;
      },
      get: async (provider, sessionId) => {
        const row = await db.get<ComputerLedgerRecord>("SELECT provider, session_id, labels, detail, updated_at FROM computer_ledger WHERE provider = ? AND session_id = ?", provider, sessionId);
        return row === undefined ? undefined : ledgerRowOf(row);
      },
      list: async (provider) => (await db.all<ComputerLedgerRecord>("SELECT provider, session_id, labels, detail, updated_at FROM computer_ledger WHERE provider = ? ORDER BY session_id", provider)).map(ledgerRowOf),
      remove: async (provider, sessionId) => {
        await db.write([{ sql: "DELETE FROM computer_ledger WHERE provider = ? AND session_id = ?", params: [provider, sessionId] }]);
      },
      // The row is compared as the JSON text put wrote: a row read and parsed gives the same text back, its keys in order.
      swap: async (provider, sessionId, was, labels, detail) => {
        const [result] = await db.write([{
          sql: "UPDATE computer_ledger SET labels = ?, detail = ?, updated_at = ? WHERE provider = ? AND session_id = ? AND labels = ? AND detail = ?",
          params: [JSON.stringify(labels), JSON.stringify(detail), now(), provider, sessionId, JSON.stringify(was.labels), JSON.stringify(was.detail)],
        }]);
        return (result?.changes ?? 0) === 1;
      },
    };

    this.computerIntervals = {
      opened: async (row) => {
        await db.write([{
          sql: "INSERT INTO computer_intervals (provider, provider_id, run_id, kind, gpu_type, gpu_count, cpus, memory_mb, disk_gb, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider, provider_id) DO NOTHING",
          params: [row.provider, row.providerId, row.runId, row.kind, row.gpuType, row.gpuCount, row.cpus, row.memoryMb, row.diskGb, row.startedAt],
        }]);
      },
      kept: async (provider, providerId) => {
        await db.write([{ sql: "UPDATE computer_intervals SET kept = 1 WHERE provider = ? AND provider_id = ?", params: [provider, providerId] }]);
      },
      ended: async (provider, providerId, at) => {
        await db.write([{ sql: "UPDATE computer_intervals SET ended_at = ? WHERE provider = ? AND provider_id = ? AND ended_at IS NULL", params: [at, provider, providerId] }]);
      },
      booked: async (provider, providerId, ms) => {
        if (!Number.isSafeInteger(ms) || ms <= 0) return;
        await db.write([{ sql: "UPDATE computer_intervals SET booked_ms = booked_ms + ? WHERE provider = ? AND provider_id = ?", params: [ms, provider, providerId] }]);
      },
      forRun: async (runId) =>
        (await db.all<ComputerIntervalRecord>("SELECT run_id, provider, provider_id, kind, gpu_type, gpu_count, cpus, memory_mb, disk_gb, started_at, kept, ended_at, booked_ms FROM computer_intervals WHERE run_id = ? ORDER BY started_at, provider, provider_id", runId)).map(intervalOf),
    };

    this.runAttempts = {
      lapsed: async (runId, epoch) => {
        await db.transaction(async (tx) => {
          // Held as a claim holds it, from its UPDATE of the run to its attempt row: a takeover in flight writes its row
          // (with the cause it read) before this reads it, and one after this reads the cut. Never a cause left unsaid.
          await d.lockRow(tx, "runs", "id", runId);
          await tx.run("UPDATE run_attempts SET cut = 'lease_lapse' WHERE run_id = ? AND epoch = ? AND cut IS NULL", runId, epoch);
          // The claim that took the run over read the lapse as a crash, if it came first: this says what it was.
          await tx.run("UPDATE run_attempts SET cause = 'lease_lapse' WHERE run_id = ? AND cause = 'crash' AND epoch = (SELECT min(epoch) FROM run_attempts WHERE run_id = ? AND epoch > ?)", runId, runId, epoch);
        });
      },
      forRun: async (runId) =>
        (await db.all<RunAttemptRecord>("SELECT run_id, epoch, turn, attempt, cause, cut, runner, from_state, journal_from, claimed_at FROM run_attempts WHERE run_id = ? ORDER BY epoch", runId)).map(attemptOf),
    };

    const PAIRED = "SELECT id, name, hello, driver, labels, pairing_id, created_at, seen_at, revoked_at FROM paired_computers";
    this.pairedComputers = {
      addCode: async (id, codeSha256, expiresAt) => {
        await db.write([
          { sql: "DELETE FROM pairing_codes WHERE expires_at <= ?", params: [now()] },
          { sql: "INSERT INTO pairing_codes (id, code_sha256, expires_at) VALUES (?, ?, ?)", params: [id, codeSha256, expiresAt] },
        ]);
      },
      // The code is burned and the computer written in one transaction: a code two drivers send at once pairs one.
      pair: (codeSha256, computer) =>
        db.transaction(async (tx) => {
          const at = now();
          const code = await tx.get<{ id: string }>("SELECT id FROM pairing_codes WHERE code_sha256 = ? AND expires_at > ?", codeSha256, at);
          if (code === undefined || (await tx.runCounted("DELETE FROM pairing_codes WHERE code_sha256 = ? AND expires_at > ?", codeSha256, at)) !== 1) return false;
          await tx.run(
            "INSERT INTO paired_computers (id, name, hello, driver, labels, token_sha256, pairing_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            computer.id, computer.name, JSON.stringify(computer.hello), String(computer.hello.version ?? ""), JSON.stringify(computer.labels), computer.tokenSha256, code.id, at,
          );
          return true;
        }),
      get: async (id) => {
        const row = await db.get<PairedRecord>(`${PAIRED} WHERE id = ?`, id);
        return row === undefined ? undefined : pairedOf(row);
      },
      byToken: async (tokenSha256) => {
        const row = await db.get<PairedRecord>(`${PAIRED} WHERE token_sha256 = ? AND revoked_at IS NULL`, tokenSha256);
        return row === undefined ? undefined : pairedOf(row);
      },
      list: async () => (await db.all<PairedRecord>(`${PAIRED} WHERE revoked_at IS NULL ORDER BY created_at, id`)).map(pairedOf),
      seen: async (id, hello) => {
        await db.write([{ sql: "UPDATE paired_computers SET seen_at = ?, hello = ?, driver = ? WHERE id = ? AND revoked_at IS NULL", params: [now(), JSON.stringify(hello), String(hello.version ?? ""), id] }]);
      },
      revoke: async (id) => {
        const [result] = await db.write([{ sql: "UPDATE paired_computers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", params: [now(), id] }]);
        return (result?.changes ?? 0) === 1;
      },
    };

    const MINTED = "SELECT machine, kind, os, arch, expires_at, revoked_at, created_at, runner, incarnation, run, refused FROM minted_tokens";
    this.mintedTokens = {
      // A mint for a machine that has one replaces it: its older token dials no more.
      mint: async ({ machine, tokenSha256, kind, os, arch, expiresAt, runner, incarnation, run }) => {
        const at = now();
        await db.write([
          { sql: "DELETE FROM minted_tokens WHERE expires_at <= ?", params: [at] },
          {
            sql: "INSERT INTO minted_tokens (machine, token_sha256, kind, os, arch, expires_at, created_at, runner, incarnation, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (machine) DO UPDATE SET token_sha256 = excluded.token_sha256, kind = excluded.kind, os = excluded.os, arch = excluded.arch, expires_at = excluded.expires_at, revoked_at = NULL, created_at = excluded.created_at, runner = excluded.runner, incarnation = excluded.incarnation, run = excluded.run, refused = NULL",
            params: [machine, tokenSha256, kind, os, arch, expiresAt, at, runner ?? null, incarnation ?? null, run ?? null],
          },
        ]);
      },
      byToken: async (tokenSha256) => {
        const row = await db.get<MintedRecord>(`${MINTED} WHERE token_sha256 = ? AND revoked_at IS NULL AND expires_at > ?`, tokenSha256, now());
        return row === undefined ? undefined : mintedOf(row);
      },
      get: async (machine) => {
        const row = await db.get<MintedRecord>(`${MINTED} WHERE machine = ?`, machine);
        return row === undefined ? undefined : mintedOf(row);
      },
      revoke: async (machine) => {
        const [result] = await db.write([{ sql: "UPDATE minted_tokens SET revoked_at = ? WHERE machine = ? AND revoked_at IS NULL", params: [now(), machine] }]);
        return (result?.changes ?? 0) === 1;
      },
      refuse: async (tokenSha256, words) => {
        await db.write([{ sql: "UPDATE minted_tokens SET refused = ? WHERE token_sha256 = ?", params: [words, tokenSha256] }]);
      },
    };

    // Stamped and judged on the deadlines' clock (fence.ts storeNow: the database's on Postgres), the one a claim's lease
    // runs on, so a runner on another host whose own clock is behind the server's never reads as gone (nor its relay).
    const RUNNERS_SELECT = "SELECT runner, incarnation, refused, host, port, seen_at, version, slots FROM runners";
    this.runners = {
      put: async ({ runner, incarnation, refused, host = null, port = null, version = null, slots = null }, { unlessLiveMs } = {}) => {
        const n = clock();
        // With unlessLiveMs, the upsert's WHERE leaves a row another incarnation renewed within it as it is, in the same
        // statement: no read between, so a later process's put can never land between a look and this write.
        const unlessLive = unlessLiveMs === undefined ? "" : ` WHERE runners.incarnation = excluded.incarnation OR runners.seen_at < excluded.seen_at - ${d.bigintParam}`;
        const [, result] = await db.write([
          { sql: `DELETE FROM runners WHERE seen_at < ${n.sql} - ${d.bigintParam}`, params: [...n.params, RUNNER_ROWS_KEPT_MS] },
          {
            sql: `INSERT INTO runners (runner, incarnation, refused, host, port, seen_at, version, slots) VALUES (?, ?, ?, ?, ?, ${n.sql}, ?, ?) ON CONFLICT (runner) DO UPDATE SET incarnation = excluded.incarnation, refused = excluded.refused, host = excluded.host, port = excluded.port, seen_at = excluded.seen_at, version = excluded.version, slots = excluded.slots${unlessLive}`,
            params: [runner, incarnation, refused, host, port, ...n.params, version, slots, ...(unlessLiveMs === undefined ? [] : [unlessLiveMs])],
          },
        ]);
        return (result?.changes ?? 0) === 1;
      },
      renew: async (runner, incarnation, at) => {
        const n = clock();
        const [result] = await db.write([{ sql: `UPDATE runners SET host = ?, port = ?, seen_at = ${n.sql} WHERE runner = ? AND incarnation = ?`, params: [at?.host ?? null, at?.port ?? null, ...n.params, runner, incarnation] }]);
        return (result?.changes ?? 0) === 1;
      },
      list: async () => (await db.all<RunnerRecord>(`${RUNNERS_SELECT} ORDER BY runner`)).map(runnerOf),
      live: async (staleMs) => {
        const n = clock();
        return (await db.all<RunnerRecord>(`${RUNNERS_SELECT} WHERE seen_at >= ${n.sql} - ${d.bigintParam} ORDER BY runner`, ...n.params, staleMs)).map(runnerOf);
      },
      remove: async (runner, incarnation) => {
        await db.write([{ sql: "DELETE FROM runners WHERE runner = ? AND incarnation = ?", params: [runner, incarnation] }]);
      },
      capacity: async (windowMs) => {
        // One read snapshot (Postgres: REPEATABLE READ READ ONLY; SQLite: one read transaction), so a claim or a release
        // that lands meanwhile never counts a run as both waiting and held, or as neither. The deadlines' clock is read
        // once in it, then bound into every count, so the counts judge one "now".
        return db.transaction(async (tx) => {
          const now = clock();
          const [read] = await tx.all<{ at: number | string }>(`SELECT ${now.sql} AS at`, ...now.params);
          const at = Number(read!.at);
          const n = { sql: d.bigintParam, params: [at] };
          const claimable = claimableIn(d, n);
          const [queued] = await tx.all<{ count: number | string }>(`SELECT count(*) AS count FROM runs WHERE ${claimable.sql}`, ...claimable.params);
          const held = await tx.all<{ runner: string; count: number | string }>(`SELECT runner, count(*) AS count FROM runs WHERE state IN ('running', 'parked') AND runner IS NOT NULL AND claimed_until >= ${n.sql} GROUP BY runner ORDER BY runner`, ...n.params);
          const [handBacks] = await tx.all<{ count: number | string }>(`SELECT count(*) AS count FROM hand_backs WHERE at >= ${n.sql} - ${d.bigintParam}`, ...n.params, windowMs);
          return { at, queued: Number(queued?.count ?? 0), held: new Map(held.map((row) => [row.runner, Number(row.count)])), handBacks: Number(handBacks?.count ?? 0) };
        }, { read: true });
      },
    };

    this.importedTemplates = {
      list: async () => (await db.all<ImportedTemplateRecord>("SELECT id, source, sha, publisher, files, imported_at FROM imported_templates ORDER BY id")).map((row) => ({
        id: row.id, source: row.source, sha: row.sha, publisher: row.publisher, files: JSON.parse(row.files) as Record<string, string>, importedAt: row.imported_at,
      })),
      ids: async () => (await db.all<{ id: string }>("SELECT id FROM imported_templates ORDER BY id")).map((row) => row.id),
      put: async ({ id, source, sha, publisher, files }) => {
        await db.write([{
          sql: "INSERT INTO imported_templates (id, source, sha, publisher, files, imported_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET source = excluded.source, sha = excluded.sha, publisher = excluded.publisher, files = excluded.files, imported_at = excluded.imported_at",
          params: [id, source, sha, publisher, JSON.stringify(files), now()],
        }]);
      },
      remove: async (id) => {
        const [result] = await db.write([{ sql: "DELETE FROM imported_templates WHERE id = ?", params: [id] }]);
        return (result?.changes ?? 0) === 1;
      },
    };

    this.triggerSettings = {
      get: async (adapter) => (await db.all<TriggerSettingRecord>("SELECT adapter, scope, field, sealed, updated_at FROM trigger_settings WHERE adapter = ? ORDER BY scope, field", adapter)).map(triggerSettingOf),
      put: async ({ adapter, scope, field, sealed }) => {
        await db.write([{ sql: "INSERT INTO trigger_settings (adapter, scope, field, sealed, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (adapter, scope, field) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at", params: [adapter, scope, field, sealed, now()] }]);
      },
      removeScope: async (adapter, scope) => {
        await db.write([{ sql: "DELETE FROM trigger_settings WHERE adapter = ? AND scope = ?", params: [adapter, scope] }]);
      },
    };

    this.channels = {
      post: async (post, told) =>
        db.transaction(async (tx) => {
          const added = await tx.runCounted(
            "INSERT INTO channel_posts (id, channel, run_id, moment, body, next_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT (id) DO NOTHING",
            post.id, post.channel, post.runId ?? null, post.moment, post.body, post.nextAt, now(),
          );
          if (told) {
            if (told.replacing !== undefined) await tx.run("DELETE FROM channel_told WHERE channel = ? AND run_id = ? AND substr(marker, 1, length(?)) = ?", post.channel, told.runId, told.replacing, told.replacing);
            await tx.run("INSERT INTO channel_told (channel, run_id, marker, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", post.channel, told.runId, told.marker, now());
          }
          return added > 0;
        }),
      get: async (id) => {
        const row = await db.get<ChannelPostRecord>(`SELECT ${CHANNEL_POST_COLUMNS} FROM channel_posts WHERE id = ?`, id);
        return row === undefined ? undefined : channelPostOf(row);
      },
      queued: async (channel) =>
        (await db.all<ChannelPostRecord>(`SELECT ${CHANNEL_POST_COLUMNS} FROM channel_posts WHERE channel = ? AND state IN ('queued', 'sending') ORDER BY created_at, id`, channel)).map(channelPostOf),
      // The claim and its read of the post in one transaction: the post as this claim took it (its count of tries).
      claim: async (id, at, leaseMs, token) =>
        db.transaction(async (tx) => {
          const took = await tx.runCounted(
            "UPDATE channel_posts SET state = 'sending', claimed_until = ?, claim = ? WHERE id = ? AND ((state = 'queued' AND next_at <= ?) OR (state = 'sending' AND claimed_until < ?))",
            at + leaseMs, token, id, at, at,
          );
          if (!took) return undefined;
          const row = await tx.get<ChannelPostRecord>(`SELECT ${CHANNEL_POST_COLUMNS} FROM channel_posts WHERE id = ? AND claim = ?`, id, token);
          return row === undefined ? undefined : channelPostOf(row);
        }),
      release: async (channel) =>
        db.transaction((tx) => tx.runCounted("UPDATE channel_posts SET state = 'queued', claimed_until = NULL, claim = NULL WHERE channel = ? AND state = 'sending'", channel)),
      settle: async (id, to, attempt, { kept = 50, sending = [], claim } = {}) =>
        db.transaction(async (tx) => {
          const post = await tx.get<{ channel: string }>("SELECT channel FROM channel_posts WHERE id = ?", id);
          if (!post) return false;
          // The fence: one UPDATE whose WHERE names the claim, so the check and the write are one compare-and-set. The
          // claim stays the try's after its write, so the same write again (its outcome unknown) writes the same row,
          // until a newer claim or a write outside every claim takes the post.
          const written = to === undefined ? 0 : claim !== undefined
            ? await tx.runCounted(
              "UPDATE channel_posts SET state = ?, attempts = COALESCE(?, attempts), next_at = COALESCE(?, next_at), reason = ?, claimed_until = NULL WHERE id = ? AND claim = ?",
              to.state, to.attempts ?? null, to.nextAt ?? null, to.reason ?? null, id, claim,
            )
            : await tx.runCounted(
              "UPDATE channel_posts SET state = ?, attempts = COALESCE(?, attempts), next_at = COALESCE(?, next_at), reason = ?, claimed_until = NULL, claim = NULL WHERE id = ?",
              to.state, to.attempts ?? null, to.nextAt ?? null, to.reason ?? null, id,
            );
          if (!attempt) return written > 0;
          // The try is logged whether or not its state was written (it was made); a retry_at only when its next try was set.
          await tx.run(
            "INSERT INTO channel_attempts (try_id, channel, post_id, moment, at, status_code, latency_ms, error, retry_at, redelivery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (try_id) DO NOTHING",
            attempt.tryId, post.channel, attempt.postId, attempt.moment, attempt.at, attempt.statusCode, attempt.latencyMs, attempt.error, written > 0 ? attempt.retryAt : null, attempt.redelivery ? 1 : 0,
          );
          await tx.run("DELETE FROM channel_attempts WHERE channel = ? AND seq NOT IN (SELECT seq FROM channel_attempts WHERE channel = ? ORDER BY seq DESC LIMIT ?)", post.channel, post.channel, kept);
          const sent = await tx.all<{ id: string }>("SELECT id FROM channel_posts WHERE channel = ? AND state IN ('sent', 'dropped') AND id NOT IN (SELECT post_id FROM channel_attempts WHERE channel = ?)", post.channel, post.channel);
          for (const { id: gone } of sent) if (!sending.includes(gone)) await tx.run("DELETE FROM channel_posts WHERE id = ?", gone);
          return written > 0;
        }),
      dropAll: async (channel, reason) =>
        db.transaction((tx) => tx.runCounted("UPDATE channel_posts SET state = 'dropped', reason = ?, claimed_until = NULL, claim = NULL WHERE channel = ? AND state IN ('queued', 'sending')", reason, channel)),
      attempts: async (channel, limit) =>
        (await db.all<ChannelAttemptRecord>("SELECT try_id, post_id, moment, at, status_code, latency_ms, error, retry_at, redelivery FROM channel_attempts WHERE channel = ? ORDER BY seq DESC LIMIT ?", channel, limit)).map(channelAttemptOf),
      told: async (channel, runId) =>
        (runId === undefined
          ? await db.all<ChannelToldRecord>("SELECT run_id, marker, at FROM channel_told WHERE channel = ? ORDER BY run_id, at, marker", channel)
          : await db.all<ChannelToldRecord>("SELECT run_id, marker, at FROM channel_told WHERE channel = ? AND run_id = ? ORDER BY at, marker", channel, runId)
        ).map((row) => ({ runId: row.run_id, marker: row.marker, at: Number(row.at) })),
      forget: async (channel, rows) => {
        if (!rows.length) return;
        await db.write(rows.map((row) => ({ sql: "DELETE FROM channel_told WHERE channel = ? AND run_id = ? AND marker = ?", params: [channel, row.runId, row.marker] })));
      },
    };

    this.mcpOauth = {
      put: async ({ state, server, sealed, working, expiresAt }) => {
        await db.write([{
          sql: `INSERT INTO mcp_oauth_pending (state, server, sealed, working, expires_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (state) DO UPDATE SET server = excluded.server, sealed = excluded.sealed, working = excluded.working, expires_at = excluded.expires_at`,
          params: [state, server, sealed, json(working), expiresAt],
        }]);
      },
      take: async (state, at) => {
        // One statement: delete the row and return it. On the store's single writer this is atomic, so two concurrent
        // takes of one state can never both get it (the second deletes nothing). The row is gone whether or not it had
        // expired; an expired one is refused by reading undefined after the delete, so a stale state can't be retried.
        const [result] = await db.write([{ sql: "DELETE FROM mcp_oauth_pending WHERE state = ? RETURNING state, server, sealed, working, expires_at", params: [state] }]);
        const row = result!.rows[0] as McpOauthRecord | undefined;
        if (row === undefined) return undefined;
        return row.expires_at <= (at ?? now()) ? undefined : mcpOauthOf(row);
      },
      sweepExpired: async (at) => (await db.write([{ sql: "DELETE FROM mcp_oauth_pending WHERE expires_at <= ?", params: [at] }]))[0]!.changes,
      count: async (at) => (await db.get<{ n: number }>("SELECT count(*) AS n FROM mcp_oauth_pending WHERE expires_at > ?", at))!.n,
    };

    // Every sealed column of every table, each with the AAD it was sealed under: the one read a runner's redaction set takes.
    this.sealedSecrets = {
      all: async () => {
        const out: SealedSecretRow[] = [];
        const bytes = (value: Uint8Array) => Uint8Array.from(value);
        // A row whose AAD cannot be built (a key holding the separator) was never sealed by this store's writers, which
        // build the same AAD: it is left out, never a failed read of every other.
        const add = (row: () => SealedSecretRow) => {
          try {
            out.push(row());
          } catch {
            // Left out: see above.
          }
        };
        for (const row of await db.all<{ name: string; sealed: Uint8Array }>("SELECT name, sealed FROM sealed_keys ORDER BY name")) {
          add(() => ({ plane: "sealed_keys", where: { name: row.name }, aad: aadOf(sealedAt.sealedKey(row.name)), sealed: bytes(row.sealed) }));
        }
        for (const row of await db.all<{ name: string; sealed: Uint8Array }>("SELECT name, sealed FROM mcp_servers WHERE sealed IS NOT NULL ORDER BY name")) {
          add(() => ({ plane: "mcp_servers", where: { name: row.name }, aad: aadOf(sealedAt.mcpServer(row.name)), sealed: bytes(row.sealed) }));
        }
        for (const row of await db.all<{ state: string; sealed: Uint8Array }>("SELECT state, sealed FROM mcp_oauth_pending ORDER BY state")) {
          add(() => ({ plane: "mcp_oauth_pending", where: { state: row.state }, aad: aadOf(sealedAt.oauthPending(row.state)), sealed: bytes(row.sealed) }));
        }
        for (const row of await db.all<{ adapter: string; scope: string; field: string; sealed: string }>("SELECT adapter, scope, field, sealed FROM trigger_settings ORDER BY adapter, scope, field")) {
          // Base64 text in this column (sealed-settings-store.ts), under the table's documented composite-key AAD.
          add(() => ({ plane: "trigger_settings", where: { adapter: row.adapter, scope: row.scope, field: row.field }, aad: `trigger_settings|${row.adapter}|${row.scope}|${row.field}`, sealed: Uint8Array.from(Buffer.from(row.sealed, "base64")) }));
        }
        for (const row of await db.all<{ agent_id: string; provider: string; pointer_sealed: Uint8Array }>("SELECT agent_id, provider, pointer_sealed FROM sign_ins ORDER BY agent_id, provider")) {
          add(() => ({ plane: "sign_ins", where: { agentId: row.agent_id, provider: row.provider }, aad: aadOf(sealedAt.signIn(row.agent_id, row.provider)), sealed: bytes(row.pointer_sealed) }));
        }
        // A tombstone keeps the pointer's sealed bytes under the live row's binding (store/seal.ts signIn).
        for (const row of await db.all<{ id: number; agent_id: string; provider: string; pointer_sealed: Uint8Array }>("SELECT id, agent_id, provider, pointer_sealed FROM sign_in_tombstones ORDER BY id")) {
          add(() => ({ plane: "sign_in_tombstones", where: { id: String(row.id), agentId: row.agent_id, provider: row.provider }, aad: aadOf(sealedAt.signIn(row.agent_id, row.provider)), sealed: bytes(row.pointer_sealed) }));
        }
        for (const row of await db.all<{ run_id: string; kind: string; tag: string; sealed: Uint8Array }>("SELECT run_id, kind, tag, sealed FROM computer_viewers ORDER BY run_id, kind, tag")) {
          add(() => ({ plane: "computer_viewers", where: { runId: row.run_id, kind: row.kind, tag: row.tag }, aad: aadOf(sealedAt.liveViewer(row.run_id, row.kind, row.tag)), sealed: bytes(row.sealed) }));
        }
        for (const row of await db.all<{ run_id: string; sealed: Uint8Array }>("SELECT run_id, sealed FROM run_launch WHERE sealed IS NOT NULL ORDER BY run_id")) {
          add(() => ({ plane: "run_launch", where: { runId: row.run_id }, aad: aadOf({ table: "run_launch", row: row.run_id, column: "sealed" }), sealed: bytes(row.sealed) }));
        }
        return out;
      },
    };

    this.signIns = {
      save: async ({ agentId, provider, name, pointerSealed }) => {
        const at = now();
        // A fresh save clears verified_at (the pointer is new, and no run has verified it yet) and numbers the save.
        const [result] = await db.write([{
          sql: `INSERT INTO sign_ins (agent_id, provider, name, pointer_sealed, saved_at, save, verified_at) VALUES (?, ?, ?, ?, ?, 1, NULL)
            ON CONFLICT (agent_id, provider) DO UPDATE SET name = excluded.name, pointer_sealed = excluded.pointer_sealed, saved_at = excluded.saved_at, save = sign_ins.save + 1, verified_at = NULL
            RETURNING ${SIGN_IN_COLUMNS}`,
          params: [agentId, provider, name, pointerSealed, at],
        }]);
        return signInOf(result!.rows[0] as SignInRecord);
      },
      saveIfAbsent: ({ agentId, provider, name, pointerSealed }) =>
        db.transaction(async (tx) => {
          // One transaction: the insert that wins or the live row that won before it, never a replace.
          const inserted = await tx.all<SignInRecord>(
            `INSERT INTO sign_ins (agent_id, provider, name, pointer_sealed, saved_at, save, verified_at) VALUES (?, ?, ?, ?, ?, 1, NULL)
              ON CONFLICT (agent_id, provider) DO NOTHING RETURNING ${SIGN_IN_COLUMNS}`,
            agentId, provider, name, pointerSealed, now(),
          );
          if (inserted[0]) return { saved: true, row: signInOf(inserted[0]) };
          const live = await tx.get<SignInRecord>(`SELECT ${SIGN_IN_COLUMNS} FROM sign_ins WHERE agent_id = ? AND provider = ?`, agentId, provider);
          return { saved: false, row: signInOf(live!) };
        }),
      list: async (agentId) =>
        (await db.all<SignInRecord>(`SELECT ${SIGN_IN_COLUMNS} FROM sign_ins WHERE agent_id = ? ORDER BY provider`, agentId)).map(signInOf),
      get: async (agentId, provider) => {
        const row = await db.get<SignInRecord>(`SELECT ${SIGN_IN_COLUMNS} FROM sign_ins WHERE agent_id = ? AND provider = ?`, agentId, provider);
        return row && signInOf(row);
      },
      verify: async (agentId, provider, at, { ifSave } = {}) => {
        // With ifSave, stamp only while the row is still that save (WHERE save = ?): a save that landed since the caller
        // checked (allowed while held; it clears verified_at) numbered itself on, in the same millisecond or not, so verify
        // never stamps it stale.
        const [result] = await db.write([{
          sql: `UPDATE sign_ins SET verified_at = ? WHERE agent_id = ? AND provider = ?${ifSave === undefined ? "" : " AND save = ?"}`,
          params: ifSave === undefined ? [at, agentId, provider] : [at, agentId, provider, ifSave],
        }]);
        return result!.changes > 0;
      },
      tombstones: async (agentId, provider) =>
        (await db.all<SignInTombstoneRecord>("SELECT agent_id, provider, pointer_sealed, forgotten_at FROM sign_in_tombstones WHERE agent_id = ? AND provider = ? ORDER BY id DESC", agentId, provider)).map(signInTombstoneOf),
      forget: (agentId, provider, held) =>
        db.transaction(async (tx) => {
          // The hold check and the move are one transaction: a launch writing sign_in_handed is another, and the store's one
          // writer lock serializes them, so forget never passes a hold a launch took, nor a launch a forget cleared. With many
          // writers, the lock both take (SIGN_IN_HANDED_LOCK) does.
          await d.lockKey(tx, SIGN_IN_HANDED_LOCK);
          const holder = held.hash !== undefined ? await handedHolderIn(tx, held.hash) : held.heldUnreadable ? await handedAnyIn(tx) : undefined;
          if (holder) throw new SignInHandedTo(holder.id);
          const live = await tx.get<SignInRecord>(`SELECT ${SIGN_IN_COLUMNS} FROM sign_ins WHERE agent_id = ? AND provider = ?`, agentId, provider);
          if (!live) throw new SignInMissing(agentId, provider);
          const at = now();
          const tomb = await tx.get<SignInTombstoneRecord>(
            "INSERT INTO sign_in_tombstones (agent_id, provider, pointer_sealed, forgotten_at) VALUES (?, ?, ?, ?) RETURNING agent_id, provider, pointer_sealed, forgotten_at",
            agentId, provider, live.pointer_sealed, at,
          );
          await tx.run("DELETE FROM sign_ins WHERE agent_id = ? AND provider = ?", agentId, provider);
          // Every tombstone is kept: what the agent learned is cut of each pointer it ever held (handed-values.ts
          // agentPointers), and a dropped one would be shown again.
          return signInTombstoneOf(tomb!);
        }),
      handedHolder: async (hash, options) => (await handedHolderIn(db, hash, { settleMs: options?.settleMs ?? 0, now: options?.at !== undefined ? { sql: d.bigintParam, params: [options.at] } : clock() }))?.id,
      handedAny: async () => (await handedAnyIn(db))?.id,
    };
  }

  /** A purge (runs.purge, agents.purge, `work` its transaction, true when it purged), on a SQLite store with a file:
   *  secureRewrite's marker first, then the purge, then a WAL checkpoint (TRUNCATE). secure_delete (worker.ts open) zeroes
   *  the purged bytes in the pages the purge writes, but those pages are new frames in the WAL: the file keeps its earlier
   *  images of them, and the WAL its earlier frames, until a checkpoint copies the zeroed pages into the file and truncates
   *  the log. The marker is written before any byte changes, as secureRewrite's is: one that cannot be written (a full
   *  disk) throws with nothing purged, so the client's retry purges whole; a server that dies past it leaves it, and its
   *  next start's scrub truncates the log. A reader in another connection (a runner's read, a backup) may hold the log
   *  back: the checkpoint waits PURGE_CHECKPOINT_BUSY_MS for it, not the connection's own busy wait, since every request of
   *  the store's one connection queues behind it. One it held back (or that failed) keeps the marker for the next start.
   *  The marker goes once no file keeps what the purge changed (the log truncated, or nothing committed: a purge refused or
   *  failed rolled back), under secureRewrite's own rule: only one that was not there before this purge wrote it (a
   *  rewrite's or an earlier start's needs that start's VACUUM), and that no other writer wrote since (#scrubMarks). */
  async #purging(work: () => Promise<boolean>): Promise<void> {
    const marker = this.#scrubMarker;
    const db = this.#db;
    if (marker === undefined || !(db instanceof Connection)) return void (await work());
    const pending = existsSync(marker);
    const mine = ++this.#scrubMarks;
    try {
      markScrub(marker);
    } catch (error) {
      throw new Error(`The purge's scrub marker could not be written (${(error as Error).message}): nothing was purged.`, { cause: error });
    }
    const done = () => {
      if (pending || this.#scrubMarks !== mine) return;
      try {
        rmSync(marker, { force: true });
      } catch {
        // Left for the next start's scrub, which costs it a VACUUM: never a failure of a purge that committed.
      }
    };
    let purged: boolean;
    try {
      purged = await work();
    } catch (error) {
      done();
      throw error;
    }
    if (purged && (await db.checkpoint(PURGE_CHECKPOINT_BUSY_MS).catch(() => undefined))?.busy !== 0) return;
    done();
  }

  async secureRewrite(work: () => Promise<number>, options: SecureRewriteOptions = {}): Promise<SecureRewrite> {
    const marker = this.#scrubMarker;
    const db = this.#db;
    if (marker === undefined || !(db instanceof Connection)) return { rewritten: await work() };
    // Written before any byte changes: a server that dies after the rewrite committed, and before the scrub below is done,
    // leaves it, and its next start scrubs though no row is left in the clear.
    const pending = existsSync(marker);
    const mine = ++this.#scrubMarks;
    markScrub(marker);
    // secure_delete is on for the connection's whole life (worker.ts open): a rewritten row's old bytes are zeroed in its page.
    const rewritten = await work();
    // Nothing rewritten, and the marker is this call's alone: no purge or other rewrite wrote it while the work ran
    // (#scrubMarks). One that did needs the checkpoint below, or the next start's scrub.
    if (rewritten === 0 && !pending && this.#scrubMarks === mine) {
      rmSync(marker, { force: true });
      return { rewritten };
    }
    // Asked with no VACUUM (a server already serving): the marker stays, and the next start's scrub runs it before it serves.
    if (options.vacuum === false) return { rewritten, left: "deferred" };
    // A copy an update of the row left before secure_delete was on (a store an earlier server wrote: a pause, a rename, a
    // firing) is in a free block or page still. VACUUM rebuilds the file with neither, through the log; the
    // checkpoint copies it into the file and truncates the log. Run outside any transaction.
    try {
      // Another connection's write (a runner's) may hold the lock past the busy wait: one retry after a short pause.
      await this.#db.all("VACUUM").catch(async (error: unknown) => {
        if (!(error instanceof StoreBusy)) throw error;
        await new Promise((resolve) => setTimeout(resolve, VACUUM_RETRY_MS));
        await this.#db.all("VACUUM");
      });
      const marksBefore = this.#scrubMarks;
      const checkpoint = await db.checkpoint();
      // A reader in another connection (a runner, a backup) held the log back: the old frames are there until a
      // checkpoint is done, so the marker stays. So does one a purge or another rewrite wrote after this checkpoint was
      // asked: its frames may be past it.
      if (checkpoint?.busy !== 0 || this.#scrubMarks !== marksBefore) return { rewritten, left: "busy" };
    } catch (error) {
      return { rewritten, left: error instanceof StoreBusy ? "busy" : "failed" };
    }
    rmSync(marker, { force: true });
    return { rewritten };
  }

  async claim(runId: string, runner: string, { leaseMs = DEFAULT_LEASE_MS }: { leaseMs?: number } = {}): Promise<Claim | null> {
    return (await this.#claimRuns(runner, leaseMs, { runId }))[0] ?? null;
  }

  /** Claims, in one transaction, the run `runId` when it is claimable, or up to `k` claimable runs oldest first: each read
   *  with its state (the claim's `from`) and moved to its next epoch under the same BEGIN IMMEDIATE, so no other claimer
   *  takes it between. */
  async #claimRuns(runner: string, leaseMs: number, pick: { runId: string } | { k: number }): Promise<Claim[]> {
    if ("k" in pick && !(Number.isSafeInteger(pick.k) && pick.k > 0)) return [];
    return this.#db.transaction(async (tx) => {
      // The clock is read once the transaction holds the writer lock: a claim that waited for another writer runs its
      // lease from now, never comes back already run out. The deadlines' clock (the database's on Postgres) both judges what
      // is claimable and stamps the lease, which comes back from the row.
      const claimable = claimableIn(this.#db.dialect, this.#clock());
      // With many claimers (Postgres), the rows picked are locked as they are read. A poll over many (claimMany) skips a
      // row another claimer holds (Dialect.claimLock): two claims never pick one run, and neither waits for the other. A
      // claim of one named run waits for a write in flight on its row (Dialect.claimOneLock), then reads it as it is: a
      // run whose holder is merely writing is never answered held.
      const lock = "runId" in pick ? this.#db.dialect.claimOneLock : this.#db.dialect.claimLock;
      const picked = "runId" in pick
        ? await tx.all<{ id: string; state: RunState; runner: string | null }>(`SELECT id, state, runner FROM runs WHERE id = ? AND ${claimable.sql}${lock}`, pick.runId, ...claimable.params)
        : await tx.all<{ id: string; state: RunState; runner: string | null }>(`SELECT id, state, runner FROM runs WHERE ${claimable.sql} ORDER BY started_at, id LIMIT ?${lock}`, ...claimable.params, pick.k);
      if (picked.length === 0) return [];
      const stamp = this.#clock();
      const rows = await tx.all<{ id: string; epoch: number; claimed_until: number }>(
        `UPDATE runs SET ${claimSet(stamp)} WHERE id IN (${picked.map(() => "?").join(", ")}) RETURNING id, epoch, claimed_until`,
        runner, ...stamp.params, leaseMs, ...picked.map((row) => row.id),
      );
      const epochs = new Map(rows.map((row) => [row.id, row.epoch]));
      const untils = new Map(rows.map((row) => [row.id, Number(row.claimed_until)]));
      // A take or reclaim leaves no viewer of an older claim behind: its rows go in this transaction, every kind, in one
      // statement for the whole batch (each run's epoch is the one just moved to), never one round trip a run.
      if (rows.length > 0) await tx.run(
        `DELETE FROM computer_viewers WHERE run_id IN (${rows.map(() => "?").join(", ")}) AND epoch < (SELECT epoch FROM runs WHERE runs.id = computer_viewers.run_id)`,
        ...rows.map((row) => row.id),
      );
      // A newer claim of a run supersedes its release here: journal() refuses by epoch, and the newer epoch passes.
      for (const { id } of picked) this.#released.delete(id);
      // A running run that still names its runner was taken from it: that runner's lease ran out mid-run (CLAIMABLE).
      const lostOf = (state: RunState, held: string | null) => (state === "running" && held !== null ? held : undefined);
      const attempts = await this.#attemptsAt(tx, runner, stamp, picked.map(({ id, state, runner: held }) => ({ runId: id, epoch: epochs.get(id)!, from: state, lost: lostOf(state, held) !== undefined })));
      return picked.map(({ id, state, runner: held }) => {
        const lost = lostOf(state, held);
        const at = attempts.get(id);
        return { runId: id, runner, epoch: epochs.get(id)!, until: untils.get(id)!, from: state, ...(lost !== undefined ? { lost: { runner: lost } } : {}), ...(at ? { turn: at.turn, attempt: at.attempt } : {}) };
      });
    });
  }

  /** Each claim's turn and attempt (run_attempts), written in the claim's transaction `tx`, in three statements for the
   *  whole batch: the run's latest claim before it, and the run's next journal id now (no write under an older claim can
   *  land after this one: each commit is fenced on the run's row, which this transaction holds). A claim that takes a run
   *  still running from a claim that was cut (that claim's release said why, or its lease ran out) works that claim's turn
   *  again, one attempt more; any other claim starts the run's next turn (a follow-up, a resume after a park, the first).
   *  The cause is the cut claim's word, else a crash (a lease that ran out with no word), else a retry. Only when the
   *  latest row is that cut claim's own: a claim moves the epoch one and a release one more, so the claim taken over is at
   *  epoch - 1 (its lease ran out) or epoch - 2 (released). A row further back belongs to an earlier claim, past one that
   *  wrote none (a runner of an earlier build, beside this server): that unrecorded claim's turn is not that row's, so this
   *  claim starts a new turn, and nothing that row's claim did is read as redone. */
  async #attemptsAt(tx: Tx, runner: string, stamp: StoreNow, claims: readonly { runId: string; epoch: number; from: RunState; lost: boolean }[]): Promise<Map<string, { turn: number; attempt: number }>> {
    const out = new Map<string, { turn: number; attempt: number }>();
    if (claims.length === 0) return out;
    const ids = claims.map((claim) => claim.runId);
    const marks = ids.map(() => "?").join(", ");
    const before = new Map((await tx.all<{ run_id: string; epoch: number | string; turn: number | string; attempt: number | string; cut: string | null }>(
      `SELECT run_id, epoch, turn, attempt, cut FROM run_attempts a WHERE run_id IN (${marks}) AND epoch = (SELECT max(epoch) FROM run_attempts b WHERE b.run_id = a.run_id)`, ...ids,
    )).map((row) => [row.run_id, row]));
    const next = new Map((await tx.all<{ run_id: string; next_id: string }>(`SELECT run_id, next_id FROM pi_metadata WHERE run_id IN (${marks})`, ...ids)).map((row) => [row.run_id, Number(row.next_id)]));
    const rows: SqliteValue[][] = [];
    for (const claim of claims) {
      const prev = before.get(claim.runId);
      // The claim taken over is the latest row's only at epoch - 1 (lost: no release moved it) or epoch - 2 (released, cut).
      const replaced = prev !== undefined && Number(prev.epoch) === claim.epoch - (claim.lost ? 1 : 2) ? prev : undefined;
      const redone = claim.from === "running" && replaced !== undefined && (claim.lost || replaced.cut !== null) ? replaced : undefined;
      const turn = prev === undefined ? 1 : Number(prev.turn) + (redone ? 0 : 1);
      const attempt = redone ? Number(redone.attempt) + 1 : 1;
      const cause: AttemptCause | null = redone ? ((redone.cut as AttemptCause | null) ?? (claim.lost ? "crash" : "retry")) : null;
      out.set(claim.runId, { turn, attempt });
      rows.push([claim.runId, claim.epoch, turn, attempt, cause, runner, claim.from, next.get(claim.runId) ?? JOURNAL_FIRST_ID]);
    }
    await tx.run(
      `INSERT INTO run_attempts (run_id, epoch, turn, attempt, cause, runner, from_state, journal_from, claimed_at) VALUES ${rows.map(() => `(?, ?, ?, ?, ?, ?, ?, ?, ${stamp.sql})`).join(", ")} ON CONFLICT (run_id, epoch) DO NOTHING`,
      ...rows.flatMap((row) => [...row, ...stamp.params]),
    );
    return out;
  }

  /** Holds the run's row before a fenced write reads the store's clock: the lease is checked, and runs, from when the write
   *  holds the row, never from before a wait for another writer (a no-op on SQLite, whose BEGIN IMMEDIATE already holds
   *  the writer lock when the clock is read). */
  #holdRun(tx: Tx, runId: string): Promise<void> {
    return this.#db.dialect.lockRow(tx, "runs", "id", runId);
  }

  async renew(claim: Claim, { leaseMs = DEFAULT_LEASE_MS }: { leaseMs?: number } = {}): Promise<Claim> {
    // As a claim's: the lease runs from when the renew holds the writer lock.
    // A lease that ran out is gone: no renew brings it back (its runner takes the run again, at a new epoch).
    const until = await this.#db.transaction(async (tx) => {
      await this.#holdRun(tx, claim.runId);
      // The deadlines' clock (the database's on Postgres) judges the lease and stamps the next one.
      const now = this.#clock();
      const fence = claimFence(claim, now);
      await tx.step(fenced(claim, `UPDATE runs SET claimed_until = ${now.sql} + ? WHERE ${fence.where} AND runner = ?`, [...now.params, leaseMs, ...fence.params, claim.runner]));
      return Number((await tx.get<{ claimed_until: number }>("SELECT claimed_until FROM runs WHERE id = ?", claim.runId))!.claimed_until);
    }, { lease: true });
    return { ...claim, until };
  }

  async renewMany(claims: readonly Claim[], { leaseMs = DEFAULT_LEASE_MS }: { leaseMs?: number } = {}): Promise<(Claim | Fenced)[]> {
    if (claims.length === 0) return [];
    // One transaction for every claim, in a few statements whatever their count: the rows held in one, then one update
    // for each RENEW_CHUNK claims, each claim under its own fence. A runner's 300 claims are never 300 round trips with
    // their rows held, which on a database a few ms away outlast the lease's margin and lose every claim at once. A claim
    // another runner took changes no row and is answered Fenced, never rolling the others back.
    return this.#db.transaction(async (tx) => {
      // Every row held first, in one order (the dialect's, by run id), so two renews of overlapping runs never wait on
      // each other in a cycle, and the clock below is read once the rows are held.
      await this.#db.dialect.lockRows(tx, "runs", "id", [...new Set(claims.map((claim) => claim.runId))]);
      const renewed = new Map<string, number>();
      for (let at = 0; at < claims.length; at += RENEW_CHUNK) {
        const chunk = claims.slice(at, at + RENEW_CHUNK);
        // The deadlines' clock (the database's on Postgres) judges each lease and stamps the next one.
        const now = this.#clock();
        const fences = chunk.map((claim) => claimFence(claim, now));
        const rows = await tx.all<{ id: string; epoch: number; runner: string; claimed_until: number }>(
          `UPDATE runs SET claimed_until = ${now.sql} + ? WHERE ${fences.map((fence) => `(${fence.where} AND runner = ?)`).join(" OR ")} RETURNING id, epoch, runner, claimed_until`,
          ...now.params, leaseMs, ...fences.flatMap((fence, i) => [...fence.params, chunk[i]!.runner]),
        );
        for (const row of rows) renewed.set(renewKey(row.id, Number(row.epoch), row.runner), Number(row.claimed_until));
      }
      return claims.map((claim) => {
        const until = renewed.get(renewKey(claim.runId, claim.epoch, claim.runner));
        return until === undefined ? new Fenced(claim.runId, claim.epoch) : { ...claim, until };
      });
      // On the lease connection (TransactionOptions.lease): a runner whose loops hold every pool client still renews.
    }, { lease: true });
  }

  async release(claim: Claim, { state, wakeAt = null, backoffUntil = null, cut }: { state?: ReleasedState; wakeAt?: number | null; backoffUntil?: number | null; cut?: "drain" | "retry" } = {}): Promise<void> {
    // The end commit is the one write that makes a run final (applyRunPatch: the leftover rows refused and the run_live
    // row deleted with it). A release never does: asked to, it is refused before anything is written.
    if (state !== undefined && FINAL_STATES.includes(state as RunState)) throw new TypeError(`a release never makes a run final (asked for ${state}): only the run's end commit does, refusing its leftover rows with it`);
    // A release that gives the run back with no state (or 'running') keeps it running (its runner shut down): it still holds
    // its sign-in. One that parks it leaves 'running', so stamp when — the Browserbase settle window reads left_running_at.
    const leaving = state !== undefined && state !== "running";
    await this.#db.transaction(async (tx) => {
      // A run its end already made final was released by that end (applyRunPatch): this release is a no-op, no second
      // move of its epoch and no error, whatever its claim's lease says now. The release moves the epoch: the row is held
      // against every write under the claim (dialect lockRow "update"), so one in flight lands first.
      await this.#db.dialect.lockRow(tx, "runs", "id", claim.runId, "update");
      const final = await tx.get<{ state: RunState; runner: string | null }>("SELECT state, runner FROM runs WHERE id = ?", claim.runId);
      if (final && FINAL_STATES.includes(final.state) && final.runner === null) return;
      // The deadlines' clock (the database's on Postgres) judges the lease and stamps when the run left running.
      const now = this.#clock();
      const fence = claimFence(claim, now);
      await tx.step(fenced(
        claim,
        // The epoch moves on at a release: the released claim is dead everywhere (its journal, its run updates, its takes),
        // never live until the next claim. A claim whose lease ran out releases nothing: the run, running with its lease run
        // out, is claimable at once, never stuck.
        `UPDATE runs SET epoch = epoch + 1, runner = NULL, claimed_until = NULL, wake_at = ?, backoff_until = ?, state = coalesce(?, state)${leaving ? `, left_running_at = ${now.sql}` : ""} WHERE ${fence.where} AND runner = ?`,
        [wakeAt, backoffUntil, state ?? null, ...(leaving ? now.params : []), ...fence.params, claim.runner],
      ));
      // A release that leaves the run running is a hand-back (schema.ts HAND_BACKS): kept in this same write for the
      // capacity read, with the rows past HAND_BACKS_KEPT_MS removed. A park, or a release of a parked run, is none.
      if ((state ?? final?.state) === "running") {
        await tx.run(`DELETE FROM hand_backs WHERE at < ${now.sql} - ${this.#db.dialect.bigintParam}`, ...now.params, HAND_BACKS_KEPT_MS);
        await tx.run(`INSERT INTO hand_backs (run_id, runner, epoch, at) VALUES (?, ?, ?, ${now.sql})`, claim.runId, claim.runner, claim.epoch, ...now.params);
      }
      // Why the claim let its run go unfinished, on its own row, in the release's transaction: the next claim reads it.
      if (cut !== undefined) await tx.run("UPDATE run_attempts SET cut = ? WHERE run_id = ? AND epoch = ? AND cut IS NULL", cut, claim.runId, claim.epoch);
    }, { full: true });
    // The released claim's journal is dead (its epoch moved on): the store keeps it no longer, and refuses it from now.
    this.#journals.delete(journalKey(claim));
    this.#released.delete(claim.runId);
    this.#released.set(claim.runId, claim.epoch);
    if (this.#released.size > RELEASED_KEPT) this.#released.delete(this.#released.keys().next().value!);
  }

  /** The claim's one journal (pi assumes one Storage per owner): asked again for the same claim while it is open, the same
   *  journal, so two callers never mint the same ids. The store keeps it only while it is open and its claim held: its
   *  close, or its claim's release, drops it, so a long-lived runner keeps no journal of a finished claim. */
  journal(claim: Claim): Journal {
    const released = this.#released.get(claim.runId);
    if (released !== undefined && claim.epoch <= released) throw new Fenced(claim.runId, claim.epoch);
    const key = journalKey(claim);
    const open = this.#journals.get(key);
    if (open && !open.closed) return open;
    const journal: RunStorage = new RunStorage(this.#db, claim, this.#now, () => {
      if (this.#journals.get(key) === journal) this.#journals.delete(key);
    }, this.where);
    this.#journals.set(key, journal);
    return journal;
  }

  /** A run's journal opened for reading only (no claim): a fresh RunStorage on the store's connection, its reads alone. A
   *  read never checks the epoch (only a commit's fence does), so the view carries epoch 0 and never writes; its type
   *  (JournalReads) hands out no commit, stage or mintId. The store keeps no reference to it — it holds no claim and two
   *  readers of one run never share ids, since neither mints any. A run with no journal yet reads as empty. */
  readJournal(runId: string): JournalReads {
    return new RunStorage(this.#db, { runId, epoch: 0 }, this.#now);
  }

  async snapshot<T>(read: (store: Store) => Promise<T>): Promise<T> {
    return this.#db.transaction((tx) => read(new SqliteStore(snapshotOf(this.#db, tx), this.#now, this.origin)), { read: true });
  }

  /** How many journals the store keeps (open, of a claim not released). */
  get openJournals(): number {
    return this.#journals.size;
  }

  async flush(): Promise<void> {
    await this.#db.write([{ sql: "UPDATE store_meta SET flushes = flushes + 1 WHERE singleton = 1" }], { full: true });
  }

  async command(runId: string, { kind, body = null }: { kind: string; body?: unknown }, { launchSealed }: LaunchSealedWrite = {}): Promise<Command> {
    const result = await this.#db.transaction(async (tx) => {
      await lockCommandsOf(tx, runId);
      const inserted = await tx.step({
        // The run row read under the share lock: a command never lands while the run's end is in flight, to be left untaken
        // by an end that refused the run's leftover rows before it (the end waits for it, or it waits for the end).
        sql: `INSERT INTO commands (run_id, kind, body, created_at) SELECT id, ?, ?, ? FROM runs WHERE id = ? AND state NOT IN (${FINAL})${tx.dialect.shareLock} RETURNING ${COMMAND_COLUMNS}`,
        params: [kind, json(body), this.#now(), runId],
        expect: { kind: "final", runId },
      });
      // The message's launch secrets, in the command's own write: written only when the command is (a final run refuses both).
      if (launchSealed) await writeLaunchSealed(tx, runId, launchSealed);
      return inserted;
    });
    wakeCommands(this.where, { runId, what: "written" });
    return commandOf(result.rows[0] as CommandRecord);
  }

  watchCommands(listener: (event: { readonly runId: string; readonly what: "written" | "answered" | "queued" }) => void): () => void {
    return watchCommandsAt(this.where, listener);
  }

  /** `run`, just committed queued: this process's runners are told it is claimable now (watchCommands' "queued"). */
  #queued<R extends { readonly id: string }>(run: R): R {
    wakeCommands(this.where, { runId: run.id, what: "queued" });
    return run;
  }

  async answerOf(runId: string, commandId: number): Promise<{ readonly value: unknown } | undefined> {
    // Read and cleared in one transaction, so two readers never both get it. A refused row never holds one.
    const text = await this.#db.transaction(async (tx) => {
      const row = await tx.get<{ answer: string | null }>("SELECT answer FROM commands WHERE id = ? AND run_id = ? AND taken_at IS NOT NULL AND refused IS NULL", commandId, runId);
      if (row?.answer === undefined || row.answer === null) return undefined;
      // The clear counts: a reader that lost the race to another one clears nothing and gets nothing.
      return (await tx.runCounted("UPDATE commands SET answer = NULL WHERE id = ? AND run_id = ? AND answer IS NOT NULL", commandId, runId)) === 0 ? undefined : row.answer;
    });
    return text === undefined ? undefined : { value: JSON.parse(text) };
  }

  async commands(runId: string, after: number): Promise<Command[]> {
    return (await this.#db.all<CommandRecord>(`SELECT ${COMMAND_COLUMNS} FROM commands WHERE run_id = ? AND id > ? ORDER BY id`, runId, after)).map(commandOf);
  }

  async runOfOrigin(key: string): Promise<{ runId: string; fingerprint: string | null } | undefined> {
    const row = await this.#db.get<{ run_id: string; fingerprint: string | null }>("SELECT run_id, fingerprint FROM run_origins WHERE key = ?", key);
    return row && { runId: row.run_id, fingerprint: row.fingerprint };
  }

  async commandsOf(cursors: readonly { runId: string; after: number }[]): Promise<Map<string, Command[]>> {
    const out = new Map<string, Command[]>();
    if (cursors.length === 0) return out;
    // One read for every run: each cursor a (run_id, after) row of a VALUES list joined against the commands.
    const rows = await this.#db.all<CommandRecord>(
      `WITH cursors(run_id, after) AS (VALUES ${cursors.map(() => `(?, ${this.#db.dialect.bigintParam})`).join(", ")})
       SELECT ${COMMAND_COLUMNS.split(", ").map((column) => `commands.${column}`).join(", ")} FROM commands JOIN cursors ON commands.run_id = cursors.run_id AND commands.id > cursors.after ORDER BY commands.id`,
      ...cursors.flatMap((cursor) => [cursor.runId, cursor.after]),
    );
    for (const row of rows) {
      const command = commandOf(row);
      out.set(command.runId, [...(out.get(command.runId) ?? []), command]);
    }
    return out;
  }

  async importRun(run: ImportRunInput): Promise<RunRow> {
    const at = this.#now();
    const state = run.state ?? "ended";
    return this.#db.transaction(async (tx) => {
      await checkSettingsGuards(tx, run.settingsGuards, "The source import grant changed before the history write committed.");
      if (run.requireActiveAgent) {
        // Archive updates this same row. It either commits first and refuses this import, or waits for this
        // already-admitted history transaction; a read outside the transaction cannot establish that order.
        const agent = await tx.get<{ id: string }>("UPDATE agents SET archived_at = archived_at WHERE id = ? AND archived_at IS NULL RETURNING id", run.agentId);
        if (!agent) throw new StoreConstraint("The agent was archived before the history write committed.");
      }
      // The ended run row, its launch row and its transcript's journal, all in this one transaction (the server's own
      // writer): a crash between them leaves nothing. The run is created at epoch 0 with no runner, and the journal's fence
      // passes for that one row, by the rowid its insert returned (the claim fence's inserted-here form).
      const row = await tx.get<RunRecord & { inserted_rowid: number | null }>(
        `INSERT INTO runs (id, agent_id, revision_id, state, epoch, cost_usd, metrics, summary, outcome, imported_from, disk, started_at, ended_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${this.#db.dialect.insertedRow} AS inserted_rowid, ${RUN_COLUMNS}`,
        run.id, run.agentId, run.revisionId, state, run.costUsd ?? null,
        run.metrics === undefined || run.metrics === null ? null : json(run.metrics), run.summary ?? null,
        run.outcome ?? null, JSON.stringify(run.importedFrom), launchDiskOf(run.launch), run.startedAt, run.endedAt ?? at,
      );
      await writeLaunch(tx, run.id, run.launch, at);
      await new RunStorage(this.#db, { runId: run.id, epoch: 0 }, this.#now).applyIn(tx, run.transcript, row!.inserted_rowid ?? "this-transaction");
      return runOf(row!);
    });
  }

  async take(claim: Claim, commandId: number, outcome: "taken" | "refused" = "taken", reason?: string): Promise<void> {
    // The clock is read inside the transaction, so the lease check and the write are one.
    await this.#db.transaction(async (tx) => {
      const now = await underClaim(tx, claim, this.#now);
      await tx.run(`UPDATE commands SET taken_at = ?, refused = ?, ${settledBody(this.#db.dialect)} WHERE id = ? AND run_id = ? AND taken_at IS NULL`, now, outcome === "refused" ? (reason ?? "refused") : null, commandId, claim.runId);
    });
    wakeCommands(this.where, { runId: claim.runId, what: "answered" });
  }

  async retry(claim: Claim, commandId: number): Promise<number> {
    const counted = await this.#db.transaction(async (tx) => {
      await underClaim(tx, claim, this.#now);
      return tx.all<{ tries: number }>("UPDATE commands SET tries = tries + 1 WHERE id = ? AND run_id = ? AND taken_at IS NULL RETURNING tries", commandId, claim.runId);
    });
    const row = counted[0];
    if (!row) throw new StoreConstraint(`run ${claim.runId}: command ${commandId} is taken, or not the run's: no try to count`);
    return row.tries;
  }

  close(): Promise<void> {
    return this.#db.close();
  }
}
