// What `serveHome` reads of an agent home, and how. The home's own files are only ever opened read-only. The agent store is
// copied once into a temporary directory by SQLite's backup (a consistent snapshot, whatever a writer is doing) and read
// there with the package's own reader, so nothing here knows how pi-durable lays documents out; the copy is removed as
// soon as it is read. Only what an export may carry goes into the answer.
import type { JsonValue } from "@earendil-works/chord";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { projectForExport } from "../export.js";
import { AGENT_STORE_FILE, ID_PATTERN, readState, runStoreIn } from "../home.js";
import type { AgentDefinition, AgentIdentity, AgentSource, PromptVariant, RunRecord, SkillFile } from "../kinds.js";
import { AgentHomeError, openStore } from "../store.js";
import type { EntryLike } from "../timeline/index.js";

/** The one schema version of pi-durable's SQLite store this reader knows; a newer one is refused, not guessed at. */
const SCHEMA_VERSION = 1;
const BUSY_MS = 5_000;

/** A store opened read-only, with its schema version checked; a write through the handle fails. The store of an `ended` run
 *  with no `-wal` beside it is at rest and opens immutable, which creates no file beside it. Any other store may have a
 *  writer, so it opens plainly and SQLite may create its `-shm` and `-wal` files to read through the log. */
export function openReadOnly(file: string, { ended = false }: { ended?: boolean } = {}): DatabaseSync {
  if (!existsSync(file)) throw new AgentHomeError("missing", `${path.basename(file)} does not exist`);
  const atRest = ended && !existsSync(`${file}-wal`);
  const db = new DatabaseSync(atRest ? `${pathToFileURL(file).href}?immutable=1` : file, { readOnly: true, timeout: BUSY_MS });
  try {
    const row = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version?: unknown } | undefined;
    if (row?.version !== SCHEMA_VERSION) throw new AgentHomeError("format", `${path.basename(file)} is pi-durable schema ${String(row?.version)}; this version reads ${SCHEMA_VERSION}`);
    return db;
  } catch (error) {
    db.close();
    throw error instanceof AgentHomeError ? error : new AgentHomeError("format", `${path.basename(file)} is not a pi-durable store`, { cause: error });
  }
}

export type SkillSummary = { path: string; sha256: string; size: number };
export type PromptEntry = PromptVariant & { id: string };
/** A run as the API gives it: what the index says, without the host's name, the run's path or its final answer. */
export type RunSummary = { id: string; startedAt: string; endedAt?: string; outcome?: string; cost?: number; prompt?: { id: string; reason: string; confidence?: number }; live: boolean };
export type AgentView = { identity: AgentIdentity; definition: AgentDefinition; source: AgentSource | null; skills: SkillSummary[]; prompts: PromptEntry[]; runs: RunSummary[] };

const ROLE_ORDER = { base: 0, overlay: 1, generic: 2, question: 3 } as const;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byNewest = (a: RunSummary, b: RunSummary) => compare(b.startedAt, a.startedAt) || compare(b.id, a.id);
/** What an exporter may copy of one stored document, as the value's own type. */
const exported = <T>(kind: string, value: T): T => projectForExport(kind, value as unknown as JsonValue) as unknown as T;

function summarize(id: string, record: RunRecord): RunSummary {
  const kept = exported("agent.runs", record);
  return {
    id, startedAt: kept.startedAt,
    ...(kept.endedAt !== undefined ? { endedAt: kept.endedAt } : {}),
    ...(kept.outcome !== undefined ? { outcome: kept.outcome } : {}),
    ...(kept.cost !== undefined ? { cost: kept.cost } : {}),
    ...(kept.prompt !== undefined ? { prompt: kept.prompt } : {}),
    live: kept.endedAt === undefined,
  };
}

/** The agent store at `file`, read from a snapshot: SQLite's backup copies it from a read-only connection into a private
 *  temporary directory, the package's `readState` reads the copy (pi-durable's own checks write to the copy only), and the
 *  directory is removed. Only the kinds an exporter may copy go into the view. */
async function snapshot(file: string): Promise<AgentView> {
  const scratch = await mkdtemp(path.join(tmpdir(), "pi-durable-agent-serve-"));
  try {
    const copy = path.join(scratch, AGENT_STORE_FILE);
    const source = openReadOnly(file);
    try {
      await backup(source, copy);
    } finally {
      source.close();
    }
    const store = await openStore(copy);
    try {
      const state = await readState(store);
      return {
        identity: exported("agent.identity", state.identity),
        definition: exported("agent.definition", state.definition),
        source: state.source ? exported("agent.source", state.source) : null,
        skills: Object.entries(state.skills).map(([key, value]) => {
          const skill = exported("agent.skills", value) as SkillFile;
          return { path: key, sha256: skill.sha256, size: Buffer.byteLength(skill.content) };
        }).sort((a, b) => compare(a.path, b.path)),
        prompts: Object.entries(state.prompts).map(([id, value]) => ({ id, ...exported("agent.prompts", value) }))
          .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || compare(a.id, b.id)),
        runs: Object.entries(state.runs).map(([id, value]) => summarize(id, value)).sort(byNewest),
      };
    } finally {
      await store.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const stamp = (file: string, emptyIsNone = false) => {
  try {
    const info = statSync(file);
    return emptyIsNone && info.size === 0 ? "none" : `${info.size}:${info.mtimeMs}`;
  } catch {
    return "none";
  }
};
/** What says the store changed: its size and mtime and its log's, since a writer's commits sit in the log until a checkpoint
 *  moves them into the main file. An empty log says nothing, and is what opening a store read-only leaves behind. */
export const signature = (file: string): string => `${stamp(file)}|${stamp(`${file}-wal`, true)}`;

/** A reader of one home's agent store: the view as of the store's last change, re-read only when its files change. */
export function agentReader(dir: string): () => Promise<AgentView> {
  const file = path.join(dir, AGENT_STORE_FILE);
  let current: { signature: string; view: Promise<AgentView> } | undefined;
  return () => {
    const seen = signature(file);
    if (current?.signature !== seen) {
      const view = snapshot(file);
      current = { signature: seen, view };
      view.catch(() => {
        if (current?.view === view) current = undefined;
      });
    }
    return current.view;
  };
}

/** The entries of the run store at `storePath`, in the order pi committed them (every conversation's, so a subagent's rows
 *  nest under its caller), or none when there is no store there; refused when the store, links resolved, is not inside
 *  `root`. Whole records, read-only; `ended` says the run has an end, as `openReadOnly` takes it. */
export function readEntriesAt(root: string, storePath: string, what = "home", { ended = false }: { ended?: boolean } = {}): EntryLike[] {
  if (!existsSync(storePath)) return [];
  const inside = realpathSync(root);
  if (!realpathSync(storePath).startsWith(`${inside}${path.sep}`)) throw new AgentHomeError("check", `the run's store is not inside the ${what}`);
  const db = openReadOnly(storePath, { ended });
  try {
    return (db.prepare("SELECT record FROM entries ORDER BY id").all() as { record: string }[]).map((row) => JSON.parse(row.record) as EntryLike);
  } finally {
    db.close();
  }
}

/** The entries of run `id`'s store in the home at `dir`, or none when the home holds the run's index entry only; `ended`
 *  says the run's index entry has an end. */
export function readRunEntries(dir: string, id: string, ended: boolean): EntryLike[] {
  if (!ID_PATTERN.test(id)) throw new AgentHomeError("invalid", "the run id is not an id");
  return readEntriesAt(dir, runStoreIn(path.join(path.resolve(dir), "runs", id)), "home", { ended });
}
