// OpenCode: the sessions it keeps under $XDG_DATA_HOME/opencode (~/.local/share/opencode without it).
//   opencode.db (opencode-<channel>.db for a dev or preview channel, or the database OPENCODE_DB names), SQLite. A 1.x
//     database keeps each session in `session`, its messages in `message` and their parts in `part`, each row's `data`
//     the message or part as JSON. A 2.x database keeps its own in `session_v2`, `session_message` (one row per message,
//     typed) and `session_part` (an assistant message's content), and the 1.x tables beside them, copied over as it opens
//     them: a session in both is the 2.x one.
//   storage/, the JSON OpenCode wrote before SQLite: session/<project>/<session>.json, message/<session>/<message>.json,
//     part/<message>/<part>.json. A session a database also holds is the database's.
// Schema from anomalyco/opencode: v1.19.5 (packages/core/src/session/sql.ts, packages/schema/src/v1/session.ts,
// packages/opencode/src/storage/storage.ts) and dev at 23fd3da786 (packages/core/src/session/sql.ts,
// packages/schema/src/session-message.ts, packages/core/src/database/migration/). A row or file that is not JSON, or
// not a record known here, is passed over.
//
// A locator is one session: { file: <database>, id: <session id> }, or a storage session's own JSON file. A locator of a
// database with no id reads each of its sessions. The cursor is the file's device and inode, whether turns were kept,
// a stamp of the session's rows (each table's row count and latest time_updated, or the storage files' sizes and
// times), and what the read found: an unchanged session is not read again; a changed one is read again whole (a session
// is never read in part), going on from the same file; a replaced file is read from its start.
//
// Tokens: normalizeUsage's "opencode" format (usage.ts), told the session's OpenCode version. Each step of an assistant
// message is one request, its usage on the step-finish part that ends it; OpenCode keeps only the last step's tokens on
// the message.
//
// A fork: 2.x names its source and how far it copied (fork_session_id, fork_boundary), and its copied rows are passed
// over by seq. 1.x's Session.fork (packages/opencode/src/session/index.ts at v1.0.0, session/session.ts at v1.18.5)
// copies each message and part under new ids, keeping its time, model, tokens and cost, and names no source. So each
// request and prompt is also keyed by what a copy keeps (fingerprint): one the import has read already (`seen`) is a
// copy, counted once, in the session read first.
//
// OpenCode's claude-agent provider runs Claude Code, which writes the same requests into its own session files: each
// such request's content names that Claude Code session in `native.sessionID` (2.x only; the provider came after the
// 1.x tables). The reader keeps those requests and names the session they mirror (Mirror), for a total to set the copy
// aside when it reads that session too.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type Env, entries, type Locator, type LocatorSize, type Reader, type ReadResult, rememberUser, type SessionRead } from "../reader.js";
import { effortOf as effortName, isObject, mostEffortOf, str } from "../text.js";
import { ACTIVE_GAP_MS, type Answer, type Ended, type Mirror, type SessionOf, type Turn } from "../types.js";
import { normalizeUsage } from "../usage.js";

type Row = Record<string, unknown>;
type Session = SessionOf<"opencode">;
type Found = SessionRead<"opencode">;

/** Where a read of one locator stopped: plain data, so structuredClone or v8.serialize keeps it whole. */
export type OpenCodeCursor = {
  source: "opencode";
  dev: number;
  ino: number;
  keep: boolean;
  /** The rows (or files) the read was of, as counts and times: one that differs has changed since. */
  stamp: string;
  sessions: Found[];
  /** The fingerprints the read added to `seen` (hashes, no text): a changed session read again whole finds its own
   *  there, which are no copies. */
  owned: string[];
};

/** A non-negative finite number: a count of tokens, a cost or a time. */
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const json = (value: unknown): unknown => {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};
// "default" is OpenCode's name for no variant.
const effortOf = (value: unknown): string | undefined => (value === "default" ? undefined : effortName(value));
const modelOf = (provider: unknown, model: unknown): string | undefined => (str(provider) && str(model) ? `${provider as string}/${model as string}` : undefined);
/** A request's or prompt's key from what a 1.x fork's copy of it keeps (a request's time, model, raw tokens and cost; a
 *  prompt's time and words): `o:` and a hash, which holds no text. */
const fingerprint = (fields: unknown[]): string => `o:${createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 32)}`;
/** What a request ran without turns keeps of its error: that it failed, never the message (a path, a provider's text). */
export const FAILED = "failed";

/** One read's sessions' share of the import: the records `seen` before (each a copy), those this read's locator added
 *  before (`before`: its own, read again), those it adds, and the time it is read at (no time is later). */
type Context = { seen: Set<string>; before: ReadonlySet<string>; owned: Set<string>; now: number; latest: number };
const contextOf = (seen: Set<string> | undefined, before: readonly string[], latest: number): Context => ({ seen: seen ?? new Set(), before: new Set(before), owned: new Set(), now: Date.now(), latest });

/** What a time past now, which a clock set ahead wrote, reads as: when `file` (or its write-ahead log) was last written,
 *  never past now. The same at each look, so the session ages out as its file does: never live for ever. */
async function latestOf(file: string): Promise<number> {
  const times = await Promise.all([file, `${file}-wal`].map((path) => stat(path).then((stats) => stats.mtimeMs, () => 0)));
  return Math.min(Math.max(...times), Date.now());
}
// The title OpenCode gives a session until it writes one (a subagent's keeps it): no title.
const DEFAULT_TITLE = /^(?:New|Child) session - \d{4}-\d\d-\d\dT/;

type Head = { id: string; file: string; cwd?: string; parent?: string; title?: string; model?: string; version?: string; created?: number; updated?: number };

/** One session as it is read: its turns, every request (`answers`, kept or not), the times of its records. */
class Reading {
  readonly session: Session;
  readonly answers: Answer[] = [];
  private readonly times: number[] = [];
  private cost = 0;
  private unpriced = false;
  /** `many`: the head's file holds many sessions (a database), so its locator names the session's id. */
  constructor(
    private readonly head: Head,
    private readonly keep: boolean,
    private readonly many: boolean,
    private readonly context: Context,
  ) {
    this.session = { source: "opencode", id: head.id, file: head.file, state: "completed", child: false, turns: [], users: 0, activeMs: 0, copies: 0 };
    if (head.cwd) this.session.cwd = head.cwd;
    if (head.model) this.session.model = head.model;
    if (head.parent) Object.assign(this.session, { child: true, parent: head.parent });
    if (head.title && !DEFAULT_TITLE.test(head.title)) this.session.sourceTitle = head.title;
  }
  /** A time read off a row; one past now (a clock set ahead would keep the session live, and past 8.64e15 is no Date)
   *  reads as its file's last write (latestOf). */
  when(value: unknown): number | undefined {
    const at = num(value);
    return at === undefined ? undefined : at > this.context.now ? this.context.latest : at;
  }
  at(...times: unknown[]): void {
    for (const at of times) {
      const time = this.when(at);
      if (time !== undefined) this.times.push(time);
    }
  }
  usage(tokens: unknown) {
    return normalizeUsage("opencode", tokens, { version: this.head.version });
  }
  /** Whether a record keyed `key` is a copy of one the import has read (not one of this locator's own, read again). */
  copy(key: string): boolean {
    return !this.context.before.has(key) && this.context.seen.has(key);
  }
  own(key: string): void {
    this.context.seen.add(key);
    this.context.owned.add(key);
  }
  /** Where the read is, to go back to (back) when what came after is a copy. */
  mark() {
    return { turns: this.session.turns.length, answers: this.answers.length, times: this.times.length, model: this.session.model, cwd: this.session.cwd };
  }
  back(mark: ReturnType<Reading["mark"]>): void {
    this.session.turns.length = mark.turns;
    this.answers.length = mark.answers;
    this.times.length = mark.times;
    for (const key of ["model", "cwd"] as const) if (mark[key] === undefined) delete this.session[key];
    else this.session[key] = mark[key];
  }
  /** Requests found copies, and their calls' results, out of the session. */
  drop(copies: ReadonlySet<Answer>): void {
    const calls = new Set([...copies].flatMap((turn) => turn.calls.map((call) => call.id)));
    const kept = this.answers.filter((turn) => !copies.has(turn));
    this.answers.splice(0, this.answers.length, ...kept);
    const turns = this.session.turns.filter((turn) => !copies.has(turn as Answer) && !(turn.role === "toolResult" && calls.has(turn.callId)));
    this.session.turns.splice(0, this.session.turns.length, ...turns);
  }
  add(turn: Turn): void {
    rememberUser(this.session, turn);
    if (turn.role === "assistant") this.answers.push(turn);
    if (this.keep) this.session.turns.push(turn);
  }
  answer(at: number, model: string | undefined, effort: string | undefined): Answer {
    if (model) this.session.model = model;
    const turn: Answer = { role: "assistant", text: "", calls: [], at, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    this.add(turn);
    return turn;
  }
  call(turn: Answer, id: string, name: string, input: unknown): void {
    turn.calls.push({ type: "toolCall", id, name, arguments: isObject(input) && this.keep ? input : {} });
  }
  result(callId: string, name: string, text: string, isError: boolean, at: number): void {
    this.add({ role: "toolResult", callId, name, text, isError, at });
  }
  mirror(turn: Answer, link: Mirror): void {
    turn.mirrors = link;
    const links = (this.session.mirrors ??= []);
    if (!links.some((known) => known.source === link.source && known.sessionId === link.sessionId)) links.push(link);
  }
  /** A message's cost, which the session's sums; unknown once a request with usage has none. */
  priced(cost: unknown, used: boolean): void {
    const usd = num(cost);
    if (usd !== undefined) this.cost += usd;
    else if (used) this.unpriced = true;
  }
  ended(state: Ended): void {
    this.session.state = state;
  }
  done(): Found {
    const session = this.session;
    // Without turns, no answer text nor error message: each request is kept for its counts, in the result and the cursor
    // alike.
    if (!this.keep)
      for (const answer of this.answers) {
        answer.text = "";
        if (answer.error !== undefined) answer.error = FAILED;
      }
    if (!this.unpriced) session.costUsd = this.cost;
    const times = this.times.sort((a, b) => a - b);
    const first = times[0] ?? this.when(this.head.created);
    const last = times.at(-1) ?? this.when(this.head.updated);
    if (first !== undefined) session.startedAt = new Date(first).toISOString();
    if (last !== undefined) session.endedAt = new Date(last).toISOString();
    for (let i = 1; i < times.length; i += 1) if (times[i]! - times[i - 1]! <= ACTIVE_GAP_MS) session.activeMs += times[i]! - times[i - 1]!;
    const effort = mostEffortOf(session.turns);
    if (effort) session.effort = effort;
    return { locator: this.many ? { file: this.head.file, id: session.id } : { file: this.head.file }, session, requests: this.answers };
  }
}

/** A 1.x error's message ({name, data: {message}}), or a 2.x one's ({type, message}). */
const errorOf = (error: unknown): string | undefined =>
  isObject(error) ? (str(isObject(error.data) ? error.data.message : undefined) ?? str(error.message) ?? str(error.name) ?? str(error.type) ?? "unknown error") : undefined;

/** One 1.x session from its row or file, its messages (each with its parts) in the order OpenCode keeps them. A prompt
 *  or request a 1.x fork copied (fingerprint) that the import has read already is a copy: passed over, counted. */
function v1Session(reading: Reading, messages: { info: Row; parts: Row[] }[]): Found {
  for (const { info, parts } of messages) {
    const time = isObject(info.time) ? info.time : {};
    const created = reading.when(time.created) ?? 0;
    if (info.role === "user") {
      const text = parts
        .filter((part) => part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true)
        .map((part) => part.text as string)
        .join("\n");
      const key = fingerprint(["user", num(time.created) ?? null, text]);
      if (reading.copy(key)) {
        reading.session.copies += 1;
        continue;
      }
      reading.own(key);
      reading.at(time.created, time.completed);
      if (text) reading.add({ role: "user", text, at: created, uuids: [key] });
      continue;
    }
    const mark = reading.mark();
    reading.at(time.created, time.completed);
    if (info.role !== "assistant") continue;
    if (!reading.session.cwd && isObject(info.path) && str(info.path.cwd)) reading.session.cwd = info.path.cwd as string;
    const model = modelOf(info.providerID, info.modelID);
    const effort = effortOf(info.variant);
    // Each step is one request, its usage and cost on the step-finish part that ends it; a message with no step-finish
    // (an older OpenCode's) is one request, its usage the message's. `raw`: each request's tokens and cost as written,
    // what its fingerprint is of (a fork made by a later OpenCode reads its usage another way).
    const raw = new Map<Answer, unknown[]>();
    let turn: Answer | undefined;
    let turns = 0;
    let stepped = false;
    let last: Answer | undefined;
    const openTurn = (at?: number): Answer => {
      if (!turn) {
        turn = last = reading.answer(turns === 0 ? created : (at ?? last?.at ?? created), model, effort);
        turns += 1;
      }
      return turn;
    };
    for (const part of parts) {
      const partTime = isObject(part.time) ? reading.when(part.time.start) : undefined;
      if (part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true) {
        const into = openTurn(partTime);
        into.text = [into.text, part.text].filter(Boolean).join("\n");
      } else if (part.type === "tool" && isObject(part.state)) {
        const state = part.state;
        const id = String(part.callID ?? "");
        const name = String(part.tool ?? "");
        const span = isObject(state.time) ? state.time : {};
        reading.at(span.start, span.end);
        reading.call(openTurn(reading.when(span.start)), id, name, state.input);
        const end = reading.when(span.end) ?? reading.when(span.start) ?? created;
        if (state.status === "completed") reading.result(id, name, typeof state.output === "string" ? state.output : "", false, end);
        else if (state.status === "error") reading.result(id, name, str(state.error) ?? "", true, end);
      } else if (part.type === "step-finish") {
        stepped = true;
        const into = openTurn();
        raw.set(into, [part.tokens ?? null, part.cost ?? null]);
        const usage = reading.usage(part.tokens);
        if (usage) into.usage = usage;
        const cost = num(part.cost);
        if (cost !== undefined) into.costUsd = cost;
        turn = undefined;
      }
    }
    const usage = reading.usage(info.tokens);
    if (!stepped && (turns > 0 || usage)) {
      const into = openTurn();
      raw.set(into, [info.tokens ?? null, info.cost ?? null]);
      if (usage) into.usage = usage;
      const cost = num(info.cost);
      if (cost !== undefined) into.costUsd = cost;
    }
    const error = errorOf(info.error);
    const aborted = isObject(info.error) && info.error.name === "MessageAbortedError";
    if (error && !aborted) (last ?? openTurn()).error = error;
    // Each request by its fingerprint: the message's time and model, its step, its tokens and cost as written. All of
    // them copies: the message is a fork's copy, passed over whole. Some: those are left out, the rest kept.
    const mine = reading.answers.slice(mark.answers);
    const keys = mine.map((answer, step) => fingerprint([num(time.created) ?? null, step, model ?? null, ...(raw.get(answer) ?? [null, null])]));
    const copies = new Set(mine.filter((_, i) => reading.copy(keys[i]!)));
    if (mine.length > 0 && copies.size === mine.length) {
      reading.back(mark);
      reading.session.copies += 1;
      continue;
    }
    mine.forEach((answer, i) => {
      if (copies.has(answer)) return;
      answer.key = keys[i]!;
      reading.own(keys[i]!);
    });
    if (copies.size) {
      reading.drop(copies);
      reading.session.copies += copies.size;
      // The message's cost holds the copies' too: its own requests' instead, unknown when one that used tokens has none.
      for (const answer of mine) if (!copies.has(answer)) reading.priced(answer.costUsd, answer.usage !== undefined);
    } else reading.priced(info.cost, usage !== undefined || stepped);
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
/** One 2.x session from its session_message rows in seq order and its session_part rows' content by message. Rows a
 *  fork copied from its source (seq up to `copiedThrough`) are copies; so is a prompt or request whose fingerprint the
 *  import has read already (a 1.x fork's copy, moved to 2.x without its source named). */
function v2Session(reading: Reading, rows: Row[], parts: Map<string, unknown[]>, copiedThrough: number): Found {
  for (const row of rows) {
    if (typeof row.seq === "number" && row.seq <= copiedThrough) {
      reading.session.copies += 1;
      continue;
    }
    const data = json(row.data);
    if (!isObject(data)) continue;
    const time = isObject(data.time) ? data.time : {};
    const written = num(time.created) ?? num(row.time_created);
    const created = reading.when(written) ?? 0;
    const model = isObject(data.model) ? modelOf(data.model.providerID, data.model.id) : undefined;
    const request = row.type === "assistant" || (row.type === "compaction" && data.status !== "running");
    const used = request ? (model ?? reading.session.model) : undefined;
    const key = row.type === "user" ? fingerprint(["user", written ?? null, typeof data.text === "string" ? data.text : null]) : request ? fingerprint([written ?? null, 0, used ?? null, data.tokens ?? null, data.cost ?? null]) : undefined;
    if (key !== undefined) {
      if (reading.copy(key)) {
        reading.session.copies += 1;
        continue;
      }
      reading.own(key);
    }
    reading.at(created, time.completed);
    if (row.type === "user" && typeof data.text === "string" && data.text) reading.add({ role: "user", text: data.text, at: created, uuids: [key!] });
    else if (row.type === "model-switched" && model) reading.session.model = model;
    else if (row.type === "idle" && typeof data.outcome === "string" && IDLE[data.outcome]) reading.ended(IDLE[data.outcome]!);
    else if (request) {
      const turn = reading.answer(created, used, isObject(data.model) ? effortOf(data.model.variant) : undefined);
      turn.key = key!;
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
          const end = reading.when(span.completed) ?? reading.when(span.created) ?? created;
          if (item.state.status === "completed") reading.result(id, name, contentText(item.state.content), false, end);
          else if (item.state.status === "error") reading.result(id, name, errorOf(item.state.error) ?? contentText(item.state.content), true, end);
        }
      }
      const sessionId =
        isObject(data.model) && data.model.providerID === "claude-agent"
          ? content.map((item) => (isObject(item) && isObject(item.native) && typeof item.native.sessionID === "string" ? item.native.sessionID.trim() : "")).find(Boolean)
          : undefined;
      if (sessionId) reading.mirror(turn, { source: "claude-code", sessionId });
      const usage = reading.usage(data.tokens);
      if (usage) turn.usage = usage;
      const cost = num(data.cost);
      if (cost !== undefined) turn.costUsd = cost;
      reading.priced(data.cost, usage !== undefined);
      const error = errorOf(data.error);
      if (error) turn.error = error;
      if (row.type === "assistant") reading.ended(error ? "failed" : "completed");
    }
  }
  return reading.done();
}

/** An open database, read-only; `read` the bytes of the `data` the queries have returned so far. */
type Db = { all(sql: string, ...params: (string | number)[]): Row[]; close(): void; read(): number };
// Read through a variable: a Bun build bundles node:sqlite as missing, and Node has no bun:sqlite.
const BUN_SQLITE = "bun:sqlite";
const NODE_SQLITE = "node:sqlite";
/** How long a read waits on OpenCode's own write (a lock it holds) before it fails, ms; as Bun sets it. */
const BUSY_MS = 5000;
const BUSY_PRAGMA = "PRAGMA busy_timeout = 5000";
/** `file` opened read-only, waiting BUSY_MS on a lock: with Node's node:sqlite, or Bun's bun:sqlite under Bun (Bun 1.3
 *  has no node:sqlite, and its opener takes no timeout: the connection's busy_timeout, which writes nothing). */
async function openDb(file: string): Promise<Db> {
  let query: (sql: string, params: (string | number)[]) => Row[];
  let close: () => void;
  if (process.versions.bun) {
    const { Database } = (await import(BUN_SQLITE)) as { Database: new (file: string, options: { readonly: boolean }) => { query(sql: string): { all(...params: unknown[]): Row[] }; close(): void } };
    const db = new Database(file, { readonly: true });
    db.query(BUSY_PRAGMA).all();
    query = (sql, params) => db.query(sql).all(...params);
    close = () => db.close();
  } else {
    const { DatabaseSync } = (await import(NODE_SQLITE)) as typeof import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_MS });
    query = (sql, params) => db.prepare(sql).all(...params) as Row[];
    close = () => db.close();
  }
  let bytes = 0;
  return {
    all(sql, ...params) {
      const rows = query(sql, params);
      for (const row of rows) if (typeof row.data === "string") bytes += Buffer.byteLength(row.data);
      return rows;
    },
    close,
    read: () => bytes,
  };
}

const headOf = (row: Row, file: string): Head => ({
  id: String(row.id),
  file,
  ...(str(row.directory) ? { cwd: row.directory as string } : {}),
  ...(str(row.parent_id) ? { parent: row.parent_id as string } : {}),
  ...(str(row.title) ? { title: row.title as string } : {}),
  ...(str(row.version) ? { version: row.version as string } : {}),
  ...(num(row.time_created) !== undefined ? { created: row.time_created as number } : {}),
  ...(num(row.time_updated) !== undefined ? { updated: row.time_updated as number } : {}),
});

/** Which of a database's tables are there: its 2.x sessions, and its 1.x ones. */
function tablesOf(db: Db): { v2: boolean; parts2: boolean; v1: boolean; parts1: boolean; all: Set<string> } {
  const all = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row.name)));
  return { v2: all.has("session_v2") && all.has("session_message"), parts2: all.has("session_part"), v1: all.has("session") && all.has("message"), parts1: all.has("part"), all };
}

/** A database's session ids, each once, with each one's last write (the latest time_updated of its rows): its 2.x
 *  sessions, then the 1.x ones it has not moved to its 2.x tables. */
async function sessionIds(file: string): Promise<Map<string, number>> {
  const db = await openDb(file);
  try {
    const tables = tablesOf(db);
    const ids = new Map<string, number>();
    const later = (id: unknown, at: unknown) => ids.has(String(id)) && ids.set(String(id), Math.max(ids.get(String(id))!, num(at) ?? 0));
    const v2 = tables.v2 ? db.all("SELECT id, time_updated FROM session_v2 ORDER BY time_created, id") : [];
    for (const row of v2) ids.set(String(row.id), num(row.time_updated) ?? 0);
    if (tables.v1) for (const row of db.all("SELECT id, time_updated FROM session ORDER BY time_created, id")) if (!ids.has(String(row.id))) ids.set(String(row.id), num(row.time_updated) ?? 0);
    // A session's messages and parts are written after its row: theirs count, in the tables its read takes.
    const own = new Set(v2.map((row) => String(row.id)));
    for (const [table, two] of [["session_message", true], ["session_part", true], ["message", false], ["part", false]] as const)
      if (tables.all.has(table)) for (const row of db.all(`SELECT session_id, max(time_updated) AS t FROM ${table} GROUP BY session_id`)) if (own.has(String(row.session_id)) === two) later(row.session_id, row.t);
    return ids;
  } finally {
    db.close();
  }
}

// Each table's rows of one session, by the column that names it.
const SESSION_TABLES: [string, string][] = [
  ["session_v2", "id"],
  ["session_message", "session_id"],
  ["session_part", "session_id"],
  ["session", "id"],
  ["message", "session_id"],
  ["part", "session_id"],
];
/** What a read of `id` (each session, without one) is of: each table's row count and latest time_updated. */
function stampOf(db: Db, tables: Set<string>, id: string | undefined): string {
  return JSON.stringify(
    SESSION_TABLES.filter(([table]) => tables.has(table)).map(([table, column]) => {
      const [row] = db.all(`SELECT count(*) AS n, max(time_updated) AS t FROM ${table}${id === undefined ? "" : ` WHERE ${column} = ?`}`, ...(id === undefined ? [] : [id]));
      return [table, row?.n ?? 0, row?.t ?? null];
    }),
  );
}

/** The sessions of an open database: the one `id` names (none when it is not there), else each. */
function dbSessions(db: Db, file: string, tables: ReturnType<typeof tablesOf>, keep: boolean, id: string | undefined, context: Context): Found[] {
  const out: Found[] = [];
  const read = new Set<string>();
  const where = id === undefined ? "" : " WHERE id = ?";
  const by = id === undefined ? [] : [id];
  if (tables.v2) {
    for (const row of db.all(`SELECT * FROM session_v2${where} ORDER BY time_created, id`, ...by)) {
      const stored = json(row.model);
      const model = isObject(stored) ? modelOf(stored.providerID, stored.id) : undefined;
      const head = { ...headOf(row, file), ...(model ? { model } : {}) };
      const parts = new Map<string, unknown[]>();
      if (tables.parts2)
        for (const part of db.all("SELECT message_id, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal", head.id)) {
          const data = json(part.data);
          if (isObject(data)) (parts.get(String(part.message_id)) ?? parts.set(String(part.message_id), []).get(String(part.message_id))!).push(data);
        }
      const rows = db.all("SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq", head.id);
      out.push(v2Session(new Reading(head, keep, true, context), rows, parts, copiedThrough(db, row)));
      read.add(head.id);
    }
  }
  if (tables.v1) {
    for (const row of db.all(`SELECT id, parent_id, directory, title, version, time_created, time_updated FROM session${where} ORDER BY time_created, id`, ...by)) {
      const head = headOf(row, file);
      if (read.has(head.id)) continue;
      const parts = new Map<string, Row[]>();
      if (tables.parts1)
        for (const part of db.all("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id", head.id)) {
          const data = json(part.data);
          if (isObject(data)) (parts.get(String(part.message_id)) ?? parts.set(String(part.message_id), []).get(String(part.message_id))!).push({ ...data, id: part.id });
        }
      const messages = db.all("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id", head.id).flatMap((message) => {
        const info = json(message.data);
        return isObject(info) ? [{ info: { ...info, id: message.id }, parts: parts.get(String(message.id)) ?? [] }] : [];
      });
      out.push(v1Session(new Reading(head, keep, true, context), messages));
    }
  }
  return out;
}

/** The last seq a 2.x fork copied from its source session (fork_boundary: through or before a message of the source),
 *  -1 when it is no fork or its boundary is not found. */
function copiedThrough(db: Db, row: Row): number {
  const boundary = json(row.fork_boundary);
  if (!str(row.fork_session_id) || !isObject(boundary) || !str(boundary.messageID)) return -1;
  const [at] = db.all("SELECT seq FROM session_message WHERE session_id = ? AND id = ?", row.fork_session_id as string, boundary.messageID as string);
  const seq = num(at?.seq);
  if (seq === undefined) return -1;
  if (boundary.type === "through") return seq;
  if (boundary.type !== "before") return -1;
  const [before] = db.all("SELECT max(seq) AS seq FROM session_message WHERE session_id = ? AND seq < ?", row.fork_session_id as string, seq);
  return num(before?.seq) ?? -1;
}

/** A file or folder gone (deleted while read, or never made): none. Any other error (no access, I/O) is the read's: a
 *  session is never read short of what it holds. */
const gone = (error: unknown): undefined => {
  const code = isObject(error) ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return undefined;
  throw error;
};
/** The JSON files in `dir`, never through a link, in name order (OpenCode's ids sort by time). */
async function jsonFiles(dir: string): Promise<string[]> {
  return ((await readdir(dir, { withFileTypes: true }).catch(gone)) ?? [])
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}
/** One JSON record's file: none when it is gone or is no JSON object (a malformed record is passed over). */
const readJson = async (file: string, bytes?: { n: number }): Promise<Row | undefined> => {
  const text = await readFile(file, "utf8").catch(gone);
  if (bytes && text !== undefined) bytes.n += Buffer.byteLength(text);
  const value = json(text);
  return isObject(value) ? value : undefined;
};
const createdOf = (info: Row) => (isObject(info.time) ? (num(info.time.created) ?? 0) : 0);

/** The storage folder a session's JSON file is in (storage/session/<project>/<session>.json). */
const storageOf = (file: string) => dirname(dirname(dirname(file)));

/** Each session of OpenCode's JSON storage: its file and id, by the time it was made. */
async function storageSessions(dir: string): Promise<{ file: string; id: string }[]> {
  const sessions: { info: Row; file: string }[] = [];
  for (const project of await entries(join(dir, "session"))) {
    if (!project.isDirectory()) continue;
    for (const file of await jsonFiles(join(dir, "session", project.name)).catch(() => [])) {
      // One that cannot be read is listed by its name (OpenCode's <id>.json), so its read fails and is said.
      const info = await readJson(file).catch((): Row => ({ id: basename(file, ".json") }));
      if (info && str(info.id)) sessions.push({ info, file });
    }
  }
  sessions.sort((a, b) => createdOf(a.info) - createdOf(b.info) || String(a.info.id).localeCompare(String(b.info.id)));
  return sessions.map(({ info, file }) => ({ file, id: info.id as string }));
}

/** What a read of a storage session is of: its file's, its messages' and their parts' sizes and times. */
async function storageStamp(file: string): Promise<string> {
  const dir = storageOf(file);
  const hash = createHash("sha256");
  const add = async (path: string) => {
    const stats = await stat(path).catch(() => null);
    hash.update(`${path}\0${stats?.size ?? -1}\0${stats?.mtimeMs ?? -1}\n`);
  };
  await add(file);
  for (const message of await jsonFiles(join(dir, "message", basename(file, ".json")))) {
    await add(message);
    for (const part of await jsonFiles(join(dir, "part", basename(message, ".json")))) await add(part);
  }
  return hash.digest("hex");
}

/** One session of the JSON storage, from its file. */
async function storageSession(file: string, keep: boolean, bytes: { n: number }, context: Context): Promise<Found[]> {
  const info = await readJson(file, bytes);
  if (!info || !str(info.id)) return [];
  const dir = storageOf(file);
  const time = isObject(info.time) ? info.time : {};
  const head = headOf({ id: info.id, directory: info.directory, parent_id: info.parentID, title: info.title, version: info.version, time_created: time.created, time_updated: time.updated }, file);
  const messages: { info: Row; parts: Row[] }[] = [];
  for (const messageFile of await jsonFiles(join(dir, "message", head.id))) {
    const message = await readJson(messageFile, bytes);
    if (!message || !str(message.id)) continue;
    const parts: Row[] = [];
    for (const partFile of await jsonFiles(join(dir, "part", message.id as string))) {
      const part = await readJson(partFile, bytes);
      if (part) parts.push(part);
    }
    messages.push({ info: message, parts });
  }
  messages.sort((a, b) => createdOf(a.info) - createdOf(b.info) || String(a.info.id).localeCompare(String(b.info.id)));
  return [v1Session(new Reading(head, keep, false, context), messages)];
}

/** Whether a locator with no id is a storage session's JSON file (storage/session/<project>/<id>.json), not a database:
 *  by its name, so a database that does not open is read as one, and its read fails. */
function isStorage(file: string): boolean {
  return file.endsWith(".json");
}

/** OpenCode's databases and JSON storage under `home`, as OpenCode finds them in `env`: its data folder
 *  $XDG_DATA_HOME/opencode (~/.local/share/opencode without it), opencode.db and each channel's opencode-<channel>.db in
 *  it; and first the database OPENCODE_DB names, a path as given or one relative to the data folder. OpenCode opens
 *  only that one; the ones it wrote before are still the person's history. Never through a link; a database's -wal and
 *  -shm files are its own. No env is none: the home's folder. */
export async function openCodeFiles(home: string, env: Env = {}): Promise<{ dbs: string[]; storage?: string }> {
  const root = join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
  const dbs = (await entries(root))
    .filter((entry) => entry.isFile() && /^opencode(?:-[\w.-]+)?\.db$/.test(entry.name))
    .map((entry) => join(root, entry.name))
    .sort();
  // ":memory:" names no file, and is found as none.
  const named = env.OPENCODE_DB ? resolve(root, env.OPENCODE_DB) : undefined;
  if (named && !dbs.includes(named) && (await lstat(named).catch(() => null))?.isFile()) dbs.unshift(named);
  const storage = join(root, "storage");
  return (await lstat(join(storage, "session")).catch(() => null))?.isDirectory() && (await lstat(storage)).isDirectory() ? { dbs, storage } : { dbs };
}

/** A database session's own size, last write and parent: the bytes of its messages' and parts' data (the 2.x tables' when the
 *  session is there, else 1.x's: the rows a read of it takes) and the latest time_updated of its rows. */
function dbSize(db: Db, tables: ReturnType<typeof tablesOf>, id: string, latest: number): LocatorSize | null {
  const [v2] = tables.v2 ? db.all("SELECT parent_id, time_created FROM session_v2 WHERE id = ?", id) : [];
  const [row] = v2 ? [v2] : tables.v1 ? db.all("SELECT parent_id, time_created FROM session WHERE id = ?", id) : [];
  if (!row) return null;
  const data = (v2 ? ["session_message", "session_part"] : ["message", "part"]).filter((table) => tables.all.has(table));
  const bytes = data.reduce((n, table) => n + Number(db.all(`SELECT coalesce(sum(length(CAST(data AS BLOB))), 0) AS n FROM ${table} WHERE session_id = ?`, id)[0]?.n ?? 0), 0);
  const times = SESSION_TABLES.filter(([table]) => tables.all.has(table)).map(([table, column]) => num(db.all(`SELECT max(time_updated) AS t FROM ${table} WHERE ${column} = ?`, id)[0]?.t) ?? 0);
  // A row written by a clock set ahead is as old as its database's last write (latestOf): not live for ever.
  const last = Math.max(0, ...times);
  return { bytes, mtimeMs: last > Date.now() ? latest : last, ...(str(row.parent_id) ? { parent: row.parent_id as string } : {}), ...(num(row.time_created) !== undefined ? { created: row.time_created as number } : {}) };
}

/** A storage session's size and last write: its session file's, its messages' and their parts' together; its parent, its
 *  session file's. */
async function storageSize(file: string): Promise<LocatorSize | null> {
  const own = await stat(file).catch(() => null);
  if (!own) return null;
  const dir = storageOf(file);
  // A file or folder that cannot be read leaves the size as far as it goes: the read says it.
  const info = await readJson(file).catch(() => undefined);
  const created = info && isObject(info.time) ? num(info.time.created) : undefined;
  const size: LocatorSize = { bytes: own.size, mtimeMs: own.mtimeMs, ...(info && str(info.parentID) ? { parent: info.parentID as string } : {}), ...(created !== undefined ? { created } : {}) };
  const add = async (path: string) => {
    const stats = await stat(path).catch(() => null);
    if (!stats) return;
    size.bytes += stats.size;
    size.mtimeMs = Math.max(size.mtimeMs, stats.mtimeMs);
  };
  for (const message of await jsonFiles(join(dir, "message", basename(file, ".json"))).catch(() => [])) {
    await add(message);
    for (const part of await jsonFiles(join(dir, "part", basename(message, ".json"))).catch(() => [])) await add(part);
  }
  return size;
}

/** A session read as a turns: false cursor keeps it: no prompt, title or working directory (counts, ids and paths alone),
 *  so a read resumed from it gives none of them, as a line source's does. */
function withoutText(found: Found): Found {
  const { firstPrompt: _prompt, titleText: _title, sourceTitle: _source, cwd: _cwd, ...session } = found.session;
  return structuredClone({ ...found, session: session as Found["session"] });
}

export const opencode: Reader<"opencode", OpenCodeCursor> = {
  source: "opencode",
  name: "OpenCode",
  harness: "opencode",
  /** One locator per session, each session once: the database's that wrote it last (a channel's opencode-<channel>.db
   *  may keep a stale copy of opencode.db's session; on a tie, the first, OPENCODE_DB's first), else its storage file. A
   *  database that cannot be listed is its own locator. */
  async discover(home, env) {
    const { dbs, storage } = await openCodeFiles(home, env);
    const out: Locator[] = [];
    const known = new Set<string>();
    // Each session's place in `out`, and when the database there wrote it last.
    const at = new Map<string, { index: number; updated: number }>();
    for (const file of dbs) {
      // One that cannot be listed is its own locator, so its read fails and is said: never a database of no sessions.
      const ids = await sessionIds(file).catch(() => undefined);
      if (!ids) out.push({ file });
      for (const [id, updated] of ids ?? []) {
        const held = at.get(id);
        if (!held) {
          known.add(id);
          at.set(id, { index: out.length, updated });
          out.push({ file, id });
        } else if (updated > held.updated) {
          held.updated = updated;
          out[held.index] = { file, id };
        }
      }
    }
    if (storage)
      for (const { file, id } of await storageSessions(storage))
        if (!known.has(id)) {
          known.add(id);
          out.push({ file });
        }
    return out;
  },
  /** Oldest session first, whichever file holds it: a 1.x fork (a newer session, whose id sorts first: OpenCode's
   *  session ids descend) holds copies of its source's records, which count in the source. One whose start is not
   *  known comes after, in the listing's order. */
  order: (a, b) => (a.created ?? Number.MAX_SAFE_INTEGER) - (b.created ?? Number.MAX_SAFE_INTEGER),
  async read(locator, cursor, { turns: keep = true, seen } = {}): Promise<ReadResult<"opencode", OpenCodeCursor>> {
    const { file, id } = locator;
    const stats = await stat(file);
    const resumed = cursor !== undefined && cursor.source === "opencode" && cursor.keep === keep && cursor.dev === stats.dev && cursor.ino === stats.ino;
    // A changed session read again whole: the fingerprints its last read added are its own, no copies.
    const context = contextOf(seen, resumed ? cursor.owned : [], await latestOf(file));
    const result = (stamp: string, sessions: Found[], read: number): ReadResult<"opencode", OpenCodeCursor> => {
      if (resumed && cursor.stamp === stamp) return { sessions: structuredClone(cursor.sessions), cursor, read: 0, resumed };
      return { sessions, cursor: { source: "opencode", dev: stats.dev, ino: stats.ino, keep, stamp, sessions: keep ? structuredClone(sessions) : sessions.map(withoutText), owned: [...context.owned] }, read, resumed };
    };
    if (id === undefined && isStorage(file)) {
      const stamp = await storageStamp(file);
      if (resumed && cursor.stamp === stamp) return result(stamp, [], 0);
      const bytes = { n: 0 };
      return result(stamp, await storageSession(file, keep, bytes, context), bytes.n);
    }
    const db = await openDb(file);
    try {
      const tables = tablesOf(db);
      const stamp = stampOf(db, tables.all, id);
      if (resumed && cursor.stamp === stamp) return result(stamp, [], 0);
      const before = db.read();
      const sessions = dbSessions(db, file, tables, keep, id, context);
      return result(stamp, sessions, db.read() - before);
    } finally {
      db.close();
    }
  },
  /** A database session's own (dbSize), not its database's: one live session leaves the others importable, and none
   *  is too large for the size of the rest. A storage session's files together; a database without an id, its file's. */
  async stat({ file, id }) {
    if (id === undefined && isStorage(file)) return storageSize(file);
    if (id === undefined) {
      const stats = await stat(file);
      return { bytes: stats.size, mtimeMs: stats.mtimeMs };
    }
    const latest = await latestOf(file);
    const db = await openDb(file);
    try {
      return dbSize(db, tablesOf(db), id, latest);
    } finally {
      db.close();
    }
  },
};
