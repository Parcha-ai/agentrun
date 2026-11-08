import type { JsonObject } from "@earendil-works/pi-durable";
import type { Workflow } from "@parcha/agentrun-dsl"; // a type only: a store that never holds a workflow loads nothing of the DSL
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ID_PATTERN, isSkillPath, openAgentHome, readAgentHome, runDirIn, runStoreIn, sha256, uuidv7 } from "./home.js";
import type { PromptVariant } from "./kinds.js";
import { canonical } from "./kinds.js";
import { seedRun } from "./runs.js";
import { AgentHomeError } from "./store.js";
import type { RunMetrics } from "./timeline/timeline.js";

// An agent store is one folder: `store.sqlite` (plain tables, and the truth) and `runs/<run id>/`, each run's own pi-durable store and
// work directory. Copy the folder and every agent, revision and run comes with it.

export const STORE_FILE = "store.sqlite";
export type RevisionKind = "agentic" | "workflow";
/** `harness`: the harness that runs the revision, an id its host knows (absent: the host's default). `place`: where its
 *  runs execute, a mode and the box it uses, ids its host knows (absent: the host's default). `learning`: whether an
 *  agentic revision's runs learn, kept when a definition says so either way (absent: the host's default).
 *  `toolSettings`: the revision's own settings of a tool its host lets a user set (the tool, or a catalog's tool or an
 *  MCP server's wildcard, to its settings, such as its provider or its permission: names and values its host checks;
 *  absent: the host's own). `maxCostUsd`: an agentic revision's default spend cap for each run, in US dollars, that a
 *  run started with none of its own takes (absent: none). `capMode`: how such a cap prices a request, a name its host
 *  knows (absent: the host's default). `package`: the template package the revision was applied from, a JSON object its
 *  host writes and reads (absent: none). */
export type RevisionPlace = { mode: string; box?: string };
export type AgenticBody = { instructions: string; skills: Record<string, string>; tools: string[]; model?: string; thinking?: string; prompts?: Record<string, PromptVariant>; harness?: string; place?: RevisionPlace; learning?: boolean; toolSettings?: Record<string, Record<string, string>>; maxCostUsd?: number; capMode?: string; package?: JsonObject };
export type WorkflowBody = { workflow: Workflow; skills: Record<string, string>; tools: string[]; harness?: string; place?: RevisionPlace; toolSettings?: Record<string, Record<string, string>>; package?: JsonObject };
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

/** Where an imported run came from: the harness that ran it on this machine, and its own session id. */
export type ImportSource = "claude-code" | "codex" | "pi";
export type ImportedFrom = { source: ImportSource; session: string };
/** `archivedAt`: when the run was archived, else when its agent was, while it is. `importedFrom`: set on a run imported
 *  from another harness's session, which is read-only. */
export type RunRow = { id: string; agent: string; revision: string; kind: RevisionKind; state: RunState; startedAt: string; endedAt?: string; costUsd?: number; summary?: string; archivedAt?: string; importedFrom?: ImportedFrom };
/** A run's metrics as the store keeps them: `runMetricsOf` of its entries, plus what only its host knows: `activeMs`, how
 *  long it was at work; `effort`, the effort it ran at; `model`, the model it ran (runMetricsOf's by default); and
 *  `costUsdEst`, an estimate of its cost apart from the cost it carried back, with `costBasis` naming how it was made. */
export type StoredMetrics = RunMetrics & { activeMs?: number; effort?: string; costUsdEst?: number; costBasis?: string };
/** A session to import as a run that has already ended. */
export type ImportedRun = { agent: string; revision: string; state: "completed" | "failed" | "stopped"; startedAt: string; endedAt: string; costUsd?: number; summary?: string; metrics?: StoredMetrics } & ImportedFrom;
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
/** Runs counted together in `analytics`: how many, how many completed (escalated included: an escalated run completed and
 *  waits for review, which `needsReview` counts) and failed (never an escalated one), how many have metrics, their tokens
 *  (input, cache read, cache write and output, summed) and their cost as `stats` sums it (`costUsd`, null when no run
 *  ended with one; `unknownCostRuns` the rest). */
export type AnalyticsGroup = { runs: number; completed: number; needsReview: number; failed: number; runsWithMetrics: number; tokens: number; costUsd: number | null; unknownCostRuns: number };
/** What `analytics` answers: the runs not archived, started in [`from`, `to`) and of `agent` when given, summed from their
 *  rows and their metrics. A running run's metrics are its last end's: it counts as a run without them. */
export type StoreAnalytics = {
  totals: AnalyticsGroup & { input: number; cacheRead: number; cacheWrite: number; output: number; requests: number; unmetered: number };
  /** `wallMs` sums ended − started over the `endedRuns`; `activeMs` sums the metrics' activeMs over the `activeRuns` that have one. */
  time: { endedRuns: number; wallMs: number; activeRuns: number; activeMs: number };
  /** By the revision's harness (`pi` when it names none, `workflow` for a workflow revision), then the metrics' effort (null when unset). */
  byHarnessEffort: Array<AnalyticsGroup & { harness: string; effort: string | null }>;
  /** By the UTC date the run started, oldest first. */
  byDay: Array<AnalyticsGroup & { day: string }>;
  /** `live`, run here, or the source an imported run came from: `live` first. */
  bySource: Array<AnalyticsGroup & { source: "live" | ImportSource }>;
  /** The 20 tools with the most calls (by name on a tie), each with how many failed. */
  tools: Array<{ tool: string; calls: number; errors: number }>;
};
/** The states a run's end can have, for `AnalyticsFilter.pending`. */
export type PendingEnd = "completed" | "escalated" | "failed" | "stopped";
/** `pending`: runs whose end the caller holds and the store does not have yet (each by the state its end will have): their
 *  counts are taken at that state, and their metrics, cost and effort are left out until the store has their end. A run
 *  the store has ended already is read as it is. */
export type AnalyticsFilter = { from?: string; to?: string; agent?: string; pending?: Readonly<Record<string, PendingEnd>> };
const PENDING_ENDS: ReadonlySet<string> = new Set<PendingEnd>(["completed", "escalated", "failed", "stopped"]);
export type NewRevision =
  | { kind: "agentic"; instructions: string; skills?: Record<string, string>; tools?: string[]; model?: string; thinking?: string; prompts?: Record<string, PromptVariant>; harness?: string; place?: RevisionPlace; learning?: boolean; toolSettings?: Record<string, Record<string, string>>; maxCostUsd?: number; capMode?: string; package?: JsonObject; note?: string }
  | { kind: "workflow"; workflow: Workflow; skills?: Record<string, string>; tools?: string[]; harness?: string; place?: RevisionPlace; toolSettings?: Record<string, Record<string, string>>; package?: JsonObject; note?: string };
/** What starts a run: `key`, the caller's name for it (1 to 256 characters), which starts one run only, and `fingerprint`
 *  (at most 256 characters), what was asked, kept to tell a retry from another request under the same key. */
export type RunOrigin = { key: string; fingerprint?: string };
/** `existing`: the run its origin had already started, nothing written now, with the fingerprint recorded then. */
export type StartedRun = { runId: string; dir: string; storePath: string; workspace: string; agentId: string; revision: Revision; existing?: { fingerprint?: string } };

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
  summary     TEXT,
  claim_epoch  INTEGER NOT NULL DEFAULT 0,
  claim_holder TEXT
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
BEGIN SELECT RAISE(ABORT, 'an archive change is written once'); END;
CREATE TABLE IF NOT EXISTS run_imports (
  run_id  TEXT PRIMARY KEY REFERENCES runs(id),
  source  TEXT NOT NULL CHECK (source IN ('claude-code', 'codex', 'pi')),
  session TEXT NOT NULL,
  at      TEXT NOT NULL,
  UNIQUE (source, session)
);
CREATE TRIGGER IF NOT EXISTS run_imports_are_written_once BEFORE UPDATE ON run_imports
BEGIN SELECT RAISE(ABORT, 'an import is written once'); END;
CREATE TRIGGER IF NOT EXISTS run_imports_are_kept BEFORE DELETE ON run_imports
BEGIN SELECT RAISE(ABORT, 'an import is written once'); END;
CREATE TRIGGER IF NOT EXISTS imported_runs_stay_ended BEFORE UPDATE ON runs WHEN EXISTS (SELECT 1 FROM run_imports i WHERE i.run_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'an imported run is read-only'); END;
CREATE TABLE IF NOT EXISTS run_metrics (
  run_id       TEXT PRIMARY KEY REFERENCES runs(id),
  input        INTEGER NOT NULL,
  cache_read   INTEGER NOT NULL,
  cache_write  INTEGER NOT NULL,
  output       INTEGER NOT NULL,
  requests     INTEGER NOT NULL,
  unmetered    INTEGER NOT NULL,
  active_ms    INTEGER,
  effort       TEXT,
  model        TEXT,
  models_json  TEXT NOT NULL,
  cost_usd_est REAL,
  cost_basis   TEXT,
  at           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_tool_metrics (
  run_id TEXT NOT NULL REFERENCES run_metrics(run_id),
  tool   TEXT NOT NULL,
  calls  INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  PRIMARY KEY (run_id, tool)
);
CREATE TABLE IF NOT EXISTS run_origins (
  key         TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL UNIQUE REFERENCES runs(id),
  fingerprint TEXT,
  at          TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS run_origins_are_written_once BEFORE UPDATE ON run_origins
BEGIN SELECT RAISE(ABORT, 'an origin is written once'); END;
CREATE TRIGGER IF NOT EXISTS run_origins_are_kept BEFORE DELETE ON run_origins
BEGIN SELECT RAISE(ABORT, 'an origin is written once'); END;`;

// archive_changes, runs_by_state, run_imports, run_metrics, run_tool_metrics and run_origins came after version 1 without
// a new version: an earlier version opens the file and ignores them. run_imports' trigger on runs is in the file, so that
// version still cannot change an imported run.
// Version 2: each run lives on the disk (<data>/disk/agents/<agent>/runs/<run>), and its row holds its claim
// (claim_epoch, claim_holder). A version 1 store's runs are under <data>/runs/, which this version does not read: it is
// refused, with no migration.
const STORE_VERSION = 2;
const SQLITE_READONLY_ROLLBACK = 776;
const SQLITE_CONSTRAINT = 19;
/** Fail closed on a file a newer version wrote. */
function checkVersion(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > STORE_VERSION) throw new AgentHomeError("format", "this store was written by a newer version");
  if (version > 0 && version < STORE_VERSION) throw new AgentHomeError("format", `this store was written by a version that kept its runs outside the disk (store version ${version}), which this version does not read`);
}

const invalid = (message: string) => new AgentHomeError("invalid", message);
/** A claim's holder: a non-empty name (the run's process, as its host describes it, or the server) of at most 1,024 characters. */
function checkHolder(holder: unknown): asserts holder is string {
  if (typeof holder !== "string" || holder === "" || holder.length > 1024) throw invalid("a claim's holder is a non-empty name of at most 1,024 characters");
}
/** Refuses a run's folder `dir` below `base` (the data directory) when any level of it there now is a symbolic link or not
 *  a directory: a run's files are never made or written where a link points. The disk's one link rule, as the learning
 *  folder's (serve learning.ts). */
function refuseLinks(base: string, dir: string): void {
  let at = base;
  for (const part of path.relative(base, dir).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    let stats;
    try {
      stats = lstatSync(at);
    } catch {
      return;
    }
    if (stats.isSymbolicLink()) throw invalid(`${path.relative(base, at)} is a symbolic link, and a run's folder is never made through one`);
    if (!stats.isDirectory()) throw invalid(`${path.relative(base, at)} is not a directory`);
  }
}
/** Makes each folder from `base` down to `dir` that is missing, 0700, each mode set after its mkdir, so no umask loosens it. */
function ownedDirs(base: string, dir: string): void {
  const below = path.relative(base, dir);
  let at = base;
  for (const part of below.split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    if (existsSync(at)) continue;
    mkdirSync(at, { mode: 0o700 });
    chmodSync(at, 0o700);
  }
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const checkId = (id: unknown, what: string): string => {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw invalid(`the ${what} id is not letters, digits, ".", "_" or "-" (at most 128)`);
  return id;
};
const checkOrigin = (origin: unknown): RunOrigin => {
  const text = (value: unknown, least: number) => typeof value === "string" && value.length >= least && value.length <= 256;
  if (!isObject(origin) || !text(origin.key, 1) || (origin.fingerprint !== undefined && !text(origin.fingerprint, 0))) throw invalid("the origin is not { key, fingerprint? }, a key of 1 to 256 characters and a fingerprint of at most 256");
  return { key: origin.key as string, ...(origin.fingerprint !== undefined ? { fingerprint: origin.fingerprint as string } : {}) };
};
const revisionHash = (r: { agent: string; parent: string | null; kind: string; body: unknown }) => sha256(canonical({ agent: r.agent, parent: r.parent, kind: r.kind, body: r.body }));
const RUN_STATES: readonly RunState[] = ["running", "completed", "failed", "stopped", "escalated"];

const importedFromOf = (r: Record<string, unknown>): { importedFrom?: ImportedFrom } =>
  r.import_source ? { importedFrom: { source: r.import_source as ImportSource, session: r.import_session as string } } : {};
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const checkTime = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) throw invalid(`the ${what} time is not an ISO time in UTC`);
  const iso = new Date(value).toISOString();
  // Date.parse rolls an impossible date or hour forward (02-30 reads as 03-02): the time must read back as written, up to
  // how its fraction of a second is spelled.
  if (iso.slice(0, 19) !== value.slice(0, 19)) throw invalid(`the ${what} time ${value} is not a time that exists`);
  return iso;
};

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isName = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= 256;
const isUsd = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** Metrics to write, checked before any write: each count a whole number of at least 0, each name non-empty text of at
 *  most 256 characters. */
function checkMetrics(m: unknown): StoredMetrics {
  if (!isObject(m)) throw invalid("the metrics are not an object");
  for (const key of ["input", "cacheRead", "cacheWrite", "output", "requests", "unmetered"] as const) if (!isCount(m[key])) throw invalid(`the metrics' ${key} is not a whole number of at least 0`);
  if ((m.unmetered as number) > (m.requests as number)) throw invalid("the metrics' unmetered requests are more than its requests");
  if (!isObject(m.models) || !Object.entries(m.models).every(([name, n]) => isName(name) && isCount(n))) throw invalid("the metrics' models are not model names to request counts");
  if (!isObject(m.tools) || !Object.entries(m.tools).every(([name, t]) => isName(name) && isObject(t) && isCount(t.calls) && isCount(t.errors) && t.errors <= t.calls)) throw invalid("the metrics' tools are not tool names to { calls, errors }, errors at most calls");
  if (m.activeMs !== undefined && !isCount(m.activeMs)) throw invalid("the metrics' activeMs is not a whole number of at least 0");
  for (const key of ["model", "effort", "costBasis"] as const) if (m[key] !== undefined && !isName(m[key])) throw invalid(`the metrics' ${key} is not non-empty text of at most 256 characters`);
  if (m.costUsdEst !== undefined && !isUsd(m.costUsdEst)) throw invalid("the metrics' costUsdEst is not a number of at least 0");
  return m as StoredMetrics;
}

/** A revision as stored, checked: the id is the hash of its content, so a row that was changed does not pass. */
function revisionOf(row: Record<string, unknown>): Revision {
  const body = JSON.parse(row.body_json as string) as unknown;
  const revision = { id: row.id as string, agent: row.agent_id as string, parent: (row.parent_id as string | null) ?? null, createdAt: row.created_at as string, ...(row.note ? { note: row.note as string } : {}), kind: row.kind as RevisionKind, body } as Revision;
  if (revisionHash(revision) !== revision.id) throw new AgentHomeError("format", "a revision does not match its id: its content was changed");
  return revision;
}

/** An id a host knows: a harness, a place's mode, a box. */
const HOST_ID = /^[a-z][a-z0-9-]{0,63}$/;
const hostId = (value: unknown): value is string => typeof value === "string" && HOST_ID.test(value);
/** A setting's or a value's name in `toolSettings`: lowercase letters, digits, dashes and underscores. */
const PICK_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** A tool's name in `toolSettings`: a plain name (PICK_NAME), a catalog's tool (`monid.discover`), an MCP server's tool
 *  (`mcp:<server>/<tool>`) or its wildcard (`mcp:<server>/*`). */
const TOOL_KEY = /^(?:[a-z][a-z0-9_-]{0,63}(?:\.[A-Za-z0-9_-]{1,64})?|mcp:[A-Za-z0-9_.-]{1,64}\/(?:\*|[A-Za-z0-9_.-]{1,128}))$/;
/** Whether `name` is a tool's name the store keeps in `toolSettings` (TOOL_KEY): the one check, which a server runs before
 *  it makes an agent, so a key the store refuses never takes an agent's id. */
export const isToolSettingsKey = (name: string): boolean => TOOL_KEY.test(name);

/** A place as a body keeps it: `{mode, box?}`, nothing else. */
function placeOf(place: unknown): RevisionPlace {
  if (!isObject(place) || !hostId(place.mode) || (place.box !== undefined && !hostId(place.box)) || Object.keys(place).some((key) => key !== "mode" && key !== "box")) throw invalid("the place is not {mode, box?}, each an id (lowercase letters, digits and dashes)");
  return { mode: place.mode, ...(place.box !== undefined ? { box: place.box } : {}) };
}

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
  if (input.harness !== undefined && !hostId(input.harness)) throw invalid("the harness is not a harness id (lowercase letters, digits and dashes)");
  const set = input.toolSettings;
  const named = (value: unknown, check: (inner: unknown) => boolean, key = PICK_NAME) => isObject(value) && Object.entries(value).every(([name, inner]) => key.test(name) && check(inner));
  if (set !== undefined && !named(set, (setting) => named(setting, (value) => typeof value === "string" && PICK_NAME.test(value)), TOOL_KEY)) throw invalid("the tool settings are not tool names to settings of names");
  if (input.package !== undefined && !isObject(input.package)) throw invalid("the package is not a JSON object");
  // Sorted, and none when empty: two revisions with the same settings are one.
  const sorted = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
  const host = { ...(input.harness !== undefined ? { harness: input.harness } : {}), ...(input.package !== undefined ? { package: structuredClone(input.package) } : {}), ...(input.place !== undefined ? { place: placeOf(input.place) } : {}), ...(set && Object.keys(set).length ? { toolSettings: Object.fromEntries(Object.entries(sorted(set)).map(([name, setting]) => [name, sorted(setting as Record<string, unknown>)])) as Record<string, Record<string, string>> } : {}) };
  if (input.kind === "agentic") {
    if (typeof input.instructions !== "string") throw invalid("an agentic revision needs instructions (its prompt, possibly empty)");
    for (const field of ["model", "thinking"] as const) if (input[field] !== undefined && (typeof input[field] !== "string" || input[field] === "")) throw invalid(`the ${field} is not a non-empty string`);
    if (input.learning !== undefined && typeof input.learning !== "boolean") throw invalid("learning is not true or false");
    if (input.maxCostUsd !== undefined && !(typeof input.maxCostUsd === "number" && Number.isFinite(input.maxCostUsd) && input.maxCostUsd > 0)) throw invalid("the maxCostUsd is not a number above 0");
    if (input.capMode !== undefined && (typeof input.capMode !== "string" || input.capMode === "")) throw invalid("the capMode is not a non-empty string");
    return { body: { instructions: input.instructions, skills, tools: [...tools], ...(input.model !== undefined ? { model: input.model } : {}), ...(input.thinking !== undefined ? { thinking: input.thinking } : {}), ...(input.prompts !== undefined ? { prompts: structuredClone(input.prompts) } : {}), ...host, ...(input.learning !== undefined ? { learning: input.learning } : {}), ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}), ...(input.capMode !== undefined ? { capMode: input.capMode } : {}) }, texts };
  }
  if (input.kind !== "workflow") throw invalid("the revision kind is not agentic or workflow");
  if (!isObject(input.workflow)) throw invalid("a workflow revision needs a workflow (a JSON object)");
  return { body: { workflow: structuredClone(input.workflow), skills, tools: [...tools], ...host }, texts };
}

/** The reads: plain SQL over the one file, on a read-only handle. `openStoreReader` reads `store.sqlite` in place: it writes nothing and makes no copy, and a store with an unfinished write is named, not rolled back. */
export class AgentStoreReader {
  /** A store an earlier version wrote has no archive_changes until a writer opens it: nothing in it is archived. */
  private readonly archives: boolean;
  /** Likewise run_imports: a store without it holds no imported run. */
  private readonly imports: boolean;
  /** And run_metrics with run_tool_metrics: a store without them holds no run's metrics. */
  private readonly metrics: boolean;
  constructor(readonly dir: string, protected readonly db: DatabaseSync) {
    const has = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    this.archives = has("archive_changes");
    this.imports = has("run_imports");
    this.metrics = has("run_metrics") && has("run_tool_metrics");
  }
  close(): void { this.db.close(); }

  /** SQL for when the `kind` whose id is `id` (an SQL expression) was archived, while it is; else NULL. */
  protected archivedAtSql(kind: ArchiveKind, id: string): string {
    return this.archives ? `(SELECT CASE WHEN c.archived = 1 THEN c.at END FROM archive_changes c WHERE c.kind = '${kind}' AND c.id = ${id} ORDER BY c.seq DESC LIMIT 1)` : "NULL";
  }
  /** The columns and join for a run's import (`r` is the run). */
  private importSql(): { columns: string; join: string } {
    return this.imports ? { columns: "i.source AS import_source, i.session AS import_session", join: "LEFT JOIN run_imports i ON i.run_id = r.id" } : { columns: "NULL AS import_source, NULL AS import_session", join: "" };
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
    const imported = this.importSql();
    const rows = this.db.prepare(`SELECT r.id, r.agent_id, r.revision_id, v.kind, r.state, r.started_at, r.ended_at, r.cost_usd, r.summary, ${this.runArchivedAtSql()} AS archived_at, ${imported.columns} FROM runs r JOIN revisions v ON v.id = r.revision_id ${imported.join}
      WHERE (? IS NULL OR r.agent_id = ?) AND (? IS NULL OR r.revision_id = ?) ORDER BY r.started_at DESC, r.rowid DESC`).all(filter.agent ?? null, filter.agent ?? null, filter.revision ?? null, filter.revision ?? null) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: r.id as string, agent: r.agent_id as string, revision: r.revision_id as string, kind: r.kind as RevisionKind, state: r.state as RunState, startedAt: r.started_at as string, ...(r.ended_at ? { endedAt: r.ended_at as string } : {}), ...(r.cost_usd !== null ? { costUsd: Number(r.cost_usd) } : {}), ...(r.summary ? { summary: r.summary as string } : {}), ...(r.archived_at ? { archivedAt: r.archived_at as string } : {}), ...importedFromOf(r) }));
  }
  /** One run: the README's join (runs, agents, revisions) for one run id, in one statement. The run plus its agent's name and its revision's note; undefined for an unknown run. */
  readRun(runId: string): (RunRow & { agentName: string; note?: string }) | undefined {
    const imported = this.importSql();
    const r = this.db.prepare(`SELECT r.id, r.agent_id, r.revision_id, v.kind, r.state, r.started_at, r.ended_at, r.cost_usd, r.summary, a.name AS agent_name, v.note, ${this.runArchivedAtSql()} AS archived_at, ${imported.columns}
      FROM runs r JOIN agents a ON a.id = r.agent_id JOIN revisions v ON v.id = r.revision_id ${imported.join} WHERE r.id = :id`).get({ id: checkId(runId, "run") }) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return { id: r.id as string, agent: r.agent_id as string, revision: r.revision_id as string, kind: r.kind as RevisionKind, state: r.state as RunState, startedAt: r.started_at as string, ...(r.ended_at ? { endedAt: r.ended_at as string } : {}), ...(r.cost_usd !== null ? { costUsd: Number(r.cost_usd) } : {}), ...(r.summary ? { summary: r.summary as string } : {}), agentName: r.agent_name as string, ...(r.note ? { note: r.note as string } : {}), ...(r.archived_at ? { archivedAt: r.archived_at as string } : {}), ...importedFromOf(r) };
  }
  /** A run's metrics, as its last carryBack or its import wrote them, with its tools by name and `at`, when they were
   *  written: one statement. Undefined for a run with none, or an unknown run. */
  runMetrics(runId: string): (StoredMetrics & { at: string }) | undefined {
    const id = checkId(runId, "run");
    if (!this.metrics) return undefined;
    const rows = this.db.prepare(`SELECT m.*, t.tool, t.calls, t.errors FROM run_metrics m LEFT JOIN run_tool_metrics t ON t.run_id = m.run_id
      WHERE m.run_id = ? ORDER BY t.tool`).all(id) as Array<Record<string, unknown>>;
    const m = rows[0];
    if (!m) return undefined;
    const optional = (key: string, column: string, as: (value: unknown) => unknown) => (m[column] !== null ? { [key]: as(m[column]) } : {});
    return {
      input: Number(m.input), cacheRead: Number(m.cache_read), cacheWrite: Number(m.cache_write), output: Number(m.output), requests: Number(m.requests), unmetered: Number(m.unmetered),
      models: JSON.parse(m.models_json as string) as Record<string, number>, ...optional("model", "model", String),
      tools: Object.fromEntries(rows.filter((r) => r.tool !== null).map((r) => [r.tool as string, { calls: Number(r.calls), errors: Number(r.errors) }])),
      ...optional("activeMs", "active_ms", Number), ...optional("effort", "effort", String), ...optional("costUsdEst", "cost_usd_est", Number), ...optional("costBasis", "cost_basis", String),
      at: m.at as string,
    };
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
  /** The runs' metrics summed (StoreAnalytics), with their counts and cost, from `run_metrics`, `run_tool_metrics`,
   *  `runs` and `revisions` alone, read in one snapshot; nothing under `runs/` is opened. `from` and `to` are ISO times in
   *  UTC. A store without the metrics tables answers its runs with none. */
  analytics(filter: AnalyticsFilter = {}): StoreAnalytics {
    const pending: Record<string, PendingEnd> = {};
    for (const [id, state] of Object.entries(filter.pending ?? {})) {
      if (!PENDING_ENDS.has(state)) throw new AgentHomeError("invalid", `pending: ${String(state).slice(0, 40)} is not the state of an end`);
      pending[checkId(id, "run")] = state;
    }
    const params = { from: filter.from === undefined ? null : checkTime(filter.from, "from"), to: filter.to === undefined ? null : checkTime(filter.to, "to"), agent: filter.agent === undefined ? null : checkId(filter.agent, "agent"), ...(Object.keys(pending).length ? { pending: JSON.stringify(pending) } : {}) };
    const metric = (column: string) => (this.metrics ? `m.${column}` : "NULL");
    // Each run in scope once, with its group keys and, when it has ended, its metrics. A pending run (its end on its way)
    // has the state its end will have, and none of its metrics, cost or effort yet.
    // No pending run (the usual read): no join at all, each run at its stored state.
    const anyPending = Object.keys(pending).length > 0;
    const scope = `WITH scope AS (SELECT r.id, ${anyPending ? "COALESCE(p.value, r.state) AS state, p.key IS NOT NULL AS pending" : "r.state AS state, 0 AS pending"}, r.started_at, r.ended_at, r.cost_usd,
        CASE WHEN v.kind = 'workflow' THEN 'workflow' ELSE COALESCE(json_extract(v.body_json, '$.harness'), 'pi') END AS harness,
        ${this.imports ? "COALESCE(i.source, 'live')" : "'live'"} AS source, ${this.metrics ? "m.run_id IS NOT NULL" : "0"} AS metered,
        ${["input", "cache_read", "cache_write", "output", "requests", "unmetered", "active_ms", "effort"].map((c) => `${metric(c)} AS ${c}`).join(", ")}
      FROM runs r JOIN revisions v ON v.id = r.revision_id
        ${anyPending ? "LEFT JOIN json_each(:pending) p ON p.key = r.id AND r.state = 'running'" : ""}
        ${this.metrics ? "LEFT JOIN run_metrics m ON m.run_id = r.id AND r.state <> 'running'" : ""} ${this.imports ? "LEFT JOIN run_imports i ON i.run_id = r.id" : ""}
      WHERE ${this.runArchivedAtSql()} IS NULL AND (:from IS NULL OR r.started_at >= :from) AND (:to IS NULL OR r.started_at < :to) AND (:agent IS NULL OR r.agent_id = :agent))`;
    const group = `COUNT(*) AS runs, SUM(state IN ('completed', 'escalated')) AS completed, SUM(state = 'escalated') AS needs_review, SUM(state = 'failed') AS failed, SUM(metered) AS metered,
      SUM(COALESCE(input + cache_read + cache_write + output, 0)) AS tokens, SUM(CASE WHEN state <> 'running' AND NOT pending THEN cost_usd END) AS cost_usd,
      SUM(state <> 'running' AND NOT pending AND cost_usd IS NOT NULL) AS known, SUM(pending) AS pending`;
    const n = (value: unknown) => Number(value ?? 0);
    const counted = (g: Record<string, unknown>): AnalyticsGroup => ({
      runs: n(g.runs), completed: n(g.completed), needsReview: n(g.needs_review), failed: n(g.failed), runsWithMetrics: n(g.metered), tokens: n(g.tokens),
      costUsd: n(g.known) > 0 ? Number(g.cost_usd) : null, unknownCostRuns: n(g.runs) - n(g.known) - n(g.pending),
    });
    const all = (sql: string) => this.db.prepare(`${scope} ${sql}`).all(params) as Array<Record<string, unknown>>;
    this.db.exec("BEGIN");
    try {
      const t = all(`SELECT ${group}, SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(output) AS output, SUM(requests) AS requests, SUM(unmetered) AS unmetered,
          SUM(state <> 'running' AND NOT pending AND ended_at IS NOT NULL) AS ended, SUM(CASE WHEN state <> 'running' AND NOT pending AND ended_at IS NOT NULL THEN MAX(0, ROUND((julianday(ended_at) - julianday(started_at)) * 86400000)) END) AS wall_ms,
          SUM(active_ms IS NOT NULL) AS active_runs, SUM(active_ms) AS active_ms FROM scope`)[0]!;
      return {
        totals: { ...counted(t), input: n(t.input), cacheRead: n(t.cache_read), cacheWrite: n(t.cache_write), output: n(t.output), requests: n(t.requests), unmetered: n(t.unmetered) },
        time: { endedRuns: n(t.ended), wallMs: n(t.wall_ms), activeRuns: n(t.active_runs), activeMs: n(t.active_ms) },
        // A pending run is in the totals' counts alone: its effort and its day's sums wait for its end.
        byHarnessEffort: all(`SELECT harness, effort, ${group} FROM scope WHERE NOT pending GROUP BY harness, effort ORDER BY harness, effort`).map((g) => ({ harness: g.harness as string, effort: (g.effort as string | null) ?? null, ...counted(g) })),
        byDay: all(`SELECT substr(started_at, 1, 10) AS day, ${group} FROM scope WHERE NOT pending GROUP BY day ORDER BY day`).map((g) => ({ day: g.day as string, ...counted(g) })),
        bySource: all(`SELECT source, ${group} FROM scope WHERE NOT pending GROUP BY source ORDER BY source <> 'live', source`).map((g) => ({ source: g.source as "live" | ImportSource, ...counted(g) })),
        tools: this.metrics
          ? all(`SELECT t.tool, SUM(t.calls) AS calls, SUM(t.errors) AS errors FROM run_tool_metrics t JOIN scope s ON s.id = t.run_id WHERE s.metered GROUP BY t.tool ORDER BY calls DESC, t.tool LIMIT 20`)
            .map((r) => ({ tool: r.tool as string, calls: n(r.calls), errors: n(r.errors) }))
          : [],
      };
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
  /** Run `runId`'s folder on the disk, `<dir>/disk/agents/<agent>/runs/<run id>`, by its row's agent. It does not check
   *  that the folder exists; an unknown run is AgentHomeError `missing`. */
  runDir(runId: string): string {
    const row = this.db.prepare("SELECT agent_id FROM runs WHERE id = ?").get(checkId(runId, "run")) as { agent_id: string } | undefined;
    if (!row) throw new AgentHomeError("missing", "that run is unknown");
    return runDirIn(this.dir, row.agent_id, runId);
  }
  /** `<run's folder>/store/run.sqlite`, for a run's timeline. It does not check that the file exists. */
  runStorePath(runId: string): string { return runStoreIn(this.runDir(runId)); }
  /** Run `runId`'s folder and its store folder, made where missing (0700, each mode set after its mkdir), for a write into
   *  them (an import's transcript, finished): a link or a non-directory at any level of them below the data directory is
   *  AgentHomeError `invalid`, before anything is made or written there. */
  runFolders(runId: string): { runId: string; dir: string; storePath: string } {
    const dir = this.runDir(runId);
    const storePath = runStoreIn(dir);
    refuseLinks(this.dir, path.dirname(storePath));
    ownedDirs(this.dir, path.dirname(storePath));
    return { runId, dir, storePath };
  }
  /** Run `runId`'s claim, as its row holds it: the epoch, bumped at each claim, and who holds it (null before the first). */
  runClaim(runId: string): { epoch: number; holder: string | null } {
    const row = this.db.prepare("SELECT claim_epoch, claim_holder FROM runs WHERE id = ?").get(checkId(runId, "run")) as { claim_epoch: number; claim_holder: string | null } | undefined;
    if (!row) throw new AgentHomeError("missing", "that run is unknown");
    return { epoch: Number(row.claim_epoch), holder: row.claim_holder };
  }
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

  /** Delete an agent with no history: no run, never archived. Its revisions go with it; its skill texts stay, as another
   *  revision may share them. An agent with a history is refused (`invalid`); one that is not here is `missing`. A create
   *  undone (a template's apply that a later step refused). */
  deleteAgent(id: string): void {
    checkId(id, "agent");
    this.tx(() => {
      if (!this.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id)) throw new AgentHomeError("missing", "there is no such agent");
      const history = this.db.prepare("SELECT 1 FROM runs WHERE agent_id = ? UNION ALL SELECT 1 FROM archive_changes WHERE kind = 'agent' AND id = ? LIMIT 1").get(id, id);
      if (history) throw invalid("only an agent with no runs that was never archived is deleted");
      this.db.prepare("UPDATE agents SET current_revision = NULL WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM revisions WHERE agent_id = ?").run(id);
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    });
  }

  /** Start a run pinned to `revision` (default: the agent's current one): the run's directory is seeded in pi-durable-disk's layout, then its row goes in as `running`.
   *  With an `origin`, its row goes in with the run's, and a key already recorded returns the run it started (`existing`), whatever the agent and revision asked now. */
  async startRun(input: { agent: string; revision?: string; origin?: RunOrigin }): Promise<StartedRun> {
    const agent = checkId(input?.agent, "agent");
    if ("runId" in input) throw invalid("startRun takes no run id: the store mints it");
    const origin = input.origin === undefined ? undefined : checkOrigin(input.origin);
    const recorded = origin && this.runOfOrigin(origin.key);
    if (recorded) return recorded;
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
    const dir = runDirIn(this.dir, agent, runId);
    refuseLinks(this.dir, dir);
    const run: StartedRun = { runId, dir, storePath: runStoreIn(dir), workspace: path.join(dir, "work"), agentId: agent, revision };
    // The directory first, then the row: a seed that fails throws and nothing is written; a hard kill between the two leaves a directory no query shows.
    try {
      await seedRun({ storePath: run.storePath, workDir: run.workspace }, { runId, leases: [], profiles: {}, skills });
      // A start under the same origin that got here first (another call, another connection) wins: this one's directory goes.
      const winner = this.tx(() => {
        const known = origin && this.runOfOrigin(origin.key);
        if (known) return known;
        const at = new Date().toISOString();
        this.db.prepare("INSERT INTO runs (id, agent_id, revision_id, started_at, state) VALUES (?, ?, ?, ?, 'running')").run(runId, agent, revisionId, at);
        if (origin) this.db.prepare("INSERT INTO run_origins (key, run_id, fingerprint, at) VALUES (?, ?, ?, ?)").run(origin.key, runId, origin.fingerprint ?? null, at);
        return undefined;
      });
      if (winner) {
        await rm(dir, { recursive: true, force: true });
        return winner;
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return run;
  }

  /** Claims run `runId` for `holder` from epoch `from`, the one its claimer read (runClaim): the epoch is bumped and the
   *  holder recorded in one statement, only while the row still holds `from`. The new epoch, which the holder carries; a
   *  holder of a lower one is fenced. Two claimers from the same epoch: one claims, the other is `stale` and writes
   *  nothing. A take-back is a claim by the server. */
  claimRun(runId: string, holder: string, from: number): number {
    checkHolder(holder);
    if (!Number.isSafeInteger(from) || from < 0) throw invalid("a claim names the epoch it claims from, a whole number of at least 0");
    const row = this.db.prepare("UPDATE runs SET claim_epoch = claim_epoch + 1, claim_holder = ? WHERE id = ? AND claim_epoch = ? RETURNING claim_epoch").get(holder, checkId(runId, "run"), from) as { claim_epoch: number } | undefined;
    if (!row) throw this.lostClaim(runId, from);
    return Number(row.claim_epoch);
  }

  /** Names `holder` for run `runId`'s claim at `epoch` (its door, once it serves), only while the row still holds that
   *  epoch: a claim that moved on is `stale`, and nothing is written. */
  setRunHolder(runId: string, epoch: number, holder: string): void {
    checkHolder(holder);
    const changed = this.db.prepare("UPDATE runs SET claim_holder = ? WHERE id = ? AND claim_epoch = ?").run(holder, checkId(runId, "run"), epoch).changes;
    if (Number(changed) === 0) throw this.lostClaim(runId, epoch);
  }

  /** Why a claim's statement changed no row: no such run, or its epoch is no longer `epoch`. */
  private lostClaim(runId: string, epoch: number): AgentHomeError {
    const now = this.db.prepare("SELECT claim_epoch FROM runs WHERE id = ?").get(runId) as { claim_epoch: number } | undefined;
    if (!now) return new AgentHomeError("missing", "that run is unknown");
    return new AgentHomeError("stale", `the run's claim is at epoch ${Number(now.claim_epoch)}, not ${epoch}`);
  }

  /** The run `key` started (startRun's `origin`), as startRun returns it with `existing`; undefined when it started none. */
  runOfOrigin(key: string): StartedRun | undefined {
    const row = this.db.prepare("SELECT o.run_id, o.fingerprint, r.agent_id, r.revision_id FROM run_origins o JOIN runs r ON r.id = o.run_id WHERE o.key = ?").get(key) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    const dir = runDirIn(this.dir, row.agent_id!, row.run_id!);
    return { runId: row.run_id!, dir, storePath: runStoreIn(dir), workspace: path.join(dir, "work"), agentId: row.agent_id!, revision: this.readRevision(row.revision_id!), existing: row.fingerprint === null ? {} : { fingerprint: row.fingerprint! } };
  }

  /** End a run, once: `state` is how it ended, `summary` a line for the list (cut to 2000 characters, never refused, so a run always ends). A second call for an ended run is refused.
   *  `metrics` (runMetricsOf of the whole run, and what its host knows) replace the run's in the same transaction, so a
   *  run opened again and ended again keeps its latest; with none it has none, as with no cost its cost is unknown.
   *  `endedAt`, an ISO time in UTC, is when the run ended as its host chose it before writing the end anywhere (so its
   *  notices and its row name one time); with none it is now. */
  carryBack(runId: string, result: { state: "completed" | "failed" | "stopped" | "escalated"; costUsd?: number; summary?: string; metrics?: StoredMetrics; endedAt?: string }): void {
    if (!["completed", "failed", "stopped", "escalated"].includes(result?.state)) throw invalid("the state is not completed, failed, stopped or escalated");
    if (result.costUsd !== undefined && !(Number.isFinite(result.costUsd) && result.costUsd >= 0)) throw invalid("the cost is not a number of at least 0");
    if (result.summary !== undefined && (typeof result.summary !== "string" || result.summary === "")) throw invalid("the summary is not non-empty text");
    const metrics = result.metrics === undefined ? undefined : checkMetrics(result.metrics);
    const id = checkId(runId, "run");
    this.refuseImported(id);
    const at = result.endedAt === undefined ? new Date().toISOString() : checkTime(result.endedAt, "end");
    this.tx(() => {
      const done = this.db.prepare("UPDATE runs SET state = ?, ended_at = ?, cost_usd = ?, summary = ? WHERE id = ? AND ended_at IS NULL").run(result.state, at, result.costUsd ?? null, result.summary === undefined ? null : cutSummary(result.summary), id);
      if (done.changes === 0) throw new AgentHomeError(this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(id) ? "exists" : "missing", "that run is unknown or has already ended");
      this.writeMetrics(id, metrics, at);
    });
  }

  /** A run's metrics replaced by `metrics` (none: removed), inside the caller's transaction. */
  private writeMetrics(runId: string, metrics: StoredMetrics | undefined, at: string): void {
    this.db.prepare("DELETE FROM run_tool_metrics WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM run_metrics WHERE run_id = ?").run(runId);
    if (!metrics) return;
    this.db.prepare(`INSERT INTO run_metrics (run_id, input, cache_read, cache_write, output, requests, unmetered, active_ms, effort, model, models_json, cost_usd_est, cost_basis, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, metrics.input, metrics.cacheRead, metrics.cacheWrite, metrics.output, metrics.requests, metrics.unmetered,
      metrics.activeMs ?? null, metrics.effort ?? null, metrics.model ?? null, JSON.stringify(metrics.models), metrics.costUsdEst ?? null, metrics.costBasis ?? null, at);
    const tool = this.db.prepare("INSERT INTO run_tool_metrics (run_id, tool, calls, errors) VALUES (?, ?, ?, ?)");
    for (const [name, t] of Object.entries(metrics.tools)) tool.run(runId, name, t.calls, t.errors);
  }

  /** Opens a completed run again, for a follow-up: running, with no end; its cost, summary and metrics stay until the
   *  next carryBack. Only a completed run opens again. */
  reopenRun(runId: string): void {
    this.refuseImported(checkId(runId, "run"));
    const done = this.db.prepare("UPDATE runs SET state = 'running', ended_at = NULL WHERE id = ? AND state = 'completed'").run(checkId(runId, "run"));
    if (done.changes > 0) return;
    if (!this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId)) throw new AgentHomeError("missing", "that run is unknown");
    throw invalid("only a completed run opens again");
  }

  /** Records a session another harness ran on this machine as a run of `agent` at `revision` that has already ended,
   *  at the source's own times. The store mints the run id; the same source and session imports once (again: undefined,
   *  nothing written). Its directory and store directory are made 0700 (no work directory: nothing ran here), and the
   *  caller writes the transcript at `storePath`. An imported run is read-only: nothing reopens or ends it again. Its
   *  `metrics` are written with its rows. */
  importRun(input: ImportedRun): Pick<StartedRun, "runId" | "dir" | "storePath"> | undefined {
    if (!isObject(input)) throw invalid("the import is not an object");
    if ("runId" in input || "id" in input) throw invalid("importRun takes no run id: the store mints it");
    const agent = checkId(input.agent, "agent");
    const revision = this.readRevision(checkId(input.revision, "revision"));
    if (revision.agent !== agent) throw invalid("that revision is not a revision of that agent");
    if (!["completed", "failed", "stopped"].includes(input.state)) throw invalid("an imported run's state is completed, failed or stopped");
    if (!["claude-code", "codex", "pi"].includes(input.source)) throw invalid("the source is not claude-code, codex or pi");
    if (typeof input.session !== "string" || input.session === "" || input.session.length > 256) throw invalid("the session is not a non-empty id of at most 256 characters");
    const startedAt = checkTime(input.startedAt, "start");
    const endedAt = checkTime(input.endedAt, "end");
    if (endedAt < startedAt) throw invalid("the run ends before it starts");
    if (input.costUsd !== undefined && !(Number.isFinite(input.costUsd) && input.costUsd >= 0)) throw invalid("the cost is not a number of at least 0");
    if (input.summary !== undefined && (typeof input.summary !== "string" || input.summary === "")) throw invalid("the summary is not non-empty text");
    const metrics = input.metrics === undefined ? undefined : checkMetrics(input.metrics);
    const runId = uuidv7();
    const dir = runDirIn(this.dir, agent, runId);
    const storePath = runStoreIn(dir);
    // The directory first, then the rows (startRun's order); each mode set after its mkdir, so no umask loosens it.
    // The folders above it made here (a first import, before any run) are the owner's too: a umask that strips the
    // owner's write bit would leave them unwritable, and this run's directory never made.
    refuseLinks(this.dir, dir);
    ownedDirs(this.dir, path.dirname(dir));
    try {
      for (const made of [dir, path.dirname(storePath)]) {
        mkdirSync(made, { mode: 0o700 });
        chmodSync(made, 0o700);
      }
      const added = this.tx(() => {
        if (this.db.prepare("SELECT 1 FROM run_imports WHERE source = ? AND session = ?").get(input.source, input.session)) return false;
        this.db.prepare("INSERT INTO runs (id, agent_id, revision_id, state, started_at, ended_at, cost_usd, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(runId, agent, revision.id, input.state, startedAt, endedAt, input.costUsd ?? null, input.summary === undefined ? null : cutSummary(input.summary));
        const at = new Date().toISOString();
        this.db.prepare("INSERT INTO run_imports (run_id, source, session, at) VALUES (?, ?, ?, ?)").run(runId, input.source, input.session, at);
        if (metrics) this.writeMetrics(runId, metrics, at);
        return true;
      });
      if (!added) {
        rmSync(dir, { recursive: true, force: true });
        return undefined;
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return { runId, dir, storePath };
  }

  /** An imported run is read-only: refused by name here, and by the file's trigger under any other writer. */
  private refuseImported(runId: string): void {
    if (this.db.prepare("SELECT 1 FROM run_imports WHERE run_id = ?").get(runId)) throw invalid("an imported run is read-only");
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
