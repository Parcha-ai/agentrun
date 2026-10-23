import type { JsonObject } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ID_PATTERN, isSkillPath, readAgentHome, runStoreIn, sha256, uuidv7 } from "./home.js";
import { openAgentHome } from "./home.js";
import type { PromptVariant } from "./kinds.js";
import { canonical } from "./kinds.js";
import { seedRun } from "./runs.js";
import { AgentHomeError } from "./store.js";

// An agent store is one folder: `store.sqlite` (plain tables, and the truth) and `runs/<run id>/`, each run's own pi-durable store and
// work directory. Copy the folder and every agent, revision and run comes with it.

export const STORE_FILE = "store.sqlite";
export type RevisionKind = "agentic" | "workflow";
export type AgenticBody = { instructions: string; skills: Record<string, string>; tools: string[]; model?: string; thinking?: string; prompts?: Record<string, PromptVariant> };
export type WorkflowBody = { workflow: JsonObject; skills: Record<string, string>; tools: string[] };
/** Written once, never edited. `id` is the SHA-256 of the canonical JSON of `{ agent, parent, kind, body }`; `body.skills` maps a skill path to the SHA-256 of its text. */
export type Revision = { id: string; agent: string; parent: string | null; createdAt: string; note?: string } & ({ kind: "agentic"; body: AgenticBody } | { kind: "workflow"; body: WorkflowBody });
export type Agent = { id: string; name: string; description?: string; createdAt: string; current: string | null };
export type AgentRow = Agent & { currentKind: RevisionKind | null; runs: number };
export type RevisionRow = { id: string; agent: string; parent: string | null; createdAt: string; note?: string; kind: RevisionKind; current: boolean };
export type RunState = "running" | "completed" | "failed" | "stopped" | "escalated";
export type RunRow = { id: string; agent: string; revision: string; kind: RevisionKind; state: RunState; startedAt: string; endedAt?: string; costUsd?: number; summary?: string };
export type NewRevision =
  | { kind: "agentic"; instructions: string; skills?: Record<string, string>; tools?: string[]; model?: string; thinking?: string; prompts?: Record<string, PromptVariant>; note?: string }
  | { kind: "workflow"; workflow: JsonObject; skills?: Record<string, string>; tools?: string[]; note?: string };
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
CREATE INDEX IF NOT EXISTS runs_by_agent ON runs(agent_id, started_at);`;

const invalid = (message: string) => new AgentHomeError("invalid", message);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const checkId = (id: unknown, what: string): string => {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw invalid(`the ${what} id is not letters, digits, ".", "_" or "-" (at most 128)`);
  return id;
};
const revisionHash = (r: { agent: string; parent: string | null; kind: string; body: unknown }) => sha256(canonical({ agent: r.agent, parent: r.parent, kind: r.kind, body: r.body }));

/** A revision as stored, checked: the id is the hash of its content, so a row that was changed does not pass. */
function revisionOf(row: Record<string, unknown>): Revision {
  const body = JSON.parse(row.body_json as string) as unknown;
  const revision = { id: row.id as string, agent: row.agent_id as string, parent: (row.parent_id as string | null) ?? null, createdAt: row.created_at as string, ...(row.note ? { note: row.note as string } : {}), kind: row.kind as RevisionKind, body } as Revision;
  if (revisionHash(revision) !== revision.id) throw new AgentHomeError("format", "a revision does not match its id: its content was changed");
  return revision;
}

/** The body of a new revision and the text of each skill it names. Everything about the input is checked here, before any write. */
function bodyOf(input: NewRevision): { body: AgenticBody | WorkflowBody; texts: Map<string, string> } {
  if (!isObject(input)) throw invalid("the revision is not an object");
  const skills: Record<string, string> = {}; const texts = new Map<string, string>();
  for (const [file, text] of Object.entries(input.skills ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isSkillPath(file)) throw invalid(`the skill path ${JSON.stringify(file)} is not a relative path inside .agents/skills/`);
    if (typeof text !== "string") throw invalid(`the skill ${file} is not text`);
    skills[file] = sha256(text); texts.set(skills[file], text);
  }
  const tools = input.tools ?? [];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && t !== "") || new Set(tools).size !== tools.length) throw invalid("the tools are not a list of distinct non-empty names");
  if (input.kind === "agentic") {
    if (typeof input.instructions !== "string" || input.instructions === "") throw invalid("an agentic revision needs instructions (its prompt)");
    for (const field of ["model", "thinking"] as const) if (input[field] !== undefined && (typeof input[field] !== "string" || input[field] === "")) throw invalid(`the ${field} is not a non-empty string`);
    return { body: { instructions: input.instructions, skills, tools: [...tools], ...(input.model !== undefined ? { model: input.model } : {}), ...(input.thinking !== undefined ? { thinking: input.thinking } : {}), ...(input.prompts !== undefined ? { prompts: structuredClone(input.prompts) } : {}) }, texts };
  }
  if (input.kind !== "workflow") throw invalid("the revision kind is not agentic or workflow");
  if (!isObject(input.workflow)) throw invalid("a workflow revision needs a workflow (a JSON object)");
  return { body: { workflow: structuredClone(input.workflow) as JsonObject, skills, tools: [...tools] }, texts };
}

/** The reads: plain SQL over the one file, on a read-only handle. `openStoreReader` is the open serve uses on a copy: it writes nothing. */
export class AgentStoreReader {
  constructor(readonly dir: string, protected readonly db: DatabaseSync) {}
  close(): void { this.db.close(); }

  listAgents(): AgentRow[] {
    const rows = this.db.prepare(`SELECT a.id, a.name, a.description, a.created_at, a.current_revision, cur.kind AS current_kind, (SELECT COUNT(*) FROM runs r WHERE r.agent_id = a.id) AS runs
      FROM agents a LEFT JOIN revisions cur ON cur.id = a.current_revision ORDER BY a.name, a.id`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: r.id as string, name: r.name as string, ...(r.description ? { description: r.description as string } : {}), createdAt: r.created_at as string, current: (r.current_revision as string | null) ?? null, currentKind: (r.current_kind as RevisionKind | null) ?? null, runs: Number(r.runs) }));
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
    const rows = this.db.prepare(`SELECT r.id, r.agent_id, r.revision_id, v.kind, r.state, r.started_at, r.ended_at, r.cost_usd, r.summary FROM runs r JOIN revisions v ON v.id = r.revision_id
      WHERE (?1 IS NULL OR r.agent_id = ?1) AND (?2 IS NULL OR r.revision_id = ?2) ORDER BY r.started_at DESC, r.rowid DESC`).all(filter.agent ?? null, filter.revision ?? null) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: r.id as string, agent: r.agent_id as string, revision: r.revision_id as string, kind: r.kind as RevisionKind, state: r.state as RunState, startedAt: r.started_at as string, ...(r.ended_at ? { endedAt: r.ended_at as string } : {}), ...(r.cost_usd !== null ? { costUsd: Number(r.cost_usd) } : {}), ...(r.summary ? { summary: r.summary as string } : {}) }));
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

  createAgent(input: { name: string; description?: string; id?: string }): Agent {
    if (typeof input?.name !== "string" || input.name.trim() === "") throw invalid("the agent needs a name");
    if (input.description !== undefined && typeof input.description !== "string") throw invalid("the description is not text");
    const agent: Agent = { id: input.id === undefined ? uuidv7() : checkId(input.id, "agent"), name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), createdAt: new Date().toISOString(), current: null };
    try { this.db.prepare("INSERT INTO agents (id, name, description, created_at) VALUES (?, ?, ?, ?)").run(agent.id, agent.name, agent.description ?? null, agent.createdAt); }
    catch { throw new AgentHomeError("exists", "that agent already exists"); }
    return agent;
  }

  /** A new revision of `agent`, its parent the agent's current revision (none: null). The same agent, parent, kind and body is the same revision and writes nothing. */
  async commitRevision(agent: string, input: NewRevision, options: { setCurrent?: boolean } = {}): Promise<Revision> {
    checkId(agent, "agent");
    const { body, texts } = bodyOf(input);
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2_000)) throw invalid("the note is not text of at most 2000 characters");
    if (input.kind === "workflow") await this.check(body); // item 2's check, before a write: a refusal writes nothing
    return this.tx(() => {
      const row = this.db.prepare("SELECT current_revision FROM agents WHERE id = ?").get(agent) as { current_revision: string | null } | undefined;
      if (!row) throw new AgentHomeError("missing", "there is no such agent");
      const parent = row.current_revision;
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
    });
  }

  setCurrent(agent: string, revision: string): void {
    const done = this.db.prepare("UPDATE agents SET current_revision = ? WHERE id = ? AND EXISTS (SELECT 1 FROM revisions WHERE id = ? AND agent_id = ?)").run(checkId(revision, "revision"), checkId(agent, "agent"), revision, agent);
    if (done.changes === 0) throw invalid("that revision is not a revision of that agent");
  }

  /** Start a run pinned to `revision` (default: the agent's current one): the run's directory is seeded in pi-durable-disk's layout, then its row goes in as `running`. */
  async startRun(input: { agent: string; revision?: string; runId?: string }): Promise<StartedRun> {
    const agent = checkId(input?.agent, "agent");
    const runId = input.runId === undefined ? uuidv7() : checkId(input.runId, "run");
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
    if (existsSync(dir)) throw new AgentHomeError("exists", "that run already exists");
    const run: StartedRun = { runId, dir, storePath: runStoreIn(dir), workspace: path.join(dir, "work"), agentId: agent, revision };
    // The directory first, then the row: a seed that fails throws and nothing is written; a hard kill between the two leaves a directory no query shows.
    try {
      await seedRun({ storePath: run.storePath, workDir: run.workspace }, { runId, agent: { instructions: "instructions" in revision.body ? revision.body.instructions : "", tools: [...revision.body.tools] }, leases: [], profiles: {}, skills } as never);
      this.db.prepare("INSERT INTO runs (id, agent_id, revision_id, started_at, state) VALUES (?, ?, ?, ?, 'running')").run(runId, agent, revisionId, new Date().toISOString());
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return run;
  }

  /** End a run, once: `state` is how it ended, `summary` a line for the list. A second call for an ended run is refused. */
  carryBack(runId: string, result: { state: "completed" | "failed" | "stopped" | "escalated"; costUsd?: number; summary?: string }): void {
    if (!["completed", "failed", "stopped", "escalated"].includes(result?.state)) throw invalid("the state is not completed, failed, stopped or escalated");
    if (result.costUsd !== undefined && !(Number.isFinite(result.costUsd) && result.costUsd >= 0)) throw invalid("the cost is not a number of at least 0");
    if (result.summary !== undefined && (typeof result.summary !== "string" || result.summary.length > 2_000)) throw invalid("the summary is not text of at most 2000 characters");
    const done = this.db.prepare("UPDATE runs SET state = ?, ended_at = ?, cost_usd = ?, summary = ? WHERE id = ? AND ended_at IS NULL").run(result.state, new Date().toISOString(), result.costUsd ?? null, result.summary ?? null, checkId(runId, "run"));
    if (done.changes === 0) throw new AgentHomeError(this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId) ? "exists" : "missing", "that run is unknown or has already ended");
  }

  /** A beta.24 agent home becomes one agent with one agentic revision (its definition and skills). Its run directories are not copied. */
  async importHome(homeDir: string): Promise<Agent> {
    const state = await readAgentHome(await openAgentHome(homeDir));
    const known = this.listAgents().find((a) => a.id === state.identity.id);
    if (known) return known; // already imported: the same home twice changes nothing
    const agent = this.createAgent({ id: state.identity.id, name: state.identity.name, ...(state.definition.description ? { description: state.definition.description } : {}) });
    await this.commitRevision(agent.id, {
      kind: "agentic", instructions: state.definition.instructions, tools: state.definition.tools,
      skills: Object.fromEntries(Object.entries(state.skills).map(([file, skill]) => [file, skill.content])),
      ...(Object.keys(state.prompts).length ? { prompts: state.prompts } : {}), note: "imported from an agent home",
    }, { setCurrent: true });
    return this.listAgents().find((a) => a.id === agent.id)!;
  }
}

async function loadCheck(body: unknown): Promise<unknown> {
  // item 2's module, loaded only for a workflow revision: a store with none never loads the DSL.
  return ((await import("./workflow.js")) as { checkWorkflowBody(body: unknown): Promise<unknown> }).checkWorkflowBody(body);
}

/** @internal `openStore` with the workflow check given, for tests. */
export function openStoreChecking(dir: string, check: (body: unknown) => Promise<unknown>): AgentStore {
  const resolved = path.resolve(dir);
  mkdirSync(resolved, { recursive: true });
  const db = new DatabaseSync(path.join(resolved, STORE_FILE), { timeout: 5_000 });
  // A rollback journal, not WAL: `cp` of store.sqlite alone is a whole copy. The file is written rarely (an agent, a revision, a run's start and end).
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return new AgentStore(resolved, db, check);
}

/** Open (and create) the agent store in `dir`. */
export const openStore = (dir: string): AgentStore => openStoreChecking(dir, loadCheck);

/** The open serve uses on a copy of the folder: read-only, it writes nothing. */
export function openStoreReader(dir: string): AgentStoreReader {
  const resolved = path.resolve(dir);
  const file = path.join(resolved, STORE_FILE);
  if (!existsSync(file)) throw new AgentHomeError("missing", `${dir} holds no ${STORE_FILE}`);
  return new AgentStoreReader(resolved, new DatabaseSync(file, { readOnly: true, timeout: 5_000 }));
}
