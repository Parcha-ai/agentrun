// The events the page itself folds in, the tab's own messages: they never came through the server, so a new snapshot (a reconnect) would drop them, and a reload of the stage would lose them
// (the tab only says what changes). The page keeps the last few, replays them over each snapshot, and, with a store (the session's), restores them after a reload, before any feed is reachable.
import { reduce } from "../reduce.ts";
import type { ShowEvent, ShowState } from "../types.ts";

export type EventStore = { get(): string | null; set(value: string): void };

/** The events the tab can cause, with the field that carries each one's payload. Anything else in a store is not ours. */
const PAYLOAD: Record<string, string> = { net: "net", checkin: "checkin", routing: "routing", homecoming: "homecoming", "homecoming.loaded": "loadMs", tools: "tools" };

function valid(e: unknown): e is ShowEvent {
  if (e === null || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  const key = typeof o.t === "string" ? PAYLOAD[o.t] : undefined;
  if (key === undefined || typeof o.at !== "number" || !Number.isFinite(o.at)) return false;
  const v = o[key];
  return o.t === "homecoming.loaded" ? typeof v === "number" : o.t === "tools" ? Array.isArray(v) : v !== null && typeof v === "object";
}

export class LocalEvents {
  private events: ShowEvent[] = [];
  private readonly cap: number;
  private readonly store: EventStore | undefined;

  constructor(cap = 200, store?: EventStore) {
    this.cap = cap;
    this.store = store;
  }

  get size(): number {
    return this.events.length;
  }

  apply(state: ShowState, event: ShowEvent): ShowState {
    this.events.push(event);
    if (this.events.length > this.cap) this.events.shift();
    try {
      this.store?.set(JSON.stringify(this.events));
    } catch {
      // storage that is full or refused: the events still work for this page's life
    }
    return reduce(state, event);
  }

  /** Reads the store back: only events of the kinds the tab causes, each with its payload; anything else is dropped. */
  restore(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(this.store?.get() ?? "null");
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    this.events = raw.filter(valid).slice(-this.cap);
  }

  replay(state: ShowState): ShowState {
    return this.events.reduce(reduce, state);
  }
}
