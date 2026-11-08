// SqliteStore: the Store (store.ts) on one SQLite file, through the one connection (connection.ts, on its worker thread).
// The only code with SQL in it, besides the schema and the run patch. The file is on local disk, never on Archil: one
// connection per process, and SQLite's one writer lock serializes the server's and every runner's commits. A unit of work
// with more than one statement is one transaction (connection.transaction, BEGIN IMMEDIATE): all of it or none of it.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunStorage } from "../journal/storage.js";
import { DDL, SCHEMA_VERSION } from "../schema.js";
import {
  SchemaVersionUnknown, StoreConstraint,
  type AgentRow, type Agents, type AlsoRow, type Claim, type Command, type Journal, type NewRevision, type RevisionRow, type RunPatch, type RunRow, type Runs,
  type RunState, type Store, type StoreRole, type TemplatePackage, type Templates, type TriggerDef, type TriggerRow, type Triggers, type TriggerScope,
  FINAL_STATES,
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
type TriggerRecord = { id: string; agent_id: string; name: string; enabled: number; source: string; target: string; next_at: number | null; last_run_id: string | null };

const AGENT_COLUMNS = "id, name, description, current_revision, created_at, archived_at";
const REVISION_COLUMNS = "id, agent_id, kind, body, package, created_at";
const COMMAND_COLUMNS = "id, run_id, kind, body, created_at, taken_at, refused, tries";
const TRIGGER_COLUMNS = "id, agent_id, name, enabled, source, target, next_at, last_run_id";
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
});
const json = (value: unknown): string => JSON.stringify(value ?? null);

/** The store's schema version as the file holds it: null when the server has not set it up (no store_meta yet). */
async function versionOf(db: Connection): Promise<number | null> {
  const table = await db.get<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'store_meta'");
  if (!table) return null;
  return (await db.get<{ schema_version: number }>("SELECT schema_version FROM store_meta WHERE singleton = 1"))?.schema_version ?? null;
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
    // The server makes its data directory; a runner opens only one that is there.
    if (role === "server") mkdirSync(options.dataDir, { recursive: true });
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

/** A statement under `claim`: one that changes no row means the run's epoch moved on, and the transaction rolls back. */
function fenced(claim: Claim, sql: string, params: readonly SqliteValue[]): Statement {
  return { sql, params, expect: { kind: "fenced", runId: claim.runId, epoch: claim.epoch } };
}

class SqliteStore implements Store {
  readonly agents: Agents;
  readonly templates: Templates;
  readonly triggers: Triggers;
  readonly runs: Runs;
  readonly #db: Connection;
  readonly #now: () => number;

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
      update: async (claim: Claim, patch: RunPatch, also: readonly AlsoRow[] = []): Promise<RunRow> => db.transaction((tx) => applyRunPatch(tx, claim, patch, also, now())),
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
  }

  journal(claim: Claim): Journal {
    return new RunStorage(this.#db, claim, this.#now);
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
