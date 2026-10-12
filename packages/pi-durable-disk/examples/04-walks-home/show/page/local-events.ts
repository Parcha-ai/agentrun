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
  private ring: ShowEvent[] = [];
  /** The latest event of each kind: a fact that has not changed (the net, the check-in, the homecoming) must outlive any number of later events, so it is kept beside the ring, not in it. */
  private pinned = new Map<string, ShowEvent>();
  private readonly cap: number;
  private readonly store: EventStore | undefined;

  constructor(cap = 200, store?: EventStore) {
    this.cap = cap;
    this.store = store;
  }

  /** The ring and the pinned latest of each kind, in the order they happened, each once. */
  private all(): ShowEvent[] {
    return [...new Set([...this.ring, ...this.pinned.values()])].sort((a, b) => a.at - b.at);
  }

  get size(): number {
    return this.all().length;
  }

  apply(state: ShowState, event: ShowEvent): ShowState {
    this.ring.push(event);
    if (this.ring.length > this.cap) this.ring.shift();
    this.pinned.set(event.t, event);
    try {
      this.store?.set(JSON.stringify(this.all()));
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
    const events = raw.filter(valid);
    this.ring = events.slice(-this.cap);
    this.pinned = new Map();
    for (const e of events) this.pinned.set(e.t, e);
  }

  replay(state: ShowState): ShowState {
    return this.all().reduce(reduce, state);
  }
}
