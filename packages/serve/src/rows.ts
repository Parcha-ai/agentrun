// A run's timeline as /v2 serves it: every row the run shows now, numbered by change, so `after=N` answers the rows
// changed after change N and the ids dropped after it.
//
// Rows come in whole (the reducer's rows of a live run, or a released store's rows) and are diffed against what was
// served. A row keeps the seq it was first served with, so seq is the order rows first appeared; a row id that comes
// back after a drop is served under a new id, so one id never names two seqs.
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";

export type Row = TimelineEvent & { seq: number };

let latest = 0;

/** One server's change numbers: they start at its start time in microseconds, so a cursor from before a restart is below
 *  every number it hands out, and increase strictly across its runs. */
export class ChangeClock {
  readonly base = Math.max(Date.now() * 1000, latest + 1);
  private counter = this.base;
  next(): number {
    latest = Math.max(latest, ++this.counter);
    return this.counter;
  }
  get current(): number {
    return this.counter;
  }
}

export type Page = { reset: boolean; rows: Row[]; drop: string[]; next_after: number; unchanged: boolean; has_more: boolean };

type Slot = { id: string; source: string; seq: number; row: Row; change: number; dropped: boolean; text: string };

const SEQ_FREE = (row: TimelineEvent) => JSON.stringify({ ...row, seq: undefined, id: undefined });

export class RowLog {
  private readonly slots = new Map<string, Slot>();
  private readonly uses = new Map<string, number>();
  private seq = 0;
  /** The last change of this run: rows, drops and its status. */
  last: number;
  private stateChange: number;
  private state = "";
  private readonly waiters = new Set<() => void>();

  constructor(private readonly clock: ChangeClock) {
    this.last = clock.base;
    this.stateChange = clock.base;
  }

  private next(): number {
    return this.clock.next();
  }

  /** Make the served rows equal `rows`: new ids are added after every row served so far, changed ones keep their seq,
   *  and ids no longer there are dropped. Returns whether anything changed. */
  sync(rows: readonly TimelineEvent[]): boolean {
    let changed = false;
    const present = new Set<string>();
    for (const row of rows) {
      present.add(row.id);
      const text = SEQ_FREE(row);
      const slot = this.slots.get(row.id);
      if (slot && !slot.dropped) {
        if (slot.text === text) continue;
        slot.text = text;
        slot.row = { ...row, id: slot.id, seq: slot.seq };
        slot.change = this.next();
        changed = true;
        continue;
      }
      const use = (this.uses.get(row.id) ?? 0) + 1;
      this.uses.set(row.id, use);
      const id = use === 1 ? row.id : `${row.id}~${use}`;
      if (slot) this.slots.set(`${row.id}\0${slot.change}`, slot);
      const seq = this.seq++;
      this.slots.set(row.id, { id, source: row.id, seq, row: { ...row, id, seq }, change: this.next(), dropped: false, text });
      changed = true;
    }
    for (const [key, slot] of this.slots) {
      if (slot.dropped || key !== slot.source || present.has(slot.source)) continue;
      slot.dropped = true;
      slot.change = this.next();
      changed = true;
    }
    if (changed) this.touch();
    return changed;
  }

  /** The run's status and state, as one more change when they move. */
  setState(value: string): boolean {
    if (value === this.state) return false;
    this.state = value;
    this.stateChange = this.next();
    this.touch();
    return true;
  }

  rows(): Row[] {
    return [...this.slots.values()].filter((s) => !s.dropped).map((s) => s.row).sort((a, b) => a.seq - b.seq);
  }

  /** The changes after `after`, at most `limit` rows. A cursor from before this process, ahead of this run, or 0
   *  answers every row with `reset`. */
  page(after: number, limit: number): Page {
    const reset = after <= 0 || after < this.clock.base || after > this.last;
    const slots = [...this.slots.values()];
    const changed = slots.filter((s) => !s.dropped && (reset || s.change > after)).sort((a, b) => a.change - b.change);
    const has_more = changed.length > limit;
    const taken = changed.slice(0, limit);
    const upto = has_more ? taken.at(-1)!.change : this.last;
    const drop = reset ? [] : slots.filter((s) => s.dropped && s.change > after && s.change <= upto).map((s) => s.id);
    const rows = taken.map((s) => s.row).sort((a, b) => a.seq - b.seq);
    const unchanged = !reset && rows.length === 0 && drop.length === 0 && this.stateChange <= after;
    return { reset, rows, drop, next_after: upto, unchanged, has_more };
  }

  /** Resolves on the next change, or after `ms`. */
  changed(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => (clearTimeout(timer), this.waiters.delete(done), resolve());
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private touch(): void {
    this.last = this.clock.current;
    for (const wake of [...this.waiters]) wake();
  }
}
