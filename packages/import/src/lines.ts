// A Reader for a source that writes each session as a JSONL file (Claude Code, Codex, pi): the file read a line at a time
// into a Session, a line that is not JSON, or not a record its source knows, passed over. Each read takes the whole file.
import { createReadStream } from "node:fs";
import { type Env, type Locator, type Reader, type ReadOptions, type ReadResult, rememberUser } from "./reader.js";
import { isObject, mostEffortOf, timeOf } from "./text.js";
import { ACTIVE_GAP_MS, type Answer, type SessionOf, type Turn } from "./types.js";

/** One file's read so far. `answers` holds every request read, whether turns are kept or not: what a total counts.
 *  `own` is the source's own (LineSource.start). */
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
   *  `out` and return the turns in their order. */
  finish?: (out: SessionOf, turns: Turn[], context: ReadContext<O>) => Turn[];
  /** The session's id when no record named one. */
  idOf: (file: string) => string;
};

/** One session file of `spec`'s source, read whole. */
async function readLines<S extends string, O>(spec: LineSource<S, O>, file: string, { turns: keep = true, seen }: ReadOptions = {}): Promise<ReadResult<S>> {
  const { source } = spec;
  const state: ReadState<O> = { session: { source, id: "", file, state: "completed", child: false, turns: [], users: 0, activeMs: 0, copies: 0 }, turns: [], answers: [], names: new Map(), priced: { sum: 0, unknown: false }, activeMs: 0, own: spec.start() };
  const context: ReadContext<O> = {
    state,
    seen: seen ?? new Set(),
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
  let rest: Buffer[] = [];
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, from)) {
      const whole = rest.length ? Buffer.concat([...rest, chunk.subarray(from, nl)]) : chunk.subarray(from, nl);
      rest = [];
      line(whole.toString("utf8", 0, whole.length && whole[whole.length - 1] === 13 ? whole.length - 1 : whole.length));
      from = nl + 1;
    }
    if (from < chunk.length) rest.push(chunk.subarray(from));
  }
  // A last line with no newline is read like any other: whole JSON counts, a line still being written is passed over.
  if (rest.length) line(Buffer.concat(rest).toString("utf8"));
  return { sessions: [{ locator: { file }, session: finish(spec, file, state, context), requests: state.answers }] };
}

/** The session the file holds, as read. */
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

/** The Reader of a JSONL source: each file one locator. */
export function lineReader<S extends string, O>(spec: LineSource<S, O>): Reader<S> {
  const { source, name, harness, order, children, idOf } = spec;
  return {
    source,
    name,
    harness,
    idOf: (locator) => idOf(locator.file),
    ...(order ? { order } : {}),
    discover: async (home, env) => (await spec.files(home, env)).map((file): Locator => ({ file })),
    read: (locator, options) => readLines(spec, locator.file, options),
    ...(children ? { children: async (home: string, env?: Env) => (await children(home, env)).map(({ file, of }) => ({ locator: { file }, of: { file: of } })) } : {}),
  };
}
