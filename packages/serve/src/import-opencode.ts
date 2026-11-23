// The sessions OpenCode keeps under a person's home, read into the importer's Session shape (import-sources.ts).
//   ~/.local/share/opencode/opencode.db (opencode-<channel>.db for a dev or preview channel), SQLite. A 1.x database
//     keeps each session in `session`, its messages in `message` and their parts in `part`, each row's `data` the
//     message or part as JSON. A 2.x database keeps its own in `session_v2`, `session_message` (one row per message, typed)
//     and `session_part` (an assistant message's content), and the 1.x tables beside them, copied over as it opens them.
//   ~/.local/share/opencode/storage/, the JSON OpenCode wrote before SQLite: session/<project>/<session>.json,
//     message/<session>/<message>.json, part/<message>/<part>.json. A session the database also holds is the database's.
// Schema from anomalyco/opencode: v1.19.5 (packages/core/src/session/sql.ts, packages/schema/src/v1/session.ts,
// packages/opencode/src/storage/storage.ts) and dev at 23fd3da786 (packages/core/src/session/sql.ts,
// packages/schema/src/session-message.ts, packages/core/src/database/migration/). A row or file that is not JSON, or
// not a record known here, is passed over.
//
// Tokens: OpenCode stores `input` without the cache reads and writes (both since its AI SDK 6 move, which subtracts
// them, and before, when it subtracted them for the providers whose count held them), and `output` without the
// reasoning, which it keeps in `reasoning`. The importer's output holds the reasoning, as Codex's does. An older
// OpenCode's output held it already: where a step records its `total`, the output is what the total leaves after the
// input and the cache.
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ACTIVE_GAP_MS, mostEffortOf, personsWords, type Ended, type Session, type ToolCall, type Turn, type Usage } from "./import-sources.js";

/** An OpenCode session: the importer's Session, of the source "opencode". */
export type OpenCodeSession = Omit<Session, "source"> & { source: "opencode" };
type Answer = Extract<Turn, { role: "assistant" }>;
type Row = Record<string, unknown>;
type Options = { turns?: boolean };

const isObject = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const json = (value: unknown): unknown => {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};
const effortOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "default" && /^[\w-]{1,32}$/.test(value) ? value : undefined);
const modelOf = (provider: unknown, model: unknown): string | undefined => (str(provider) && str(model) ? `${provider as string}/${model as string}` : undefined);
// The title OpenCode gives a session until it writes one (a subagent's keeps it): no title.
const DEFAULT_TITLE = /^(?:New|Child) session - \d{4}-\d\d-\d\dT/;

/** A request's tokens in OpenCode's shape ({input, output, reasoning, cache: {read, write}, total?}) as the importer
 *  counts them; undefined when they are not counts, or all nought (a request cut before its usage came). */
export function usageOf(tokens: unknown): Usage | undefined {
  if (!isObject(tokens)) return undefined;
  const cache = isObject(tokens.cache) ? tokens.cache : {};
  const [input, output, reasoning, cacheRead, cacheWrite] = [tokens.input, tokens.output, tokens.reasoning ?? 0, cache.read ?? 0, cache.write ?? 0].map((value) => {
    const n = count(value);
    return n === undefined ? undefined : Math.round(n);
  });
  if (input === undefined || output === undefined || reasoning === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  const total = count(tokens.total);
  const left = total === undefined ? -1 : Math.round(total) - input - cacheRead - cacheWrite;
  const usage = { input, output: left >= output ? left : output + reasoning, cacheRead, cacheWrite };
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ? usage : undefined;
}

/** One session as it is read: its turns, the times of its records, and what a listing shows. */
class Reading {
  readonly session: OpenCodeSession;
  private readonly times: number[] = [];
  private readonly created?: number;
  private readonly updated?: number;
  private cost = 0;
  private unpriced = false;
  constructor(
    head: { id: string; file: string; cwd?: string; parent?: string; title?: string; model?: string; created?: number; updated?: number },
    private readonly keep: boolean,
  ) {
    this.session = { source: "opencode", id: head.id, file: head.file, state: "completed", child: false, turns: [], users: 0, activeMs: 0, copies: 0 };
    if (head.cwd) this.session.cwd = head.cwd;
    if (head.model) this.session.model = head.model;
    if (head.parent) Object.assign(this.session, { child: true, parent: head.parent });
    if (head.title && !DEFAULT_TITLE.test(head.title)) this.session.sourceTitle = head.title;
    this.created = head.created;
    this.updated = head.updated;
  }
  at(...times: unknown[]): void {
    for (const at of times) if (count(at) !== undefined) this.times.push(at as number);
  }
  add(turn: Turn): void {
    if (turn.role === "user") {
      this.session.users += 1;
      this.session.firstPrompt ??= turn.text;
      const words = personsWords(turn.text);
      if (words !== undefined) this.session.titleText ??= words;
    }
    if (this.keep) this.session.turns.push(turn);
  }
  answer(at: number, model: string | undefined, effort: string | undefined): Answer {
    if (model) this.session.model = model;
    const turn: Answer = { role: "assistant", text: "", calls: [], at, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    this.add(turn);
    return turn;
  }
  call(turn: Answer, id: string, name: string, input: unknown): void {
    turn.calls.push({ type: "toolCall", id, name, arguments: isObject(input) ? input : {} } satisfies ToolCall);
  }
  result(callId: string, name: string, text: string, isError: boolean, at: number): void {
    this.add({ role: "toolResult", callId, name, text, isError, at });
  }
  /** A message's cost, which the session's sums; unknown once a request with usage has none. */
  priced(cost: unknown, used: boolean): void {
    const usd = count(cost);
    if (usd !== undefined) this.cost += usd;
    else if (used) this.unpriced = true;
  }
  ended(state: Ended): void {
    this.session.state = state;
  }
  done(): OpenCodeSession {
    const session = this.session;
    if (!this.unpriced) session.costUsd = this.cost;
    const times = this.times.sort((a, b) => a - b);
    const first = times[0] ?? this.created;
    const last = times.at(-1) ?? this.updated;
    if (first !== undefined) session.startedAt = new Date(first).toISOString();
    if (last !== undefined) session.endedAt = new Date(last).toISOString();
    for (let i = 1; i < times.length; i += 1) if (times[i]! - times[i - 1]! <= ACTIVE_GAP_MS) session.activeMs += times[i]! - times[i - 1]!;
    const effort = mostEffortOf(session.turns);
    if (effort) session.effort = effort;
    return session;
  }
}

/** A 1.x error's message ({name, data: {message}}), or a 2.x one's ({type, message}). */
const errorOf = (error: unknown): string | undefined =>
  isObject(error) ? (str(isObject(error.data) ? error.data.message : undefined) ?? str(error.message) ?? str(error.name) ?? str(error.type) ?? "unknown error") : undefined;

/** One 1.x session from its row or file, its messages (each with its parts) in the order OpenCode keeps them. */
function v1Session(head: ConstructorParameters<typeof Reading>[0], messages: { info: Row; parts: Row[] }[], keep: boolean): OpenCodeSession {
  const reading = new Reading(head, keep);
  for (const { info, parts } of messages) {
    const time = isObject(info.time) ? info.time : {};
    const created = count(time.created) ?? 0;
    reading.at(time.created, time.completed);
    if (info.role === "user") {
      const text = parts
        .filter((part) => part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true)
        .map((part) => part.text as string)
        .join("\n");
      if (text) reading.add({ role: "user", text, at: created });
      continue;
    }
    if (info.role !== "assistant") continue;
    if (!head.cwd && isObject(info.path) && str(info.path.cwd)) reading.session.cwd = info.path.cwd as string;
    const model = modelOf(info.providerID, info.modelID);
    const effort = effortOf(info.variant);
    // Each step is one request, its usage and cost on the step-finish part that ends it; a message with no step-finish
    // (an older OpenCode's) is one request, its usage the message's.
    let turn: Answer | undefined;
    let turns = 0;
    let stepped = false;
    let last: Answer | undefined;
    const open = (at?: number): Answer => {
      if (!turn) {
        turn = last = reading.answer(turns === 0 ? created : (at ?? last?.at ?? created), model, effort);
        turns += 1;
      }
      return turn;
    };
    for (const part of parts) {
      const partTime = isObject(part.time) ? count(part.time.start) : undefined;
      if (part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true) {
        const into = open(partTime);
        into.text = [into.text, part.text].filter(Boolean).join("\n");
      } else if (part.type === "tool" && isObject(part.state)) {
        const state = part.state;
        const id = String(part.callID ?? "");
        const name = String(part.tool ?? "");
        const span = isObject(state.time) ? state.time : {};
        reading.at(span.start, span.end);
        reading.call(open(count(span.start)), id, name, state.input);
        const end = count(span.end) ?? count(span.start) ?? created;
        if (state.status === "completed") reading.result(id, name, typeof state.output === "string" ? state.output : "", false, end);
        else if (state.status === "error") reading.result(id, name, str(state.error) ?? "", true, end);
      } else if (part.type === "step-finish") {
        stepped = true;
        const into = open();
        const usage = usageOf(part.tokens);
        if (usage) into.usage = usage;
        const cost = count(part.cost);
        if (cost !== undefined) into.costUsd = cost;
        if (str(part.id)) into.key = part.id as string;
        turn = undefined;
      }
    }
    const usage = usageOf(info.tokens);
    if (!stepped && (turns > 0 || usage)) {
      const into = open();
      if (usage) into.usage = usage;
      const cost = count(info.cost);
      if (cost !== undefined) into.costUsd = cost;
    }
    if (str(info.id) && last && !last.key) last.key = info.id as string;
    reading.priced(info.cost, usage !== undefined || stepped);
    const error = errorOf(info.error);
    const aborted = isObject(info.error) && info.error.name === "MessageAbortedError";
    if (error && !aborted) (last ?? open()).error = error;
    reading.ended(aborted ? "stopped" : error ? "failed" : "completed");
  }
  return reading.done();
}

/** A 2.x tool result's text: its content's text, a file named by its name. */
const contentText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((item) => (isObject(item) ? (typeof item.text === "string" ? item.text : item.type === "file" ? `[file${str(item.name) ? ` ${item.name as string}` : ""}]` : "") : ""))
        .filter(Boolean)
        .join("\n")
    : "";

const IDLE: Record<string, Ended> = { succeeded: "completed", failed: "failed", interrupted: "stopped" };
/** One 2.x session from its session_v2 row, its session_message rows in seq order, and its session_part rows'
 *  content by message. Rows a fork copied from its source (seq up to `copiedThrough`) are copies. */
function v2Session(head: ConstructorParameters<typeof Reading>[0], rows: Row[], parts: Map<string, unknown[]>, copiedThrough: number, keep: boolean): OpenCodeSession {
  const reading = new Reading(head, keep);
  for (const row of rows) {
    if (typeof row.seq === "number" && row.seq <= copiedThrough) {
      reading.session.copies += 1;
      continue;
    }
    const data = json(row.data);
    if (!isObject(data)) continue;
    const time = isObject(data.time) ? data.time : {};
    const created = count(time.created) ?? count(row.time_created) ?? 0;
    reading.at(created, time.completed);
    const model = isObject(data.model) ? modelOf(data.model.providerID, data.model.id) : undefined;
    if (row.type === "user" && typeof data.text === "string" && data.text) reading.add({ role: "user", text: data.text, at: created });
    else if (row.type === "model-switched" && model) reading.session.model = model;
    else if (row.type === "idle" && typeof data.outcome === "string" && IDLE[data.outcome]) reading.ended(IDLE[data.outcome]!);
    else if (row.type === "assistant" || (row.type === "compaction" && data.status !== "running")) {
      const turn = reading.answer(created, model ?? reading.session.model, isObject(data.model) ? effortOf(data.model.variant) : undefined);
      turn.key = String(row.id);
      if (row.type === "compaction" && typeof data.summary === "string") turn.text = data.summary;
      const content = [...(parts.get(String(row.id)) ?? []), ...(Array.isArray(data.content) ? data.content : [])];
      for (const item of content) {
        if (!isObject(item)) continue;
        if (item.type === "text" && typeof item.text === "string") turn.text = [turn.text, item.text].filter(Boolean).join("\n");
        else if (item.type === "tool" && isObject(item.state)) {
          const id = String(item.id ?? "");
          const name = String(item.name ?? "");
          const span = isObject(item.time) ? item.time : {};
          reading.at(span.created, span.completed);
          reading.call(turn, id, name, item.state.input);
          const end = count(span.completed) ?? count(span.created) ?? created;
          if (item.state.status === "completed") reading.result(id, name, contentText(item.state.content), false, end);
          else if (item.state.status === "error") reading.result(id, name, errorOf(item.state.error) ?? contentText(item.state.content), true, end);
        }
      }
      const usage = usageOf(data.tokens);
      if (usage) turn.usage = usage;
      const cost = count(data.cost);
      if (cost !== undefined) turn.costUsd = cost;
      reading.priced(data.cost, usage !== undefined);
      const error = errorOf(data.error);
      if (error) turn.error = error;
      if (row.type === "assistant") reading.ended(error ? "failed" : "completed");
    }
  }
  return reading.done();
}

type Db = { all(sql: string, ...params: (string | number)[]): Row[]; close(): void };
// Read through a variable: a Bun build bundles node:sqlite as missing, and Node has no bun:sqlite.
const BUN_SQLITE = "bun:sqlite";
const NODE_SQLITE = "node:sqlite";
/** `file` opened read-only: with Node's node:sqlite, or Bun's bun:sqlite under Bun (Bun 1.3 has no node:sqlite). */
async function openDb(file: string): Promise<Db> {
  if (process.versions.bun) {
    const { Database } = (await import(BUN_SQLITE)) as { Database: new (file: string, options: { readonly: boolean }) => { query(sql: string): { all(...params: unknown[]): Row[] }; close(): void } };
    const db = new Database(file, { readonly: true });
    return { all: (sql, ...params) => db.query(sql).all(...params), close: () => db.close() };
  }
  const { DatabaseSync } = (await import(NODE_SQLITE)) as typeof import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  return { all: (sql, ...params) => db.prepare(sql).all(...params) as Row[], close: () => db.close() };
}

const headOf = (row: Row, file: string) => ({
  id: String(row.id),
  file,
  ...(str(row.directory) ? { cwd: row.directory as string } : {}),
  ...(str(row.parent_id) ? { parent: row.parent_id as string } : {}),
  ...(str(row.title) ? { title: row.title as string } : {}),
  ...(count(row.time_created) !== undefined ? { created: row.time_created as number } : {}),
  ...(count(row.time_updated) !== undefined ? { updated: row.time_updated as number } : {}),
});

/** Every session of one opencode.db: its 2.x sessions, then the 1.x ones it has not moved to its 2.x tables. */
export async function readOpenCodeDb(file: string, { turns: keep = true }: Options = {}): Promise<OpenCodeSession[]> {
  const db = await openDb(file);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row.name)));
    const out: OpenCodeSession[] = [];
    const read = new Set<string>();
    if (tables.has("session_v2") && tables.has("session_message")) {
      for (const row of db.all("SELECT * FROM session_v2 ORDER BY time_created, id")) {
        const stored = json(row.model);
        const head = { ...headOf(row, file), ...(isObject(stored) && modelOf(stored.providerID, stored.id) ? { model: modelOf(stored.providerID, stored.id)! } : {}) };
        const parts = new Map<string, unknown[]>();
        if (tables.has("session_part"))
          for (const part of db.all("SELECT message_id, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal", head.id)) {
            const data = json(part.data);
            if (isObject(data)) parts.set(String(part.message_id), [...(parts.get(String(part.message_id)) ?? []), data]);
          }
        const rows = db.all("SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq", head.id);
        out.push(v2Session(head, rows, parts, copiedThrough(db, row), keep));
        read.add(head.id);
      }
    }
    if (tables.has("session") && tables.has("message")) {
      for (const row of db.all("SELECT id, parent_id, directory, title, time_created, time_updated FROM session ORDER BY time_created, id")) {
        const head = headOf(row, file);
        if (read.has(head.id)) continue;
        const parts = new Map<string, Row[]>();
        if (tables.has("part"))
          for (const part of db.all("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id", head.id)) {
            const data = json(part.data);
            if (isObject(data)) parts.set(String(part.message_id), [...(parts.get(String(part.message_id)) ?? []), { ...data, id: part.id }]);
          }
        const messages = db
          .all("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id", head.id)
          .flatMap((message) => {
            const info = json(message.data);
            return isObject(info) ? [{ info: { ...info, id: message.id }, parts: parts.get(String(message.id)) ?? [] }] : [];
          });
        out.push(v1Session(head, messages, keep));
      }
    }
    return out;
  } finally {
    db.close();
  }
}

/** The last seq a 2.x fork copied from its source session (fork_boundary: through or before a message of the source),
 *  -1 when it is no fork or its boundary is not found. */
function copiedThrough(db: Db, row: Row): number {
  const boundary = json(row.fork_boundary);
  if (!str(row.fork_session_id) || !isObject(boundary) || !str(boundary.messageID)) return -1;
  const [at] = db.all("SELECT seq FROM session_message WHERE session_id = ? AND id = ?", row.fork_session_id as string, boundary.messageID as string);
  const seq = count(at?.seq);
  if (seq === undefined) return -1;
  if (boundary.type === "through") return seq;
  if (boundary.type !== "before") return -1;
  const [before] = db.all("SELECT max(seq) AS seq FROM session_message WHERE session_id = ? AND seq < ?", row.fork_session_id as string, seq);
  return count(before?.seq) ?? -1;
}

const entries = async (dir: string): Promise<Dirent[]> => readdir(dir, { withFileTypes: true }).catch(() => []);
/** The JSON files in `dir`, never through a link, in name order (OpenCode's ids sort by time). */
async function jsonFiles(dir: string): Promise<string[]> {
  return (await entries(dir))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}
const readJson = async (file: string): Promise<Row | undefined> => {
  const value = json(await readFile(file, "utf8").catch(() => undefined));
  return isObject(value) ? value : undefined;
};

/** Every session of OpenCode's JSON storage (…/opencode/storage). */
export async function readOpenCodeStorage(dir: string, { turns: keep = true }: Options = {}): Promise<OpenCodeSession[]> {
  const out: OpenCodeSession[] = [];
  const sessions: { info: Row; file: string }[] = [];
  for (const project of await entries(join(dir, "session"))) {
    if (!project.isDirectory()) continue;
    for (const file of await jsonFiles(join(dir, "session", project.name))) {
      const info = await readJson(file);
      if (info && str(info.id)) sessions.push({ info, file });
    }
  }
  const created = (info: Row) => (isObject(info.time) ? (count(info.time.created) ?? 0) : 0);
  sessions.sort((a, b) => created(a.info) - created(b.info) || String(a.info.id).localeCompare(String(b.info.id)));
  for (const { info, file } of sessions) {
    const time = isObject(info.time) ? info.time : {};
    const head = headOf({ id: info.id, directory: info.directory, parent_id: info.parentID, title: info.title, time_created: time.created, time_updated: time.updated }, file);
    const messages: { info: Row; parts: Row[] }[] = [];
    for (const messageFile of await jsonFiles(join(dir, "message", head.id))) {
      const message = await readJson(messageFile);
      if (!message || !str(message.id)) continue;
      const parts: Row[] = [];
      for (const partFile of await jsonFiles(join(dir, "part", message.id as string))) {
        const part = await readJson(partFile);
        if (part) parts.push(part);
      }
      messages.push({ info: message, parts });
    }
    messages.sort((a, b) => created(a.info) - created(b.info) || String(a.info.id).localeCompare(String(b.info.id)));
    out.push(v1Session(head, messages, keep));
  }
  return out;
}

/** OpenCode's databases and JSON storage under `home` (~/.local/share/opencode), or in `dataRoot` when the caller names
 *  OpenCode's data folder (OPENCODE_DATA_DIR, $XDG_DATA_HOME/opencode). Never through a link; a database's -wal and -shm
 *  files are its own. */
export async function openCodeFiles(home: string, dataRoot?: string): Promise<{ dbs: string[]; storage?: string }> {
  const root = dataRoot ?? join(home, ".local", "share", "opencode");
  const dbs = (await entries(root)).filter((entry) => entry.isFile() && /^opencode(?:-[\w.-]+)?\.db$/.test(entry.name)).map((entry) => join(root, entry.name)).sort();
  const storage = join(root, "storage");
  return (await lstat(join(storage, "session")).catch(() => null))?.isDirectory() && (await lstat(storage)).isDirectory() ? { dbs, storage } : { dbs };
}

/** Every OpenCode session under `home`: each database's, then the storage's the databases do not hold. A database that
 *  cannot be read is passed over. */
export async function readOpenCode(home: string, { dataRoot, ...options }: Options & { dataRoot?: string } = {}): Promise<OpenCodeSession[]> {
  const { dbs, storage } = await openCodeFiles(home, dataRoot);
  const out: OpenCodeSession[] = [];
  const read = new Set<string>();
  const keep = (sessions: OpenCodeSession[]) => {
    for (const session of sessions) {
      if (read.has(session.id)) continue;
      out.push(session);
      read.add(session.id);
    }
  };
  for (const db of dbs) keep(await readOpenCodeDb(db, options).catch(() => []));
  if (storage) keep(await readOpenCodeStorage(storage, options));
  return out;
}
