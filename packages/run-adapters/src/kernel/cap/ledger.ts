// What the kernel cap counts: what the run has spent (null: unknown, never $0), and what each step under way is held at,
// by its own id, until it settles. A model request settles by how it ended, through booking.ts's one rule (answered: its
// cost, else its hold; nothing: 0; lost: its hold; stopped: what streamed, within its hold); a paid call at its charge, or
// its hold when it said none. A step settles once.
import { bookRequest } from "../../booking.js";
import type { Settled } from "./types.js";

/** A step under way: what it is held at, and for a model request what it counts at if stopped having streamed that many. */
export type Hold = { readonly usd: number; readonly stoppedPrice?: (streamedTokens: number) => number };

export class Ledger {
  #spent: number | null;
  readonly #holds = new Map<string, Hold>();

  constructor(spentUsd: number | null) {
    this.#spent = spentUsd;
  }

  spent(): number | null {
    return this.#spent;
  }

  held(): number {
    let sum = 0;
    for (const hold of this.#holds.values()) sum += hold.usd;
    return sum;
  }

  hold(id: string, hold: Hold): void {
    if (this.#holds.has(id)) throw new Error(`the cap already holds a step ${id}: each step holds under its own id`);
    this.#holds.set(id, hold);
  }

  /** Lets `id`'s hold go with nothing booked: a step that never left (its start mark could not be written). */
  release(id: string): void {
    this.#holds.delete(id);
  }

  /** Lets `id`'s hold go and books what it ended at, with the rule that gave it. A step it never held books its own figure
   *  (a paid call's charge, an answer's cost), or nothing that can be known. */
  settle(id: string, ended: Settled): { usd: number | null; rule: string } {
    const hold = this.#holds.get(id);
    this.#holds.delete(id);
    let booked: { usd: number | null; rule: string };
    if (ended.end === "charged") {
      const said = typeof ended.usd === "number" && Number.isFinite(ended.usd) && ended.usd >= 0;
      booked = { usd: said ? (ended.usd as number) : hold?.usd ?? null, rule: said ? "charged" : "charged:held" };
    } else {
      booked = bookRequest(ended, { ...(hold ? { hold: hold.usd } : {}), ...(hold?.stoppedPrice ? { stoppedPrice: hold.stoppedPrice } : {}) });
    }
    const usd = booked.usd;
    this.#spent = this.#spent === null || usd === null ? null : this.#spent + usd;
    return booked;
  }
}
