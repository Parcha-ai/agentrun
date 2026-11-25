// A Reader for a source that writes each session as a JSONL file (Claude Code, Codex, pi): the file read a line at a time
// into a Session, a line that is not JSON, or not a record its source knows, passed over. A read goes on from a cursor:
// the file's identity (device, inode), the byte after the last whole line read, and the read's state, so a later read
// takes only the bytes written since.
import { type FileHandle, open } from "node:fs/promises";
import { addRequest, type Counts, counts, trimmed } from "./counts.js";
import { DROPS_CURSOR, type InternalReadOptions, NO_READ_AHEAD } from "./internal.js";
import { type Env, type Locator, type Reader, type ReadOptions, type ReadResult, rememberUser } from "./reader.js";
import { type Fields, fieldsOf, type Shape, scan } from "./scan.js";
import { isObject, mostEffortOf, timeOf } from "./text.js";
import { ACTIVE_GAP_MS, type Answer, type SessionOf, type Turn } from "./types.js";

/** One file's read so far, all of it plain data (no function, Maps and Sets allowed), so a cursor can carry it and
 *  structuredClone or v8.serialize can copy it. `answers` holds every request read, whether turns are kept or not: what
 *  a total counts; a totals read's are in `counts` instead, each its model, usage and time alone. `own` is the source's own (LineSource.start). A turns: true read's holds the session's text (its
 *  turns, prompts, titles, tool output, working directory); a turns: false read's cursor holds none of it, only counts,
 *  ids and the like (see LineSource.forget). */
export type ReadState<O = unknown> = {
  session: SessionOf;
  turns: Turn[];
  answers: Answer[];
  /** Tool names by call id, for the results that name none. */
  names: Map<string, string>;
  /** The sum of the requests the source priced, and whether one was not. */
  priced: { sum: number; unknown: boolean };
  /** The effort in force (Codex's turn_context, pi's thinking level). */
  effort?: string;
  first?: number;
  last?: number;
  activeMs: number;
  own: O;
  /** A totals read's requests (ReadOptions.totals), in place of `answers`. */
  counts?: Counts;
  /** The records seen, when the caller shares none across files. */
  seen?: Set<string>;
};

/** What a source's record and finish are handed: the file's state, the records seen across the import's files ("u:"
 *  a record's uuid, "m:" a request's key, "l:" a bare message id a store imported before keys had request ids), whether turns are kept, and `add`, which keeps a turn (and counts a user's). */
export type ReadContext<O = unknown> = {
  state: ReadState<O>;
  seen: Set<string>;
  keep: boolean;
  add: (turn: Turn) => void;
};

/** A JSONL source: where its files are, and how it reads one record of one into the session. */
export type LineSource<S extends string, O> = Pick<Reader<S>, "source" | "name" | "harness" | "order"> & {
  /** The candidate session files under `home`, any order; links are dropped by the caller. */
  files: (home: string, env?: Env) => Promise<string[]>;
  /** Subagents' session files that name no parent themselves, each with the session file it ran under (`of`). */
  children?: (home: string, env?: Env) => Promise<{ file: string; of: string }[]>;
  /** The source's own state for a new file. */
  start: () => O;
  /** One record read: false for one read already (a copy), which moves no time. */
  record: (value: Record<string, unknown>, at: number, context: ReadContext<O>) => boolean | void;
  /** The session as the file ends, from `out` (a copy of the state's session, its turns `turns`): it may set more of
   *  `out` and return the turns in their order. It never changes the state, which a later read goes on from. */
  finish?: (out: SessionOf, turns: Turn[], context: ReadContext<O>) => Turn[];
  /** The session's id when no record named one. */
  idOf: (file: string) => string;
  /** `own` without the session's text (prompts, titles, tool output), for the cursor of a turns: false read. */
  forget?: (own: O) => O;
  /** true when a totals read (ReadOptions.totals) may keep each request's model, usage and time alone, as it is
   *  added: the source sets no turn's model, usage or time after adding it, or keeps its requests in `counts` itself. Without it a totals
   *  read is a turns: false read, its requests whole. */
  totals?: true;
  /** What `record` reads of a record in a totals read: a line is then read for these fields alone, from its bytes (scan),
   *  every other value checked as JSON but not decoded, and parsed whole only when the scan leaves it to JSON.parse. It
   *  names every field whose value can change what a totals read gives (a field whose value goes only into a turn or
   *  text a totals read drops may be left out); the read itself takes the record's `timestamp`. Without it, or in any
   *  other read, each line is parsed whole. */
  fields?: Shape;
  /** The shape of the state (`own`) its cursors hold, set when it changes from one a release saved: a cursor saved at
   *  another (none for a source that never set one) is no place to go on from, and the file is read from its start. */
  stateVersion?: number;
};

/** The bytes a read takes from its file at once. */
const CHUNK = 1 << 20;

/** A line longer than the read's maxLine (ReadOptions): the read ends before decoding it. */
export class LineTooLong extends Error {
  constructor(readonly file: string, readonly offset: number, readonly bytes: number, readonly maxLine: number) {
    super(`${file}: a line at byte ${offset} is longer than ${maxLine} bytes (${bytes} so far)`);
    this.name = "LineTooLong";
  }
}

/** What a listing reads from the session's text: a turns: false cursor keeps none of it, and a read resumed from one
 *  gives none (it would describe only what was written since). */
const withoutText = <T extends SessionOf>(session: T): T => {
  const { firstPrompt: _prompt, titleText: _title, cwd: _cwd, sourceTitle: _source, ...rest } = session;
  return rest as T;
};

/** Where a read of a file stopped, and what it had read. Plain data (Maps, Sets and shared objects, no function):
 *  structuredClone or v8.serialize keeps it whole. Read it through its reader alone. A turns: true read's cursor
 *  holds the session's text, as its state does (ReadState); keep or send it as you would the session. */
export type FileCursor = {
  source: string;
  dev: number;
  ino: number;
  /** The byte after the last newline read: a last line with none is read again next time. */
  offset: number;
  /** The last bytes before `offset` (up to 64, base64): a file rewritten in place to at least the same length no longer
   *  has them there, and is read from its start. */
  mark: string;
  /** Whether the read kept turns, and whether it was a totals read: a cursor of another kind is no place to go on from. */
  keep: boolean;
  totals?: boolean;
  /** Its reader's state shape when saved (LineSource.stateVersion). */
  stateVersion?: number;
  state: ReadState;
};

/** The up to 64 bytes before `offset` in the open file, base64. */
async function markOf(handle: FileHandle, offset: number): Promise<string> {
  const n = Math.min(64, offset);
  if (n === 0) return "";
  const bytes = Buffer.alloc(n);
  const { bytesRead } = await handle.read(bytes, 0, n, offset - n);
  return bytes.subarray(0, bytesRead).toString("base64");
}

/** A read started ahead of its turn: a failure the read never gets to (a line too long ends it first) is not unhandled;
 *  awaited, it still throws. */
const ahead = <T>(read: Promise<T>): Promise<T> => {
  read.catch(() => {});
  return read;
};

/** Whether a read from `cursor` of the open file goes on from it: the same source, kind of read and state shape
 *  (LineSource.stateVersion), the same file (device and inode), no shorter, and the bytes before its offset as they
 *  were. Else it reads the file from its start. */
async function goesOn<S extends string, O>(spec: LineSource<S, O>, keep: boolean, totals: boolean, cursor: FileCursor, handle: FileHandle, stats: { dev: number; ino: number; size: number }): Promise<boolean> {
  return cursor.source === spec.source && cursor.keep === keep && (cursor.totals ?? false) === totals && cursor.stateVersion === spec.stateVersion && cursor.dev === stats.dev && cursor.ino === stats.ino && stats.size >= cursor.offset && (await markOf(handle, cursor.offset)) === cursor.mark;
}

/** Whether a read with these options is a totals read: asked for, with no turns kept, from a source that has one. */
const totalsRead = <S extends string, O>(spec: LineSource<S, O>, keep: boolean, asked: boolean): boolean => asked && !keep && spec.totals === true;

/** Whether `spec`'s line reader would go on from `cursor` in `file` now (a read with `options`), as it decides when it
 *  reads: so a reader built on it can choose how to read before reading. A file it cannot open is no place to go on. */
export async function resumes<S extends string, O>(spec: LineSource<S, O>, file: string, cursor: FileCursor | undefined, { turns: keep = true, totals: asked = false }: ReadOptions = {}): Promise<boolean> {
  if (cursor === undefined) return false;
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    return await goesOn(spec, keep, totalsRead(spec, keep, asked), cursor, handle, await handle.stat());
  } finally {
    await handle.close();
  }
}

/** The records seen, as a source asks: `extra` over `base`, so a line read that is not kept leaves `base` as it was. */
const overlay = (base: Set<string>): Set<string> => {
  const extra = new Set<string>();
  return { has: (key: string) => extra.has(key) || base.has(key), add: (key: string) => extra.add(key) } as Set<string>;
};

/** One session file of `spec`'s source, read from its start or from `cursor`. */
async function readLines<S extends string, O>(spec: LineSource<S, O>, shape: Fields | undefined, file: string, cursor: FileCursor | undefined, { turns: keep = true, totals: asked = false, seen, keepsCursor = true, [DROPS_CURSOR]: dropsCursor = false, [NO_READ_AHEAD]: inTurn = false, maxLine = Infinity }: InternalReadOptions = {}): Promise<ReadResult<S, FileCursor>> {
  const { source } = spec;
  const totals = totalsRead(spec, keep, asked);
  const fields = totals ? shape : undefined;
  const handle = await open(file, "r");
  try {
    const stats = await handle.stat();
    // The cursor's presence checked here, so `resumed` narrows it where its state and offset are read.
    const resumed = cursor !== undefined && (await goesOn(spec, keep, totals, cursor, handle, stats));
    const state = (
      resumed
        ? structuredClone(cursor.state)
        : { session: { source, id: "", file, state: "completed", child: false, turns: [], users: 0, activeMs: 0, copies: 0 }, turns: [], answers: [], names: new Map(), priced: { sum: 0, unknown: false }, activeMs: 0, own: spec.start(), ...(totals ? { counts: counts() } : {}), ...(seen ? {} : { seen: new Set<string>() }) }
    ) as ReadState<O>;
    const context: ReadContext<O> = {
      state,
      seen: seen ?? (state.seen ??= new Set()),
      keep,
      add: (turn: Turn) => {
        rememberUser(state.session, turn);
        if (keep) state.turns.push(turn);
        if (turn.role !== "assistant") return;
        if (state.counts) addRequest(state.counts, turn.model, turn.usage, turn.at);
        else state.answers.push(turn);
      },
    };
    const line = (value: unknown) => {
      if (!isObject(value)) return;
      const at = timeOf(value.timestamp);
      // A copy of a record read already moves no time: its time was counted where it was first read.
      const copy = spec.record(value, at ?? state.last ?? 0, context) === false;
      if (copy) state.session.copies += 1;
      if (at !== undefined && !copy) {
        state.first ??= at;
        // A record older than the latest (a block a resumed file repeats) moves no time either.
        if (state.last === undefined || at >= state.last) {
          if (state.last !== undefined && at - state.last <= ACTIVE_GAP_MS) state.activeMs += at - state.last;
          state.last = at;
        }
      }
    };
    // A line's bytes b[from, to): its fields alone where the source names them and the scan is sure of the line, else
    // the line decoded and parsed whole; a line that is not JSON is passed over.
    const take = (b: Buffer, from: number, to: number) => {
      let value = fields ? scan(b, from, to, fields) : undefined;
      if (value === undefined) {
        const text = b.toString("utf8", from, to);
        try {
          value = JSON.parse(text);
        } catch {
          return;
        }
      }
      line(value);
    };
    const start = resumed ? cursor.offset : 0;
    let offset = start;
    let read = 0;
    let rest: Buffer[] = [];
    let restBytes = 0;
    const tooLong = (bytes: number) => {
      if (bytes > maxLine) throw new LineTooLong(file, offset, bytes, maxLine);
    };
    if (stats.size > start) {
      // The open handle, so the bytes read are the file stat described, whatever the path names now. The buffers last the
      // whole read (a new buffer a chunk leaves freed native memory behind on every thread that reads, the read pool's):
      // two taken in turn, the next chunk read into one while this one's lines are read; read in turn (NO_READ_AHEAD),
      // one, the next chunk read into it once its lines are.
      const buffers = inTurn ? [Buffer.allocUnsafeSlow(CHUNK)] : [Buffer.allocUnsafeSlow(CHUNK), Buffer.allocUnsafeSlow(CHUNK)];
      let which = 0;
      let next = ahead(handle.read(buffers[0]!, 0, CHUNK, start));
      for (let at = start; ; ) {
        const { bytesRead } = await next;
        if (!bytesRead) break;
        const buffer = buffers[which]!;
        at += bytesRead;
        which = (which + 1) % buffers.length;
        if (!inTurn) next = ahead(handle.read(buffers[which]!, 0, CHUNK, at));
        const chunk = buffer.subarray(0, bytesRead);
        read += chunk.length;
        let from = 0;
        for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, from)) {
          tooLong(restBytes + nl - from);
          // The line in the chunk where it starts there, else its start's copies and the chunk's part as one.
          let b = chunk;
          let s = from;
          let n = nl;
          if (rest.length) {
            b = Buffer.concat([...rest, chunk.subarray(from, nl)]);
            s = 0;
            n = b.length;
            rest = [];
            restBytes = 0;
          }
          take(b, s, n > s && b[n - 1] === 13 ? n - 1 : n);
          offset += n - s + 1;
          from = nl + 1;
        }
        // The buffer is read into again: a line's start is kept as a copy.
        if (from < chunk.length) {
          restBytes += chunk.length - from;
          tooLong(restBytes);
          rest.push(Buffer.from(chunk.subarray(from)));
        }
        if (inTurn) next = handle.read(buffer, 0, CHUNK, at);
      }
    }
    // A last line with no newline yet may be a record still being written: read into this result when it is whole JSON,
    // but the cursor stays before it, its state without it. A caller that keeps the cursor reads the line again from it,
    // so its `seen` is left untouched by it; one that keeps none (readSession) has it in `seen` like any other line.
    // A caller that drops the cursor (DROPS_CURSOR) gets one on the read's own state, that line in it: no copy of the
    // whole state (the file's request index and counts with it) is made to leave the line out.
    let kept = state;
    if (rest.length) {
      if (!dropsCursor) kept = structuredClone(state);
      if (keepsCursor) context.seen = overlay(context.seen);
      const last = Buffer.concat(rest);
      take(last, 0, last.length);
    }
    const mark = await markOf(handle, offset);
    let session = finish(spec, file, state, context);
    if (!keep) {
      if (!dropsCursor) kept = { ...kept, session: withoutText(kept.session), own: spec.forget ? spec.forget(kept.own) : kept.own, ...(kept.counts ? { counts: trimmed(kept.counts) } : {}) };
      if (resumed) session = withoutText(session);
    }
    return { sessions: [{ locator: { file }, session, requests: state.answers, ...(state.counts ? { counts: state.counts } : {}) }], cursor: { source, dev: stats.dev, ino: stats.ino, offset, mark, keep, ...(totals ? { totals } : {}), ...(spec.stateVersion !== undefined ? { stateVersion: spec.stateVersion } : {}), state: kept as ReadState }, read, resumed };
  } finally {
    await handle.close();
  }
}

/** The session as read so far, the state left as it is. */
function finish<S extends string, O>(spec: LineSource<S, O>, file: string, state: ReadState<O>, context: ReadContext<O>): SessionOf<S> {
  const out = { ...state.session, file } as SessionOf<S>;
  const turns = spec.finish ? spec.finish(out, context.keep ? [...state.turns] : [], context) : context.keep ? [...state.turns] : [];
  if (!out.id) out.id = spec.idOf(file);
  if (state.first !== undefined) out.startedAt = new Date(state.first).toISOString();
  if (state.last !== undefined) out.endedAt = new Date(state.last).toISOString();
  out.activeMs = Math.round(state.activeMs);
  out.turns = turns;
  const effort = mostEffortOf(turns);
  if (effort) out.effort = effort;
  return out;
}

/** The Reader of a JSONL source: each file one locator, its cursor a FileCursor. */
export function lineReader<S extends string, O>(spec: LineSource<S, O>): Reader<S, FileCursor> {
  const { source, name, harness, order, children } = spec;
  const fields = spec.fields ? fieldsOf({ ...spec.fields, timestamp: true }) : undefined;
  return {
    source,
    name,
    harness,
    ...(order ? { order } : {}),
    discover: async (home, env) => (await spec.files(home, env)).map((file): Locator => ({ file })),
    read: (locator, cursor, options) => readLines(spec, fields, locator.file, cursor, options),
    ...(children ? { children: async (home: string, env?: Env) => (await children(home, env)).map(({ file, of }) => ({ locator: { file }, of: { file: of } })) } : {}),
  };
}
