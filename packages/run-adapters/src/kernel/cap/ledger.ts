// What the kernel cap counts: what the run has spent (null: unknown, never $0), and what each step under way is held at,
// by its own id, until it settles. A model request settles by how it ended, through booking.ts's one rule (answered: its
// cost, else its hold; nothing: 0; lost: its hold; stopped: what streamed, within its hold); a paid call at its charge, or
// its hold when it said none. A step books once: a settle retried answers the first booking. An id may be used again once
// its step has settled: each use holds and books on its own. A settle of an id the ledger never held is refused.
import { bookRequest } from "../../booking.js";
import type { Settled } from "./types.js";

/** A step under way: what it is held at (null with no cap: nothing held, an unknown figure if it never says its cost),
 *  and for a model request what it counts at if stopped having streamed that many. */
export type Hold = { readonly usd: number | null; readonly stoppedPrice?: (streamedTokens: number) => number };
export type Booking = { readonly usd: number | null; readonly rule: string };

/** A settle of an id the ledger never held: refused, nothing booked. */
export class StepNotHeld extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`the cap holds no step ${id}: nothing was booked (a step settles under the id it was admitted with)`);
    this.name = "StepNotHeld";
    this.id = id;
  }
}

export class Ledger {
  #spent: number | null;
  readonly #holds = new Map<string, Hold>();
  /** Each id's last booking: a settle retried after it (its marks failed) answers it, never books again. */
  readonly #booked = new Map<string, Booking>();

  constructor(spentUsd: number | null) {
    this.#spent = spentUsd;
  }

  spent(): number | null {
    return this.#spent;
  }

  held(): number {
    let sum = 0;
    for (const hold of this.#holds.values()) if (hold.usd !== null) sum += hold.usd;
    return sum;
  }

  /** Whether a step is under way under `id`. */
  holds(id: string): boolean {
    return this.#holds.has(id);
  }

  /** Holds a step under `id`: refused while another step holds under it; an id whose step settled is free again. */
  hold(id: string, hold: Hold): void {
    if (this.#holds.has(id)) throw new Error(`the cap already holds a step ${id}: each step under way holds under its own id`);
    this.#holds.set(id, hold);
    this.#booked.delete(id);
  }

  /** Lets `id`'s hold go with nothing booked: a step that never left (its start mark could not be written). */
  release(id: string): void {
    this.#holds.delete(id);
  }

  /** Lets `id`'s hold go and books what its step ended at, with the rule that gave it. With no step under way under `id`:
   *  the booking of the step that last settled under it (a retried settle), else StepNotHeld. */
  settle(id: string, ended: Settled): Booking {
    const hold = this.#holds.get(id);
    if (!hold) {
      const last = this.#booked.get(id);
      if (last) return last;
      throw new StepNotHeld(id);
    }
    this.#holds.delete(id);
    let booked: Booking;
    if (ended.end === "charged") {
      const said = typeof ended.usd === "number" && Number.isFinite(ended.usd) && ended.usd >= 0;
      booked = { usd: said ? (ended.usd as number) : hold.usd, rule: said ? "charged" : "charged:held" };
    } else {
      booked = bookRequest(ended, { ...(hold.usd === null ? {} : { hold: hold.usd }), ...(hold.stoppedPrice ? { stoppedPrice: hold.stoppedPrice } : {}) });
    }
    const usd = booked.usd;
    this.#spent = this.#spent === null || usd === null ? null : this.#spent + usd;
    this.#booked.set(id, booked);
    return booked;
  }
}
