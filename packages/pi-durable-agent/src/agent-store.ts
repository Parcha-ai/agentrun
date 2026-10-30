import type { JsonObject } from "@earendil-works/pi-durable";
import type { Workflow } from "@parcha/agentrun-dsl"; // a type only: a store that never holds a workflow loads nothing of the DSL
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ID_PATTERN, isSkillPath, openAgentHome, readAgentHome, runStoreIn, sha256, uuidv7 } from "./home.js";
import type { PromptVariant } from "./kinds.js";
import { canonical } from "./kinds.js";
import { seedRun } from "./runs.js";
import { AgentHomeError } from "./store.js";

// An agent store is one folder: `store.sqlite` (plain tables, and the truth) and `runs/<run id>/`, each run's own pi-durable store and
// work directory. Copy the folder and every agent, revision and run comes with it.

export const STORE_FILE = "store.sqlite";
export type RevisionKind = "agentic" | "workflow";
/** `harness`: the harness that runs the revision, an id its host knows (absent: the host's default). */
export type AgenticBody = { instructions: string; skills: Record<string, string>; tools: string[]; model?: string; thinking?: string; prompts?: Record<string, PromptVariant>; harness?: string };
export type WorkflowBody = { workflow: Workflow; skills: Record<string, string>; tools: string[]; harness?: string };
/** Written once, never edited. `id` is the SHA-256 of the canonical JSON of `{ agent, parent, kind, body }`; `body.skills` maps a skill path to the SHA-256 of its text. */
export type Revision = { id: string; agent: string; parent: string | null; createdAt: string; note?: string } & ({ kind: "agentic"; body: AgenticBody } | { kind: "workflow"; body: WorkflowBody });
/** `archivedAt`: when it was archived, while it is: hidden from lists, kept with its history. */
export type Agent = { id: string; name: string; description?: string; createdAt: string; current: string | null; archivedAt?: string };
export type AgentRow = Agent & { currentKind: RevisionKind | null; runs: number };
export type RevisionRow = { id: string; agent: string; parent: string | null; createdAt: string; note?: string; kind: RevisionKind; current: boolean };
export type RunState = "running" | "completed" | "failed" | "stopped" | "escalated";
/** At most 2000 UTF-16 units: a longer text keeps its start plus an ellipsis, and never splits a surrogate pair. */
function cutSummary(text: string): string {
  if (text.length <= 2_000) return text;
  let end = 1_999;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + "\u2026";
}

/** `archivedAt`: when the run was archived, else when its agent was, while it is. */
export type RunRow = { id: string; agent: string; revision: string; kind: RevisionKind; state: RunState; startedAt: string; endedAt?: string; costUsd?: number; summary?: string; archivedAt?: string };
/** What can be archived. */
export type ArchiveKind = "agent" | "run";
type RunCounts = Record<RunState, number> & { total: number };
/** `usd` sums the costs of the `known` runs, those that ended with one; null when there are none, never 0. A run still
 *  running, or one that ended with no cost, is `unknown`. */
type CostSum = { usd: number | null; known: number; unknown: number };
/** What `stats` answers. Every number but `archivedAgents` and `archivedRuns` leaves out what is archived; a run of an
 *  archived agent is archived with it. `byAgent`: each agent by name, with its run count; `running`: the ids of the runs
 *  still running. */
export type StoreStats = {
  agents: number; archivedAgents: number; runs: RunCounts; archivedRuns: number; cost: CostSum;
  byAgent: Array<{ id: string; name: string; runs: number }>;
  running: string[];
};
export type NewRevision =
  | { kind: "agentic"; instructions: string; skills?: Record<string, string>; tools?: string[]; model?: string; thinking?: string; prompts?: Record<string, PromptVariant>; harness?: string; note?: string }
  | { kind: "workflow"; workflow: Workflow; skills?: Record<string, string>; tools?: string[]; harness?: string; note?: string };
export type StartedRun = { runId: string; dir: string; storePath: string; workspace: string; agentId: string; revision: Revision };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  created_at       TEXT NOT NULL,
  current_revision TEXT REFERENCES revisions(id)
);
CREATE TABLE IF NOT EXISTS revisions (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  parent_id  TEXT REFERENCES revisions(id),
  kind       TEXT NOT NULL CHECK (kind IN ('agentic', 'workflow')),
  body_json  TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS revisions_are_written_once BEFORE UPDATE ON revisions
BEGIN SELECT RAISE(ABORT, 'a revision is written once'); END;
CREATE TABLE IF NOT EXISTS skills (
  sha256  TEXT PRIMARY KEY,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  state       TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'stopped', 'escalated')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  cost_usd    REAL,
  summary     TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_agent ON runs(agent_id, started_at);
CREATE INDEX IF NOT EXISTS runs_by_state ON runs(state);
CREATE TABLE IF NOT EXISTS archive_changes (
  seq      INTEGER PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('agent', 'run')),
  id       TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_changes_by_item ON archive_changes(kind, id, seq);
CREATE TRIGGER IF NOT EXISTS archive_changes_are_written_once BEFORE UPDATE ON archive_changes
BEGIN SELECT RAISE(ABORT, 'an archive change is written once'); END;
CREATE TRIGGER IF NOT EXISTS archive_changes_are_kept BEFORE DELETE ON archive_changes
BEGIN SELECT RAISE(ABORT, 'an archive change is written once'); END;`;

// archive_changes and runs_by_state came after version 1 without a new version: an earlier version opens the file and
// ignores them.
const STORE_VERSION = 1;
const SQLITE_READONLY_ROLLBACK = 776;
const SQLITE_CONSTRAINT = 19;
/** Fail closed on a file a newer version wrote. */
function checkVersion(db: DatabaseSync): void {
  if ((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version > STORE_VERSION) throw new AgentHomeError("format", "this store was written by a newer version");
}

const invalid = (message: string) => new AgentHomeError("invalid", message);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const checkId = (id: unknown, what: string): string => {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw invalid(`the ${what} id is not letters, digits, ".", "_" or "-" (at most 128)`);
  return id;
};
const revisionHash = (r: { agent: string; parent: string | null; kind: string; body: unknown }) => sha256(canonical({ agent: r.agent, parent: r.parent, kind: r.kind, body: r.body }));
const RUN_STATES: readonly RunState[] = ["running", "completed", "failed", "stopped", "escalated"];

/** A revision as stored, checked: the id is the hash of its content, so a row that was changed does not pass. */
function revisionOf(row: Record<string, unknown>): Revision {
  const body = JSON.parse(row.body_json as string) as unknown;
  const revision = { id: row.id as string, agent: row.agent_id as string, parent: (row.parent_id as string | null) ?? null, createdAt: row.created_at as string, ...(row.note ? { note: row.note as string } : {}), kind: row.kind as RevisionKind, body } as Revision;
  if (revisionHash(revision) !== revision.id) throw new AgentHomeError("format", "a revision does not match its id: its content was changed");
  return revision;
}

const HARNESS_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** The body of a new revision and the text of each skill it names. Everything about the input is checked here, before any write. */
function bodyOf(input: NewRevision): { body: AgenticBody | WorkflowBody; texts: Map<string, string> } {
  if (!isObject(input)) throw invalid("the revision is not an object");
  const skills: Record<string, string> = {}; const texts = new Map<string, string>();
  for (const [file, text] of Object.entries(input.skills ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isSkillPath(file)) throw invalid("a skill path is not a relative path inside .agents/skills/");
    if (typeof text !== "string") throw invalid("a skill is not text");
    skills[file] = sha256(text); texts.set(skills[file], text);
  }
  const tools = input.tools ?? [];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && t !== "") || new Set(tools).size !== tools.length) throw invalid("the tools are not a list of distinct non-empty names");
  if (input.harness !== undefined && (typeof input.harness !== "string" || !HARNESS_ID.test(input.harness))) throw invalid("the harness is not a harness id (lowercase letters, digits and dashes)");
  const harness = input.harness !== undefined ? { harness: input.harness } : {};
  if (input.kind === "agentic") {
    if (typeof input.instructions !== "string") throw invalid("an agentic revision needs instructions (its prompt, possibly empty)");
    for (const field of ["model", "thinking"] as const) if (input[field] !== undefined && (typeof input[field] !== "string" || input[field] === "")) throw invalid(`the ${field} is not a non-empty string`);
    return { body: { instructions: input.instructions, skills, tools: [...tools], ...(input.model !== undefined ? { model: input.model } : {}), ...(input.thinking !== undefined ? { thinking: input.thinking } : {}), ...(input.prompts !== undefined ? { prompts: structuredClone(input.prompts) } : {}), ...harness }, texts };
  }
  if (input.kind !== "workflow") throw invalid("the revision kind is not agentic or workflow");
  if (!isObject(input.workflow)) throw invalid("a workflow revision needs a workflow (a JSON object)");
  return { body: { workflow: structuredClone(input.workflow), skills, tools: [...tools], ...harness }, texts };
}

/** The reads: plain SQL over the one file, on a read-only handle. `openStoreReader` reads `store.sqlite` in place: it writes nothing and makes no copy, and a store with an unfinished write is named, not rolled back. */
export class AgentStoreReader {
  /** A store an earlier version wrote has no archive_changes until a writer opens it: nothing in it is archived. */
  private readonly archives: boolean;
  constructor(readonly dir: string, protected readonly db: DatabaseSync) {
    this.archives = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_changes'").get() !== undefined;
  }
  close(): void { this.db.close(); }

  /** SQL for when the `kind` whose id is `id` (an SQL expression) was archived, while it is; else NULL. */
  protected archivedAtSql(kind: ArchiveKind, id: string): string {
    return this.archives ? `(SELECT CASE WHEN c.archived = 1 THEN c.at END FROM archive_changes c WHERE c.kind = '${kind}' AND c.id = ${id} ORDER BY c.seq DESC LIMIT 1)` : "NULL";
  }
  /** A run's own archive time, else its agent's. */
  private runArchivedAtSql(): string {
    return `COALESCE(${this.archivedAtSql("run", "r.id")}, ${this.archivedAtSql("agent", "r.agent_id")})`;
  }

  listAgents(): AgentRow[] {
    const rows = this.db.prepare(`SELECT a.id, a.name, a.description, a.created_at, a.current_revision, cur.kind AS current_kind, (SELECT COUNT(*) FROM runs r WHERE r.agent_id = a.id) AS runs,
      ${this.archivedAtSql("agent", "a.id")} AS archived_at
      FROM agents a LEFT JOIN revisions cur ON cur.id = a.current_revision ORDER BY a.name, a.id`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: r.id as string, name: r.name as string, ...(r.description ? { description: r.description as string } : {}), createdAt: r.created_at as string, current: (r.current_revision as string | null) ?? null, currentKind: (r.current_kind as RevisionKind | null) ?? null, runs: Number(r.runs), ...(r.archived_at ? { archivedAt: r.archived_at as string } : {}) }));
  }
  /** Newest first. */
  listRevisions(agent: string): RevisionRow[] {
    const rows = this.db.prepare(`SELECT v.id, v.agent_id, v.parent_id, v.created_at, v.note, v.kind, (a.current_revision = v.id) AS is_current
      FROM revisions v JOIN agents a ON a.id = v.agent_id WHERE v.agent_id = ? ORDER BY v.created_at DESC, v.rowid DESC`).all(checkId(agent, "agent")) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: r.id as string, agent: r.agent_id as string, parent: (r.parent_id as string | null) ?? null, createdAt: r.created_at as string, ...(r.note ? { note: r.note as string } : {}), kind: r.kind as RevisionKind, current: Boolean(r.is_current) }));
  }
  readRevision(id: string): Revision {
    const row = this.db.prepare("SELECT * FROM revisions WHERE id = ?").get(checkId(id, "revision")) as Record<string, unknown> | undefined;
    if (!row) throw new AgentHomeError("missing", "there is no such revision");
    return revisionOf(row);
  }
  /** Newest first; a run joined to its revision's kind. */
  listRuns(filter: { agent?: string; revision?: string } = {}): RunRow[] {
    const rows = this.db.prepare(`SELECT r.id, r.agent_id, r.revision_id, v.kind, r.state, r.started_at, r.ended_at, r.cost_usd, r.summary, ${this.runArchivedAtSql()} AS archived_at FROM runs r JOIN revisions v ON v.id = r.revision_id
      WHERE (? IS NULL OR r.agent_id = ?) AND (? IS NULL OR r.revision_id = ?) ORDER BY r.started_at DESC, r.rowid DESC`).all(filter.agent ?? null, filter.agent ?? null, filter.revision ?? null, filter.revision ?? null) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: r.id as string, agent: r.agent_id as string, revision: r.revision_id as string, kind: r.kind as RevisionKind, state: r.state as RunState, startedAt: r.started_at as string, ...(r.ended_at ? { endedAt: r.ended_at as string } : {}), ...(r.cost_usd !== null ? { costUsd: Number(r.cost_usd) } : {}), ...(r.summary ? { summary: r.summary as string } : {}), ...(r.archived_at ? { archivedAt: r.archived_at as string } : {}) }));
  }
  /** One run: the README's join (runs, agents, revisions) for one run id, in one statement. The run plus its agent's name and its revision's note; undefined for an unknown run. */
  readRun(runId: string): (RunRow & { agentName: string; note?: string }) | undefined {
    const r = this.db.prepare(`SELECT r.id, r.agent_id, r.revision_id, v.kind, r.state, r.started_at, r.ended_at, r.cost_usd, r.summary, a.name AS agent_name, v.note, ${this.runArchivedAtSql()} AS archived_at
      FROM runs r JOIN agents a ON a.id = r.agent_id JOIN revisions v ON v.id = r.revision_id WHERE r.id = :id`).get({ id: checkId(runId, "run") }) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return { id: r.id as string, agent: r.agent_id as string, revision: r.revision_id as string, kind: r.kind as RevisionKind, state: r.state as RunState, startedAt: r.started_at as string, ...(r.ended_at ? { endedAt: r.ended_at as string } : {}), ...(r.cost_usd !== null ? { costUsd: Number(r.cost_usd) } : {}), ...(r.summary ? { summary: r.summary as string } : {}), agentName: r.agent_name as string, ...(r.note ? { note: r.note as string } : {}), ...(r.archived_at ? { archivedAt: r.archived_at as string } : {}) };
  }
  /** Counts and cost sums over the whole store, each an SQL aggregate over `store.sqlite`'s indexes, read in one
   *  snapshot; nothing under `runs/` is opened. */
  stats(): StoreStats {
    const notArchived = `${this.runArchivedAtSql()} IS NULL`;
    this.db.exec("BEGIN");
    try {
      const agents = this.db.prepare(`SELECT a.id, a.name, ${this.archivedAtSql("agent", "a.id")} IS NOT NULL AS archived FROM agents a ORDER BY a.name, a.id`).all() as Array<Record<string, unknown>>;
      // One pass over runs_by_agent: a run's own archive state is a group key, so it is looked up once per run.
      const groups = this.db.prepare(`SELECT agent_id, archived, COUNT(*) AS total, ${RUN_STATES.map((state) => `SUM(state = '${state}') AS ${state}`).join(", ")},
          SUM(CASE WHEN state <> 'running' THEN cost_usd END) AS cost_usd, SUM(state <> 'running' AND cost_usd IS NOT NULL) AS known
        FROM (SELECT r.agent_id, r.state, r.cost_usd, ${this.archivedAtSql("run", "r.id")} IS NOT NULL AS archived FROM runs r) GROUP BY agent_id, archived`).all() as Array<Record<string, unknown>>;
      const running = (this.db.prepare(`SELECT r.id FROM runs r WHERE r.state = 'running' AND ${notArchived}`).all() as Array<{ id: string }>).map((r) => r.id);
      const counts = (r?: Record<string, unknown>): RunCounts => ({ total: Number(r?.total ?? 0), ...(Object.fromEntries(RUN_STATES.map((state) => [state, Number(r?.[state] ?? 0)])) as Record<RunState, number>) });
      const shown = new Map<string, Record<string, unknown>>();
      const hidden = new Map<string, number>();
      for (const g of groups) {
        if (g.archived) hidden.set(g.agent_id as string, Number(g.total));
        else shown.set(g.agent_id as string, g);
      }
      const stats: StoreStats = { agents: 0, archivedAgents: 0, runs: counts(), archivedRuns: 0, cost: { usd: null, known: 0, unknown: 0 }, byAgent: [], running };
      for (const a of agents) {
        const g = shown.get(a.id as string);
        const runs = counts(g);
        stats.archivedRuns += hidden.get(a.id as string) ?? 0;
        if (a.archived) {
          stats.archivedAgents += 1;
          stats.archivedRuns += runs.total;
          continue;
        }
        const known = Number(g?.known ?? 0);
        stats.agents += 1;
        stats.byAgent.push({ id: a.id as string, name: a.name as string, runs: runs.total });
        for (const key of ["total", ...RUN_STATES] as const) stats.runs[key] += runs[key];
        if (known > 0) stats.cost.usd = (stats.cost.usd ?? 0) + Number(g!.cost_usd);
        stats.cost.known += known;
        stats.cost.unknown += runs.total - known;
      }
      return stats;
    } finally {
      this.db.exec("COMMIT");
    }
  }
  /** One agent with every revision and its body, newest first, `current` marked: one statement. Each revision is hash-verified as `readRevision` verifies it. Undefined for an unknown agent. */
  readAgent(agentId: string): { agent: Agent; revisions: Array<Revision & { current: boolean }> } | undefined {
    const rows = this.db.prepare(`SELECT a.id AS agent_id, a.name, a.description, a.created_at AS agent_created_at, a.current_revision, ${this.archivedAtSql("agent", "a.id")} AS archived_at,
        v.id, v.parent_id, v.kind, v.body_json, v.note, v.created_at
      FROM agents a LEFT JOIN revisions v ON v.agent_id = a.id WHERE a.id = :id ORDER BY v.created_at DESC, v.rowid DESC`).all({ id: checkId(agentId, "agent") }) as Array<Record<string, unknown>>;
    const first = rows[0];
    if (!first) return undefined;
    const agent: Agent = { id: first.agent_id as string, name: first.name as string, ...(first.description ? { description: first.description as string } : {}), createdAt: first.agent_created_at as string, current: (first.current_revision as string | null) ?? null, ...(first.archived_at ? { archivedAt: first.archived_at as string } : {}) };
    const revisions = rows.filter((r) => r.id !== null).map((r) => ({ ...revisionOf({ ...r, agent_id: r.agent_id }), current: r.id === first.current_revision }));
    return { agent, revisions };
  }
  /** `<dir>/runs/<run id>/store/run.sqlite`, for a run's timeline. It does not check that the file exists. */
  runStorePath(runId: string): string { return runStoreIn(path.join(this.dir, "runs", checkId(runId, "run"))); }
}

export class AgentStore extends AgentStoreReader {
  constructor(dir: string, db: DatabaseSync, private readonly check: (body: unknown) => Promise<unknown>) { super(dir, db); }
  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createAgent(input: { name: string; description?: string; id?: string }): Agent { return this.insertAgent(input); }

  private insertAgent(input: { name: string; description?: string; id?: string }): Agent {
    if (typeof input?.name !== "string" || input.name.trim() === "") throw invalid("the agent needs a name");
    if (input.description !== undefined && typeof input.description !== "string") throw invalid("the description is not text");
    const agent: Agent = { id: input.id === undefined ? uuidv7() : checkId(input.id, "agent"), name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), createdAt: new Date().toISOString(), current: null };
    try { this.db.prepare("INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?)").run(agent.id, agent.name, agent.description ?? null, agent.createdAt); }
    catch (error) {
      // Only the id's constraint means it exists; a busy store is the caller's to wait out.
      if ((Number((error as { errcode?: unknown }).errcode) & 0xff) === SQLITE_CONSTRAINT) throw new AgentHomeError("exists", "that agent already exists");
      throw error;
    }
    return agent;
  }

  /** A new revision of `agent`, its parent the agent's current revision (none: null). The same agent, parent, kind and body is the same revision and writes nothing. With `ifCurrent` (the current revision the caller read, null for none) the commit is a compare-and-swap: another current is refused (`stale`) inside the same transaction, and nothing is written. */
  async commitRevision(agent: string, input: NewRevision, options: { setCurrent?: boolean; ifCurrent?: string | null } = {}): Promise<Revision> {
    checkId(agent, "agent");
    if (options.ifCurrent !== undefined && options.ifCurrent !== null) checkId(options.ifCurrent, "revision");
    const { body, texts } = bodyOf(input);
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2_000)) throw invalid("the note is not text of at most 2000 characters");
    if (input.kind === "workflow") await this.check(body); // item 2's check, before a write: a refusal writes nothing
    return this.tx(() => this.writeRevision(agent, input, body, texts, options));
  }

  /** The rows of a new revision, inside the caller's transaction. */
  private writeRevision(agent: string, input: NewRevision, body: AgenticBody | WorkflowBody, texts: Map<string, string>, options: { setCurrent?: boolean; ifCurrent?: string | null }): Revision {
    {
      const row = this.db.prepare("SELECT current_revision FROM agents WHERE id = ?").get(agent) as { current_revision: string | null } | undefined;
      if (!row) throw new AgentHomeError("missing", "there is no such agent");
      if (options.ifCurrent !== undefined && row.current_revision !== options.ifCurrent) throw new AgentHomeError("stale", "the agent's current revision is not the one the commit expects");
      const parent = row.current_revision; // always the agent's current revision, which setCurrent only sets to its own: the parent is the agent's own by construction
      if (parent !== null && !this.db.prepare("SELECT 1 FROM revisions WHERE id = ? AND agent_id = ?").get(parent, agent)) throw invalid("the parent is not a revision of that agent");
      const id = revisionHash({ agent, parent, kind: input.kind, body });
      let revision: Revision;
      const known = this.db.prepare("SELECT * FROM revisions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (known) revision = revisionOf(known);
      else {
        revision = { id, agent, parent, createdAt: new Date().toISOString(), ...(input.note !== undefined ? { note: input.note } : {}), kind: input.kind, body } as Revision;
        for (const [sha, text] of texts) this.db.prepare("INSERT OR IGNORE INTO skills (sha256, content) VALUES (?, ?)").run(sha, text);
        this.db.prepare("INSERT INTO revisions (id, agent_id, parent_id, kind, body_json, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, agent, parent, input.kind, JSON.stringify(body), input.note ?? null, revision.createdAt);
      }
      if (options.setCurrent) this.db.prepare("UPDATE agents SET current_revision = ? WHERE id = ?").run(id, agent);
      return revision;
    }
  }

  setCurrent(agent: string, revision: string): void {
    const done = this.db.prepare("UPDATE agents SET current_revision = ? WHERE id = ? AND EXISTS (SELECT 1 FROM revisions WHERE id = ? AND agent_id = ?)").run(checkId(revision, "revision"), checkId(agent, "agent"), revision, agent);
    if (done.changes === 0) throw invalid("that revision is not a revision of that agent");
  }

  /** Archive (`archived`) or unarchive an agent or a run: one row appended when its state changes, none when it does
   *  not. When it is archived now, the time it was; else null. A run of an archived agent is archived with it, but its
   *  own state is its own. */
  setArchived(kind: ArchiveKind, id: string, archived: boolean): string | null {
    if (kind !== "agent" && kind !== "run") throw invalid("only an agent or a run is archived");
    checkId(id, kind);
    return this.tx(() => {
      if (!this.db.prepare(`SELECT 1 FROM ${kind === "agent" ? "agents" : "runs"} WHERE id = ?`).get(id)) throw new AgentHomeError("missing", `there is no such ${kind}`);
      const own = (this.db.prepare(`SELECT ${this.archivedAtSql(kind, "?")} AS at`).get(id) as { at: string | null }).at;
      if (Boolean(own) === archived) return own;
      const at = new Date().toISOString();
      this.db.prepare("INSERT INTO archive_changes (kind, id, archived, at) VALUES (?, ?, ?, ?)").run(kind, id, archived ? 1 : 0, at);
      return archived ? at : null;
    });
  }

  /** Start a run pinned to `revision` (default: the agent's current one): the run's directory is seeded in pi-durable-disk's layout, then its row goes in as `running`. */
  async startRun(input: { agent: string; revision?: string }): Promise<StartedRun> {
    const agent = checkId(input?.agent, "agent");
    if ("runId" in input) throw invalid("startRun takes no run id: the store mints it");
    const runId = uuidv7();
    const revisionId = input.revision ?? (this.db.prepare("SELECT current_revision FROM agents WHERE id = ?").get(agent) as { current_revision: string | null } | undefined)?.current_revision;
    if (!revisionId) throw invalid("the agent has no current revision: name one");
    const revision = this.readRevision(revisionId);
    if (revision.agent !== agent) throw invalid("that revision is not a revision of that agent");
    const skills = Object.fromEntries(Object.entries(revision.body.skills).map(([file, sha]) => {
      const text = (this.db.prepare("SELECT content FROM skills WHERE sha256 = ?").get(sha) as { content: string } | undefined)?.content;
      if (text === undefined || sha256(text) !== sha) throw new AgentHomeError("format", "a skill of the revision is missing or does not match its hash");
      return [file, text];
    }));
    const dir = path.join(this.dir, "runs", runId);
    const run: StartedRun = { runId, dir, storePath: runStoreIn(dir), workspace: path.join(dir, "work"), agentId: agent, revision };
    // The directory first, then the row: a seed that fails throws and nothing is written; a hard kill between the two leaves a directory no query shows.
    try {
      await seedRun({ storePath: run.storePath, workDir: run.workspace }, { runId, leases: [], profiles: {}, skills });
      this.db.prepare("INSERT INTO runs (id, agent_id, revision_id, started_at, state) VALUES (?, ?, ?, ?, 'running')").run(runId, agent, revisionId, new Date().toISOString());
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return run;
  }

  /** End a run, once: `state` is how it ended, `summary` a line for the list (cut to 2000 characters, never refused, so a run always ends). A second call for an ended run is refused. */
  carryBack(runId: string, result: { state: "completed" | "failed" | "stopped" | "escalated"; costUsd?: number; summary?: string }): void {
    if (!["completed", "failed", "stopped", "escalated"].includes(result?.state)) throw invalid("the state is not completed, failed, stopped or escalated");
    if (result.costUsd !== undefined && !(Number.isFinite(result.costUsd) && result.costUsd >= 0)) throw invalid("the cost is not a number of at least 0");
    if (result.summary !== undefined && (typeof result.summary !== "string" || result.summary === "")) throw invalid("the summary is not non-empty text");
    const done = this.db.prepare("UPDATE runs SET state = ?, ended_at = ?, cost_usd = ?, summary = ? WHERE id = ? AND ended_at IS NULL").run(result.state, new Date().toISOString(), result.costUsd ?? null, result.summary === undefined ? null : cutSummary(result.summary), checkId(runId, "run"));
    if (done.changes === 0) throw new AgentHomeError(this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId) ? "exists" : "missing", "that run is unknown or has already ended");
  }

  /** Opens a completed run again, for a follow-up: running, with no end; its cost and summary stay until the next
   *  carryBack. Only a completed run opens again. */
  reopenRun(runId: string): void {
    const done = this.db.prepare("UPDATE runs SET state = 'running', ended_at = NULL WHERE id = ? AND state = 'completed'").run(checkId(runId, "run"));
    if (done.changes > 0) return;
    if (!this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId)) throw new AgentHomeError("missing", "that run is unknown");
    throw invalid("only a completed run opens again");
  }

  /** A beta.24 agent home becomes one agent with one agentic revision (its definition and skills). Its run directories are not copied. */
  async importHome(homeDir: string): Promise<Agent> {
    const state = await readAgentHome(await openAgentHome(homeDir));
    const input: NewRevision = {
      kind: "agentic", instructions: state.definition.instructions, tools: state.definition.tools,
      skills: Object.fromEntries(Object.entries(state.skills).map(([file, skill]) => [file, skill.content])),
      ...(Object.keys(state.prompts).length ? { prompts: state.prompts } : {}), note: "imported from an agent home",
    };
    const { body, texts } = bodyOf(input); // checked before any write
    // One transaction: the agent, its skills and its revision all land, or none does.
    return this.tx(() => {
      const known = this.listAgents().find((a) => a.id === state.identity.id);
      if (known) return known; // already imported: the same home twice changes nothing
      const agent = this.insertAgent({ id: state.identity.id, name: state.identity.name, ...(state.definition.description ? { description: state.definition.description } : {}) });
      this.writeRevision(agent.id, input, body, texts, { setCurrent: true });
      return this.listAgents().find((a) => a.id === agent.id)!;
    });
  }
}

async function loadCheck(body: unknown): Promise<unknown> {
  // item 2's module, loaded only for a workflow revision: a store with none never loads the DSL.
  return ((await import("./workflow.js")) as { checkWorkflowBody(body: unknown): Promise<unknown> }).checkWorkflowBody(body);
}

/** Open (and create) the agent store in `dir`. `busyTimeoutMs` is how long a read or write waits, synchronously, for
 *  another connection to let go of the store before it throws SQLite's busy error (default 5000). It applies once the
 *  store is open: opening it always waits up to 5 s. */
export function openStore(dir: string, { busyTimeoutMs = 5_000 }: { busyTimeoutMs?: number } = {}): AgentStore {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) throw invalid("busyTimeoutMs is a whole number of milliseconds, 0 or more");
  const resolved = path.resolve(dir);
  mkdirSync(resolved, { recursive: true });
  const db = new DatabaseSync(path.join(resolved, STORE_FILE), { timeout: 5_000 });
  try {
    // A rollback journal, not WAL: `cp` of store.sqlite alone is a whole copy. The file is written rarely (an agent, a revision, a run's start and end).
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    checkVersion(db);
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${STORE_VERSION}`);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  } catch (error) {
    db.close();
    throw error;
  }
  return new AgentStore(resolved, db, loadCheck);
}

/** Reads `store.sqlite` in place, read-only: it writes nothing and makes no copy. `busyTimeoutMs` is as `openStore`'s. */
export function openStoreReader(dir: string, { busyTimeoutMs = 5_000 }: { busyTimeoutMs?: number } = {}): AgentStoreReader {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) throw invalid("busyTimeoutMs is a whole number of milliseconds, 0 or more");
  const resolved = path.resolve(dir);
  const file = path.join(resolved, STORE_FILE);
  if (!existsSync(file)) throw new AgentHomeError("missing", `there is no ${STORE_FILE} in that folder`);
  const db = new DatabaseSync(file, { readOnly: true, timeout: busyTimeoutMs });
  try { checkVersion(db); } catch (error) {
    db.close();
    // A writer killed mid-transaction leaves a hot journal, which a read-only open cannot roll back: SQLite says SQLITE_READONLY_ROLLBACK (by its result code, never its text).
    if ((error as { errcode?: unknown }).errcode === SQLITE_READONLY_ROLLBACK) throw new AgentHomeError("busy", 'this store has an unfinished write from a run that stopped; open it once with write access to roll it back, for example: sqlite3 store.sqlite "PRAGMA integrity_check"');
    throw error;
  }
  return new AgentStoreReader(resolved, db);
}
