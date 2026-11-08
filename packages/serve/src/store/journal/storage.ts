// One run's journal in the one store: pi-durable 1.5's `Storage` over the store's connection, scoped by run_id. A port of
// pi-durable's own SqliteStorage (MIT, see NOTICE): the same checks, writes and reads, with run_id on every row and in
// every query (its tables are PI_DDL in store/schema.ts), the run's own id and seq namespaces (pi_metadata, one row per
// run), and every commit fenced by the run's claim: in its one transaction, `UPDATE runs … WHERE id AND epoch` must change
// the run's row, or the whole transaction rolls back and the commit rejects with Fenced, which fails the Session (pi: any
// commit error is final). A patch of the run row (state, cost, metrics, ended_at) staged before a commit lands in that
// same transaction, so a run's end and its last journal commit are one commit; a command it takes lands with its effect
// (taken_at, exactly once). `close` leaves the store's connection open: the store owns it.
import type { Context, JsonValue } from "@earendil-works/chord";
import { apply } from "@earendil-works/chord/delta";
import {
  type CommitResult,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type Page,
  type Seq,
  type Storage,
  StorageRequestError,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { PI_TABLE as T } from "../schema.js";
import type { Connection } from "../sqlite/connection.js";
import { applyRunPatch } from "../sqlite/run-patch.js";
import { type Claim, CommandTaken, Fenced, type Journal, type Staged } from "../store.js";

/** A run's claim, as the journal is opened under it: the run and the epoch its claim holds. */
export type JournalClaim = Pick<Claim, "runId" | "epoch">;

/** The store's connection as the journal uses it (sqlite/connection.ts): reads, and one interactive transaction per commit. */
export type JournalConnection = Pick<Connection, "get" | "all" | "transaction">;

/** A value a statement binds. */
type SqliteValue = null | number | bigint | string | Uint8Array;

/** The calls the journal's queries make (pi's SqliteStorage shape): inside a transaction, steps of it; outside, reads. */
interface SqliteExecutor {
  run(sql: string, ...params: SqliteValue[]): Promise<void>;
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number>;
  get<R extends object>(sql: string, ...params: SqliteValue[]): Promise<R | undefined>;
  all<R extends object>(sql: string, ...params: SqliteValue[]): Promise<R[]>;
}

/** Reads on `db` outside a transaction, as the journal's executor (a read writes nothing, so it has no run or runCounted). */
function readsOf(db: JournalConnection): Pick<SqliteExecutor, "get" | "all"> {
  return {
    get: <R extends object>(sql: string, ...params: SqliteValue[]) => db.get<R>(sql, ...params),
    all: <R extends object>(sql: string, ...params: SqliteValue[]) => db.all<R>(sql, ...params),
  };
}

/** A run's first id to mint: pi's root conversation is 1. */
const FIRST_ID = 2;

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** A document a commit changed, as the live view reads it: its value at that seq, or `retired` with none. */
export type JournalDocument = { readonly id: DocumentId; readonly kind: string; readonly conversationId?: ConversationId } & ({ readonly value: JsonValue; readonly retired?: undefined } | { readonly retired: true; readonly value?: undefined });
/** One stored commit of the run, with only the records it wrote. */
export type JournalCommit = { readonly seq: Seq; readonly entries: EntryRecord[]; readonly documents: JournalDocument[]; readonly tasks: StoredTask[]; readonly submissions: SubmissionRecord[] };
/** A page of commits (journal.commitsAfter): `next` to read on from, when more may follow. */
export type JournalPage = { readonly commits: JournalCommit[]; readonly next?: number };
type Row = Record<string, SqliteValue>;
type DocumentContent = { readonly kind: "base"; readonly version: number; readonly value: JsonValue } | { readonly kind: "delta"; readonly version: number; readonly ops: unknown };
type DocumentAction = { create?: DocumentRecord; content?: DocumentContent; copy?: { readonly id: DocumentId; readonly at: DocumentPoint }; retire: boolean };
type ScanOrder = "ascending" | "descending";

const parseJson = <T>(value: SqliteValue): T => JSON.parse(String(value)) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value);
// Some SQLite bindings replace lone UTF-16 surrogates. JSON encoding keeps indexed identities lossless.
const encodeIndexedString = (value: string): string => JSON.stringify(value);
const idOf = <I>(value: number): I => value as unknown as I;
const seqOf = (value: number): Seq => value as unknown as Seq;

/** A scan's order and position (pi-durable's scan.ts): a cursor continues in the order it was made with. */
function scanStart(requested: ScanOrder | undefined, cursor: Cursor | undefined, fallback: ScanOrder): { order: ScanOrder; after: number | undefined } {
  if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
    throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
  }
  if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
  const { after, order: stored } = cursor as { after?: unknown; order?: unknown };
  if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new StorageRequestError("Invalid storage cursor");
  if (stored !== undefined && stored !== "ascending" && stored !== "descending") throw new StorageRequestError("Invalid storage cursor");
  const order = (stored as ScanOrder | undefined) ?? fallback;
  if (requested !== undefined && requested !== order) {
    throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
  }
  return { order, after };
}
const nextCursor = (id: number, order: ScanOrder): Cursor => ({ after: id, order }) as unknown as Cursor;
const cursorId = (cursor: Cursor | undefined): number | undefined => {
  const after = (cursor as { after?: unknown } | undefined)?.after;
  if (after === undefined) return undefined;
  if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new StorageRequestError("Invalid storage cursor");
  return after;
};
const page = <V extends { id: unknown }>(values: V[], limit: number, order: ScanOrder = "ascending"): Page<V, Cursor> => {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items } as Page<V, Cursor>;
  return { items, next: nextCursor(items.at(-1)!.id as number, order) } as Page<V, Cursor>;
};
/** The id condition, its parameter, and the ORDER BY direction of a table scan. */
const scanSql = (start: { order: ScanOrder; after: number | undefined }) =>
  start.order === "ascending"
    ? { clause: "id > ?", param: start.after ?? -1, direction: "ASC" }
    : { clause: "id < ?", param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" };

type Scope = DocumentAddress["scope"];
const scopeColumns = (scope: Scope): { scopeKind: string; ownerId: number } => {
  switch (scope.kind) {
    case "session":
      return { scopeKind: "session", ownerId: 0 };
    case "conversation":
      return { scopeKind: "conversation", ownerId: scope.conversationId as unknown as number };
    case "task":
      return { scopeKind: "task", ownerId: scope.taskId as unknown as number };
  }
};
const addressParts = (address: DocumentAddress) => {
  const scope = scopeColumns(address.scope);
  return { kind: encodeIndexedString(address.kind), ...scope, family: address.key === undefined ? 0 : 1, keyValue: encodeIndexedString((address.key as string | undefined) ?? "") };
};
const addressKey = (address: DocumentAddress): string => {
  const parts = addressParts(address);
  return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};
const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
  const { createdAt, retiredAt } = record as unknown as { createdAt: number; retiredAt?: number };
  if (at === "current") return retiredAt === undefined;
  return createdAt <= (at as unknown as number) && (retiredAt === undefined || (at as unknown as number) < retiredAt);
};
/** A forked conversation's parent and the entry it forked at. */
type Parent = { readonly conversationId: ConversationId; readonly at: number };
const parentOf = (conversation: ConversationRecord): Parent | undefined => (conversation as { parent?: Parent }).parent;
const isCurrentOnly = (record: DocumentRecord): boolean => record.scope.kind !== "conversation" || (record as { history?: string }).history === "latest";
const writeId = (write: StorageWrite): number | undefined => {
  switch (write.type) {
    case "conversation":
    case "entry":
    case "task":
    case "submission":
      return write.value.id as unknown as number;
    case "document.create":
    case "document.copy":
      return write.record.id as unknown as number;
    default:
      return undefined;
  }
};

/** `executor`, noting in `calls.failed` when one of its calls throws: then a failing check is the database's. */
function watchCalls(executor: SqliteExecutor, calls: { failed: boolean }): SqliteExecutor {
  const watched = async <R>(call: () => Promise<R>): Promise<R> => {
    try {
      return await call();
    } catch (error) {
      calls.failed = true;
      throw error;
    }
  };
  return {
    run: (sql, ...params) => watched(() => executor.run(sql, ...params)),
    runCounted: (sql, ...params) => watched(() => executor.runCounted(sql, ...params)),
    get: <R extends object>(sql: string, ...params: SqliteValue[]) => watched(() => executor.get<R>(sql, ...params)),
    all: <R extends object>(sql: string, ...params: SqliteValue[]) => watched(() => executor.all<R>(sql, ...params)),
  };
}

/** pi-durable's Storage for one run in the one store. */
export class RunStorage implements Journal {
  readonly #db: JournalConnection;
  readonly #read: Pick<SqliteExecutor, "get" | "all">;
  readonly #runId: string;
  readonly #epoch: number;
  /** The store's clock (epoch ms): a take's taken_at and a final state's ended_at stamp. */
  readonly #now: () => number;
  #nextId = Number.NaN;
  #opening: Promise<void> | undefined;
  #staged: Staged | undefined;
  /** Commands staged to be taken, each with the record of its effect: taken only by the commit that stores that record. */
  readonly #takes = new Map<number, number>();
  /** Ids this journal minted and has not yet written: the only ones a staged take may name as its effect. */
  readonly #minted = new Set<number>();
  #closed = false;
  #closing: Promise<void> | undefined;
  #admittedReads = 0;
  /** Commits asked for and not yet settled: close waits for them. */
  readonly #pending = new Set<Promise<CommitResult>>();
  #readsDrained: (() => void) | undefined;

  /** The journal of `claim`'s run on `db` (the store's connection, its schema in place). Its id namespace is read, and made
   *  on first use, by its first commit or mintId. `now`: the store's clock (epoch ms). */
  constructor(db: JournalConnection, claim: JournalClaim, now: () => number = Date.now, onClose?: () => void) {
    this.#db = db;
    this.#read = readsOf(db);
    this.#runId = claim.runId;
    this.#epoch = claim.epoch;
    this.#now = now;
    this.#onClose = onClose;
  }

  /** Told when this journal closes (the store drops it from the journals it hands out). */
  readonly #onClose: (() => void) | undefined;

  /** The journal of `claim`'s run on `db`, its id namespace read (and made on first use). */
  static async open(db: JournalConnection, claim: JournalClaim, now: () => number = Date.now): Promise<RunStorage> {
    const storage = new RunStorage(db, claim, now);
    await storage.#opened();
    return storage;
  }

  /** The run's id namespace, read once: pi_metadata's row, or pi's first id after the root when the run has none yet. A
   *  read only: nothing but a commit writes, so every write of the journal is under the claim's fence. */
  #opened(): Promise<void> {
    this.#opening ??= this.#read.get<{ next_id: string }>(`SELECT next_id FROM ${T.metadata} WHERE run_id = ?`, this.#runId).then(
      (metadata) => {
        if (Number.isNaN(this.#nextId)) this.#nextId = Number(metadata?.next_id ?? FIRST_ID);
      },
      (error: unknown) => {
        // A failed read is not kept: the next call reads again.
        this.#opening = undefined;
        throw error;
      },
    );
    return this.#opening;
  }

  /** Whether the journal is closed (store.journal hands out a new one then). */
  get closed(): boolean {
    return this.#closed;
  }

  /** One transaction of the store's connection, its work stepping only its own statements (it holds every other call). */
  #transaction<R>(work: (tx: SqliteExecutor) => Promise<R>): Promise<R> {
    return this.#db.transaction((tx) => work(tx));
  }

  /** The run whose journal this is. */
  get runId(): string {
    return this.#runId;
  }

  /**
   * Stage what a commit writes beside its batches, in its one transaction, under its fence:
   * - the run row's patch and other rows (`also`, such as an outbox row for a run moment), with `effect`, the id of the
   *   record they land with (a park's ask, an end's entry), matched as a take's effect is (an id its batch newly
   *   allocates; an effect that updates a record carries a marker entry minted for it): written only by the commit that
   *   newly writes that record, then cleared, so a run never reads parked or ended without what caused it; until then
   *   they wait. A later stage that names a patch or rows replaces them.
   * - the commands it takes (`take`: each with the id of the record that is its effect, an id its effect's batch newly
   *   allocates): a take is written only by the commit that newly writes that record, so a command is taken with its own
   *   effect or not at all, never by another path's update of an existing record. An effect that changes or retires a
   *   document, or updates a task, carries a marker entry (kind `agentrun.command`, data `{ command }`) minted for it in
   *   the same batch. A take naming an id this journal did not mint, or has already written, throws here: it could never
   *   be taken, so it is refused rather than left waiting. Otherwise a take waits, across commits and later stages; stage
   *   it before its effect's commit is asked. Each must be this run's untaken command, else that commit rejects with
   *   CommandTaken.
   */
  stage(staged: Staged): void {
    if ((staged.run !== undefined || staged.also !== undefined) && !Number.isSafeInteger(Number(staged.effect))) {
      throw new Error(`run ${this.#runId}: a staged run patch or rows name no effect (the id of the record they land with)`);
    }
    for (const take of staged.take ?? []) {
      if (!Number.isSafeInteger(take?.command) || !Number.isSafeInteger(Number(take?.effect))) throw new Error(`run ${this.#runId}: a staged take names no command and effect ids: ${JSON.stringify(take)}`);
      // Refused here, never left waiting forever: an effect must be an id this journal minted and has not yet written,
      // so only the batch that newly writes it can take the command.
      if (!this.#minted.has(Number(take.effect))) {
        throw new Error(`run ${this.#runId}: command ${take.command}'s take names effect ${String(take.effect)}, which is no id this journal minted and has not yet written (an effect that updates a record takes its command through a marker entry minted for it)`);
      }
    }
    for (const take of staged.take ?? []) this.#takes.set(take.command, Number(take.effect));
    // A stage that names a run patch or rows replaces the ones staged before; one that only takes leaves them.
    if (staged.run !== undefined || staged.also !== undefined) this.#staged = { ...(staged.run !== undefined ? { run: staged.run } : {}), ...(staged.also !== undefined ? { also: staged.also } : {}), effect: Number(staged.effect) };
  }

  /**
   * Commit `batches` in one transaction of the store, each with its own seq: first the fence (the run's row at this
   * claim's epoch, else Fenced and nothing written), then each batch checked before it writes anything, against the
   * state the earlier ones left; the first one refused ends the commit, the ones before it stand. A staged run patch is
   * written in the same transaction once a batch is stored.
   */
  async commit(batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, context: Context): Promise<CommitResult> {
    this.#assertOpen();
    // Asked before a close: the close waits for it, so it never meets a connection its store closed after the journal's.
    const work = this.#commit(batches, receive, context);
    this.#pending.add(work);
    try {
      return await work;
    } finally {
      this.#pending.delete(work);
    }
  }

  async #commit(batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, _context: Context): Promise<CommitResult> {
    const seqs: Seq[] = [];
    let refused: { error: unknown } | undefined;
    let candidateNextId = Number.NaN;
    const staged = this.#staged;
    // The takes this commit writes: those whose effect a stored batch of it holds.
    const taking: number[] = [];
    // Whether a stored batch of this commit writes the staged patch's effect: only then does the patch land.
    let patching = false;
    // Queued at once, with nothing awaited before it (a fresh journal reads its namespace inside the transaction), so a
    // store close asked after this commit waits for it. The transaction holds the store's one connection: its work awaits
    // only its own statements, never a model or a tool.
    await this.#transaction(async (tx) => {
      if ((await tx.runCounted("UPDATE runs SET epoch = epoch WHERE id = ? AND epoch = ?", this.#runId, this.#epoch)) === 0) {
        throw new Fenced(this.#runId, this.#epoch);
      }
      const metadata = await this.#readMetadata(tx);
      if (Number.isNaN(this.#nextId)) this.#nextId = Number(metadata.next_id);
      candidateNextId = this.#nextId;
      let next = Number(metadata.next_seq);
      // Whether a database call of a batch's checks failed: then the failure is an unknown outcome, not a refusal.
      const calls = { failed: false };
      const checked = watchCalls(tx, calls);
      for (const writes of batches) {
        let documentActions: Map<number, DocumentAction>;
        calls.failed = false;
        try {
          documentActions = this.#prepareDocumentActions(writes);
          await this.#checkBatch(checked, writes, documentActions);
        } catch (error) {
          if (calls.failed) throw error;
          refused = { error };
          break;
        }
        const seq = seqOf(next++);
        // The ids this batch newly allocates, read before it writes: a take's effect is matched only to one of them, a
        // record that no other path can have written (an update of an existing task, or a document's change or retire,
        // takes nothing: the command's runner puts a marker entry, freshly minted, in that batch).
        const fresh = await this.#freshIds(tx, writes);
        await this.#applyBatch(tx, writes, documentActions, seq);
        seqs.push(seq);
        candidateNextId = Math.max(candidateNextId, this.#candidateNextId(writes));
        // A take whose effect this stored batch newly writes is this commit's, and so is the staged patch.
        for (const [command, effect] of this.#takes) if (fresh.has(effect) && !taking.includes(command)) taking.push(command);
        if (staged?.effect !== undefined && fresh.has(staged.effect)) patching = true;
      }
      if (seqs.length > 0) {
        await tx.run(
          `INSERT INTO ${T.metadata} (run_id, next_id, next_seq) VALUES (?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET next_id = excluded.next_id, next_seq = excluded.next_seq`,
          this.#runId, String(Math.max(Number(metadata.next_id), candidateNextId)), next,
        );
        // The run patch's fenced UPDATE (0 rows: Fenced), then its rows (store/sqlite/run-patch.ts, as runs.update writes
        // them), then the takes.
        const now = this.#now();
        if (patching && (staged?.run !== undefined || (staged?.also ?? []).length > 0)) {
          await applyRunPatch(tx, { runId: this.#runId, epoch: this.#epoch }, staged?.run ?? {}, staged?.also ?? [], now);
        }
        for (const commandId of taking) {
          if ((await tx.runCounted("UPDATE commands SET taken_at = ? WHERE id = ? AND run_id = ? AND taken_at IS NULL", now, commandId, this.#runId)) === 0) {
            throw new CommandTaken(this.#runId, commandId);
          }
        }
      }
    });
    this.#nextId = Math.max(this.#nextId, candidateNextId);
    // Ids written now are no longer fresh: a take staged after this cannot name them.
    for (const [index, writes] of batches.entries()) {
      if (index >= seqs.length) break;
      for (const write of writes) {
        const id = writeId(write);
        if (id !== undefined) this.#minted.delete(id);
      }
    }
    // Landed with its effect: no longer staged (a patch whose effect this commit did not store waits).
    if (patching && this.#staged === staged) this.#staged = undefined;
    // Taken with their effects, now durable: no longer waiting.
    for (const command of taking) this.#takes.delete(command);
    // COMMIT returned: the stored batches are durable (to the store's synchronous level; flush makes them so on disk).
    for (const [index, seq] of seqs.entries()) receive(index, seq);
    return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: refused.error };
  }

  /**
   * pi's publication of a commit this storage already made durable (its in-memory cache, adoption and observers): run
   * now. The run row's end is not written here but in the commit itself (stage), so publication has nothing to join.
   */
  publishing(publish: () => void, _context: Context): void {
    publish();
  }

  async #readMetadata(executor: SqliteExecutor): Promise<{ next_id: string; next_seq: number }> {
    // A run with no row yet starts at pi's first id after the root and seq 1; its first stored commit writes the row.
    const metadata = await executor.get<{ next_id: string; next_seq: number }>(`SELECT next_id, next_seq FROM ${T.metadata} WHERE run_id = ?`, this.#runId);
    return metadata ?? { next_id: String(FIRST_ID), next_seq: 1 };
  }

  async #checkBatch(executor: SqliteExecutor, writes: readonly StorageWrite[], documentActions: Map<number, DocumentAction>): Promise<void> {
    await this.#checkGlobalIds(executor, writes);
    await this.#checkDocumentActions(executor, documentActions);
    await this.#resolveCopies(executor, documentActions);
  }

  /** The ids `writes` newly allocate in this run: an entry's and a created or copied document's always (pi's checks refuse
   *  a reused id), a conversation's, task's or submission's when no record holds that id yet (else it is an update). */
  async #freshIds(executor: SqliteExecutor, writes: readonly StorageWrite[]): Promise<Set<number>> {
    const fresh = new Set<number>();
    const upserts: number[] = [];
    for (const write of writes) {
      const id = writeId(write);
      if (id === undefined) continue;
      if (write.type === "entry" || write.type === "document.create" || write.type === "document.copy") fresh.add(id);
      else upserts.push(id);
    }
    if (upserts.length > 0) {
      const known = new Set((await executor.all<{ id: number }>(`SELECT id FROM ${T.recordIds} WHERE run_id = ? AND id IN (${upserts.map(() => "?").join(", ")})`, this.#runId, ...upserts)).map((row) => Number(row.id)));
      for (const id of upserts) if (!known.has(id)) fresh.add(id);
    }
    return fresh;
  }

  async #applyBatch(executor: SqliteExecutor, writes: readonly StorageWrite[], documentActions: Map<number, DocumentAction>, seq: Seq): Promise<void> {
    for (const write of writes) await this.#applyTableWrite(executor, write, seq);
    await this.#applyDocumentActions(executor, documentActions, seq);
    await this.#logWrites(executor, writes, documentActions, seq);
  }

  /** This commit's own writes of the rows kept only as they are now (tasks, submissions, latest-only documents), as it
   *  wrote them, in its transaction (pi_commit_writes): the last write of a row within the commit is the one kept. */
  async #logWrites(executor: SqliteExecutor, writes: readonly StorageWrite[], documentActions: Map<number, DocumentAction>, seq: Seq): Promise<void> {
    const log = (kind: string, id: number, value: unknown) =>
      executor.run(`INSERT INTO ${T.commitWrites} (run_id, seq, kind, id, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id, seq, kind, id) DO UPDATE SET value = excluded.value`, this.#runId, seq as unknown as number, kind, id, encodeJson(value as JsonValue));
    for (const write of writes) {
      if (write.type === "task" || write.type === "submission") await log(write.type, write.value.id as unknown as number, write.value);
    }
    for (const id of documentActions.keys()) {
      const row = await executor.get<Row>(`SELECT record FROM ${T.documents} WHERE run_id = ? AND id = ?`, this.#runId, id);
      if (row === undefined) continue;
      const record = parseJson<DocumentRecord & { retiredAt?: number }>(row.record!);
      if (!isCurrentOnly(record)) continue;
      if (record.retiredAt === (seq as unknown as number)) {
        await log("document", id, { retired: true });
        continue;
      }
      const stored = await this.#materializeDocument(executor, id, "current");
      if (stored) await log("document", id, { value: (stored as unknown as { value: JsonValue }).value });
    }
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    this.#assertOpen();
    await this.#opened();
    if (!Number.isSafeInteger(this.#nextId)) throw new Error("ID space is exhausted");
    const id = this.#nextId++;
    this.#minted.add(id);
    return idOf<I>(id);
  }

  async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    this.#assertOpen();
    return this.#readConversation(id);
  }

  async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<ConversationRecord, Cursor>> {
    this.#assertOpen();
    const start = scanStart(query.order as ScanOrder | undefined, cursor, "ascending");
    const scan = scanSql(start);
    const clauses = ["run_id = ?", scan.clause];
    const params: SqliteValue[] = [this.#runId, scan.param];
    if (query.ownerConversationId !== undefined) (clauses.push("owner_conversation_id = ?"), params.push(query.ownerConversationId as unknown as number));
    if (query.ownerTaskId !== undefined) (clauses.push("owner_task_id = ?"), params.push(query.ownerTaskId as unknown as number));
    params.push(limit + 1);
    const rows = await this.#read.all<Row>(`SELECT id, record FROM ${T.conversations} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`, ...params);
    return page(rows.map((row) => parseJson<ConversationRecord>(row.record!)), limit, start.order);
  }

  entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(idOrConversationId: EntryId | ConversationId, idOrContext: EntryId | Context, context?: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    return this.#admitRead(() => this.#readEntry(idOrConversationId as unknown as number, idOrContext, context));
  }

  findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, _context: Context): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.#admitRead(() => this.#readLatestHeadMarker(conversationId, atOrBeforeEntryId as unknown as number | undefined));
  }

  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<EntryRecord, Cursor>> {
    return this.#admitRead(() => this.#readEntries(query, limit, cursor));
  }

  async #readEntry(idOrConversationId: number, idOrContext: unknown, context: Context | undefined): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    const id = context === undefined ? idOrConversationId : typeof idOrContext === "number" ? idOrContext : undefined;
    if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
    let conversation: ConversationRecord | undefined;
    if (context !== undefined) {
      const conversationId = idOf<ConversationId>(idOrConversationId);
      conversation = await this.#readConversation(conversationId);
      if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
    }
    const row = await this.#read.get<Row>(`SELECT record, commit_seq FROM ${T.entries} WHERE run_id = ? AND id = ?`, this.#runId, id);
    if (row === undefined) return undefined;
    const entry = parseJson<EntryRecord>(row.record!);
    if (conversation !== undefined) {
      let upperEntryId = Number.POSITIVE_INFINITY;
      while (conversation.id !== entry.conversationId) {
        const parent: Parent | undefined = parentOf(conversation);
        if (parent === undefined) return undefined;
        upperEntryId = Math.min(upperEntryId, parent.at);
        conversation = (await this.#readConversation(parent.conversationId))!;
      }
      if ((entry.id as unknown as number) > upperEntryId) return undefined;
    }
    return { entry, commitSeq: seqOf(Number(row.commit_seq)) };
  }

  async #readLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: number | undefined): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    let conversation = await this.#readConversation(conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
    let upper = atOrBeforeEntryId;
    while (true) {
      const row =
        upper === undefined
          ? await this.#read.get<Row>(`SELECT record FROM ${T.entries} WHERE run_id = ? AND conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1`, this.#runId, conversation.id as unknown as number)
          : await this.#read.get<Row>(`SELECT record FROM ${T.entries} WHERE run_id = ? AND conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1`, this.#runId, conversation.id as unknown as number, upper);
      if (row !== undefined) return parseJson<EntryRecord & { readonly head: EntryId }>(row.record!);
      const parent: Parent | undefined = parentOf(conversation);
      if (parent === undefined) return undefined;
      upper = upper === undefined ? parent.at : Math.min(upper, parent.at);
      conversation = (await this.#readConversation(parent.conversationId))!;
    }
  }

  async #readEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined): Promise<Page<EntryRecord, Cursor>> {
    const { order, after } = scanStart(query.order as ScanOrder | undefined, cursor, "descending");
    const minEntryId = query.minEntryId as unknown as number | undefined;
    const maxEntryId = query.maxEntryId as unknown as number | undefined;
    if (order === "ascending") return this.#readEntriesAscending(query.conversationId, minEntryId, maxEntryId, limit, after);
    let conversation = await this.#readConversation(query.conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
    let upper = maxEntryId;
    if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
    const values: EntryRecord[] = [];
    while (true) {
      const clauses = ["run_id = ?", "conversation_id = ?"];
      const params: SqliteValue[] = [this.#runId, conversation.id as unknown as number];
      if (minEntryId !== undefined) (clauses.push("id >= ?"), params.push(minEntryId));
      if (upper !== undefined) (clauses.push("id <= ?"), params.push(upper));
      params.push(limit + 1 - values.length);
      const rows = await this.#read.all<Row>(`SELECT record FROM ${T.entries} WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...params);
      values.push(...rows.map((row) => parseJson<EntryRecord>(row.record!)));
      const parent: Parent | undefined = parentOf(conversation);
      if (values.length > limit || parent === undefined) break;
      const bound: number = upper === undefined ? parent.at : Math.min(upper, parent.at);
      upper = bound;
      if (minEntryId !== undefined && bound < minEntryId) break;
      conversation = (await this.#readConversation(parent.conversationId))!;
    }
    return page(values, limit, "descending");
  }

  /** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
  async #readEntriesAscending(conversationId: ConversationId, minEntryId: number | undefined, maxEntryId: number | undefined, limit: number, after: number | undefined): Promise<Page<EntryRecord, Cursor>> {
    const segments: { conversationId: number; upper: number | undefined }[] = [];
    let conversation = await this.#readConversation(conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
    let upper = maxEntryId;
    while (true) {
      segments.push({ conversationId: conversation.id as unknown as number, upper });
      const parent: Parent | undefined = parentOf(conversation);
      if (parent === undefined) break;
      const bound: number = upper === undefined ? parent.at : Math.min(upper, parent.at);
      upper = bound;
      if (minEntryId !== undefined && bound < minEntryId) break;
      conversation = (await this.#readConversation(parent.conversationId))!;
    }
    let lower = minEntryId;
    if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
    const values: EntryRecord[] = [];
    for (const segment of segments.reverse()) {
      const clauses = ["run_id = ?", "conversation_id = ?"];
      const params: SqliteValue[] = [this.#runId, segment.conversationId];
      if (lower !== undefined) (clauses.push("id >= ?"), params.push(lower));
      if (segment.upper !== undefined) (clauses.push("id <= ?"), params.push(segment.upper));
      params.push(limit + 1 - values.length);
      const rows = await this.#read.all<Row>(`SELECT record FROM ${T.entries} WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`, ...params);
      values.push(...rows.map((row) => parseJson<EntryRecord>(row.record!)));
      if (values.length > limit) break;
    }
    return page(values, limit, "ascending");
  }

  async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
    this.#assertOpen();
    const row = await this.#read.get<Row>(`SELECT record FROM ${T.tasks} WHERE run_id = ? AND id = ?`, this.#runId, id as unknown as number);
    return row === undefined ? undefined : parseJson<StoredTask>(row.record!);
  }

  async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<StoredTask, Cursor>> {
    this.#assertOpen();
    const start = scanStart(query.order as ScanOrder | undefined, cursor, "ascending");
    const scan = scanSql(start);
    const clauses = ["run_id = ?", scan.clause];
    const params: SqliteValue[] = [this.#runId, scan.param];
    if (query.conversationId !== undefined) (clauses.push("conversation_id = ?"), params.push(query.conversationId as unknown as number));
    if (query.kind !== undefined) (clauses.push("kind = ?"), params.push(encodeIndexedString(query.kind)));
    if (query.status !== undefined) (clauses.push("status = ?"), params.push(query.status));
    if (query.abortRequested !== undefined) (clauses.push("abort_requested = ?"), params.push(query.abortRequested ? 1 : 0));
    if (query.background !== undefined) (clauses.push("background = ?"), params.push(query.background ? 1 : 0));
    params.push(limit + 1);
    const rows = await this.#read.all<Row>(`SELECT record FROM ${T.tasks} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`, ...params);
    return page(rows.map((row) => parseJson<StoredTask>(row.record!)), limit, start.order);
  }

  async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    this.#assertOpen();
    const row = await this.#read.get<Row>(`SELECT record FROM ${T.submissions} WHERE run_id = ? AND id = ?`, this.#runId, id as unknown as number);
    return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record!);
  }

  async scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<SubmissionRecord, Cursor>> {
    this.#assertOpen();
    const start = scanStart(query.order as ScanOrder | undefined, cursor, "ascending");
    const scan = scanSql(start);
    const clauses = ["run_id = ?", scan.clause];
    const params: SqliteValue[] = [this.#runId, scan.param];
    if (query.conversationId !== undefined) (clauses.push("conversation_id = ?"), params.push(query.conversationId as unknown as number));
    if (query.status !== undefined) (clauses.push("status = ?"), params.push(query.status));
    params.push(limit + 1);
    const rows = await this.#read.all<Row>(`SELECT record FROM ${T.submissions} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`, ...params);
    return page(rows.map((row) => parseJson<SubmissionRecord>(row.record!)), limit, start.order);
  }

  async submissionByRequest(conversationId: ConversationId, requestId: string, _context: Context): Promise<SubmissionRecord | undefined> {
    this.#assertOpen();
    const row = await this.#read.get<Row>(`SELECT record FROM ${T.submissions} WHERE run_id = ? AND conversation_id = ? AND request_id = ?`, this.#runId, conversationId as unknown as number, encodeIndexedString(requestId));
    return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record!);
  }

  async findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
    this.#assertOpen();
    const parts = addressParts(address);
    const sql =
      at === "current"
        ? `SELECT record FROM ${T.documents}
          WHERE run_id = ? AND kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
          AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
        : `SELECT record FROM ${T.documents}
          WHERE run_id = ? AND kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
          AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
          ORDER BY created_at DESC LIMIT 1`;
    const params: SqliteValue[] = [this.#runId, parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
    if (at !== "current") params.push(at as unknown as number, at as unknown as number);
    const row = await this.#read.get<Row>(sql, ...params);
    return row === undefined ? undefined : parseJson<DocumentRecord>(row.record!);
  }

  async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
    this.#assertOpen();
    // The record and revision queries must observe one committed state; a commit between them can replace the base.
    // One snapshot for both queries, in a deferred read transaction: no writer lock, so a read never waits behind a write.
    return this.#db.transaction((tx) => this.#materializeDocument(tx, id as unknown as number, at), { read: true });
  }

  async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<DocumentRecord, Cursor>> {
    this.#assertOpen();
    const scope = scopeColumns(query.scope);
    const clauses = ["run_id = ?", "scope_kind = ?", "owner_id = ?", "id > ?"];
    const params: SqliteValue[] = [this.#runId, scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
    if (query.kind !== undefined) (clauses.push("kind = ?"), params.push(encodeIndexedString(query.kind)));
    if (query.at === "current") clauses.push("retired_at IS NULL");
    else (clauses.push("created_at <= ?", "(retired_at IS NULL OR retired_at > ?)"), params.push(query.at as unknown as number, query.at as unknown as number));
    params.push(limit + 1);
    const rows = await this.#read.all<Row>(`SELECT record FROM ${T.documents} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`, ...params);
    return page(rows.map((row) => parseJson<DocumentRecord>(row.record!)), limit);
  }

  /**
   * The run's commits after `afterSeq`, in seq order, at most `limit`, for the live view: each with its own entries, the
   * documents it changed (each's value at that seq, a latest-only one's as that commit wrote it; a retired one marked
   * `retired`, with no value), and the tasks and submissions it wrote, as it wrote them (pi_commit_writes), so a replay
   * equals the live view. One
   * transaction, so the page is one committed state. `next`: the last seq returned, when commits may follow it. A
   * run's seqs are consecutive from 1 (each stored batch takes the next), so a commit that wrote only a conversation is
   * one too, with nothing listed.
   */
  async commitsAfter(afterSeq: number, limit: number, _context: Context): Promise<JournalPage> {
    this.#assertOpen();
    // One snapshot in a deferred read transaction: a reader never takes the writer's lock.
    return this.#admitRead(() =>
      this.#db.transaction(async (tx) => {
        const metadata = await this.#readMetadata(tx);
        const last = Number(metadata.next_seq) - 1;
        const from = Math.max(0, Math.floor(Number(afterSeq) || 0));
        const upto = Math.min(last, from + Math.max(0, Math.floor(limit)));
        const commits: JournalCommit[] = [];
        for (let seq = from + 1; seq <= upto; seq++) commits.push(await this.#commitAt(tx, seq));
        return upto < last && commits.length > 0 ? { commits, next: upto } : { commits };
      }, { read: true }),
    );
  }

  async #commitAt(tx: SqliteExecutor, seq: number): Promise<JournalCommit> {
    const run = this.#runId;
    const entries = (await tx.all<Row>(`SELECT record FROM ${T.entries} WHERE run_id = ? AND commit_seq = ? ORDER BY id`, run, seq)).map((row) => parseJson<EntryRecord>(row.record!));
    // This commit's own writes, as it wrote them (pi_commit_writes), never the rows as later commits left them.
    const logged = await tx.all<{ kind: string; id: number; value: string }>(`SELECT kind, id, value FROM ${T.commitWrites} WHERE run_id = ? AND seq = ? ORDER BY kind, id`, run, seq);
    const tasks = logged.filter((row) => row.kind === "task").map((row) => parseJson<StoredTask>(row.value));
    const submissions = logged.filter((row) => row.kind === "submission").map((row) => parseJson<SubmissionRecord>(row.value));
    const latestOnly = new Map(logged.filter((row) => row.kind === "document").map((row) => [row.id, parseJson<{ value?: JsonValue; retired?: true }>(row.value)]));
    const changed = await tx.all<{ id: number }>(
      `SELECT document_id AS id FROM ${T.documentRevisions} WHERE run_id = ? AND seq = ?
        UNION SELECT id FROM ${T.documents} WHERE run_id = ? AND (created_at = ? OR retired_at = ?) ORDER BY id`,
      run, seq, run, seq, seq,
    );
    const documents: JournalDocument[] = [];
    // A latest-only document's revision of this commit is gone once a later commit wrote it: its log row names it.
    const ids = [...new Set([...changed.map((row) => row.id), ...latestOnly.keys()])].sort((a, b) => a - b);
    for (const id of ids) {
      const row = await tx.get<Row>(`SELECT record FROM ${T.documents} WHERE run_id = ? AND id = ?`, run, id);
      if (row === undefined) continue;
      const record = parseJson<DocumentRecord & { retiredAt?: number }>(row.record!);
      const scope = record.scope as { kind: string; conversationId?: ConversationId };
      const head = { id: record.id, kind: record.kind, ...(scope.kind === "conversation" ? { conversationId: scope.conversationId } : {}) };
      if (isCurrentOnly(record)) {
        // A document that keeps only its latest value: as this commit wrote it (its log row), if it wrote it.
        const written = latestOnly.get(id);
        if (written?.retired) documents.push({ ...head, retired: true });
        else if (written) documents.push({ ...head, value: written.value as JsonValue });
        continue;
      }
      if (record.retiredAt === seq) {
        documents.push({ ...head, retired: true });
        continue;
      }
      // Its value at this seq (a document that keeps its history).
      const stored = await this.#materializeDocument(tx, id, seq as unknown as DocumentPoint);
      if (stored) documents.push({ ...head, value: (stored as unknown as { value: JsonValue }).value });
    }
    return { seq: seqOf(seq), entries, documents, tasks, submissions };
  }

  /** Every later operation rejects; reads admitted and commits asked before it end first (a commit's outcome is its
   *  caller's, never the close's). The store's connection stays open: the store owns it. */
  close(_context: Context): Promise<void> {
    if (this.#closing === undefined) {
      this.#closed = true;
      this.#onClose?.();
      const reads = this.#admittedReads > 0 ? new Promise<void>((resolve) => (this.#readsDrained = resolve)) : Promise.resolve();
      const commits = [...this.#pending].map((commit) => commit.then(() => undefined, () => undefined));
      this.#closing = Promise.all([reads, ...commits]).then(() => undefined);
    }
    return this.#closing;
  }

  /** A read of several queries: close waits for it, so its later queries never run on a closed journal. */
  async #admitRead<R>(read: () => Promise<R>): Promise<R> {
    this.#assertOpen();
    this.#admittedReads++;
    try {
      return await read();
    } finally {
      if (--this.#admittedReads === 0) this.#readsDrained?.();
    }
  }

  async #readConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
    const row = await this.#read.get<Row>(`SELECT record FROM ${T.conversations} WHERE run_id = ? AND id = ?`, this.#runId, id as unknown as number);
    return row === undefined ? undefined : parseJson<ConversationRecord>(row.record!);
  }

  async #materializeDocument(executor: SqliteExecutor, id: number, at: DocumentPoint): Promise<StoredDocument | undefined> {
    const row = await executor.get<Row>(`SELECT record FROM ${T.documents} WHERE run_id = ? AND id = ?`, this.#runId, id);
    if (row === undefined) return undefined;
    const record = parseJson<DocumentRecord>(row.record!);
    if (at !== "current" && isCurrentOnly(record)) throw new StorageRequestError(`Document ${id} does not retain historical content`);
    if (!isAliveAt(record, at)) return undefined;
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : (at as unknown as number);
    const base = await executor.get<{ seq: number; kind: string; version: number; content: string }>(
      `SELECT seq, kind, version, content FROM ${T.documentRevisions}
        WHERE run_id = ? AND document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`,
      this.#runId,
      id,
      upper,
    );
    if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
    let value = parseJson<JsonValue>(base.content);
    const tail = await executor.all<{ seq: number; kind: string; version: number; content: string }>(
      `SELECT seq, kind, version, content FROM ${T.documentRevisions}
        WHERE run_id = ? AND document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
      this.#runId,
      id,
      base.seq,
      upper,
    );
    for (const revision of tail) {
      if (revision.kind !== "delta" || revision.version !== base.version) throw new Error(`Document ${id} crosses a stored version boundary without a base`);
      value = apply(value as never, parseJson(revision.content)) as JsonValue;
    }
    return { record, version: base.version, value, deltasSinceBase: tail.length } as unknown as StoredDocument;
  }

  #candidateNextId(writes: readonly StorageWrite[]): number {
    let nextId = this.#nextId;
    for (const write of writes) {
      const id = writeId(write);
      if (id !== undefined) nextId = Math.max(nextId, id + 1);
    }
    return nextId;
  }

  async #checkGlobalIds(executor: SqliteExecutor, writes: readonly StorageWrite[]): Promise<void> {
    const claimed = new Map<number, string>();
    for (const write of writes) {
      if (write.type === "document.change" || write.type === "document.retire") continue;
      const document = write.type === "document.create" || write.type === "document.copy";
      const table = document ? "document" : write.type;
      const id = (document ? write.record.id : write.value.id) as unknown as number;
      const existing = (await executor.get<{ record_type: string }>(`SELECT record_type FROM ${T.recordIds} WHERE run_id = ? AND id = ?`, this.#runId, id))?.record_type;
      const earlier = claimed.get(id);
      if (table === "conversation" || table === "entry" || table === "document") {
        if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
      } else {
        if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
      }
      claimed.set(id, table);
    }
  }

  #prepareDocumentActions(writes: readonly StorageWrite[]): Map<number, DocumentAction> {
    const actions = new Map<number, DocumentAction>();
    for (const write of writes) {
      if (write.type !== "document.create" && write.type !== "document.copy" && write.type !== "document.change" && write.type !== "document.retire") continue;
      const id = (write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id) as unknown as number;
      let action = actions.get(id);
      if (action === undefined) actions.set(id, (action = { retire: false }));
      switch (write.type) {
        case "document.create":
          if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) throw new Error(`Document ${id} has more than one content command`);
          action.create = write.record as unknown as DocumentRecord;
          action.content = write.content as DocumentContent;
          break;
        case "document.copy":
          if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) throw new Error(`Document ${id} has more than one content command`);
          action.create = write.record as unknown as DocumentRecord;
          action.copy = write.source as { id: DocumentId; at: DocumentPoint };
          break;
        case "document.change":
          if (action.content !== undefined || action.copy !== undefined) throw new Error(`Document ${id} has more than one content command`);
          action.content = write.content as DocumentContent;
          break;
        case "document.retire":
          if (action.retire) throw new Error(`Document ${id} is retired more than once`);
          action.retire = true;
          break;
      }
    }
    return actions;
  }

  async #checkDocumentActions(executor: SqliteExecutor, actions: Map<number, DocumentAction>): Promise<void> {
    const liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      if (action.copy !== undefined && actions.has(action.copy.id as unknown as number)) throw new Error(`Document copy ${id} source is changed in the copy batch`);
      const row = await executor.get<Row>(`SELECT record FROM ${T.documents} WHERE run_id = ? AND id = ?`, this.#runId, id);
      const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record!);
      if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
      if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
      if ((existing as { retiredAt?: number } | undefined)?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        const previous = await executor.get<{ version: number }>(`SELECT version FROM ${T.documentRevisions} WHERE run_id = ? AND document_id = ? ORDER BY seq DESC LIMIT 1`, this.#runId, id);
        if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
        if (previous.version !== action.content.version) throw new Error(`Document ${id} version transition requires a base`);
      }
      const record = (action.create ?? existing)!;
      const key = addressKey(record);
      let live = liveCounts.get(key);
      if (live === undefined) live = (await this.#currentDocumentId(executor, record)) === undefined ? 0 : 1;
      if (action.retire && existing !== undefined) live--;
      if (action.create !== undefined && !action.retire) live++;
      liveCounts.set(key, live);
    }
    for (const live of liveCounts.values()) if (live > 1) throw new Error("Document address already has a current incarnation");
  }

  async #currentDocumentId(executor: SqliteExecutor, address: DocumentAddress): Promise<number | undefined> {
    const parts = addressParts(address);
    const row = await executor.get<{ id: number }>(
      `SELECT id FROM ${T.documents}
        WHERE run_id = ? AND kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ? AND retired_at IS NULL
        LIMIT 1`,
      this.#runId,
      parts.kind,
      parts.scopeKind,
      parts.ownerId,
      parts.family,
      parts.keyValue,
    );
    return row?.id;
  }

  async #applyTableWrite(executor: SqliteExecutor, write: StorageWrite, seq: Seq): Promise<void> {
    const run = this.#runId;
    switch (write.type) {
      case "conversation": {
        const value = write.value as ConversationRecord & { owner?: { conversationId?: number; taskId?: number } };
        await this.#claimId(executor, value.id as unknown as number, "conversation");
        await executor.run(`INSERT INTO ${T.conversations} (run_id, id, owner_conversation_id, owner_task_id, record) VALUES (?, ?, ?, ?, ?)`, run, value.id as unknown as number, value.owner?.conversationId ?? null, value.owner?.taskId ?? null, encodeJson(value));
        break;
      }
      case "entry": {
        const value = write.value as EntryRecord & { head?: number };
        await this.#claimId(executor, value.id as unknown as number, "entry");
        await executor.run(`INSERT INTO ${T.entries} (run_id, id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?, ?)`, run, value.id as unknown as number, value.conversationId as unknown as number, value.head ?? null, seq as unknown as number, encodeJson(value));
        break;
      }
      case "task": {
        const value = write.value as StoredTask;
        await this.#claimId(executor, value.id as unknown as number, "task");
        await executor.run(
          `INSERT INTO ${T.tasks} (run_id, id, conversation_id, kind, status, abort_requested, background, seq, record)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
            status = excluded.status, abort_requested = excluded.abort_requested,
            background = excluded.background, seq = excluded.seq, record = excluded.record`,
          run,
          value.id as unknown as number,
          value.conversationId as unknown as number,
          encodeIndexedString(value.kind),
          (value.state as { status: string }).status,
          value.abortRequested ? 1 : 0,
          value.background ? 1 : 0,
          seq as unknown as number,
          encodeJson(value),
        );
        break;
      }
      case "submission": {
        const value = write.value as SubmissionRecord & { requestId?: string };
        await this.#claimId(executor, value.id as unknown as number, "submission");
        await executor.run(
          `INSERT INTO ${T.submissions} (run_id, id, conversation_id, request_id, status, seq, record) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, id) DO UPDATE SET conversation_id = excluded.conversation_id,
            request_id = excluded.request_id, status = excluded.status, seq = excluded.seq, record = excluded.record`,
          run,
          value.id as unknown as number,
          value.conversationId as unknown as number,
          value.requestId === undefined ? null : encodeIndexedString(value.requestId),
          value.status,
          seq as unknown as number,
          encodeJson(value),
        );
        break;
      }
      default:
        break;
    }
  }

  async #claimId(executor: SqliteExecutor, id: number, table: string): Promise<void> {
    await executor.run(`INSERT OR IGNORE INTO ${T.recordIds} (run_id, id, record_type) VALUES (?, ?, ?)`, this.#runId, id, table);
  }

  /** Resolve each copy to a base of its source's state before this batch, which may not change the source. */
  async #resolveCopies(executor: SqliteExecutor, actions: Map<number, DocumentAction>): Promise<void> {
    for (const [id, action] of actions) {
      if (action.copy === undefined) continue;
      try {
        const stored = (await this.#materializeDocument(executor, action.copy.id as unknown as number, action.copy.at)) as unknown as { record: DocumentRecord & Record<string, unknown>; version: number; value: JsonValue } | undefined;
        if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
        const create = action.create! as DocumentRecord & Record<string, unknown>;
        if (
          stored.record.scope.kind !== "conversation" ||
          create.scope.kind !== "conversation" ||
          stored.record.kind !== create.kind ||
          stored.record.key !== create.key ||
          stored.record.history !== create.history ||
          stored.record.fork !== create.fork
        ) {
          throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
        }
        action.content = { kind: "base", version: stored.version, value: stored.value };
      } catch (error) {
        throw new Error(`Document copy ${id} was rejected`, { cause: error });
      }
    }
  }

  async #applyDocumentActions(executor: SqliteExecutor, actions: Map<number, DocumentAction>, seq: Seq): Promise<void> {
    const run = this.#runId;
    const at = seq as unknown as number;
    for (const [id, action] of actions) {
      // Copies are resolved to their content by #resolveCopies.
      const content = action.content;
      let record: DocumentRecord;
      if (action.create !== undefined) {
        record = { ...action.create, createdAt: seq, ...(action.retire ? { retiredAt: seq } : {}) } as DocumentRecord;
        const parts = addressParts(record);
        await this.#claimId(executor, id, "document");
        await executor.run(
          `INSERT INTO ${T.documents}
            (run_id, id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          run,
          id,
          parts.kind,
          parts.family,
          parts.keyValue,
          parts.scopeKind,
          parts.ownerId,
          at,
          action.retire ? at : null,
          encodeJson(record),
        );
      } else {
        const row = (await executor.get<Row>(`SELECT record FROM ${T.documents} WHERE run_id = ? AND id = ?`, run, id))!;
        record = parseJson<DocumentRecord>(row.record!);
      }
      if (content !== undefined) {
        if (content.kind === "base" && isCurrentOnly(record)) await executor.run(`DELETE FROM ${T.documentRevisions} WHERE run_id = ? AND document_id = ?`, run, id);
        const encoded = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
        await executor.run(`INSERT INTO ${T.documentRevisions} (run_id, document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?, ?)`, run, id, at, content.kind, content.version, encoded);
      }
      if (action.retire) {
        if (action.create === undefined) {
          record = { ...record, retiredAt: seq } as DocumentRecord;
          await executor.run(`UPDATE ${T.documents} SET retired_at = ?, record = ? WHERE run_id = ? AND id = ?`, at, encodeJson(record), run, id);
        }
        if (isCurrentOnly(record)) await executor.run(`DELETE FROM ${T.documentRevisions} WHERE run_id = ? AND document_id = ?`, run, id);
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("RunStorage is closed");
  }
}
