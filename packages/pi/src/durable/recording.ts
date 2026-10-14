// A run's store as durable recording lines (agentrun.recording/1, section 3.1). Three readers share one mapper, so a
// commit gives the same lines whichever reads it:
//   - recordCommits, inside the run's process, maps each commit pi publishes as it is adopted (the full history,
//     tasks at their real commit);
//   - snapshotLines writes every document at one commit, for a process to record after it opens the run;
//   - recordingLines reads a store file no process holds: the history pi kept (it deletes a current-only document's
//     older revisions when it writes a new base, and the driver document checkpoints every 32 deltas).
import { apply } from "@earendil-works/chord/delta";
import type { CommitPublication, Session, Storage } from "@earendil-works/pi-durable";
import { withDurableFile } from "./readers.js";

type Database = import("node:sqlite").DatabaseSync;
type Json = any;
type Context = Parameters<Session["commit"]>[1];

/** Who owns a line's record, by its kind's package prefix; a kind with no package prefix is the host's. */
export type RecordingSource = "workflow" | "pi" | "browser" | "vision" | "transport" | "host";

/** One durable line: a document revision (`data` is `{ doc, key?, value, version }`, the whole value after the
 *  revision), a conversation entry (`data` is the entry as stored), or a task's record (`data` as stored). */
export type RecordingLine = {
  channel: "durable";
  source: RecordingSource;
  /** The document's kind, the entry's own `kind`, or the task's kind. */
  kind: string;
  /** The generation of the latest `agentrun.driver` revision at or before `commit`; absent when there is none. */
  gen?: number;
  /** The store's commit sequence. */
  commit: number;
  /** The line's place inside its commit: documents by id, then entries by id, then tasks by id. */
  order: number;
  /** The workflow execution path the record is about, when the record names one. */
  path?: string;
  /** The pi conversation the record belongs to, when it belongs to one. */
  conv?: number;
  /** Present on a line `recordCommits` wrote: when the process adopted the commit, by the recorder's clock. */
  t?: number;
  /** Present on `snapshotLines`' lines: a document's state at `commit`, not a change made there. */
  snapshot?: true;
  data: Json;
};

/** A line before it is numbered inside its commit: a document, then an entry, then a task, each by id. */
type Placed = { commit: number; rank: 0 | 1 | 2; id: number; line: Omit<RecordingLine, "order" | "gen"> };

const PREFIXES: Array<[string, RecordingSource]> = [["agentrun.", "workflow"], ["browser.", "browser"], ["vision.", "vision"], ["transport.", "transport"], ["pi.", "pi"]];
const sourceOf = (kind: string): RecordingSource => PREFIXES.find(([prefix]) => kind.startsWith(prefix))?.[1] ?? "host";

/** The execution path a document names: an effect's id is `<frame>:<path>#call:<n>` after the journal key and NUL
 *  (`frozenEffectId`; read as the DSL's `frozenEffectPath` reads it), a node attempt's key is
 *  `<driver>:<label>:<frame>:<path>:a<n>` (`frozenStepSessionId`), and any other value may carry `executionPath` or
 *  `execution_path`. */
function pathOf(kind: string, key: string | undefined, value: Json): string | undefined {
  if (kind === "agentrun.effects" && key !== undefined) return /^[^:]+:(.*)#call:(\d+)$/s.exec(key.slice(key.indexOf("\u0000") + 1))?.[1];
  if (kind === "agentrun.nodes" && key !== undefined) return /:(?:step|adapt):(\/.*):a\d+$/.exec(key)?.[1];
  const named = value?.executionPath ?? value?.execution_path;
  return typeof named === "string" ? named : undefined;
}

/** A document revision: `key` is the family key (absent for a singleton), `conv` the conversation the document
 *  belongs to (its scope's, or its task's). */
function documentLine(id: number, kind: string, key: string | undefined, value: Json, version: number, conv: number | undefined, commit: number): Placed {
  const path = pathOf(kind, key, value);
  return { commit, rank: 0, id, line: {
    channel: "durable", source: sourceOf(kind), kind, commit, ...(path !== undefined ? { path } : {}), ...(conv !== undefined ? { conv } : {}),
    data: { doc: kind, ...(key !== undefined ? { key } : {}), value, version },
  } };
}
const entryLine = (entry: Json, commit: number): Placed => ({ commit, rank: 1, id: Number(entry.id), line: {
  channel: "durable", source: "pi", kind: String(entry?.kind ?? "pi.entry"), commit, conv: Number(entry.conversationId), data: entry,
} });
const taskLine = (task: Json, commit: number): Placed => {
  const kind = String(task.kind);
  return { commit, rank: 2, id: Number(task.id), line: { channel: "durable", source: sourceOf(kind), kind, commit, conv: Number(task.conversationId), data: task } };
};

/** Lines in `(commit, order)` order, each with the generation `genAt` gives its commit. */
function numbered(placed: Placed[], genAt: (commit: number) => number | undefined, extra: Partial<RecordingLine> = {}): RecordingLine[] {
  placed.sort((a, b) => a.commit - b.commit || a.rank - b.rank || a.id - b.id);
  const lines: RecordingLine[] = [];
  for (let i = 0; i < placed.length; i += 1) {
    const { commit, line } = placed[i]!;
    const order = i > 0 && placed[i - 1]!.commit === commit ? lines[i - 1]!.order + 1 : 0;
    const gen = genAt(commit);
    const { data, ...rest } = line;
    lines.push({ ...rest, ...(gen !== undefined ? { gen } : {}), order, ...extra, data });
  }
  return lines;
}

/** Every surviving `agentrun.driver` revision as `[commit, generation]`, in commit order. */
function driverGenerations(db: Database): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const { id } of db.prepare("SELECT id FROM documents WHERE kind = ?").all(JSON.stringify("agentrun.driver")) as Array<{ id: number }>) {
    let value: Json;
    for (const rev of db.prepare("SELECT seq, kind, content FROM document_revisions WHERE document_id = ? ORDER BY seq").all(id) as Array<{ seq: number; kind: string; content: string }>) {
      value = rev.kind === "base" ? JSON.parse(rev.content) : apply(structuredClone(value), JSON.parse(rev.content));
      if (typeof value?.generation === "number") out.push([rev.seq, value.generation]);
    }
  }
  // Two journals' revisions in one commit: the higher generation.
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Every change the store `file` committed after `after` (default: all), as durable recording lines in `(commit, order)`
 * order, and `last`, the highest commit returned (`after` when nothing is). For a store no process holds (a disk run's
 * store admits one connection): read-only, in one read transaction.
 *
 * - A document revision is a line of the document's kind, with the whole value after it (each delta applied over its
 *   base); `key` is the family key as stored, absent for a singleton.
 * - A conversation entry is a line of the entry's own kind, source `pi`, `conv` its conversation, the entry as stored
 *   (image blocks included: the recorder moves them to blobs).
 * - Every task's current record is a line of the task's kind, at the store's last commit, after that commit's other
 *   lines, by task id: the state at export, since the store keeps no commit for a task's change. Its memos ride in the
 *   record; there are no memo lines.
 * - `gen` is the generation of the latest surviving `agentrun.driver` revision at or before the line's commit (it
 *   counts journal opens, not processes), and absent before the earliest surviving one. No line has `t`: the store
 *   keeps no commit time.
 *
 * This is the store's surviving history: pi deletes a current-only document's older revisions when it writes a new
 * base. The full history is `recordCommits`', written inside the run's process as each commit lands.
 */
export function recordingLines(file: string, options: { after?: number } = {}): { lines: RecordingLine[]; last: number } {
  const after = options.after ?? 0;
  return withDurableFile(file, (db) => {
    const placed: Placed[] = [];
    const taskConversation = new Map((db.prepare("SELECT id, conversation_id FROM tasks").all() as Array<{ id: number; conversation_id: number }>).map((task) => [task.id, task.conversation_id]));
    const docs = db.prepare("SELECT DISTINCT d.id, d.kind, d.family, d.key_value, d.scope_kind, d.owner_id FROM documents d JOIN document_revisions r ON r.document_id = d.id WHERE r.seq > ?")
      .all(after) as Array<{ id: number; kind: string; family: number; key_value: string; scope_kind: string; owner_id: number }>;
    for (const doc of docs) {
      const kind = JSON.parse(doc.kind) as string;
      const key = doc.family === 1 ? JSON.parse(doc.key_value) as string : undefined;
      const conv = doc.scope_kind === "conversation" ? doc.owner_id : doc.scope_kind === "task" ? taskConversation.get(doc.owner_id) : undefined;
      let value: Json;
      for (const rev of db.prepare("SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq").all(doc.id) as Array<{ seq: number; kind: string; version: number; content: string }>) {
        value = rev.kind === "base" ? JSON.parse(rev.content) : apply(structuredClone(value), JSON.parse(rev.content));
        if (rev.seq > after) placed.push(documentLine(doc.id, kind, key, structuredClone(value), rev.version, conv, rev.seq));
      }
    }
    for (const entry of db.prepare("SELECT commit_seq, record FROM entries WHERE commit_seq > ?").all(after) as Array<{ commit_seq: number; record: string }>) {
      placed.push(entryLine(JSON.parse(entry.record), entry.commit_seq));
    }
    const end = (db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as { next_seq: number }).next_seq - 1;
    if (end > after) for (const task of db.prepare("SELECT record FROM tasks").all() as Array<{ record: string }>) placed.push(taskLine(JSON.parse(task.record), end));
    const generations = driverGenerations(db);
    let at = 0;
    const lines = numbered(placed, (commit) => {
      while (at < generations.length && generations[at]![0] <= commit) at += 1;
      return at > 0 ? generations[at - 1]![1] : undefined;
    });
    return { lines, last: lines.length ? lines[lines.length - 1]!.commit : after };
  }) ?? { lines: [], last: after };
}

/** The lines of one commit pi published, as `recordingLines` would give them, with `gen` the generation in force. */
function publicationLines(publication: CommitPublication, gen: number | undefined): { lines: RecordingLine[]; gen: number | undefined } {
  const commit = Number(publication.seq);
  const placed: Placed[] = [];
  let next = gen;
  for (const change of publication.changes) {
    if (change.type === "document") {
      // A retirement adopts no value and the store keeps no revision for it.
      if (change.value === null || change.version === undefined) continue;
      const { record } = change;
      placed.push(documentLine(Number(record.id), record.kind, record.key, structuredClone(change.value), change.version, change.conversationId === undefined ? undefined : Number(change.conversationId), commit));
      const generation = (change.value as { generation?: unknown }).generation;
      if (record.kind === "agentrun.driver" && typeof generation === "number") next = Math.max(next ?? generation, generation);
    } else if (change.type === "entry") placed.push(entryLine(structuredClone(change.value), commit));
    else if (change.type === "task") placed.push(taskLine(structuredClone(change.value), commit));
    // A conversation's or a submission's record, and a document copy (it carries no value), make no line.
  }
  return { lines: numbered(placed, () => next), gen: next };
}

/**
 * Records the run's commits as durable lines inside its process, on pi's commit publications: each commit adopted
 * after this call becomes the lines `recordingLines` would give it, with tasks at their real commit, `t` the adoption
 * time (`clock()`, default `Date.now()`), and `gen` the generation of the latest `agentrun.driver` revision at or
 * before the commit (`gen` until the process writes its first one).
 *
 * The listener only maps and queues: it never throws, blocks or calls the Session. `write` receives one commit's lines
 * at a time, in commit order, after the listener has returned; a commit in flight when the process dies is lost, and
 * the next process's `snapshotLines` restores the state. The returned stop ends the subscription, waits for every
 * queued write, and then throws the first write that failed.
 */
export function recordCommits(session: Pick<Session, "subscribeCommits">, options: { gen?: number; write: (lines: RecordingLine[]) => void | Promise<void>; clock?: () => number }): () => Promise<void> {
  const clock = options.clock ?? Date.now;
  let gen = options.gen;
  let chain: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | undefined;
  const unsubscribe = session.subscribeCommits((publication) => {
    try {
      const t = clock();
      const mapped = publicationLines(publication, gen);
      gen = mapped.gen;
      if (mapped.lines.length === 0) return;
      const lines = mapped.lines.map((line) => ({ ...line, t }));
      chain = chain.then(() => options.write(lines)).catch((error) => { failure ??= { error }; });
    } catch (error) { failure ??= { error }; }
  });
  return async () => {
    unsubscribe();
    await chain;
    if (failure) throw failure.error;
  };
}

/** Every page of a storage scan. */
async function scanAll<T, C>(scan: (cursor: C | undefined) => Promise<{ readonly items: readonly T[]; readonly next?: C }>): Promise<T[]> {
  const out: T[] = [];
  let cursor: C | undefined;
  do {
    const page = await scan(cursor);
    out.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return out;
}

/**
 * Every document of the run as it stands, as whole values marked `snapshot: true` at commit `at`, in document id order:
 * the state a process records after it opens the run and before it resumes, so the recording is exact after any kill.
 * `storage` is the store the run's Harness was opened over; `at` is the store's latest commit (pi's `Storage` has no
 * head query: a disk run reads it with pi-durable-disk's `storeHead`). The reads are of the current state (pi keeps no
 * past revision of a session or task document), so the snapshot is exact only while nothing commits: take it before
 * the run resumes. `gen` defaults to the highest `agentrun.driver` generation in it.
 */
export async function snapshotLines(storage: Pick<Storage, "scanConversations" | "scanTasks" | "scanDocuments" | "document">, options: { at: number; gen?: number; context: Context }): Promise<RecordingLine[]> {
  const { at, context } = options;
  const page = 256;
  const conversations = await scanAll((cursor) => storage.scanConversations({}, page, cursor as never, context));
  const tasks = await scanAll((cursor) => storage.scanTasks({}, page, cursor as never, context));
  const scopes: Array<{ scope: Parameters<Storage["scanDocuments"]>[0]["scope"]; conv: number | undefined }> = [
    { scope: { kind: "session" }, conv: undefined },
    ...conversations.map((conversation) => ({ scope: { kind: "conversation" as const, conversationId: conversation.id }, conv: Number(conversation.id) })),
    ...tasks.map((task) => ({ scope: { kind: "task" as const, taskId: task.id }, conv: Number(task.conversationId) })),
  ];
  const placed: Placed[] = [];
  let driverGen: number | undefined;
  for (const { scope, conv } of scopes) {
    for (const record of await scanAll((cursor) => storage.scanDocuments({ scope, at: "current" }, page, cursor as never, context))) {
      const stored = await storage.document(record.id, "current", context);
      if (!stored) continue;
      placed.push(documentLine(Number(record.id), record.kind, record.key, structuredClone(stored.value), stored.version, conv, at));
      const generation = (stored.value as { generation?: unknown }).generation;
      if (record.kind === "agentrun.driver" && typeof generation === "number") driverGen = Math.max(driverGen ?? generation, generation);
    }
  }
  const gen = options.gen ?? driverGen;
  return numbered(placed, () => gen, { snapshot: true });
}
