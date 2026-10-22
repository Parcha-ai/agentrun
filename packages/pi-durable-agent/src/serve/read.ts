// What `serveHome` reads of an agent home, and how: read-only, with no lock, and only the kinds an exporter may copy.
// Nothing here writes, creates or locks a file of the home.
import type { JsonValue } from "@earendil-works/chord";
import { apply } from "@earendil-works/chord/delta";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { EXPORTABLE_KINDS, projectForExport, SECRET_KINDS } from "../export.js";
import { AGENT_STORE_FILE, ID_PATTERN, runStoreIn } from "../home.js";
import type { AgentDefinition, AgentIdentity, AgentSource, PromptVariant, RunRecord, SkillFile } from "../kinds.js";
import { SIDE_FILES } from "../pack-shared.js";
import { AgentHomeError } from "../store.js";
import type { EntryLike } from "../timeline/index.js";

/** The one schema version of pi-durable's SQLite store this reader knows; a newer one is refused, not guessed at. */
const SCHEMA_VERSION = 1;
const BUSY_MS = 5_000;
/** pi-durable keeps the agent's documents in the session scope, owner 0. */
const SESSION = "scope_kind = 'session' AND owner_id = 0";

/**
 * A store opened for reading and nothing else. A store with no `-wal`, `-shm` or `-journal` beside it is at rest, and
 * SQLite's `immutable` open creates and locks nothing, so the home's files are not touched. A store with side files has a
 * writer (or one that stopped): it is opened read-only in the ordinary way, which reads through the write-ahead log and
 * creates nothing new. Either way a write through the handle fails.
 */
export function openReadOnly(file: string): DatabaseSync {
  if (!existsSync(file)) throw new AgentHomeError("missing", `${path.basename(file)} does not exist`);
  const atRest = !SIDE_FILES.some((suffix) => existsSync(`${file}${suffix}`));
  const db = atRest ? new DatabaseSync(`${pathToFileURL(file).href}?mode=ro&immutable=1`, { readOnly: true }) : new DatabaseSync(file, { readOnly: true, timeout: BUSY_MS });
  try {
    const row = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version?: unknown } | undefined;
    if (row?.version !== SCHEMA_VERSION) throw new AgentHomeError("format", `${path.basename(file)} is pi-durable schema ${String(row?.version)}; this version reads ${SCHEMA_VERSION}`);
    return db;
  } catch (error) {
    db.close();
    throw error instanceof AgentHomeError ? error : new AgentHomeError("format", `${path.basename(file)} is not a pi-durable store`, { cause: error });
  }
}

const parse = (text: string): JsonValue => JSON.parse(text) as JsonValue;

/** The current value of every live document of `kind` in the session scope, by key (`""` for a document with none). Only
 *  an exportable kind is asked for, and the kind is in the SQL, so a row of any other kind is never selected. */
export function readDocuments(db: DatabaseSync, kind: string): Map<string, JsonValue> {
  if (!EXPORTABLE_KINDS.includes(kind) || SECRET_KINDS.includes(kind)) throw new AgentHomeError("invalid", `${kind} is not a kind a viewer may read`);
  const documents = db.prepare(`SELECT id, key_value FROM documents WHERE ${SESSION} AND kind = ? AND retired_at IS NULL ORDER BY id`).all(JSON.stringify(kind)) as { id: number; key_value: string }[];
  const base = db.prepare("SELECT seq, version, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1");
  const tail = db.prepare("SELECT kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq");
  const found = new Map<string, JsonValue>();
  for (const { id, key_value: key } of documents) {
    const first = base.get(id) as { seq: number; version: number; content: string } | undefined;
    if (!first) throw new AgentHomeError("format", `a ${kind} document has no base revision`);
    let value = parse(first.content);
    for (const revision of tail.all(id, first.seq) as { kind: string; version: number; content: string }[]) {
      if (revision.kind !== "delta" || revision.version !== first.version) throw new AgentHomeError("format", `a ${kind} document crosses a version boundary without a base`);
      value = apply(value as never, parse(revision.content) as never) as JsonValue;
    }
    found.set(parse(key) as string, value);
  }
  return found;
}

const only = <T>(documents: Map<string, JsonValue>, what: string): T => {
  const value = documents.get("");
  if (value === undefined) throw new AgentHomeError("format", `the agent store has no ${what}`);
  return value as T;
};

export type SkillSummary = { path: string; sha256: string; size: number };
export type PromptEntry = PromptVariant & { id: string };
/** A run as the API gives it: what the index says, without the host's name, the run's path or its final answer. */
export type RunSummary = { id: string; startedAt: string; endedAt?: string; outcome?: string; cost?: number; prompt?: { id: string; reason: string; confidence?: number }; live: boolean };
export type AgentView = { identity: AgentIdentity; definition: AgentDefinition; source: AgentSource | null; skills: SkillSummary[]; prompts: PromptEntry[]; runs: RunSummary[] };

const ROLE_ORDER = { base: 0, overlay: 1, generic: 2, question: 3 } as const;

function summarize(id: string, record: RunRecord): RunSummary {
  const kept = projectForExport("agent.runs", record as unknown as JsonValue) as unknown as RunRecord;
  return {
    id, startedAt: kept.startedAt,
    ...(kept.endedAt !== undefined ? { endedAt: kept.endedAt } : {}),
    ...(kept.outcome !== undefined ? { outcome: kept.outcome } : {}),
    ...(kept.cost !== undefined ? { cost: kept.cost } : {}),
    ...(kept.prompt !== undefined ? { prompt: kept.prompt } : {}),
    live: kept.endedAt === undefined,
  };
}

const byNewest = (a: RunSummary, b: RunSummary) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The runs index of the home in `dir`, newest run first. */
export function readRuns(dir: string): RunSummary[] {
  const db = openReadOnly(path.join(dir, AGENT_STORE_FILE));
  try {
    return [...readDocuments(db, "agent.runs")].map(([id, value]) => summarize(id, value as unknown as RunRecord)).sort(byNewest);
  } finally {
    db.close();
  }
}

/** The agent home in `dir` as a viewer may see it: identity, definition, source, the skills' names and sizes, the prompt
 *  variants and the runs index. Read-only; nothing a host keeps for itself is read. */
export function readAgent(dir: string): AgentView {
  const db = openReadOnly(path.join(dir, AGENT_STORE_FILE));
  try {
    const skills = [...readDocuments(db, "agent.skills")].map(([key, value]) => {
      const file = value as unknown as SkillFile;
      return { path: key, sha256: file.sha256, size: Buffer.byteLength(file.content) };
    }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const prompts = [...readDocuments(db, "agent.prompts")].map(([id, value]) => ({ id, ...(value as unknown as PromptVariant) }))
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const runs = [...readDocuments(db, "agent.runs")].map(([id, value]) => summarize(id, value as unknown as RunRecord)).sort(byNewest);
    return {
      identity: only<AgentIdentity>(readDocuments(db, "agent.identity"), "identity"),
      definition: only<AgentDefinition>(readDocuments(db, "agent.definition"), "definition"),
      source: (readDocuments(db, "agent.source").get("") as AgentSource | undefined) ?? null,
      skills, prompts, runs,
    };
  } finally {
    db.close();
  }
}

/**
 * The entries of run `id`'s store, in the order pi committed them (every conversation's, so a subagent's rows nest under
 * its caller), or none when the home holds the run's index entry only. Read-only.
 */
export function readRunEntries(dir: string, id: string): EntryLike[] {
  if (!ID_PATTERN.test(id)) throw new AgentHomeError("invalid", "the run id is not an id");
  const storePath = runStoreIn(path.join(path.resolve(dir), "runs", id));
  if (!existsSync(storePath)) return [];
  const home = realpathSync(dir);
  if (!realpathSync(storePath).startsWith(`${home}${path.sep}`)) throw new AgentHomeError("check", "the run's store is not inside the home");
  const db = openReadOnly(storePath);
  try {
    return (db.prepare("SELECT record FROM entries ORDER BY id").all() as { record: string }[]).map((row) => JSON.parse(row.record) as EntryLike);
  } finally {
    db.close();
  }
}
