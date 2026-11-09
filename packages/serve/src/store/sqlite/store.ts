// SqliteStore: the Store (store.ts) on one SQLite file, through the one connection (connection.ts, on its worker thread).
// The only code with SQL in it, besides the schema and the run patch. The file is on local disk, never on Archil: one
// connection per process, and SQLite's one writer lock serializes the server's and every runner's commits. A unit of work
// with more than one statement is one transaction (connection.transaction, BEGIN IMMEDIATE): all of it or none of it.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claimFence } from "../fence.js";
import { RunStorage } from "../journal/storage.js";
import { DDL, SCHEMA_VERSION } from "../schema.js";
import {
  CommandTaken, Fenced, RefreshLeaseLost, SchemaVersionUnknown, StoreConstraint, StoreFromEarlierVersion, type AgentRow, type Agents,
  type AlsoRow, type Claim, type Command, type ImportRunInput, type Journal, type NewRevision, type RevisionRow, type RunPatch, type RunRow, type Runs,
  type JournalReads,
  type RunState, type Store, type StoreRole, type TemplatePackage, type Templates, type TriggerDef, type TriggerRow, type Triggers, type TriggerScope,
  FINAL_STATES, MCP_REFRESH_CALL_MS, MCP_REFRESH_LEASE_MS, type Learning, type LearningProposal, type Live, type LiveRow, type LiveViewerRow, type LiveViewers, type Mcp, type McpPinRow, type McpServerRow,
  type McpOauth, type McpOauthPendingRow, type SealedKeyRow, type SealedKeys, type Settings, type SettingRow, type TriggerSettingRow, type TriggerSettings,
  SignInHandedTo, SignInMissing, SIGN_IN_TOMBSTONES_KEPT, type SignIns, type SignInRow, type SignInTombstoneRow,
} from "../store.js";
import { Connection, type SqliteExecutor, type SqliteValue, type Statement } from "./connection.js";
import { applyRunPatch, refuseLeftovers, RUN_COLUMNS, runOf, type RunRecord } from "./run-patch.js";
import { readLaunch, writeLaunch } from "./run-launch.js";

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
type RevisionRecord = { id: string; agent_id: string; parent_id: string | null; kind: string; body: string; skills: string | null; note: string | null; package: string | null; created_at: number };
type CommandRecord = { id: number; run_id: string; kind: string; body: string; created_at: number; taken_at: number | null; refused: string | null; tries: number };
type TriggerRecord = { id: string; agent_id: string; name: string; enabled: number; source: string; target: string; next_at: number | null; last_run_id: string | null };

const AGENT_COLUMNS = "id, name, description, current_revision, created_at, archived_at";
const REVISION_COLUMNS = "id, agent_id, parent_id, kind, body, skills, note, package, created_at";
const COMMAND_COLUMNS = "id, run_id, kind, body, created_at, taken_at, refused, tries";
const TRIGGER_COLUMNS = "id, agent_id, name, enabled, source, target, next_at, last_run_id";
const FINAL = FINAL_STATES.map((state) => `'${state}'`).join(", ");
/** The runs a runner may claim, at a time bound five times (CLAIMABLE_AT): queued; running with no runner (released) or
 *  its claim run out, once its backoff (an interrupted run's) has passed; parked, once no claim holds it (a run parks
 *  under its claim and is released a few seconds later), with its wake_at passed, an untaken stop or cancel, or an untaken command
 *  that can answer it once its backoff (a failed resume's) has passed. A row marked `answers: false` (a trigger's
 *  follow-up message) answers no park: it waits, untaken, and its loop gets it after the person's answer wakes the run. */
const CLAIMABLE = `(state = 'queued'
  OR (state = 'running' AND (runner IS NULL OR claimed_until < ?) AND (backoff_until IS NULL OR backoff_until <= ?))
  OR (state = 'parked' AND (runner IS NULL OR claimed_until < ?) AND (
    (wake_at IS NOT NULL AND wake_at <= ?)
    OR EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.taken_at IS NULL AND commands.kind IN ('stop', 'cancel'))
    OR ((backoff_until IS NULL OR backoff_until <= ?) AND EXISTS (SELECT 1 FROM commands WHERE commands.run_id = runs.id AND commands.taken_at IS NULL
      AND json_extract(commands.body, '$.answers') IS NOT 0)))))`;
const CLAIMABLE_AT = (at: number): number[] => [at, at, at, at, at];
/** What a claim sets: the next epoch, the runner and its lease, running, no backoff. */
const CLAIM_SET = "epoch = epoch + 1, runner = ?, claimed_until = ?, state = 'running', backoff_until = NULL";

const agentOf = (r: AgentRecord): AgentRow => ({ id: r.id, name: r.name, description: r.description, currentRevision: r.current_revision, createdAt: r.created_at, archivedAt: r.archived_at });
const revisionOf = (r: RevisionRecord): RevisionRow => ({
  id: r.id, agentId: r.agent_id, parent: r.parent_id, kind: r.kind, body: JSON.parse(r.body), skills: r.skills === null ? null : JSON.parse(r.skills),
  note: r.note, package: r.package === null ? null : (JSON.parse(r.package) as TemplatePackage), createdAt: r.created_at,
});
const commandOf = (r: CommandRecord): Command => ({ id: r.id, runId: r.run_id, kind: r.kind, body: JSON.parse(r.body), createdAt: r.created_at, takenAt: r.taken_at, refused: r.refused, tries: r.tries });
const triggerOf = (r: TriggerRecord): TriggerRow => ({
  id: r.id, agentId: r.agent_id, name: r.name, enabled: r.enabled === 1, source: JSON.parse(r.source), target: JSON.parse(r.target), nextAt: r.next_at, lastRunId: r.last_run_id,
});
const json = (value: unknown): string => JSON.stringify(value ?? null);

type McpServerRecord = {
  name: string; url: string; auth: string; protocol: string | null; tools: string; prices: string; server_info: string | null; instructions: string | null; sealed: Uint8Array | null;
  refresh_holder: string | null; refresh_until: number | null; created_at: number; updated_at: number; listed_at: number | null;
};
type McpPinRecord = { run_id: string; body: string; pinned_at: number };
const MCP_SERVER_COLUMNS = "name, url, auth, protocol, tools, prices, server_info, instructions, sealed, refresh_holder, refresh_until, created_at, updated_at, listed_at";
const mcpServerOf = (r: McpServerRecord): McpServerRow => ({
  name: r.name, url: r.url, auth: r.auth, protocol: r.protocol, tools: JSON.parse(r.tools), prices: JSON.parse(r.prices),
  serverInfo: r.server_info === null ? null : JSON.parse(r.server_info), instructions: r.instructions,
  sealed: r.sealed === null ? null : Uint8Array.from(r.sealed), refreshHolder: r.refresh_holder, refreshUntil: r.refresh_until, createdAt: r.created_at, updatedAt: r.updated_at, listedAt: r.listed_at,
});
const mcpPinOf = (r: McpPinRecord): McpPinRow => ({ runId: r.run_id, body: JSON.parse(r.body), pinnedAt: r.pinned_at });

type SettingRecord = { key: string; value: string; updated_at: number };
const settingOf = (r: SettingRecord): SettingRow => ({ key: r.key, value: JSON.parse(r.value), updatedAt: r.updated_at });
type SealedKeyRecord = { name: string; sealed: Uint8Array; updated_at: number };
const sealedKeyOf = (r: SealedKeyRecord): SealedKeyRow => ({ name: r.name, sealed: Uint8Array.from(r.sealed), updatedAt: r.updated_at });
type TriggerSettingRecord = { adapter: string; scope: string; field: string; sealed: string; updated_at: number };
const triggerSettingOf = (r: TriggerSettingRecord): TriggerSettingRow => ({ adapter: r.adapter, scope: r.scope, field: r.field, sealed: r.sealed, updatedAt: r.updated_at });
type McpOauthRecord = { state: string; server: string; sealed: Uint8Array; working: string | null; expires_at: number };
const mcpOauthOf = (r: McpOauthRecord): McpOauthPendingRow => ({ state: r.state, server: r.server, sealed: Uint8Array.from(r.sealed), working: r.working === null ? null : JSON.parse(r.working), expiresAt: r.expires_at });
type SignInRecord = { agent_id: string; provider: string; name: string; pointer_sealed: Uint8Array; saved_at: number };
const signInOf = (r: SignInRecord): SignInRow => ({ agentId: r.agent_id, provider: r.provider, name: r.name, pointerSealed: Uint8Array.from(r.pointer_sealed), savedAt: r.saved_at });
type SignInTombstoneRecord = { agent_id: string; provider: string; pointer_sealed: Uint8Array; forgotten_at: number };
const signInTombstoneOf = (r: SignInTombstoneRecord): SignInTombstoneRow => ({ agentId: r.agent_id, provider: r.provider, pointerSealed: Uint8Array.from(r.pointer_sealed), forgottenAt: r.forgotten_at });

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
  // A directory linked in counts as one (stat follows the link), as the server's check of old homes reads them: an
  // earlier version's home or run kept elsewhere and linked in is still the earlier version's.
  const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  const dirsIn = (path: string) => (isDir(path) ? readdirSync(path).filter((name) => isDir(join(path, name))) : []);
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

/** How many released claims a store remembers, to refuse their journals. */
const RELEASED_KEPT = 1024;

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
  readonly liveViewers: LiveViewers;
  readonly learning: Learning;
  readonly settings: Settings;
  readonly sealedKeys: SealedKeys;
  readonly triggerSettings: TriggerSettings;
  readonly mcpOauth: McpOauth;
  readonly signIns: SignIns;
  readonly #db: Connection;
  readonly #now: () => number;
  /** Each claim's one journal, until it is closed. */
  readonly #journals = new Map<string, RunStorage>();
  /** Each run's claim this store released last (its epoch): journal() refuses that claim, or an older one, rather than
   *  hand out a journal that is Fenced at its first write. A newer claim of the run by this store drops it; at most
   *  RELEASED_KEPT are kept, the oldest dropped first. Past that cap journal() no longer refuses an old released claim,
   *  but nothing is written through it: release moved the run's epoch on, so the journal's first commit is Fenced by the
   *  epoch check in its own transaction. The map refuses early; the epoch is what guarantees it. */
  readonly #released = new Map<string, number>();

  constructor(db: Connection, now: () => number) {
    this.#db = db;
    this.#now = now;

    const insertAgent = (tx: SqliteExecutor, agent: { id: string; name: string; description?: string | null }, at: number) =>
      tx.run("INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?)", agent.id, agent.name, agent.description ?? null, at);
    const insertRevision = async (tx: SqliteExecutor, agentId: string, revision: NewRevision, at: number) => {
      // The parent is the agent's current revision now (null for its first): the agent must exist, which its first revision
      // (create) and a later one (addRevision, upgrade) both guarantee before this.
      const agent = await tx.get<{ current_revision: string | null }>("SELECT current_revision FROM agents WHERE id = ?", agentId);
      if (!agent) throw new StoreConstraint(`no agent ${agentId}`);
      await tx.run("INSERT INTO revisions (id, agent_id, parent_id, kind, body, skills, note, package, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        revision.id, agentId, agent.current_revision, revision.kind, json(revision.body),
        revision.skills === undefined || revision.skills === null ? null : json(revision.skills),
        revision.note ?? null, revision.package === undefined ? null : json(revision.package), at);
      await tx.run("UPDATE agents SET current_revision = ? WHERE id = ?", revision.id, agentId);
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
      setCurrent: async (agentId, revisionId) => {
        const changed = await db.transaction((tx) => tx.runCounted(
          "UPDATE agents SET current_revision = ? WHERE id = ? AND EXISTS (SELECT 1 FROM revisions WHERE id = ? AND agent_id = ?)",
          revisionId, agentId, revisionId, agentId,
        ));
        if (changed === 0) throw new StoreConstraint(`${revisionId} is not a revision of agent ${agentId}`);
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
      fire: async (firing, run) =>
        db.transaction(async (tx) => {
          const at = now();
          const row = await tx.get<RunRecord>(`INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES (?, ?, ?, 'queued', 0, ?) RETURNING ${RUN_COLUMNS}`, run.id, run.agentId, run.revisionId, at);
          await tx.run(
            "INSERT INTO trigger_firings (trigger_id, key, by, nominal_at, status, at, run_id, catch_up, payload) VALUES (?, ?, ?, ?, 'started', ?, ?, ?, ?)",
            firing.triggerId, firing.key, firing.by ?? null, firing.nominalAt ?? null, at, run.id, firing.catchUp === undefined ? null : firing.catchUp ? 1 : 0, firing.payload ?? null,
          );
          if ((await tx.runCounted("UPDATE triggers SET last_run_id = ?, updated_at = ? WHERE id = ?", run.id, at, firing.triggerId)) === 0) throw new StoreConstraint(`no trigger ${firing.triggerId}`);
          return runOf(row!);
        }),
    };

    this.runs = {
      create: async ({ id, agentId, revisionId, origin }, launch) => {
        // sign_in_handed is not written here: the runner writes it at its claim (runs.update under the epoch fence).
        const insert = `INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES (?, ?, ?, 'queued', 0, ?) RETURNING ${RUN_COLUMNS}`;
        if (origin || launch) {
          // The run, its origin and its launch row in one transaction: the key -> run link holds even if the kept response
          // never lands, and a run never exists without the launch it was started with.
          return db.transaction(async (tx) => {
            const at = now();
            const row = await tx.get<RunRecord>(insert, id, agentId, revisionId, at);
            if (origin) await tx.run("INSERT INTO run_origins (key, run_id, fingerprint, created_at) VALUES (?, ?, ?, ?)", origin.key, id, origin.fingerprint ?? null, at);
            if (launch) await writeLaunch(tx, id, launch, at);
            return runOf(row!);
          });
        }
        const [result] = await db.write([{ sql: insert, params: [id, agentId, revisionId, now()] }]);
        return runOf(result!.rows[0] as RunRecord);
      },
      get: async (id) => {
        const row = await db.get<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, id);
        return row && runOf(row);
      },
      launch: (runId) => readLaunch(db, runId),
      list: async ({ agentId, revisionId, state, archived, limit }) => {
        const where: string[] = [];
        const params: SqliteValue[] = [];
        if (agentId !== undefined) (where.push("agent_id = ?"), params.push(agentId));
        if (revisionId !== undefined) (where.push("revision_id = ?"), params.push(revisionId));
        if (state !== undefined) (where.push("state = ?"), params.push(state));
        if (archived !== undefined) where.push(`archived_at IS ${archived ? "NOT NULL" : "NULL"}`);
        const bounded = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0;
        if (bounded) params.push(limit);
        const rows = await db.all<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC${bounded ? " LIMIT ?" : ""}`, ...params);
        return rows.map(runOf);
      },
      archive: async (runId, archived) => {
        await db.write([{ sql: "UPDATE runs SET archived_at = ? WHERE id = ?", params: [archived ? now() : null, runId] }]);
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
          // An update that made the run final: its other untaken rows are refused in this transaction, after its own takes.
          await refuseLeftovers(tx, claim.runId, patch.state, at);
          return row;
        });
      },
    };

    const server = async (executor: SqliteExecutor, name: string) => {
      const row = await executor.get<McpServerRecord>(`SELECT ${MCP_SERVER_COLUMNS} FROM mcp_servers WHERE name = ?`, name);
      return row && mcpServerOf(row);
    };
    this.mcp = {
      put: async ({ name, url, auth, protocol = null, tools, prices = null, serverInfo = null, instructions = null, sealed = null, listedAt, updatedAt }) => {
        const at = now();
        // updated_at defaults to now (a save or a sign-in); a refresh passes the kept one so it is not read as an edit.
        // listed_at is the tools' listing time, now unless given.
        const updated = updatedAt ?? at;
        const listed = listedAt ?? at;
        const [result] = await db.write([{
          sql: `INSERT INTO mcp_servers (name, url, auth, protocol, tools, prices, server_info, instructions, sealed, created_at, updated_at, listed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET url = excluded.url, auth = excluded.auth, protocol = excluded.protocol, tools = excluded.tools,
              prices = excluded.prices, server_info = excluded.server_info, instructions = excluded.instructions, sealed = excluded.sealed, refresh_holder = NULL, refresh_until = NULL, updated_at = excluded.updated_at, listed_at = excluded.listed_at
            RETURNING ${MCP_SERVER_COLUMNS}`,
          params: [name, url, auth, protocol, json(tools), json(prices), serverInfo === null ? null : json(serverInfo), instructions, sealed, at, updated, listed],
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
          // Under the claim's epoch and its lease: a runner paused past its lease pins nothing.
          const fence = claimFence(claim, now());
          await tx.step(fenced(claim, `UPDATE runs SET epoch = epoch WHERE ${fence.where}`, fence.params));
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
      // One transaction for the tick; each row written only under its run's current epoch and live lease (the SELECT finds
      // no run row for a stale or lapsed claim, so nothing is inserted or changed). The drop below stays on the epoch.
      put: (rows) =>
        db.transaction(async (tx) => {
          const at = now();
          const written: string[] = [];
          const fenced: string[] = [];
          for (const { claim, state } of rows) {
            const fence = claimFence(claim, at);
            const changed = await tx.runCounted(
              `INSERT INTO run_live (run_id, state, updated_at) SELECT id, ?, ? FROM runs WHERE ${fence.where}
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
          sql: "DELETE FROM run_live WHERE run_id = ? AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND epoch = ?)",
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
          const fence = claimFence(claim, at);
          const changed = await tx.runCounted(
            `INSERT INTO browser_viewers (run_id, tag, port, viewer_id, sealed, at, runner, epoch) SELECT id, ?, ?, ?, ?, ?, ?, ? FROM runs WHERE ${fence.where}
              ON CONFLICT (run_id, tag) DO UPDATE SET port = excluded.port, viewer_id = excluded.viewer_id, sealed = excluded.sealed, at = excluded.at, runner = excluded.runner, epoch = excluded.epoch`,
            viewer.tag, viewer.port, viewer.id, viewer.sealed, at, claim.runner, claim.epoch, ...fence.params,
          );
          return changed > 0;
        }),
      // On the claim's epoch alone, as run_live's drop: a runner clearing its own rows after its lease ran out takes no
      // one else's.
      drop: async (claim, tag) => {
        await db.write([{
          sql: `DELETE FROM browser_viewers WHERE run_id = ?${tag === undefined ? "" : " AND tag = ?"} AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND epoch = ?)`,
          params: [claim.runId, ...(tag === undefined ? [] : [tag]), claim.runId, claim.epoch],
        }]);
      },
      // The server's read: only the run's epoch, under a live lease on the store's clock, written by the run's runner.
      of: async (runId) => {
        const rows = await db.all<{ tag: string; port: number; viewer_id: string; sealed: Uint8Array; at: number; runner: string }>(
          `SELECT v.tag, v.port, v.viewer_id, v.sealed, v.at, v.runner FROM browser_viewers v JOIN runs r ON r.id = v.run_id
            WHERE v.run_id = ? AND v.epoch = r.epoch AND r.claimed_until >= ? AND v.runner = r.runner ORDER BY v.at DESC, v.tag`,
          runId, now(),
        );
        return rows.map((row): LiveViewerRow => ({ tag: row.tag, port: row.port, id: row.viewer_id, sealed: new Uint8Array(row.sealed), at: row.at, runner: row.runner }));
      },
    };

    type ProposalRecord = { run_id: string; agent_id: string; turn: string; proposal: string; learning_run_id: string | null; created_at: number };
    const proposalOf = (row: ProposalRecord): LearningProposal => ({
      runId: row.run_id, agentId: row.agent_id, turn: JSON.parse(row.turn), proposal: JSON.parse(row.proposal),
      ...(row.learning_run_id === null ? {} : { learningRunId: row.learning_run_id }), createdAt: row.created_at,
    });
    this.learning = {
      proposal: async (runId) => {
        const row = await db.get<ProposalRecord>("SELECT run_id, agent_id, turn, proposal, learning_run_id, created_at FROM learning_proposals WHERE run_id = ?", runId);
        return row ? proposalOf(row) : undefined;
      },
      proposals: async (agentId, { limit = 100 } = {}) =>
        (await db.all<ProposalRecord>(
          "SELECT run_id, agent_id, turn, proposal, learning_run_id, created_at FROM learning_proposals WHERE agent_id = ? ORDER BY created_at DESC, run_id DESC LIMIT ?",
          agentId, limit,
        )).map(proposalOf),
    };

    this.settings = {
      get: async (key) => {
        const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
        return row === undefined ? undefined : JSON.parse(row.value);
      },
      put: async (key, value) => {
        await db.write([{ sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", params: [key, json(value), now()] }]);
      },
      remove: async (key) => {
        await db.write([{ sql: "DELETE FROM settings WHERE key = ?", params: [key] }]);
      },
      all: async () => (await db.all<SettingRecord>("SELECT key, value, updated_at FROM settings ORDER BY key")).map(settingOf),
    };

    this.sealedKeys = {
      get: async (name) => {
        const row = await db.get<{ sealed: Uint8Array }>("SELECT sealed FROM sealed_keys WHERE name = ?", name);
        return row === undefined ? undefined : Uint8Array.from(row.sealed);
      },
      put: async (name, sealed) => {
        await db.write([{ sql: "INSERT INTO sealed_keys (name, sealed, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at", params: [name, sealed, now()] }]);
      },
      remove: async (name) => {
        await db.write([{ sql: "DELETE FROM sealed_keys WHERE name = ?", params: [name] }]);
      },
      all: async () => (await db.all<SealedKeyRecord>("SELECT name, sealed, updated_at FROM sealed_keys ORDER BY name")).map(sealedKeyOf),
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

    // A running run whose sign_in_handed array holds `hash` (handedHolder), or any running run handed a sign-in at all
    // (handedAny): the one read forget and the runner make, over `runs` alone.
    const handedHolderIn = (tx: Pick<SqliteExecutor, "get">, hash: string) =>
      tx.get<{ id: string }>("SELECT id FROM runs WHERE state = 'running' AND sign_in_handed IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(sign_in_handed) WHERE value = ?) LIMIT 1", hash);
    const handedAnyIn = (tx: Pick<SqliteExecutor, "get">) =>
      tx.get<{ id: string }>("SELECT id FROM runs WHERE state = 'running' AND sign_in_handed IS NOT NULL AND json_array_length(sign_in_handed) > 0 LIMIT 1");
    this.signIns = {
      save: async ({ agentId, provider, name, pointerSealed }) => {
        const at = now();
        const [result] = await db.write([{
          sql: `INSERT INTO sign_ins (agent_id, provider, name, pointer_sealed, saved_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (agent_id, provider) DO UPDATE SET name = excluded.name, pointer_sealed = excluded.pointer_sealed, saved_at = excluded.saved_at
            RETURNING agent_id, provider, name, pointer_sealed, saved_at`,
          params: [agentId, provider, name, pointerSealed, at],
        }]);
        return signInOf(result!.rows[0] as SignInRecord);
      },
      list: async (agentId) =>
        (await db.all<SignInRecord>("SELECT agent_id, provider, name, pointer_sealed, saved_at FROM sign_ins WHERE agent_id = ? ORDER BY provider", agentId)).map(signInOf),
      get: async (agentId, provider) => {
        const row = await db.get<SignInRecord>("SELECT agent_id, provider, name, pointer_sealed, saved_at FROM sign_ins WHERE agent_id = ? AND provider = ?", agentId, provider);
        return row && signInOf(row);
      },
      tombstones: async (agentId, provider) =>
        (await db.all<SignInTombstoneRecord>("SELECT agent_id, provider, pointer_sealed, forgotten_at FROM sign_in_tombstones WHERE agent_id = ? AND provider = ? ORDER BY id DESC", agentId, provider)).map(signInTombstoneOf),
      forget: (agentId, provider, held) =>
        db.transaction(async (tx) => {
          // The hold check and the move are one transaction: a launch writing sign_in_handed is another, and the store's one
          // writer lock serializes them, so forget never passes a hold a launch took, nor a launch a forget cleared.
          const holder = held.hash !== undefined ? await handedHolderIn(tx, held.hash) : held.heldUnreadable ? await handedAnyIn(tx) : undefined;
          if (holder) throw new SignInHandedTo(holder.id);
          const live = await tx.get<SignInRecord>("SELECT agent_id, provider, name, pointer_sealed, saved_at FROM sign_ins WHERE agent_id = ? AND provider = ?", agentId, provider);
          if (!live) throw new SignInMissing(agentId, provider);
          const at = now();
          const tomb = await tx.get<SignInTombstoneRecord>(
            "INSERT INTO sign_in_tombstones (agent_id, provider, pointer_sealed, forgotten_at) VALUES (?, ?, ?, ?) RETURNING agent_id, provider, pointer_sealed, forgotten_at",
            agentId, provider, live.pointer_sealed, at,
          );
          await tx.run("DELETE FROM sign_ins WHERE agent_id = ? AND provider = ?", agentId, provider);
          // The newest kept, the oldest dropped first (per agent, across providers).
          await tx.run("DELETE FROM sign_in_tombstones WHERE agent_id = ? AND id NOT IN (SELECT id FROM sign_in_tombstones WHERE agent_id = ? ORDER BY id DESC LIMIT ?)", agentId, agentId, SIGN_IN_TOMBSTONES_KEPT);
          return signInTombstoneOf(tomb!);
        }),
      handedHolder: async (hash) => (await handedHolderIn(db, hash))?.id,
      handedAny: async () => (await handedAnyIn(db))?.id,
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
      // A take or reclaim leaves no viewer of an older claim behind: its rows go in this transaction.
      for (const row of rows) await tx.run("DELETE FROM browser_viewers WHERE run_id = ? AND epoch < ?", row.id, row.epoch);
      // A newer claim of a run supersedes its release here: journal() refuses by epoch, and the newer epoch passes.
      for (const { id } of picked) this.#released.delete(id);
      return picked.map(({ id, state }) => ({ runId: id, runner, epoch: epochs.get(id)!, until, from: state }));
    });
  }

  async renew(claim: Claim, { leaseMs = DEFAULT_LEASE_MS }: { leaseMs?: number } = {}): Promise<Claim> {
    // As a claim's: the lease runs from when the renew holds the writer lock.
    // A lease that ran out is gone: no renew brings it back (its runner takes the run again, at a new epoch).
    const until = await this.#db.transaction(async (tx) => {
      const now = this.#now();
      const at = now + leaseMs;
      const fence = claimFence(claim, now);
      await tx.step(fenced(claim, `UPDATE runs SET claimed_until = ? WHERE ${fence.where} AND runner = ?`, [at, ...fence.params, claim.runner]));
      return at;
    });
    return { ...claim, until };
  }

  async renewMany(claims: readonly Claim[], { leaseMs = DEFAULT_LEASE_MS }: { leaseMs?: number } = {}): Promise<(Claim | Fenced)[]> {
    if (claims.length === 0) return [];
    // One transaction for every claim, each update on its own: a claim another runner took changes no row and is answered
    // Fenced, never rolling the others back.
    return this.#db.transaction(async (tx) => {
      const now = this.#now();
      const until = now + leaseMs;
      const out: (Claim | Fenced)[] = [];
      for (const claim of claims) {
        const fence = claimFence(claim, now);
        const renewed = await tx.all<{ id: string }>(`UPDATE runs SET claimed_until = ? WHERE ${fence.where} AND runner = ? RETURNING id`, until, ...fence.params, claim.runner);
        out.push(renewed.length > 0 ? { ...claim, until } : new Fenced(claim.runId, claim.epoch));
      }
      return out;
    });
  }

  async release(claim: Claim, { state, wakeAt = null, backoffUntil = null }: { state?: RunState; wakeAt?: number | null; backoffUntil?: number | null } = {}): Promise<void> {
    const ending = state !== undefined && FINAL_STATES.includes(state);
    await this.#db.transaction(async (tx) => {
      // A run its end already made final was released by that end (applyRunPatch): this release is a no-op, no second
      // move of its epoch and no error, whatever its claim's lease says now.
      const final = await tx.get<{ state: RunState; runner: string | null }>("SELECT state, runner FROM runs WHERE id = ?", claim.runId);
      if (final && FINAL_STATES.includes(final.state) && final.runner === null) return;
      const now = this.#now();
      await tx.step(fenced(
        claim,
        // The epoch moves on at a release: the released claim is dead everywhere (its journal, its run updates, its takes),
        // never live until the next claim. A claim whose lease ran out releases nothing: the run, running with its lease run
        // out, is claimable at once, never stuck.
        `UPDATE runs SET epoch = epoch + 1, runner = NULL, claimed_until = NULL, wake_at = ?, backoff_until = ?, state = coalesce(?, state)${ending ? ", ended_at = coalesce(ended_at, ?)" : ""} WHERE ${claimFence(claim, now).where} AND runner = ?`,
        [wakeAt, backoffUntil, state ?? null, ...(ending ? [now] : []), ...claimFence(claim, now).params, claim.runner],
      ));
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
    });
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

  async runOfOrigin(key: string): Promise<{ runId: string; fingerprint: string | null } | undefined> {
    const row = await this.#db.get<{ run_id: string; fingerprint: string | null }>("SELECT run_id, fingerprint FROM run_origins WHERE key = ?", key);
    return row && { runId: row.run_id, fingerprint: row.fingerprint };
  }

  async commandsOf(cursors: readonly { runId: string; after: number }[]): Promise<Map<string, Command[]>> {
    const out = new Map<string, Command[]>();
    if (cursors.length === 0) return out;
    // One read for every run: each cursor a (run_id, after) row of a VALUES list joined against the commands.
    const rows = await this.#db.all<CommandRecord>(
      `WITH cursors(run_id, after) AS (VALUES ${cursors.map(() => "(?, ?)").join(", ")})
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
      // The ended run row, its launch row and its transcript's journal, all in this one transaction (the server's own
      // writer): a crash between them leaves nothing. The run is created at epoch 0 with no runner, and the journal's fence
      // passes for that one row, by the rowid its insert returned (the claim fence's inserted-here form).
      const row = await tx.get<RunRecord & { inserted_rowid: number }>(
        `INSERT INTO runs (id, agent_id, revision_id, state, epoch, cost_usd, metrics, summary, outcome, imported_from, started_at, ended_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?) RETURNING rowid AS inserted_rowid, ${RUN_COLUMNS}`,
        run.id, run.agentId, run.revisionId, state, run.costUsd ?? null,
        run.metrics === undefined || run.metrics === null ? null : json(run.metrics), run.summary ?? null,
        run.outcome ?? null, JSON.stringify(run.importedFrom), run.startedAt, run.endedAt ?? at,
      );
      await writeLaunch(tx, run.id, run.launch, at);
      await new RunStorage(this.#db, { runId: run.id, epoch: 0 }, this.#now).applyIn(tx, run.transcript, row!.inserted_rowid);
      return runOf(row!);
    });
  }

  async take(claim: Claim, commandId: number, outcome: "taken" | "refused" = "taken", reason?: string): Promise<void> {
    // The clock is read inside the transaction, so the lease check and the write are one.
    await this.#db.transaction(async (tx) => {
      const now = this.#now();
      const fence = claimFence(claim, now);
      await tx.step(fenced(claim, `UPDATE runs SET epoch = epoch WHERE ${fence.where}`, fence.params));
      await tx.run("UPDATE commands SET taken_at = ?, refused = ? WHERE id = ? AND run_id = ? AND taken_at IS NULL", now, outcome === "refused" ? (reason ?? "refused") : null, commandId, claim.runId);
    });
  }

  async retry(claim: Claim, commandId: number): Promise<number> {
    const counted = await this.#db.transaction(async (tx) => {
      const fence = claimFence(claim, this.#now());
      await tx.step(fenced(claim, `UPDATE runs SET epoch = epoch WHERE ${fence.where}`, fence.params));
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
