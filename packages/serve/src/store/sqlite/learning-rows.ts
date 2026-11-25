// An agent's learning as versioned rows (schema.ts LEARNING_ROWS): the part of Store.learning that keeps its notes,
// workflows, promotions, grades and audits. Written once for SQLite and Postgres, over the store's connection and its
// Dialect: a save is one transaction, under the agent's lock on Postgres (SQLite's one writer lock holds it there), its
// compare and swap on the agent's newest version. A run's purge and an agent's reset or delete are plain deletes.
import { randomBytes } from "node:crypto";
import type { Learning, LearningAt, LearningChangeKind, LearningDiff, LearningItem, LearningItemKind, LearningRecord, LearningRecordKind, LearningRecordWrite, LearningSave, LearningSaveBy } from "../store.js";
import type { SqliteExecutor, SqliteValue, StoreConnection, Tx } from "./connection.js";

type SaveKind = "init" | "run" | "person" | "purged";
type SaveRow = { version: number | string; id: string; at: number | string; kind: SaveKind; by_run: string | null; merge_key: string | null; change: string };
type ItemRow = { kind: LearningItemKind; name: string; version: number | string; body?: string | null; by_run: string | null; change: string; person: number | string; pos: number | string; digest: string | null; at: number | string };
type RecordRow = { seq: number | string; run_id: string | null; workflow: string | null; digest: string | null; data: string; at: number | string };

const SAVE_COLUMNS = "version, id, at, kind, by_run, merge_key, change";
const ITEM_FACTS = "kind, name, version, by_run, change, person, pos, digest, at";
const ITEM_COLUMNS = `${ITEM_FACTS}, body`;
const RECORD_COLUMNS = "seq, run_id, workflow, digest, data, at";
/** What a read takes: the connection, or a transaction's handle. */
type Reader = Pick<SqliteExecutor, "get" | "all">;

/** What a save's `change` column keeps: a run's or a person's, who saved it, why, and the paths it changed; the
 *  host's (an init, a purged run's), nothing. */
type SaveChange = { by?: LearningSaveBy; reason?: string; files?: string[] };

function saveOf(row: SaveRow): LearningSave {
  const change = JSON.parse(row.change) as SaveChange;
  const by: LearningSaveBy = row.kind === "init" || row.kind === "purged" ? { host: row.kind } : change.by!;
  return { version: Number(row.version), id: row.id, at: Number(row.at), by, reason: change.reason ?? "", files: change.files ?? [], mergeKey: row.merge_key };
}
const factsOf = (row: ItemRow): Omit<LearningItem, "body"> => ({
  kind: row.kind, name: row.name, version: Number(row.version), byRun: row.by_run, change: row.change as LearningChangeKind,
  person: Number(row.person) === 1, pos: Number(row.pos), digest: row.digest, at: Number(row.at),
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

/** Run `runId`'s learning rows gone from its agent `agentId`'s, inside the caller's transaction (its purge, its
 *  delete), every statement scoped to that agent: the promotions and audits of each workflow version it wrote that no
 *  other version holds, its grades and audits, the item versions it wrote, and its saves' words (each save's version, id
 *  and merge key stay), a person's save that changed only its text (an approve of its draft, a removal of its line)
 *  with them: that save's words name what the run wrote. */
export async function dropRunLearning(tx: Tx, agentId: string, runId: string): Promise<void> {
  await tx.run(`DELETE FROM learning_records WHERE agent_id = ? AND kind IN ('promotion', 'audit')
    AND EXISTS (SELECT 1 FROM learning_items i WHERE i.agent_id = learning_records.agent_id AND i.kind = 'workflow' AND i.name = learning_records.workflow AND i.digest = learning_records.digest AND i.by_run = ?)
    AND NOT EXISTS (SELECT 1 FROM learning_items j WHERE j.agent_id = learning_records.agent_id AND j.kind = 'workflow' AND j.name = learning_records.workflow AND j.digest = learning_records.digest AND (j.by_run IS NULL OR j.by_run <> ?))`, agentId, runId, runId);
  await tx.run("DELETE FROM learning_records WHERE agent_id = ? AND run_id = ?", agentId, runId);
  await tx.run(`UPDATE learning_saves SET kind = 'purged', by_run = NULL, change = '{}' WHERE agent_id = ? AND kind = 'person'
    AND EXISTS (SELECT 1 FROM learning_items i WHERE i.agent_id = learning_saves.agent_id AND i.version = learning_saves.version AND i.by_run = ?)
    AND NOT EXISTS (SELECT 1 FROM learning_items j WHERE j.agent_id = learning_saves.agent_id AND j.version = learning_saves.version AND (j.by_run IS NULL OR j.by_run <> ?))`, agentId, runId, runId);
  await tx.run("DELETE FROM learning_items WHERE agent_id = ? AND by_run = ?", agentId, runId);
  await tx.run("UPDATE learning_saves SET kind = 'purged', by_run = NULL, change = '{}' WHERE agent_id = ? AND by_run = ?", agentId, runId);
}

/** Every learning row of agent `agentId` gone, inside the caller's transaction (a reset, its purge, its delete). */
export async function dropAgentLearning(tx: SqliteExecutor, agentId: string): Promise<void> {
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
        `SELECT i.kind, i.name, i.version, i.body, i.by_run AS item_by_run, i.change AS item_change, i.person, i.pos, i.digest, i.at, s.id, s.at AS save_at, s.kind AS save_kind, s.by_run, s.merge_key, s.change
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
      const head = Number((await tx.get<{ v: number | string | null }>("SELECT MAX(version) AS v FROM learning_saves WHERE agent_id = ?", agentId))?.v ?? 0);
      if (head !== input.base) return { stale: head };
      const at = now();
      const version = head + 1;
      const id = versionId();
      const change: SaveChange = { by: input.by, reason: input.reason, files: [...input.files] };
      const byRun = "run" in input.by ? input.by.run : null;
      await tx.run(`INSERT INTO learning_saves (agent_id, version, id, at, kind, by_run, merge_key, change) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, agentId, version, id, at, byRun === null ? "person" : "run", byRun, input.mergeKey ?? null, JSON.stringify(change));
      for (const item of input.items) {
        await tx.run(`INSERT INTO learning_items (agent_id, kind, name, version, body, by_run, change, person, pos, digest, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          agentId, item.kind, item.name, version, item.body, item.byRun, item.change, item.person ? 1 : 0, item.pos, item.digest, at);
      }
      return { saved: { version, id, at, by: input.by, reason: input.reason, files: [...input.files], mergeKey: input.mergeKey ?? null } };
    }),
    purgeRun: (agentId, runId) => db.transaction(async (tx) => {
      await d.lockKey(tx, `learning:${agentId}`);
      await dropRunLearning(tx, agentId, runId);
    }),
    reset: (agentId) => db.transaction(async (tx) => {
      await d.lockKey(tx, `learning:${agentId}`);
      await dropAgentLearning(tx, agentId);
    }),
    erase: (agentId) => db.transaction(async (tx) => {
      await d.lockKey(tx, `learning:${agentId}`);
      await dropAgentLearning(tx, agentId);
    }),
    records: (agentId, kind) => recordsIn(db, agentId, kind),
    addRecord: (agentId, kind, record) => db.transaction(async (tx) => {
      await d.lockKey(tx, `learning.records:${agentId}`);
      const seq = Number((await tx.get<{ s: number | string | null }>("SELECT MAX(seq) AS s FROM learning_records WHERE agent_id = ? AND kind = ?", agentId, kind))?.s ?? 0) + 1;
      const at = now();
      await insertRecord(tx, agentId, kind, record, seq, at);
      return { seq, runId: record.runId, workflow: record.workflow, digest: record.digest, data: JSON.parse(JSON.stringify(record.data ?? null)) as unknown, at };
    }),
    changeRecords: (agentId, kind, update) => db.transaction(async (tx) => {
      await d.lockKey(tx, `learning.records:${agentId}`);
      const before = await recordsIn(tx, agentId, kind);
      const answer = update(before);
      if (!("records" in answer)) return answer.result;
      const was = new Map(before.map((one) => [one.seq, one]));
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
