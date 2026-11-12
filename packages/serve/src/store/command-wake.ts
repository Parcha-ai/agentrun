// A wake for command rows: a hint to read now, not a source of truth. Two paths, both after the write committed:
//   - in this process, a bus keyed by a store's `where` (two handles on the same data share one), so a write through one
//     handle wakes the readers of the others at once;
//   - across processes, the connection's wire (CommandWire): Postgres's NOTIFY and LISTEN (postgres/wake.ts), a wake file
//     beside a SQLite store's file (sqlite/wake-file.ts). Each wire event names the process and data it came from, and a
//     handle drops the ones from its own process on its own data, which the bus already brought: one wake per write.
// A wake lost on either path costs only the reader's poll: a write never waits on one, nor fails with one.
import { randomUUID } from "node:crypto";

/** What woke a listener: a command row was written for the run, or one was taken, refused or answered. */
export interface CommandWake {
  readonly runId: string;
  readonly what: "written" | "answered";
}

/** A connection's way to the other processes on its data: `send` after a commit, never waiting or throwing; `listen` hears
 *  the events the others sent (each wire's text, wireText), its first listener opening the wire's reader and its last
 *  unsubscribe closing it. The connection's close closes it too. */
export interface CommandWire {
  send(text: string): void;
  listen(hear: (text: string) => void): () => void;
}

/** What a store's wake goes through: its connection's identity and, when its data is shared across processes, its wire. */
export interface WakeAt {
  readonly where: string;
  readonly wire?: CommandWire | undefined;
}

type Listener = (event: CommandWake) => void;

const listeners = new Map<string, Set<Listener>>();

/** This process's tag on what it sends, per `where`: a handle drops a wire event with its own (the bus brought it). */
const PROCESS = randomUUID();
const sources = new Map<string, string>();
const sourceOf = (where: string): string => {
  let source = sources.get(where);
  if (source === undefined) sources.set(where, (source = `${PROCESS}.${sources.size + 1}`));
  return source;
};

/** One event as a wire carries it: `{ from, runId, what }`, one line of JSON. */
export const wireText = (where: string, event: CommandWake): string => JSON.stringify({ from: sourceOf(where), runId: event.runId, what: event.what });

/** A wire's text as an event for the handle on `where`: undefined for one from this process on this data, and for text
 *  that is not one. */
export function wireEvent(where: string, text: string): CommandWake | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { from, runId, what } = parsed as Record<string, unknown>;
  if (from === sourceOf(where) || typeof runId !== "string" || (what !== "written" && what !== "answered")) return undefined;
  return { runId, what };
}

/** Each listener told `event`, each one's throw swallowed: a listener's failure is its own. */
function tell(set: Iterable<Listener>, events: readonly CommandWake[]): void {
  for (const listener of [...set]) {
    for (const event of events) {
      try {
        listener(event);
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

/** Subscribes `listener` to the commands of the data `at` names, from this process (the bus) and from the others (its
 *  wire); answers the unsubscribe. */
export function watchCommandsAt(at: WakeAt, listener: Listener): () => void {
  const { where } = at;
  let set = listeners.get(where);
  if (set === undefined) listeners.set(where, (set = new Set()));
  const mine = set;
  mine.add(listener);
  const unhear = at.wire?.listen((text) => {
    const event = wireEvent(where, text);
    if (event !== undefined) tell([listener], [event]);
  });
  return () => {
    unhear?.();
    mine.delete(listener);
    if (mine.size === 0 && listeners.get(where) === mine) listeners.delete(where);
  };
}

/** Tells the listeners of the data `at` names about `events`, after the write committed: this process's asynchronously,
 *  the other processes' through the wire, so a write never waits on or fails with a listener. */
export function wakeCommands(at: WakeAt, ...events: readonly CommandWake[]): void {
  if (events.length === 0) return;
  if (at.wire !== undefined) {
    for (const event of events) {
      try {
        at.wire.send(wireText(at.where, event));
      } catch {
        // A wire's failure costs the other processes' readers their poll, never the write.
      }
    }
  }
  const set = listeners.get(at.where);
  if (set === undefined) return;
  queueMicrotask(() => tell(set, events));
}
