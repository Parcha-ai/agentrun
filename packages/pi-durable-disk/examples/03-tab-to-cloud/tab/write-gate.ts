// A gate for the writes a page does on someone else's behalf (the creature page's files), so a checkout can scan the workspace with none in flight and none arriving: `run` holds a write while the gate is
// closed and tracks it once it starts, `drain` waits for the ones in flight. Portable: the clock is injected.
export class WriteGate {
  readonly #pending = new Set<Promise<void>>();
  readonly #closed: () => boolean;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxWaitMs: number;
  readonly #now: () => number;

  constructor(closed: () => boolean, sleep: (ms: number) => Promise<void>, maxWaitMs = 300_000, now: () => number = Date.now) {
    this.#closed = closed;
    this.#sleep = sleep;
    this.#maxWaitMs = maxWaitMs;
    this.#now = now;
  }

  /** Run `write` once the gate is open (a gate closed for longer than the limit refuses with `not-holder`); it counts as in flight until it settles. */
  async run(write: () => Promise<void>): Promise<void> {
    const until = this.#now() + this.#maxWaitMs;
    while (this.#closed()) {
      if (this.#now() > until) throw new Error("not-holder");
      await this.#sleep(100);
    }
    const started = write(); // no await between the check above and this: a write that passed the gate is in the set before anyone can close it
    this.#pending.add(started);
    try { await started; } finally { this.#pending.delete(started); }
  }

  /** Every write that has started has settled (a failed one counts: it wrote nothing more). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
}
