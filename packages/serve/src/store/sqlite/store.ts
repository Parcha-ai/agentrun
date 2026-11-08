// SqliteStore: the Store (store.ts) on one SQLite file, through the one connection (connection.ts, on its worker thread).
// The only code with SQL in it, besides the schema and the run patch. The file is on local disk, never on Archil: one
// connection per process, and SQLite's one writer lock serializes the server's and every runner's commits. A unit of work
// with more than one statement is one transaction (connection.transaction, BEGIN IMMEDIATE): all of it or none of it.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunStorage } from "../journal/storage.js";
import { DDL, SCHEMA_VERSION } from "../schema.js";
import {
  CommandTaken, RefreshLeaseLost, SchemaVersionUnknown, StoreConstraint, StoreFromEarlierVersion, TriggerFull,
  type AgentRow, type Agents, type AlsoRow, type Claim, type Command, type FiringChange, type FiringRow, type FiringStatus, type Journal, type NewRevision, type RevisionRow, type RunPatch, type RunRow, type Runs,
  type RunState, type Store, type StoreRole, type TemplatePackage, type Templates, type TriggerDef, type TriggerPatch, type TriggerRow, type Triggers, type TriggerScope,
  FINAL_STATES, MCP_REFRESH_CALL_MS, MCP_REFRESH_LEASE_MS, type Live, type LiveRow, type Mcp, type McpPinRow, type McpServerRow,
} from "../store.js";
import { Connection, type SqliteExecutor, type SqliteValue, type Statement } from "./connection.js";
import { applyRunPatch, RUN_COLUMNS, runOf, type RunRecord } from "./run-patch.js";

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

type AgentRecord = { id: string; name: string; description: string | null; current_revision: string | null; created_at: number; archived_at: number | null };
type RevisionRecord = { id: string; agent_id: string; kind: string; body: string; package: string | null; created_at: number };
type CommandRecord = { id: number; run_id: string; kind: string; body: string; created_at: number; taken_at: number | null; refused: string | null; tries: number };
type TriggerRecord = {
  id: string; agent_id: string; name: string; enabled: number; source: string; target: string; next_at: number | null; last_run_id: string | null;
  catchup_window_s: number | null; failures_in_a_row: number; disabled: string | null; max_active_runs: number | null; created_at: number; updated_at: number;
};
type FiringRecord = {
  trigger_id: string; key: string; by: string | null; nominal_at: number | null; status: FiringStatus; at: number; run_id: string | null; reason: string | null;
  error: string | null; count: number | null; attempts: number; retry_at: number | null; payload: string | null; attrs: string | null; notified: number | null;
  catch_up: number | null; paused: number | null; shown: number | null; waits_on: string | null;
};
const FIRING_COLUMNS = "trigger_id, key, by, nominal_at, status, at, run_id, reason, error, count, attempts, retry_at, payload, attrs, notified, catch_up, paused, shown, waits_on";
const firingOf = (r: FiringRecord): FiringRow => ({
  triggerId: r.trigger_id, key: r.key, by: r.by ?? "manual", nominalAt: r.nominal_at ?? r.at, status: r.status, at: r.at, runId: r.run_id, reason: r.reason,
  error: r.error === null ? null : JSON.parse(r.error), count: r.count, attempts: r.attempts, retryAt: r.retry_at, payload: r.payload,
  attrs: r.attrs === null ? null : JSON.parse(r.attrs), notified: r.notified === 1, catchUp: r.catch_up === 1, paused: r.paused === 1, shown: r.shown !== 0, waitsOn: r.waits_on,
});
/** The trigger's patch as columns: name -> [column, value]. */
const TRIGGER_PATCH: { [K in keyof TriggerPatch]-?: (value: NonNullable<TriggerPatch[K]> | null) => [string, SqliteValue] } = {
  name: (v) => ["name", v],
  enabled: (v) => ["enabled", v ? 1 : 0],
  source: (v) => ["source", json(v)],
  target: (v) => ["target", json(v)],
  nextAt: (v) => ["next_at", v],
  catchupWindowS: (v) => ["catchup_window_s", v],
  failuresInARow: (v) => ["failures_in_a_row", v ?? 0],
  disabled: (v) => ["disabled", v === null ? null : json(v)],
  maxActiveRuns: (v) => ["max_active_runs", v],
};
/** `patch`'s columns, `updated_at` with them: the SET clause and its values. */
function triggerSet(patch: TriggerPatch, at: number): { set: string; params: SqliteValue[] } {
  const pairs = (Object.keys(patch) as (keyof TriggerPatch)[]).filter((k) => patch[k] !== undefined).map((k) => (TRIGGER_PATCH[k] as (v: unknown) => [string, SqliteValue])(patch[k] as unknown));
  pairs.push(["updated_at", at]);
  return { set: pairs.map(([column]) => `${column} = ?`).join(", "), params: pairs.map(([, value]) => value) };
}

const AGENT_COLUMNS = "id, name, description, current_revision, created_at, archived_at";
const REVISION_COLUMNS = "id, agent_id, kind, body, package, created_at";
const COMMAND_COLUMNS = "id, run_id, kind, body, created_at, taken_at, refused, tries";
const TRIGGER_COLUMNS = "id, agent_id, name, enabled, source, target, next_at, last_run_id, catchup_window_s, failures_in_a_row, disabled, max_active_runs, created_at, updated_at";
const FINAL = FINAL_STATES.map((state) => `'${state}'`).join(", ");
/** The runs a runner may claim, at a time bound three times (CLAIMABLE_AT): queued; running with no runner (released) or
 *  its claim run out; parked with its wake_at passed, an untaken stop, or an untaken command once its backoff (a failed
 *  resume's) has passed. */
const CLAIMABLE = `(state = 'queued'
  OR (state = 'running' AND (runner IS NULL OR claimed_until < ?))
  OR (state = 'parked' AND (
    (wake_at IS NOT NULL AND wake_at <= ?)
    OR EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.taken_at IS NULL AND commands.kind = 'stop')
    OR ((backoff_until IS NULL OR backoff_until <= ?) AND EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.taken_at IS NULL)))))`;
const CLAIMABLE_AT = (at: number): number[] => [at, at, at];
/** What a claim sets: the next epoch, the runner and its lease, running, no backoff. */
const CLAIM_SET = "epoch = epoch + 1, runner = ?, claimed_until = ?, state = 'running', backoff_until = NULL";

const agentOf = (r: AgentRecord): AgentRow => ({ id: r.id, name: r.name, description: r.description, currentRevision: r.current_revision, createdAt: r.created_at, archivedAt: r.archived_at });
const revisionOf = (r: RevisionRecord): RevisionRow => ({
  id: r.id, agentId: r.agent_id, kind: r.kind, body: JSON.parse(r.body), package: r.package === null ? null : (JSON.parse(r.package) as TemplatePackage), createdAt: r.created_at,
});
const commandOf = (r: CommandRecord): Command => ({ id: r.id, runId: r.run_id, kind: r.kind, body: JSON.parse(r.body), createdAt: r.created_at, takenAt: r.taken_at, refused: r.refused, tries: r.tries });
const triggerOf = (r: TriggerRecord): TriggerRow => ({
  id: r.id, agentId: r.agent_id, name: r.name, enabled: r.enabled === 1, source: JSON.parse(r.source), target: JSON.parse(r.target), nextAt: r.next_at, lastRunId: r.last_run_id,
  catchupWindowS: r.catchup_window_s, failuresInARow: r.failures_in_a_row, disabled: r.disabled === null ? null : JSON.parse(r.disabled), maxActiveRuns: r.max_active_runs,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const json = (value: unknown): string => JSON.stringify(value ?? null);

type McpServerRecord = {
  name: string; url: string; auth: string; protocol: string | null; tools: string; prices: string; sealed: Uint8Array | null;
  refresh_holder: string | null; refresh_until: number | null; created_at: number; updated_at: number;
};
type McpPinRecord = { run_id: string; body: string; pinned_at: number };
const MCP_SERVER_COLUMNS = "name, url, auth, protocol, tools, prices, sealed, refresh_holder, refresh_until, created_at, updated_at";
const mcpServerOf = (r: McpServerRecord): McpServerRow => ({
  name: r.name, url: r.url, auth: r.auth, protocol: r.protocol, tools: JSON.parse(r.tools), prices: JSON.parse(r.prices),
  sealed: r.sealed === null ? null : Uint8Array.from(r.sealed), refreshHolder: r.refresh_holder, refreshUntil: r.refresh_until, createdAt: r.created_at, updatedAt: r.updated_at,
});
const mcpPinOf = (r: McpPinRecord): McpPinRow => ({ runId: r.run_id, body: JSON.parse(r.body), pinnedAt: r.pinned_at });

/** The store's schema version as the file holds it: null when the server has not set it up (no store_meta yet). */
async function versionOf(db: Connection): Promise<number | null> {
  const table = await db.get<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'store_meta'");
  if (!table) return null;
  return (await db.get<{ schema_version: number }>("SELECT schema_version FROM store_meta WHERE singleton = 1"))?.schema_version ?? null;
}

/** The files only an earlier version kept at a data directory's top: its MCP servers, triggers, tool keys, trigger
 *  secrets, webhook and its outbox, kept idempotency answers, learning's usage ledger, and the per-run door's token.
 *  This version's own (.token, .server.json beside the store and its lock) and a leftover box-image.json are not among
 *  them: a directory holding those opens. */
const EARLIER_ROOT_FILES = ["mcp-servers.json", "triggers.json", "tool-keys.json", "trigger-secrets.json", "webhook.json", "webhook-outbox.json", ".idempotency.json", "learning-usage.jsonl", ".door-token"];

/** The files an earlier version kept in a data directory, relative to it: its store (a STORE_FILE with tables and no
 *  store_meta row), agent homes (<agent>/agent.sqlite, agents/<agent>/agent.sqlite), run databases (runs/<run>/run.sqlite,
 *  disk/agents/<agent>/runs/<run>/run.sqlite), its settings files (EARLIER_ROOT_FILES) and its homes' sign-ins
 *  (homes/<home>/sign-ins/sign-ins.json). Read only: nothing is opened for writing or made. */
function earlierVersionIn(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  const found: string[] = [];
  const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  const dirsIn = (path: string) => (statSync(path, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
  const store = join(dataDir, STORE_FILE);
  if (isFile(store) && !isThisVersionsStore(store)) found.push(STORE_FILE);
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

/** Whether `file` is this version's store, or one with nothing in it yet: an earlier one has tables and no store_meta. */
function isThisVersionsStore(file: string): boolean {
  const db = new DatabaseSync(file, { readOnly: true });
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
 *  directory) too. */
export async function openSqliteStore(options: SqliteStoreOptions): Promise<Store> {
  const role = options.role ?? "server";
  let file: string;
  if (options.dataDir !== undefined) {
    // The server makes its data directory; a runner opens only one that is there. No migration: a directory an earlier
    // version wrote is refused before anything in it is opened or made.
    if (role === "server") {
      const earlier = earlierVersionIn(options.dataDir);
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
    if (found !== SCHEMA_VERSION) throw new SchemaVersionUnknown(file, found, SCHEMA_VERSION);
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
  return new SqliteStore(connection, options.now ?? Date.now);
}

/** The key of a claim's one journal: its run and epoch. */
const journalKey = (claim: Pick<Claim, "runId" | "epoch">): string => `${claim.runId}\u0000${claim.epoch}`;

/** A statement under `claim`: one that changes no row means the run's epoch moved on, and the transaction rolls back. */
function fenced(claim: Claim, sql: string, params: readonly SqliteValue[]): Statement {
  return { sql, params, expect: { kind: "fenced", runId: claim.runId, epoch: claim.epoch } };
}

class SqliteStore implements Store {
  readonly agents: Agents;
  readonly templates: Templates;
  readonly triggers: Triggers;
  readonly runs: Runs;
  readonly mcp: Mcp;
  readonly live: Live;
  readonly #db: Connection;
  readonly #now: () => number;
  /** Each claim's one journal, until it is closed. */
  readonly #journals = new Map<string, RunStorage>();

  constructor(db: Connection, now: () => number) {
    this.#db = db;
    this.#now = now;

    const insertAgent = (tx: SqliteExecutor, agent: { id: string; name: string; description?: string | null }, at: number) =>
      tx.run("INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?)", agent.id, agent.name, agent.description ?? null, at);
    const insertRevision = async (tx: SqliteExecutor, agentId: string, revision: NewRevision, at: number) => {
      await tx.run("INSERT INTO revisions (id, agent_id, kind, body, package, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        revision.id, agentId, revision.kind, json(revision.body), revision.package === undefined ? null : json(revision.package), at);
      if ((await tx.runCounted("UPDATE agents SET current_revision = ? WHERE id = ?", revision.id, agentId)) === 0) throw new StoreConstraint(`no agent ${agentId}`);
    };
    const writeScopes = async (tx: SqliteExecutor, triggerId: string, scopes: readonly TriggerScope[]) => {
      await tx.run("DELETE FROM trigger_scopes WHERE trigger_id = ?", triggerId);
      for (const { kind, scope } of scopes) await tx.run("INSERT INTO trigger_scopes (kind, scope, trigger_id) VALUES (?, ?, ?)", kind, scope, triggerId);
    };
    /** Inserts the trigger, or (on its name for the agent) changes it in place, keeping its id; then its scope rows, only
     *  while it is enabled. */
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

    this.agents = {
      put: async ({ id, name, description = null }) => {
        await db.write([{ sql: "INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description", params: [id, name, description, now()] }]);
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
      list: async ({ archived = false } = {}) =>
        (await db.all<AgentRecord>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY created_at, id`)).map(agentOf),
      archive: async (id, archived) => {
        await db.write([{ sql: "UPDATE agents SET archived_at = ? WHERE id = ?", params: [archived ? now() : null, id] }]);
      },
      addRevision: async ({ agentId, ...revision }) => {
        await db.transaction((tx) => insertRevision(tx, agentId, revision, now()));
      },
      revision: async (id) => {
        const row = await db.get<RevisionRecord>(`SELECT ${REVISION_COLUMNS} FROM revisions WHERE id = ?`, id);
        return row && revisionOf(row);
      },
      revisions: async (agentId) => (await db.all<RevisionRecord>(`SELECT ${REVISION_COLUMNS} FROM revisions WHERE agent_id = ? ORDER BY created_at, id`, agentId)).map(revisionOf),
    };

    this.templates = {
      apply: async (agent, revision, triggers, idempotencyKey) =>
        db.transaction(async (tx) => {
          if (idempotencyKey !== undefined) {
            const kept = await tx.get<{ response: string }>("SELECT response FROM idempotency WHERE scope = 'templates.apply' AND key = ?", idempotencyKey);
            if (kept) return JSON.parse(kept.response) as { agentId: string; revisionId: string };
          }
          const at = now();
          await insertAgent(tx, agent, at);
          await insertRevision(tx, agent.id, revision, at);
          // A new agent has no triggers: a plain insert, so a name given twice is refused (UNIQUE (agent_id, name)).
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
      create: async (t) => {
        const at = now();
        const row = await db.transaction((tx) =>
          tx.get<TriggerRecord>(
            `INSERT INTO triggers (id, agent_id, name, enabled, source, target, next_at, catchup_window_s, max_active_runs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${TRIGGER_COLUMNS}`,
            t.id, t.agentId, t.name, t.enabled ? 1 : 0, json(t.source), json(t.target), t.nextAt, t.catchupWindowS, t.maxActiveRuns ?? null, at, at,
          ),
        );
        return triggerOf(row!);
      },
      update: async (id, patch) => {
        const { set, params } = triggerSet(patch, now());
        const row = await db.transaction((tx) => tx.get<TriggerRecord>(`UPDATE triggers SET ${set} WHERE id = ? RETURNING ${TRIGGER_COLUMNS}`, ...params, id));
        return row && triggerOf(row);
      },
      remove: async (id) => {
        await db.write([{ sql: "DELETE FROM triggers WHERE id = ?", params: [id] }]);
      },
      record: async (triggerId, firings, { patch, room } = {}) =>
        db.transaction(async (tx) => {
          const at = now();
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
        (await db.all<FiringRecord>(`SELECT ${FIRING_COLUMNS} FROM trigger_firings WHERE trigger_id = ? AND shown = 1 ORDER BY at DESC, rowid DESC`, triggerId)).map(firingOf),
      settle: async (triggerId, key, change, streak) =>
        db.transaction(async (tx) => {
          const at = now();
          const was = await tx.get<FiringRecord>(`SELECT ${FIRING_COLUMNS} FROM trigger_firings WHERE trigger_id = ? AND key = ?`, triggerId, key);
          if (!was) return undefined;
          const settled = change.status !== undefined && change.status !== "due";
          // Out of due, a firing keeps no retry, wait or payload, nor the reason its last try gave (unless it gives one).
          const set: [string, SqliteValue][] = [];
          if (change.status !== undefined) set.push(["status", change.status]);
          if (settled) set.push(["retry_at", null], ["waits_on", null], ["payload", null], ["reason", change.reason ?? null], ["attempts", change.attempts ?? 0]);
          else if (change.reason !== undefined) set.push(["reason", change.reason]);
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
        (await db.all<FiringRecord>(`SELECT ${FIRING_COLUMNS} FROM trigger_firings WHERE status = 'due' OR (status = 'failed' AND (notified IS NULL OR notified = 0)) ORDER BY at, rowid`)).map(firingOf),
      message: async ({ triggerId, key }, runId, command, bound) =>
        db.transaction(async (tx) => {
          const at = now();
          const firing = await tx.get<{ status: string }>("SELECT status FROM trigger_firings WHERE trigger_id = ? AND key = ?", triggerId, key);
          if (!firing || firing.status !== "due") return undefined;
          const waiting = (await tx.get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM commands WHERE run_id = ? AND taken_at IS NULL AND json_extract(body, '$.origin.trigger_id') = ?", runId, triggerId,
          ))!.n;
          const clear = "retry_at = NULL, waits_on = NULL, payload = NULL, attempts = 0";
          if (waiting >= bound.max) {
            await tx.run(`UPDATE trigger_firings SET status = 'skipped', reason = ?, ${clear} WHERE trigger_id = ? AND key = ?`, bound.reason, triggerId, key);
            return { skipped: bound.reason };
          }
          const row = await tx.get<{ id: number }>("INSERT INTO commands (run_id, kind, body, created_at) VALUES (?, ?, ?, ?) RETURNING id", runId, command.kind, json(command.body), at);
          await tx.run(`UPDATE trigger_firings SET status = 'sent', run_id = ?, reason = NULL, ${clear} WHERE trigger_id = ? AND key = ?`, runId, triggerId, key);
          await tx.run("UPDATE triggers SET failures_in_a_row = 0, updated_at = ? WHERE id = ?", at, triggerId);
          return { sent: true as const, commandId: row!.id };
        }),
      waiting: async () =>
        (await db.all<FiringRecord & { free: number }>(
          `SELECT ${FIRING_COLUMNS.split(", ").map((c) => `f.${c}`).join(", ")},
             (SELECT COUNT(*) FROM trigger_firings s JOIN runs r ON r.id = s.run_id
               WHERE s.trigger_id = f.trigger_id AND s.status = 'started' AND r.state NOT IN (${FINAL})) < COALESCE(t.max_active_runs, 1) AS free
           FROM trigger_firings f JOIN triggers t ON t.id = f.trigger_id
           WHERE f.status = 'due' AND f.waits_on IS NOT NULL ORDER BY f.at, f.rowid`,
        )).map((r) => ({ ...firingOf(r), free: r.free === 1 })),
      soonest: async () => (await db.get<{ at: number | null }>("SELECT MIN(next_at) AS at FROM triggers WHERE enabled = 1 AND next_at IS NOT NULL"))?.at ?? null,
      activeRuns: async (triggerId) =>
        (await db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM trigger_firings f JOIN runs r ON r.id = f.run_id WHERE f.trigger_id = ? AND f.status = 'started' AND r.state NOT IN (${FINAL})`, triggerId,
        ))!.n,
      prune: async (triggerId, { history, dayMs, keepByKey }) => {
        await db.transaction(async (tx) => {
          const at = now();
          // Past the newest `history` shown firings: never a due one, a failure not yet told, or a started one whose run
          // has not ended. The rest leave the history: kept for their key's day when a sender's key names them, else gone.
          const old = await tx.all<{ key: string; by: string | null }>(
            `SELECT f.key, f.by FROM trigger_firings f LEFT JOIN runs r ON r.id = f.run_id
             WHERE f.trigger_id = ? AND f.shown = 1 AND f.status != 'due' AND NOT (f.status = 'failed' AND (f.notified IS NULL OR f.notified = 0))
               AND NOT (f.status = 'started' AND r.id IS NOT NULL AND r.state NOT IN (${FINAL}))
               AND f.key NOT IN (SELECT key FROM trigger_firings WHERE trigger_id = ? AND shown = 1 ORDER BY at DESC, rowid DESC LIMIT ?)`,
            triggerId, triggerId, history,
          );
          for (const { key, by } of old) {
            if (keepByKey(by ?? "manual")) await tx.run("UPDATE trigger_firings SET shown = 0, payload = NULL WHERE trigger_id = ? AND key = ?", triggerId, key);
            else await tx.run("DELETE FROM trigger_firings WHERE trigger_id = ? AND key = ?", triggerId, key);
          }
          await tx.run(
            `DELETE FROM trigger_firings WHERE trigger_id = ? AND shown = 0 AND at < ? AND status != 'due'
               AND NOT (status = 'started' AND run_id IN (SELECT id FROM runs WHERE state NOT IN (${FINAL})))`,
            triggerId, at - dayMs,
          );
        });
      },
      enable: async (triggerId, scopes) => {
        await db.transaction(async (tx) => {
          if ((await tx.runCounted("UPDATE triggers SET enabled = 1, disabled = NULL, updated_at = ? WHERE id = ?", now(), triggerId)) === 0) throw new StoreConstraint(`no trigger ${triggerId}`);
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
      fire: async (firing, run, _options = {}) =>
        db.transaction(async (tx) => {
          const at = now();
          const row = await tx.get<RunRecord>(`INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES (?, ?, ?, 'queued', 0, ?) RETURNING ${RUN_COLUMNS}`, run.id, run.agentId, run.revisionId, at);
          // The due firing the engine recorded becomes started; one not recorded yet is recorded started. A firing already
          // past due (started, or settled otherwise) is refused, and its run with it.
          const moved = await tx.runCounted(
            "UPDATE trigger_firings SET status = 'started', run_id = ?, retry_at = NULL, waits_on = NULL, payload = NULL, reason = NULL, attempts = 0 WHERE trigger_id = ? AND key = ? AND status = 'due'",
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
        }),
    };

    this.runs = {
      create: async ({ id, agentId, revisionId }) => {
        const [result] = await db.write([{ sql: `INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES (?, ?, ?, 'queued', 0, ?) RETURNING ${RUN_COLUMNS}`, params: [id, agentId, revisionId, now()] }]);
        return runOf(result!.rows[0] as RunRecord);
      },
      get: async (id) => {
        const row = await db.get<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, id);
        return row && runOf(row);
      },
      list: async ({ agentId, revisionId, state, limit }) => {
        const where: string[] = [];
        const params: SqliteValue[] = [];
        if (agentId !== undefined) (where.push("agent_id = ?"), params.push(agentId));
        if (revisionId !== undefined) (where.push("revision_id = ?"), params.push(revisionId));
        if (state !== undefined) (where.push("state = ?"), params.push(state));
        const bounded = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0;
        if (bounded) params.push(limit);
        const rows = await db.all<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC${bounded ? " LIMIT ?" : ""}`, ...params);
        return rows.map(runOf);
      },
      claimable: async ({ limit } = {}) => {
        const at = now();
        const bounded = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0;
        const rows = await db.all<{ id: string }>(`SELECT id FROM runs WHERE ${CLAIMABLE} ORDER BY started_at, id${bounded ? " LIMIT ?" : ""}`, ...CLAIMABLE_AT(at), ...(bounded ? [limit] : []));
        return rows.map((row) => row.id);
      },
      claimMany: (runner, k, { leaseMs = DEFAULT_LEASE_MS } = {}) => this.#claimRuns(runner, leaseMs, { k }),
      update: async (claim, patch, rows = {}) => {
        if (Array.isArray(rows) || typeof rows !== "object" || rows === null) throw new TypeError("runs.update's third argument is { also?, take? }");
        const { also = [], take = [] } = rows;
        return db.transaction(async (tx) => {
          const at = now();
          const row = await applyRunPatch(tx, claim, patch, also, at);
          for (const commandId of take) {
            if ((await tx.runCounted("UPDATE commands SET taken_at = ? WHERE id = ? AND run_id = ? AND taken_at IS NULL", at, commandId, claim.runId)) === 0) {
              throw new CommandTaken(claim.runId, commandId);
            }
          }
          return row;
        });
      },
    };

    const server = async (executor: SqliteExecutor, name: string) => {
      const row = await executor.get<McpServerRecord>(`SELECT ${MCP_SERVER_COLUMNS} FROM mcp_servers WHERE name = ?`, name);
      return row && mcpServerOf(row);
    };
    this.mcp = {
      put: async ({ name, url, auth, protocol = null, tools, prices = null, sealed = null }) => {
        const at = now();
        const [result] = await db.write([{
          sql: `INSERT INTO mcp_servers (name, url, auth, protocol, tools, prices, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET url = excluded.url, auth = excluded.auth, protocol = excluded.protocol, tools = excluded.tools,
              prices = excluded.prices, sealed = excluded.sealed, refresh_holder = NULL, refresh_until = NULL, updated_at = excluded.updated_at
            RETURNING ${MCP_SERVER_COLUMNS}`,
          params: [name, url, auth, protocol, json(tools), json(prices), sealed, at, at],
        }]);
        return mcpServerOf(result!.rows[0] as McpServerRecord);
      },
      remove: async (name) => {
        await db.write([{ sql: "DELETE FROM mcp_servers WHERE name = ?", params: [name] }]);
      },
      servers: async () => (await db.all<McpServerRecord>(`SELECT ${MCP_SERVER_COLUMNS} FROM mcp_servers ORDER BY name`)).map(mcpServerOf),
      server: (name) => server(db, name),
      pin: async (runId) => {
        const row = await db.get<McpPinRecord>("SELECT run_id, body, pinned_at FROM mcp_pins WHERE run_id = ?", runId);
        return row && mcpPinOf(row);
      },
      pinOnce: (claim, body) =>
        db.transaction(async (tx) => {
          await tx.step(fenced(claim, "UPDATE runs SET epoch = epoch WHERE id = ? AND epoch = ?", [claim.runId, claim.epoch]));
          await tx.run("INSERT INTO mcp_pins (run_id, body, pinned_at) VALUES (?, ?, ?) ON CONFLICT (run_id) DO NOTHING", claim.runId, json(body), now());
          return mcpPinOf((await tx.get<McpPinRecord>("SELECT run_id, body, pinned_at FROM mcp_pins WHERE run_id = ?", claim.runId))!);
        }),
      // The credential as read is compared by its bytes (`sealed IS ?`, NULL included): updated_at can repeat within a ms.
      leaseRefresh: async (name, { seen, holder, ms = MCP_REFRESH_LEASE_MS }) => {
        if (!(Number.isFinite(ms) && ms > MCP_REFRESH_CALL_MS)) {
          throw new RangeError(`a refresh lease must be longer than the refresh call's own deadline (${MCP_REFRESH_CALL_MS} ms), not ${ms} ms: it would lapse while its holder's call may still spend the token`);
        }
        return db.transaction(async (tx) => {
          const at = now();
          const granted = await tx.runCounted(
            "UPDATE mcp_servers SET refresh_holder = ?, refresh_until = ? WHERE name = ? AND sealed IS ? AND (refresh_until IS NULL OR refresh_until < ?)",
            holder, at + ms, name, seen, at,
          );
          const row = await server(tx, name);
          if (!row) throw new StoreConstraint(`no MCP server ${name}: it is no longer saved`);
          return { leased: granted === 1, row };
        });
      },
      refreshToken: (name, { holder, sealed }) =>
        db.transaction(async (tx) => {
          const at = now();
          const written = await tx.runCounted(
            "UPDATE mcp_servers SET sealed = ?, refresh_holder = NULL, refresh_until = NULL, updated_at = max(?, updated_at + 1) WHERE name = ? AND refresh_holder = ?",
            sealed, at, name, holder,
          );
          if (written === 0) throw new RefreshLeaseLost(name, holder);
          return (await server(tx, name))!;
        }),
      releaseRefresh: async (name, holder) => {
        await db.write([{ sql: "UPDATE mcp_servers SET refresh_holder = NULL, refresh_until = NULL WHERE name = ? AND refresh_holder = ?", params: [name, holder] }]);
      },
    };

    this.live = {
      // One transaction for the tick; each row written only under its run's current epoch (the SELECT finds no run row
      // for a stale claim, so nothing is inserted or changed).
      put: (rows) =>
        db.transaction(async (tx) => {
          const at = now();
          const written: string[] = [];
          const fenced: string[] = [];
          for (const { claim, state } of rows) {
            const changed = await tx.runCounted(
              `INSERT INTO run_live (run_id, state, updated_at) SELECT id, ?, ? FROM runs WHERE id = ? AND epoch = ?
                ON CONFLICT (run_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
              json(state), at, claim.runId, claim.epoch,
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
      drop: async (runId) => {
        await db.write([{ sql: "DELETE FROM run_live WHERE run_id = ?", params: [runId] }]);
      },
    };
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
      // lease from now, never comes back already run out.
      const at = this.#now();
      const until = at + leaseMs;
      const picked = "runId" in pick
        ? await tx.all<{ id: string; state: RunState }>(`SELECT id, state FROM runs WHERE id = ? AND ${CLAIMABLE}`, pick.runId, ...CLAIMABLE_AT(at))
        : await tx.all<{ id: string; state: RunState }>(`SELECT id, state FROM runs WHERE ${CLAIMABLE} ORDER BY started_at, id LIMIT ?`, ...CLAIMABLE_AT(at), pick.k);
      if (picked.length === 0) return [];
      const rows = await tx.all<{ id: string; epoch: number }>(
        `UPDATE runs SET ${CLAIM_SET} WHERE id IN (${picked.map(() => "?").join(", ")}) RETURNING id, epoch`,
        runner, until, ...picked.map((row) => row.id),
      );
      const epochs = new Map(rows.map((row) => [row.id, row.epoch]));
      return picked.map(({ id, state }) => ({ runId: id, runner, epoch: epochs.get(id)!, until, from: state }));
    });
  }

  async renew(claim: Claim, { leaseMs = DEFAULT_LEASE_MS }: { leaseMs?: number } = {}): Promise<Claim> {
    // As a claim's: the lease runs from when the renew holds the writer lock.
    const until = await this.#db.transaction(async (tx) => {
      const at = this.#now() + leaseMs;
      await tx.step(fenced(claim, "UPDATE runs SET claimed_until = ? WHERE id = ? AND epoch = ? AND runner = ?", [at, claim.runId, claim.epoch, claim.runner]));
      return at;
    });
    return { ...claim, until };
  }

  async release(claim: Claim, { state, wakeAt = null, backoffUntil = null }: { state?: RunState; wakeAt?: number | null; backoffUntil?: number | null } = {}): Promise<void> {
    const ending = state !== undefined && FINAL_STATES.includes(state);
    await this.#db.write([fenced(
      claim,
      // The epoch moves on at a release: the released claim is dead everywhere (its journal, its run updates, its takes),
      // never live until the next claim.
      `UPDATE runs SET epoch = epoch + 1, runner = NULL, claimed_until = NULL, wake_at = ?, backoff_until = ?, state = coalesce(?, state)${ending ? ", ended_at = coalesce(ended_at, ?)" : ""} WHERE id = ? AND epoch = ? AND runner = ?`,
      [wakeAt, backoffUntil, state ?? null, ...(ending ? [this.#now()] : []), claim.runId, claim.epoch, claim.runner],
    )], { full: true });
    // The released claim's journal is dead (its epoch moved on): the store keeps it no longer.
    this.#journals.delete(journalKey(claim));
  }

  /** The claim's one journal (pi assumes one Storage per owner): asked again for the same claim while it is open, the same
   *  journal, so two callers never mint the same ids. The store keeps it only while it is open and its claim held: its
   *  close, or its claim's release, drops it, so a long-lived runner keeps no journal of a finished claim. */
  journal(claim: Claim): Journal {
    const key = journalKey(claim);
    const open = this.#journals.get(key);
    if (open && !open.closed) return open;
    const journal: RunStorage = new RunStorage(this.#db, claim, this.#now, () => {
      if (this.#journals.get(key) === journal) this.#journals.delete(key);
    });
    this.#journals.set(key, journal);
    return journal;
  }

  /** How many journals the store keeps (open, of a claim not released). */
  get openJournals(): number {
    return this.#journals.size;
  }

  async flush(): Promise<void> {
    await this.#db.write([{ sql: "UPDATE store_meta SET flushes = flushes + 1 WHERE singleton = 1" }], { full: true });
  }

  async command(runId: string, { kind, body = null }: { kind: string; body?: unknown }): Promise<Command> {
    const [result] = await this.#db.write([{
      sql: `INSERT INTO commands (run_id, kind, body, created_at) SELECT id, ?, ?, ? FROM runs WHERE id = ? AND state NOT IN (${FINAL}) RETURNING ${COMMAND_COLUMNS}`,
      params: [kind, json(body), this.#now(), runId],
      expect: { kind: "final", runId },
    }]);
    return commandOf(result!.rows[0] as CommandRecord);
  }

  async commands(runId: string, after: number): Promise<Command[]> {
    return (await this.#db.all<CommandRecord>(`SELECT ${COMMAND_COLUMNS} FROM commands WHERE run_id = ? AND id > ? ORDER BY id`, runId, after)).map(commandOf);
  }

  async take(claim: Claim, commandId: number, outcome: "taken" | "refused" = "taken", reason?: string): Promise<void> {
    await this.#db.write([
      fenced(claim, "UPDATE runs SET epoch = epoch WHERE id = ? AND epoch = ?", [claim.runId, claim.epoch]),
      { sql: "UPDATE commands SET taken_at = ?, refused = ? WHERE id = ? AND run_id = ? AND taken_at IS NULL", params: [this.#now(), outcome === "refused" ? (reason ?? "refused") : null, commandId, claim.runId] },
    ]);
  }

  async retry(claim: Claim, commandId: number): Promise<number> {
    const [, counted] = await this.#db.write([
      fenced(claim, "UPDATE runs SET epoch = epoch WHERE id = ? AND epoch = ?", [claim.runId, claim.epoch]),
      { sql: "UPDATE commands SET tries = tries + 1 WHERE id = ? AND run_id = ? AND taken_at IS NULL RETURNING tries", params: [commandId, claim.runId] },
    ]);
    const row = counted!.rows[0] as { tries: number } | undefined;
    if (!row) throw new StoreConstraint(`run ${claim.runId}: command ${commandId} is taken, or not the run's: no try to count`);
    return row.tries;
  }

  close(): Promise<void> {
    return this.#db.close();
  }
}
