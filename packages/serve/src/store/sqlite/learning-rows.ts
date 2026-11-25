// An agent's learning as versioned rows (schema.ts LEARNING_ROWS): the part of Store.learning that keeps its notes,
// workflows, promotions, grades and audits. Written once for SQLite and Postgres, over the store's connection and its
// Dialect: a save is one transaction, under the agent's lock on Postgres (SQLite's one writer lock holds it there), its
// compare and swap on the agent's newest version. An agent's reset or delete is plain deletes; a run's purge deletes its
// notes and rewrites each workflow version that held a file it wrote, file by file (rewriteWorkflow), and is a save of
// its own (the host's, kind `purged`), so a save computed before it is stale.
import { randomBytes } from "node:crypto";
import { type Learning, type LearningAt, type LearningChangeKind, type LearningDiff, type LearningItem, type LearningItemKind, type LearningRecord, type LearningRecordKind, LearningRecordRefused, type LearningRecordWrite, type LearningSave, type LearningSaveBy } from "../store.js";
import { learnedStatus, restoredLearned, retiredLearned, workflowRunOf, WORKFLOWS_DIR } from "../../learn/workflow-draft.js";
import type { SqliteExecutor, SqliteValue, StoreConnection, Tx } from "./connection.js";

type SaveKind = "init" | "run" | "person" | "purged";
type SaveRow = { version: number | string; id: string; at: number | string; kind: SaveKind; by_run: string | null; merge_key: string | null; change: string };
type ItemRow = { kind: LearningItemKind; name: string; version: number | string; body?: string | null; by_run: string | null; change: string; person: number | string; pos: number | string; digest: string | null; writers: string | null; at: number | string };
/** A workflow's writer of each file (LearningItem.writers). */
type Writers = Record<string, string | null>;
type RecordRow = { seq: number | string; run_id: string | null; workflow: string | null; digest: string | null; data: string; at: number | string };

const SAVE_COLUMNS = "version, id, at, kind, by_run, merge_key, change";
const ITEM_FACTS = "kind, name, version, by_run, change, person, pos, digest, writers, at";
const ITEM_COLUMNS = `${ITEM_FACTS}, body`;
const RECORD_COLUMNS = "seq, run_id, workflow, digest, data, at";
/** What a read takes: the connection, or a transaction's handle. */
type Reader = Pick<SqliteExecutor, "get" | "all">;

/** What a save's `change` column keeps: a run's or a person's, who saved it, why, and the paths it changed; the
 *  host's (an init, a purge, a purged run's), nothing. */
type SaveChange = { by?: LearningSaveBy; reason?: string; files?: string[] };

function saveOf(row: SaveRow): LearningSave {
  const change = JSON.parse(row.change) as SaveChange;
  const by: LearningSaveBy = row.kind === "init" || row.kind === "purged" ? { host: row.kind } : change.by!;
  return { version: Number(row.version), id: row.id, at: Number(row.at), by, reason: change.reason ?? "", files: change.files ?? [], mergeKey: row.merge_key };
}
const factsOf = (row: ItemRow): Omit<LearningItem, "body"> => ({
  kind: row.kind, name: row.name, version: Number(row.version), byRun: row.by_run, change: row.change as LearningChangeKind,
  person: Number(row.person) === 1, pos: Number(row.pos), digest: row.digest, writers: row.writers ? (JSON.parse(row.writers) as Writers) : null, at: Number(row.at),
});
const itemOf = (row: ItemRow): LearningItem => ({ ...factsOf(row), body: row.body ?? null });
const recordOf = (row: RecordRow): LearningRecord => ({ seq: Number(row.seq), runId: row.run_id, workflow: row.workflow, digest: row.digest, data: JSON.parse(row.data) as unknown, at: Number(row.at) });

/** A save's version id: 40 hex, random, the shape a git commit id had (what a run's seed and the log's `commit` name). */
const versionId = (): string => randomBytes(20).toString("hex");

/** The item rows newest at or before `version`: each item's live version there. */
const LIVE_AT = `SELECT ${ITEM_COLUMNS} FROM learning_items i
  WHERE i.agent_id = ? AND i.version <= ? AND i.body IS NOT NULL
    AND i.version = (SELECT MAX(j.version) FROM learning_items j WHERE j.agent_id = i.agent_id AND j.kind = i.kind AND j.name = i.name AND j.version <= ?)
  ORDER BY i.kind, i.pos, i.name`;

async function atSave(db: Reader, agentId: string, save: LearningSave): Promise<LearningAt> {
  const items = (await db.all<ItemRow>(LIVE_AT, agentId, save.version, save.version)).map(itemOf);
  const history = (await db.all<ItemRow>(`SELECT ${ITEM_FACTS} FROM learning_items WHERE agent_id = ? AND version <= ? ORDER BY version`, agentId, save.version)).map(factsOf);
  return { save, items, history };
}

const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const filesIn = (body: string | null): Record<string, string> => (body === null ? {} : (JSON.parse(body) as Record<string, string>));

/** Workflow `name` of agent `agentId`, every version rewritten with run `runId`'s files taken out, inside the caller's
 *  transaction: each file at each version is its text as the versions say with the run's changes left out (a file the
 *  run changed is its text before, its writer before; one it deleted is there again; another writer's change of it
 *  stands), and a version that comes to hold what the one before it holds is deleted, as is one before any text. Its
 *  digest and run follow its workflow.json (a json text's digest as the version that held it says). The digests some
 *  version held before and none holds after (`lost`: their promotions and audits are of the run's text alone), the
 *  paths some version held before and none holds after (`taken`: the run's alone, so their names are its words too),
 *  whether no version is left (`gone`), and whether any row changed (`changed`). */
async function rewriteWorkflow(tx: Tx, agentId: string, runId: string, name: string): Promise<{ lost: string[]; taken: string[]; gone: boolean; changed: boolean }> {
  const rows = await tx.all<{ version: number | string; body: string | null; writers: string | null; by_run: string | null; digest: string | null; person: number | string; change: string; save_kind: SaveKind; save_run: string | null }>(
    `SELECT i.version, i.body, i.writers, i.by_run, i.digest, i.person, i.change, s.kind AS save_kind, s.by_run AS save_run
       FROM learning_items i JOIN learning_saves s ON s.agent_id = i.agent_id AND s.version = i.version
      WHERE i.agent_id = ? AND i.kind = 'workflow' AND i.name = ? ORDER BY i.version`, agentId, name);
  const json = `${WORKFLOWS_DIR}/${name}/workflow.json`;
  const readme = `${WORKFLOWS_DIR}/${name}/README.md`;
  const digests = new Map<string, string>();
  for (const row of rows) {
    const text = filesIn(row.body)[json];
    if (text !== undefined && row.digest !== null) digests.set(text, row.digest);
  }
  const before = new Set(rows.flatMap((row) => (row.digest === null ? [] : [row.digest])));
  const after = new Set<string>();
  const pathsBefore = new Set(rows.flatMap((row) => Object.keys(filesIn(row.body))));
  const pathsAfter = new Set<string>();
  let changed = false;
  const state = new Map<string, { text: string; writer: string | null }>();
  // The version before's files and writers, as written (`was`), and as kept (`last`: undefined before the first).
  let was = new Map<string, { text: string; writer: string | null }>();
  let last: { body: string | null; writers: string | null } | undefined;
  for (const row of rows) {
    const files = filesIn(row.body);
    const writers = row.writers === null ? {} : (JSON.parse(row.writers) as Writers);
    const now = new Map(Object.entries(files).map(([path, text]) => [path, { text, writer: Object.hasOwn(writers, path) ? (writers[path] ?? null) : row.by_run }]));
    const saver = row.save_kind === "run" ? row.save_run : null;
    for (const path of new Set([...was.keys(), ...now.keys()])) {
      const [then, file] = [was.get(path), now.get(path)];
      // A file this version changed: its text, or its writer (a run that wrote back bytes a version before held).
      if (then?.text === file?.text && then?.writer === file?.writer) continue;
      if (file === undefined) {
        if (saver !== runId) state.delete(path);
        continue;
      }
      if (file.writer !== runId) state.set(path, file);
    }
    // A person's retire, and their restore, is the owner's decision on the workflow, not on the run's text: each stays on
    // the version that comes back (its README.md retired, or restored, as the person's change writes it, its writer the
    // text's), so the newest of them stands after the purge: a purge never serves again what the owner stopped, nor stops
    // what they restored. A README.md that cannot be retired so reads retired already (learnedStatus); one that cannot be
    // restored so stays retired (fail closed). A person's approve is not replayed: it was of the run's text, and the text
    // that comes back is one the owner never approved.
    const front = state.get(readme);
    if (Number(row.person) === 1 && row.change === "retired" && front && learnedStatus(front.text) !== "retired") {
      try {
        state.set(readme, { text: retiredLearned(front.text), writer: front.writer });
      } catch {
        // Unreadable front matter: retired as it reads.
      }
    } else if (Number(row.person) === 1 && row.change === "restored" && front && learnedStatus(front.text) === "retired") {
      try {
        state.set(readme, { text: restoredLearned(front.text), writer: front.writer });
      } catch {
        // Not restorable as it reads: it stays retired.
      }
    }
    was = now;
    const paths = [...state.keys()].sort(byBytes);
    const body = paths.length ? JSON.stringify(Object.fromEntries(paths.map((path) => [path, state.get(path)!.text]))) : null;
    const kept: Writers | null = paths.length ? Object.fromEntries(paths.map((path) => [path, state.get(path)!.writer])) : null;
    const written = kept ? JSON.stringify(kept) : null;
    if ((last === undefined && body === null) || (last !== undefined && last.body === body && last.writers === written)) {
      await tx.run("DELETE FROM learning_items WHERE agent_id = ? AND kind = 'workflow' AND name = ? AND version = ?", agentId, name, row.version);
      changed = true;
      continue;
    }
    last = { body, writers: written };
    for (const path of paths) pathsAfter.add(path);
    const digest = state.has(json) ? (digests.get(state.get(json)!.text) ?? null) : null;
    if (digest !== null) after.add(digest);
    const by = kept ? workflowRunOf(name, kept) : null;
    if (body !== row.body || written !== row.writers || by !== row.by_run || digest !== row.digest) {
      await tx.run("UPDATE learning_items SET body = ?, writers = ?, by_run = ?, digest = ? WHERE agent_id = ? AND kind = 'workflow' AND name = ? AND version = ?", body, written, by, digest, agentId, name, row.version);
      changed = true;
    }
  }
  return {
    lost: [...before].filter((digest) => !after.has(digest)), taken: [...pathsBefore].filter((path) => !pathsAfter.has(path)).sort(byBytes),
    gone: last === undefined || last.body === null, changed,
  };
}

/** Run `runId`'s learning rows gone from its agent `agentId`'s, inside the caller's transaction (its purge, its
 *  delete), every statement scoped to that agent: each workflow it wrote a file of rewritten without its files
 *  (rewriteWorkflow), with the promotions and audits of each digest no version holds then; its notes; its grades and
 *  audits; and its saves' words (each save's version, id and merge key stay), a person's save left with no item (an
 *  approve of its draft, a removal of its line) with them: that save's words name what the run wrote. Every other save
 *  names none of the paths only it wrote, nor a workflow gone with it. When any row changed, the purge is a save of its
 *  own at the agent's newest version + 1 (the host's, kind `purged`, at `at`): a save computed before it is stale, and a
 *  run's merge read at a save before it is refused (save's `readAt`). Callers hold the agent's learning lock
 *  (`learning:<agent>`); this takes its records' lock (`learning.records:<agent>`) after it. */
export async function dropRunLearning(tx: Tx, agentId: string, runId: string, at: number): Promise<void> {
  // The records' lock before any version changes: a promotion's write reads its digests under it (changeRecords).
  await tx.dialect.lockKey(tx, `learning.records:${agentId}`);
  const names = (await tx.all<{ name: string }>(`SELECT DISTINCT i.name FROM learning_items i JOIN learning_saves s ON s.agent_id = i.agent_id AND s.version = i.version
    WHERE i.agent_id = ? AND i.kind = 'workflow' AND (s.by_run = ? OR i.by_run = ?) ORDER BY i.name`, agentId, runId, runId)).map((row) => row.name);
  // The person's saves that wrote a version of the run's text, read before it goes.
  const persons = new Set((await tx.all<{ version: number | string }>(`SELECT DISTINCT i.version FROM learning_items i JOIN learning_saves s ON s.agent_id = i.agent_id AND s.version = i.version
    WHERE i.agent_id = ? AND s.kind = 'person' AND ((i.kind = 'note' AND i.by_run = ?) OR (i.kind = 'workflow' AND i.name IN (SELECT j.name FROM learning_items j JOIN learning_saves r ON r.agent_id = j.agent_id AND r.version = j.version WHERE j.agent_id = ? AND j.kind = 'workflow' AND (r.by_run = ? OR j.by_run = ?))))`,
  agentId, runId, agentId, runId, runId)).map((row) => Number(row.version)));
  const count = async (sql: string) => Number((await tx.get<{ n: number | string }>(sql, agentId, runId))?.n ?? 0);
  let changed = (await count("SELECT COUNT(*) AS n FROM learning_items WHERE agent_id = ? AND kind = 'note' AND by_run = ?")) > 0
    || (await count("SELECT COUNT(*) AS n FROM learning_saves WHERE agent_id = ? AND by_run = ?")) > 0;
  const gone: string[] = [];
  const taken = new Set<string>();
  for (const name of names) {
    const rewritten = await rewriteWorkflow(tx, agentId, runId, name);
    for (const digest of rewritten.lost) await tx.run("DELETE FROM learning_records WHERE agent_id = ? AND kind IN ('promotion', 'audit') AND workflow = ? AND digest = ?", agentId, name, digest);
    if (rewritten.gone) gone.push(name);
    for (const path of rewritten.taken) taken.add(path);
    if (rewritten.changed) changed = true;
  }
  await tx.run("DELETE FROM learning_items WHERE agent_id = ? AND kind = 'note' AND by_run = ?", agentId, runId);
  await tx.run("DELETE FROM learning_records WHERE agent_id = ? AND run_id = ?", agentId, runId);
  for (const version of persons) {
    if (!(await tx.get("SELECT 1 AS one FROM learning_items WHERE agent_id = ? AND version = ?", agentId, version))) {
      await tx.run("UPDATE learning_saves SET kind = 'purged', by_run = NULL, change = '{}' WHERE agent_id = ? AND version = ? AND kind = 'person'", agentId, version);
    }
  }
  // A path only the run wrote (no version holds it now) and a workflow gone with it are the run's words: no other save,
  // a run's or a person's, names one in its files, its `file` or its reason.
  if (taken.size) {
    const others = await tx.all<{ version: number | string; kind: SaveKind; change: string }>("SELECT version, kind, change FROM learning_saves WHERE agent_id = ? AND kind IN ('run', 'person') AND (by_run IS NULL OR by_run <> ?)", agentId, runId);
    for (const row of others) {
      const change = JSON.parse(row.change) as SaveChange;
      const by = change.by && "person" in change.by ? change.by : undefined;
      let reason = change.reason ?? "";
      if (!by) for (const name of gone) reason = reason.replaceAll(`workflow ${name}`, "a workflow");
      for (const path of taken) reason = reason.replaceAll(path, "a file");
      const kept: SaveChange = {
        ...change, files: (change.files ?? []).filter((path) => !taken.has(path)), reason,
        ...(by && taken.has(by.file) ? { by: { ...by, file: "" }, reason: `${by.person} by a person` } : {}),
      };
      if (JSON.stringify(kept) !== JSON.stringify(change)) await tx.run("UPDATE learning_saves SET change = ? WHERE agent_id = ? AND version = ?", JSON.stringify(kept), agentId, row.version);
    }
  }
  await tx.run("UPDATE learning_saves SET kind = 'purged', by_run = NULL, change = '{}' WHERE agent_id = ? AND by_run = ?", agentId, runId);
  if (!changed) return;
  const head = Number((await tx.get<{ v: number | string | null }>("SELECT MAX(version) AS v FROM learning_saves WHERE agent_id = ?", agentId))?.v ?? 0);
  await tx.run("INSERT INTO learning_saves (agent_id, version, id, at, kind, by_run, merge_key, change) VALUES (?, ?, ?, ?, 'purged', NULL, NULL, '{}')", agentId, head + 1, versionId(), at);
}

/** Every learning row of agent `agentId` gone, inside the caller's transaction (a reset, its purge, its delete), under
 *  the agent's learning lock and then its records' lock, the order a run's purge takes them: a records write that read
 *  before it is in before it, never written after. */
export async function dropAgentLearning(tx: Tx, agentId: string): Promise<void> {
  await tx.dialect.lockKey(tx, `learning:${agentId}`);
  await tx.dialect.lockKey(tx, `learning.records:${agentId}`);
  await tx.run("DELETE FROM learning_items WHERE agent_id = ?", agentId);
  await tx.run("DELETE FROM learning_saves WHERE agent_id = ?", agentId);
  await tx.run("DELETE FROM learning_records WHERE agent_id = ?", agentId);
}

type Rows = Pick<Learning, "seed" | "newest" | "itemsAt" | "saves" | "saveOf" | "versions" | "diff" | "save" | "purgeRun" | "reset" | "erase" | "records" | "addRecord" | "changeRecords">;

/** Store.learning's rows, over `db`; `now`, the store's clock. */
export function learningRows(db: StoreConnection, now: () => number): Rows {
  const d = db.dialect;
  const saveBy = async (ex: Reader, agentId: string, where: string, ...params: SqliteValue[]) => {
    const row = await ex.get<SaveRow>(`SELECT ${SAVE_COLUMNS} FROM learning_saves WHERE agent_id = ? AND ${where}`, agentId, ...params);
    return row ? saveOf(row) : undefined;
  };
  const newest = (ex: Reader, agentId: string) => saveBy(ex, agentId, "version = (SELECT MAX(version) FROM learning_saves WHERE agent_id = ?)", agentId);
  /** A record's columns from its data: the run it is of, its workflow and digest. */
  const columnsOf = (record: LearningRecordWrite): SqliteValue[] => [record.runId, record.workflow, record.digest, JSON.stringify(record.data ?? null)];
  const insertRecord = async (tx: Tx, agentId: string, kind: LearningRecordKind, record: LearningRecordWrite, seq: number, at: number) =>
    tx.run(`INSERT INTO learning_records (agent_id, kind, seq, run_id, workflow, digest, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, agentId, kind, seq, ...columnsOf(record), at);
  const recordsIn = async (ex: Reader, agentId: string, kind: LearningRecordKind) =>
    (await ex.all<RecordRow>(`SELECT ${RECORD_COLUMNS} FROM learning_records WHERE agent_id = ? AND kind = ? ORDER BY seq`, agentId, kind)).map(recordOf);
  /** Whether a version of each workflow holds a digest, read inside the records' transaction (under its lock, which a
   *  purge takes before it changes a version). */
  const heldIn = async (tx: Tx, agentId: string): Promise<(workflow: string, digest: string) => boolean> => {
    const held = new Set((await tx.all<{ name: string; digest: string }>("SELECT DISTINCT name, digest FROM learning_items WHERE agent_id = ? AND kind = 'workflow' AND digest IS NOT NULL", agentId)).map((row) => `${row.name}\0${row.digest}`));
    return (workflow, digest) => held.has(`${workflow}\0${digest}`);
  };
  /** The records a write adds (or moves to another run, workflow or digest), checked in its transaction: a promotion's or
   *  an audit's digest held by a version of its workflow (`anyDigest` aside: a failed draft's, which none holds), and no
   *  run purged. LearningRecordRefused otherwise, so the transaction writes nothing. */
  const checkAdded = async (tx: Tx, agentId: string, kind: LearningRecordKind, added: readonly LearningRecordWrite[], held: (workflow: string, digest: string) => boolean, anyDigest?: string) => {
    if (!added.length) return;
    if (kind !== "grade") {
      const unheld = added.filter((one) => one.workflow !== null && one.digest !== null && one.digest !== anyDigest && !held(one.workflow, one.digest));
      if (unheld.length) throw new LearningRecordRefused(agentId, unheld, "unheld");
    }
    const purged: LearningRecordWrite[] = [];
    for (const one of added) {
      if (one.runId !== null && (await tx.get("SELECT 1 AS one FROM runs WHERE id = ? AND purged_at IS NOT NULL", one.runId))) purged.push(one);
    }
    if (purged.length) throw new LearningRecordRefused(agentId, purged, "purged");
  };

  return {
    seed: async (agentId) => {
      const save = (await newest(db, agentId)) ?? (await db.transaction(async (tx) => {
        await d.lockKey(tx, `learning:${agentId}`);
        const there = await newest(tx, agentId);
        if (there) return there;
        await tx.run(`INSERT INTO learning_saves (agent_id, version, id, at, kind, by_run, merge_key, change) VALUES (?, 1, ?, ?, 'init', NULL, NULL, '{}')`, agentId, versionId(), now());
        return (await newest(tx, agentId))!;
      }));
      return atSave(db, agentId, save);
    },
    newest: async (agentId) => {
      const save = await newest(db, agentId);
      return save ? atSave(db, agentId, save) : undefined;
    },
    itemsAt: async (agentId, id) => {
      const save = await saveBy(db, agentId, "id = ?", id);
      return save ? atSave(db, agentId, save) : undefined;
    },
    saves: async (agentId, { limit = 200, before } = {}) => {
      const shown = "agent_id = ? AND kind IN ('run', 'person')";
      const rows = await db.all<SaveRow>(`SELECT ${SAVE_COLUMNS} FROM learning_saves WHERE ${shown}${before === undefined ? "" : " AND version < ?"} ORDER BY version DESC LIMIT ?`, agentId, ...(before === undefined ? [] : [before]), limit + 1);
      const total = Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM learning_saves WHERE ${shown}`, agentId))?.n ?? 0);
      return { saves: rows.slice(0, limit).map(saveOf), more: rows.length > limit, total };
    },
    saveOf: (agentId, by) => ("id" in by ? saveBy(db, agentId, "id = ?", by.id) : saveBy(db, agentId, "merge_key = ?", by.mergeKey)),
    versions: async (agentId, kind, name) => {
      const rows = await db.all<ItemRow & Omit<SaveRow, "kind"> & { save_at: number | string; save_kind: SaveKind; item_change: string; item_by_run: string | null }>(
        `SELECT i.kind, i.name, i.version, i.body, i.by_run AS item_by_run, i.change AS item_change, i.person, i.pos, i.digest, i.writers, i.at, s.id, s.at AS save_at, s.kind AS save_kind, s.by_run, s.merge_key, s.change
           FROM learning_items i JOIN learning_saves s ON s.agent_id = i.agent_id AND s.version = i.version
          WHERE i.agent_id = ? AND i.kind = ? AND i.name = ? ORDER BY i.version DESC`, agentId, kind, name);
      return rows.map((row) => ({ ...itemOf({ ...row, by_run: row.item_by_run, change: row.item_change }), save: saveOf({ ...row, kind: row.save_kind, at: row.save_at }) }));
    },
    diff: async (agentId, id) => {
      const save = await saveBy(db, agentId, "id = ?", id);
      if (!save || "host" in save.by) return undefined;
      const parent = await saveBy(db, agentId, "version = (SELECT MAX(version) FROM learning_saves WHERE agent_id = ? AND version < ?)", agentId, save.version);
      const written = await db.all<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM learning_items WHERE agent_id = ? AND version = ? ORDER BY kind, pos, name`, agentId, save.version);
      const items: LearningDiff["items"][number][] = [];
      for (const row of written) {
        const before = await db.get<{ body: string | null }>(`SELECT body FROM learning_items WHERE agent_id = ? AND kind = ? AND name = ? AND version = (SELECT MAX(version) FROM learning_items WHERE agent_id = ? AND kind = ? AND name = ? AND version < ?)`, agentId, row.kind, row.name, agentId, row.kind, row.name, save.version);
        items.push({ kind: row.kind, name: row.name, before: before?.body ?? null, after: row.body ?? null });
      }
      return { save, parent, items };
    },
    save: (agentId, input) => db.transaction(async (tx) => {
      await d.lockKey(tx, `learning:${agentId}`);
      if (input.mergeKey !== undefined) {
        const merged = await saveBy(tx, agentId, "merge_key = ?", input.mergeKey);
        if (merged) return { already: merged };
      }
      if (input.seed !== undefined && !(await saveBy(tx, agentId, "id = ?", input.seed))) return { refused: { seed: input.seed } };
      // A run's purge since a save the write read at rewrote that save's rows in place: what the write gives can't be
      // told apart from the purged run's bytes (a file given back unchanged from its seed), so none of it is written.
      if (input.readAt?.length) {
        const purge = Number((await tx.get<{ v: number | string | null }>("SELECT MAX(version) AS v FROM learning_saves WHERE agent_id = ? AND kind = 'purged'", agentId))?.v ?? 0);
        for (const id of input.readAt) {
          const read = await saveBy(tx, agentId, "id = ?", id);
          if (read && read.version < purge) return { purged: { readAt: id } };
        }
      }
      const head = Number((await tx.get<{ v: number | string | null }>("SELECT MAX(version) AS v FROM learning_saves WHERE agent_id = ?", agentId))?.v ?? 0);
      if (head !== input.base) return { stale: head };
      const at = now();
      const version = head + 1;
      const id = versionId();
      const change: SaveChange = { by: input.by, reason: input.reason, files: [...input.files] };
      const byRun = "run" in input.by ? input.by.run : null;
      await tx.run(`INSERT INTO learning_saves (agent_id, version, id, at, kind, by_run, merge_key, change) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, agentId, version, id, at, byRun === null ? "person" : "run", byRun, input.mergeKey ?? null, JSON.stringify(change));
      for (const item of input.items) {
        await tx.run(`INSERT INTO learning_items (agent_id, kind, name, version, body, by_run, change, person, pos, digest, writers, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          agentId, item.kind, item.name, version, item.body, item.byRun, item.change, item.person ? 1 : 0, item.pos, item.digest, item.writers ? JSON.stringify(item.writers) : null, at);
      }
      return { saved: { version, id, at, by: input.by, reason: input.reason, files: [...input.files], mergeKey: input.mergeKey ?? null } };
    }),
    purgeRun: (agentId, runId) => db.transaction(async (tx) => {
      await d.lockKey(tx, `learning:${agentId}`);
      await dropRunLearning(tx, agentId, runId, now());
    }),
    reset: (agentId) => db.transaction((tx) => dropAgentLearning(tx, agentId)),
    erase: (agentId) => db.transaction((tx) => dropAgentLearning(tx, agentId)),
    records: (agentId, kind) => recordsIn(db, agentId, kind),
    addRecord: (agentId, kind, record) => db.transaction(async (tx) => {
      await d.lockKey(tx, `learning.records:${agentId}`);
      await checkAdded(tx, agentId, kind, [record], await heldIn(tx, agentId));
      const seq = Number((await tx.get<{ s: number | string | null }>("SELECT MAX(seq) AS s FROM learning_records WHERE agent_id = ? AND kind = ?", agentId, kind))?.s ?? 0) + 1;
      const at = now();
      await insertRecord(tx, agentId, kind, record, seq, at);
      return { seq, runId: record.runId, workflow: record.workflow, digest: record.digest, data: JSON.parse(JSON.stringify(record.data ?? null)) as unknown, at };
    }),
    changeRecords: (agentId, kind, update, options) => db.transaction(async (tx) => {
      await d.lockKey(tx, `learning.records:${agentId}`);
      const before = await recordsIn(tx, agentId, kind);
      const held = await heldIn(tx, agentId);
      const answer = update(before, held);
      if (!("records" in answer)) return answer.result;
      const was = new Map(before.map((one) => [one.seq, one]));
      const moved = (record: LearningRecordWrite, old: LearningRecord | undefined) => !old || old.runId !== record.runId || old.workflow !== record.workflow || old.digest !== record.digest;
      await checkAdded(tx, agentId, kind, answer.records.filter((record) => moved(record, record.seq === undefined ? undefined : was.get(record.seq))), held, options?.anyDigest);
      const kept = new Set<number>();
      let next = Math.max(0, ...before.map((one) => one.seq)) + 1;
      const at = now();
      for (const record of answer.records) {
        const old = record.seq === undefined ? undefined : was.get(record.seq);
        if (!old) {
          await insertRecord(tx, agentId, kind, record, next++, at);
          continue;
        }
        kept.add(old.seq);
        if (JSON.stringify(old.data) !== JSON.stringify(record.data ?? null) || old.runId !== record.runId || old.workflow !== record.workflow || old.digest !== record.digest) {
          await tx.run("UPDATE learning_records SET run_id = ?, workflow = ?, digest = ?, data = ? WHERE agent_id = ? AND kind = ? AND seq = ?", ...columnsOf(record), agentId, kind, old.seq);
        }
      }
      for (const one of before) if (!kept.has(one.seq)) await tx.run("DELETE FROM learning_records WHERE agent_id = ? AND kind = ? AND seq = ?", agentId, kind, one.seq);
      return answer.result;
    }),
  };
}
