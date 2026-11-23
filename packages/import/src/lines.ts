// A Reader for a source that writes each session as a JSONL file (Claude Code, Codex, pi): the file read a line at a time
// into a Session, a line that is not JSON, or not a record its source knows, passed over. A read goes on from a cursor:
// the file's identity (device, inode), the byte after the last whole line read, and the read's state, so a later read
// takes only the bytes written since.
import { createReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { type Env, type Locator, type Reader, type ReadOptions, type ReadResult, rememberUser } from "./reader.js";
import { isObject, mostEffortOf, timeOf } from "./text.js";
import { ACTIVE_GAP_MS, type Answer, type SessionOf, type Turn } from "./types.js";

/** One file's read so far, all of it plain data (no function, Maps and Sets allowed), so a cursor can carry it and
 *  structuredClone or v8.serialize can copy it. `answers` holds every request read, whether turns are kept or not: what
 *  a total counts. `own` is the source's own (LineSource.start). */
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
  /** The records seen, when the caller shares none across files. */
  seen?: Set<string>;
};

/** What a source's record and finish are handed: the file's state, the records seen across the import's files ("u:"
 *  a record's uuid, "m:" a request's key), whether turns are kept, and `add`, which keeps a turn (and counts a user's). */
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
};

/** Where a read of a file stopped, and what it had read. Plain data (Maps, Sets and shared objects, no function):
 *  structuredClone or v8.serialize keeps it whole. Read it through its reader alone. */
export type FileCursor = {
  source: string;
  dev: number;
  ino: number;
  /** The byte after the last newline read: a last line with none is read again next time. */
  offset: number;
  /** The last bytes before `offset` (up to 64, base64): a file rewritten in place to at least the same length no longer
   *  has them there, and is read from its start. */
  mark: string;
  /** Whether the read kept turns: a cursor of the other kind is no place to go on from. */
  keep: boolean;
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

/** The records seen, as a source asks: `extra` over `base`, so a line read that is not kept leaves `base` as it was. */
const overlay = (base: Set<string>): Set<string> => {
  const extra = new Set<string>();
  return { has: (key: string) => extra.has(key) || base.has(key), add: (key: string) => extra.add(key) } as Set<string>;
};

/** One session file of `spec`'s source, read from its start or from `cursor`. */
async function readLines<S extends string, O>(spec: LineSource<S, O>, file: string, cursor: FileCursor | undefined, { turns: keep = true, seen }: ReadOptions = {}): Promise<ReadResult<S, FileCursor>> {
  const { source } = spec;
  const handle = await open(file, "r");
  try {
    const stats = await handle.stat();
    const resumed = cursor !== undefined && cursor.source === source && cursor.keep === keep && cursor.dev === stats.dev && cursor.ino === stats.ino && stats.size >= cursor.offset && (await markOf(handle, cursor.offset)) === cursor.mark;
    const state = (
      resumed
        ? structuredClone(cursor.state)
        : { session: { source, id: "", file, state: "completed", child: false, turns: [], users: 0, activeMs: 0, copies: 0 }, turns: [], answers: [], names: new Map(), priced: { sum: 0, unknown: false }, activeMs: 0, own: spec.start(), ...(seen ? {} : { seen: new Set<string>() }) }
    ) as ReadState<O>;
    const context: ReadContext<O> = {
      state,
      seen: seen ?? (state.seen ??= new Set()),
      keep,
      add: (turn: Turn) => {
        rememberUser(state.session, turn);
        if (keep) state.turns.push(turn);
        if (turn.role === "assistant") state.answers.push(turn);
      },
    };
    const line = (text: string) => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return;
      }
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
    const start = resumed ? cursor.offset : 0;
    let offset = start;
    let read = 0;
    let rest: Buffer[] = [];
    if (stats.size > start) {
      // The open handle's descriptor, so the bytes streamed are the file stat described, whatever the path names now.
      for await (const chunk of createReadStream(file, { fd: handle.fd, start, autoClose: false, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
        read += chunk.length;
        let from = 0;
        for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, from)) {
          const whole = rest.length ? Buffer.concat([...rest, chunk.subarray(from, nl)]) : chunk.subarray(from, nl);
          rest = [];
          line(whole.toString("utf8", 0, whole.length && whole[whole.length - 1] === 13 ? whole.length - 1 : whole.length));
          offset += whole.length + 1;
          from = nl + 1;
        }
        if (from < chunk.length) rest.push(chunk.subarray(from));
      }
    }
    // A last line with no newline yet may be a record still being written: read into this result when it is whole JSON,
    // but the cursor stays before it, its state without it, and the import's `seen` untouched by it.
    let kept = state;
    if (rest.length) {
      kept = structuredClone(state);
      context.seen = overlay(context.seen);
      line(Buffer.concat(rest).toString("utf8"));
    }
    const mark = await markOf(handle, offset);
    const session = finish(spec, file, state, context);
    return { sessions: [{ locator: { file }, session, requests: state.answers }], cursor: { source, dev: stats.dev, ino: stats.ino, offset, mark, keep, state: kept as ReadState }, read, resumed };
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
  return {
    source,
    name,
    harness,
    ...(order ? { order } : {}),
    discover: async (home, env) => (await spec.files(home, env)).map((file): Locator => ({ file })),
    read: (locator, cursor, options) => readLines(spec, locator.file, cursor, options),
    ...(children ? { children: async (home: string, env?: Env) => (await children(home, env)).map(({ file, of }) => ({ locator: { file }, of: { file: of } })) } : {}),
  };
}
