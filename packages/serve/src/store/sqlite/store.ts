// SqliteStore: the Store (store.ts) on one SQLite file, through the one connection (connection.ts, on its worker thread).
// The only code with SQL in it, besides the schema. The file is on local disk, never on Archil: one connection per
// process, and SQLite's one writer lock serializes the server's and every runner's commits.
import type { Storage } from "@earendil-works/pi-durable";
import { DDL, SCHEMA_VERSION } from "../schema.js";
import { FINAL_STATES, type AgentRow, type Agents, type Claim, type Command, type RevisionRow, type RunRow, type Runs, type RunState, type Store } from "../store.js";
import { Connection, type Params } from "./connection.js";

/** A claim's length when the caller names none. */
export const DEFAULT_LEASE_MS = 30_000;

export type SqliteStoreOptions = {
  /** The store's file. */
  file: string;
  /** The store's clock, in ms (Date.now): claimed_until and every row's time. */
  now?: () => number;
  /** How long a write waits for another process's lock before StoreBusy. */
  busyTimeoutMs?: number;
};

type RunRecord = {
  id: string; agent_id: string; revision_id: string; state: RunState; epoch: number; runner: string | null; claimed_until: string | null;
  cost_usd: number | null; metrics: string | null; summary: string | null; started_at: string; ended_at: string | null;
};
type AgentRecord = { id: string; name: string; description: string | null; current_revision: string | null; created_at: string; archived_at: string | null };
type RevisionRecord = { id: string; agent_id: string; kind: string; body: string; created_at: string };
type CommandRecord = { id: number; run_id: string; kind: string; body: string; created_at: string; taken_at: string | null };

const RUN_COLUMNS = "id, agent_id, revision_id, state, epoch, runner, claimed_until, cost_usd, metrics, summary, started_at, ended_at";
const FINAL = FINAL_STATES.map((state) => `'${state}'`).join(", ");

const runOf = (r: RunRecord): RunRow => ({
  id: r.id, agentId: r.agent_id, revisionId: r.revision_id, state: r.state, epoch: r.epoch, runner: r.runner, claimedUntil: r.claimed_until,
  costUsd: r.cost_usd, metrics: r.metrics === null ? null : JSON.parse(r.metrics), summary: r.summary, startedAt: r.started_at, endedAt: r.ended_at,
});
const agentOf = (r: AgentRecord): AgentRow => ({ id: r.id, name: r.name, description: r.description, currentRevision: r.current_revision, createdAt: r.created_at, archivedAt: r.archived_at });
const revisionOf = (r: RevisionRecord): RevisionRow => ({ id: r.id, agentId: r.agent_id, kind: r.kind, body: JSON.parse(r.body), createdAt: r.created_at });
const commandOf = (r: CommandRecord): Command => ({ id: r.id, runId: r.run_id, kind: r.kind, body: JSON.parse(r.body), createdAt: r.created_at, takenAt: r.taken_at });

/** Opens (creating when it is not there) the store at `file`: its schema, at version SCHEMA_VERSION, in one durable commit. */
export async function openSqliteStore(options: SqliteStoreOptions): Promise<Store> {
  const connection = await Connection.open(options.file, options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs });
  const now = options.now ?? Date.now;
  try {
    await connection.write([...DDL.map((sql) => ({ sql })), { sql: "INSERT INTO store_meta (singleton, schema_version) VALUES (1, ?) ON CONFLICT (singleton) DO NOTHING", params: [SCHEMA_VERSION] }], { full: true });
    const meta = await connection.get<{ schema_version: number }>("SELECT schema_version FROM store_meta WHERE singleton = 1");
    if (meta?.schema_version !== SCHEMA_VERSION) throw new Error(`the store at ${options.file} is schema version ${String(meta?.schema_version)}; this build reads version ${SCHEMA_VERSION}`);
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
  return new SqliteStore(connection, now);
}

class SqliteStore implements Store {
  readonly agents: Agents;
  readonly runs: Runs;
  readonly #db: Connection;
  readonly #now: () => number;

  constructor(db: Connection, now: () => number) {
    this.#db = db;
    this.#now = now;
    const iso = () => new Date(this.#now()).toISOString();

    this.agents = {
      put: async ({ id, name, description = null }) => {
        await db.write([{ sql: "INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description", params: [id, name, description, iso()] }]);
      },
      get: async (id) => {
        const row = await db.get<AgentRecord>("SELECT id, name, description, current_revision, created_at, archived_at FROM agents WHERE id = ?", [id]);
        return row && agentOf(row);
      },
      list: async ({ archived = false } = {}) =>
        (await db.all<AgentRecord>(`SELECT id, name, description, current_revision, created_at, archived_at FROM agents WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY created_at, id`)).map(agentOf),
      archive: async (id, archived) => {
        await db.write([{ sql: "UPDATE agents SET archived_at = ? WHERE id = ?", params: [archived ? iso() : null, id] }]);
      },
      addRevision: async ({ id, agentId, kind, body }) => {
        await db.write([
          { sql: "INSERT INTO revisions (id, agent_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)", params: [id, agentId, kind, JSON.stringify(body ?? null), iso()] },
          { sql: "UPDATE agents SET current_revision = ? WHERE id = ?", params: [id, agentId] },
        ]);
      },
      revision: async (id) => {
        const row = await db.get<RevisionRecord>("SELECT id, agent_id, kind, body, created_at FROM revisions WHERE id = ?", [id]);
        return row && revisionOf(row);
      },
      revisions: async (agentId) => (await db.all<RevisionRecord>("SELECT id, agent_id, kind, body, created_at FROM revisions WHERE agent_id = ? ORDER BY created_at, id", [agentId])).map(revisionOf),
    };

    this.runs = {
      create: async ({ id, agentId, revisionId }) => {
        const [result] = await db.write([{ sql: `INSERT INTO runs (id, agent_id, revision_id, state, epoch, started_at) VALUES (?, ?, ?, 'queued', 0, ?) RETURNING ${RUN_COLUMNS}`, params: [id, agentId, revisionId, iso()] }]);
        return runOf(result!.rows[0] as RunRecord);
      },
      get: async (id) => {
        const row = await db.get<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, [id]);
        return row && runOf(row);
      },
      list: async ({ agentId, revisionId, state, limit }) => {
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (agentId !== undefined) (where.push("agent_id = ?"), params.push(agentId));
        if (revisionId !== undefined) (where.push("revision_id = ?"), params.push(revisionId));
        if (state !== undefined) (where.push("state = ?"), params.push(state));
        const bounded = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0;
        if (bounded) params.push(limit);
        const rows = await db.all<RunRecord>(`SELECT ${RUN_COLUMNS} FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC${bounded ? " LIMIT ?" : ""}`, params);
        return rows.map(runOf);
      },
      update: async (claim, patch) => {
        const sets: string[] = [];
        const params: Params[number][] = [];
        const set = (column: string, value: Params[number]) => (sets.push(`${column} = ?`), params.push(value));
        if (patch.state !== undefined) set("state", patch.state);
        if (patch.costUsd !== undefined) set("cost_usd", patch.costUsd);
        if (patch.metrics !== undefined) set("metrics", patch.metrics === null ? null : JSON.stringify(patch.metrics));
        if (patch.summary !== undefined) set("summary", patch.summary);
        const ending = patch.state !== undefined && FINAL_STATES.includes(patch.state);
        if (patch.endedAt !== undefined) set("ended_at", patch.endedAt);
        else if (ending) set("ended_at", iso());
        // Nothing to change still proves the claim: the epoch is read back under it.
        const assignments = sets.length ? sets.join(", ") : "epoch = epoch";
        const [result] = await db.write([fenced(claim, `UPDATE runs SET ${assignments} WHERE id = ? AND epoch = ? RETURNING ${RUN_COLUMNS}`, [...params, claim.runId, claim.epoch])]);
        return runOf(result!.rows[0] as RunRecord);
      },
    };
  }

  async claim(runId: string, runner: string, { leaseMs = DEFAULT_LEASE_MS }: { leaseMs?: number } = {}): Promise<Claim | null> {
    const at = this.#now();
    const until = new Date(at + leaseMs).toISOString();
    const [result] = await this.#db.write([{
      sql: `UPDATE runs SET epoch = epoch + 1, runner = ?, claimed_until = ?, state = CASE WHEN state = 'queued' THEN 'running' ELSE state END
        WHERE id = ? AND (state = 'queued' OR (state IN ('running', 'parked') AND (claimed_until IS NULL OR claimed_until < ?)))
        RETURNING epoch`,
      params: [runner, until, runId, new Date(at).toISOString()],
    }]);
    const row = result!.rows[0] as { epoch: number } | undefined;
    return row ? { runId, runner, epoch: row.epoch, until } : null;
  }

  async renew(claim: Claim, { leaseMs = DEFAULT_LEASE_MS }: { leaseMs?: number } = {}): Promise<Claim> {
    const until = new Date(this.#now() + leaseMs).toISOString();
    await this.#db.write([fenced(claim, "UPDATE runs SET claimed_until = ? WHERE id = ? AND epoch = ? AND runner = ?", [until, claim.runId, claim.epoch, claim.runner])]);
    return { ...claim, until };
  }

  async release(claim: Claim): Promise<void> {
    await this.#db.write([fenced(claim, "UPDATE runs SET runner = NULL, claimed_until = NULL WHERE id = ? AND epoch = ? AND runner = ?", [claim.runId, claim.epoch, claim.runner])], { full: true });
  }

  journal(_claim: Claim): Storage {
    throw new Error("the store's journal (pi-durable's Storage by run_id) is module A2's: not in this build yet");
  }

  async flush(): Promise<void> {
    await this.#db.write([{ sql: "UPDATE store_meta SET flushes = flushes + 1 WHERE singleton = 1" }], { full: true });
  }

  async command(runId: string, { kind, body = null }: { kind: string; body?: unknown }): Promise<Command> {
    const [result] = await this.#db.write([{
      sql: `INSERT INTO commands (run_id, kind, body, created_at) SELECT id, ?, ?, ? FROM runs WHERE id = ? AND state NOT IN (${FINAL})
        RETURNING id, run_id, kind, body, created_at, taken_at`,
      params: [kind, JSON.stringify(body), new Date(this.#now()).toISOString(), runId],
      expect: { kind: "final", runId },
    }]);
    return commandOf(result!.rows[0] as CommandRecord);
  }

  async commands(runId: string, after: number): Promise<Command[]> {
    return (await this.#db.all<CommandRecord>("SELECT id, run_id, kind, body, created_at, taken_at FROM commands WHERE run_id = ? AND id > ? ORDER BY id", [runId, after])).map(commandOf);
  }

  async take(claim: Claim, commandId: number): Promise<void> {
    await this.#db.write([
      fenced(claim, "UPDATE runs SET epoch = epoch WHERE id = ? AND epoch = ?", [claim.runId, claim.epoch]),
      { sql: "UPDATE commands SET taken_at = ? WHERE id = ? AND run_id = ? AND taken_at IS NULL", params: [new Date(this.#now()).toISOString(), commandId, claim.runId] },
    ]);
  }

  close(): Promise<void> {
    return this.#db.close();
  }
}

/** A statement under `claim`: one that changes no row means the run's epoch moved on, and the transaction rolls back. */
function fenced(claim: Claim, sql: string, params: Params) {
  return { sql, params, expect: { kind: "fenced" as const, runId: claim.runId, epoch: claim.epoch } };
}
