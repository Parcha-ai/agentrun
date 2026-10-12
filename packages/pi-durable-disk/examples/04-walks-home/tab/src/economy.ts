// How hard the creature page works when it is embedded under the agent's page (?econ=1). The creature shares the browser's main thread with the model's file reads and its polls, so the page does not draw
// and simulate at full rate when nobody is watching it change: it is paused while the parent says the model is loading, runs at a low rate when nothing is happening, and at the full rate for a few seconds after
// anything that changes the picture (the agent's edit, a skill switch, a policy, the user's drag or kick or command). Not embedded (a standalone page), it is always full. Pure: the clock is the caller's.

export interface EconomyOptions {
  /** False: always full (the standalone page). */
  enabled: boolean;
  /** How long full rate lasts after an event. */
  fullMs?: number;
  /** The gap between frames of work at the low rate. */
  lowIntervalMs?: number;
}

export class Economy {
  readonly enabled: boolean;
  readonly #fullMs: number;
  readonly #lowMs: number;
  #paused = false;
  #fullUntil = 0;
  #lastWork = -Infinity;
  /** Animation frames seen and frames that did the work: what a check counts. */
  ticks = 0;
  worked = 0;

  constructor(o: EconomyOptions) {
    this.enabled = o.enabled;
    this.#fullMs = o.fullMs ?? 6000;
    this.#lowMs = o.lowIntervalMs ?? 125;
  }

  get paused(): boolean { return this.#paused; }

  /** The parent says the model is loading (or done): while paused nothing is simulated or drawn. */
  pause(paused: boolean, now: number): void {
    this.#paused = this.enabled && paused;
    if (!this.#paused) this.wake(now);
  }

  /** Something changed the picture: full rate from now for a while. */
  wake(now: number, ms = this.#fullMs): void {
    this.#fullUntil = Math.max(this.#fullUntil, now + ms);
  }

  /** Whether this animation frame simulates and draws. */
  frame(now: number, dragging = false): boolean {
    this.ticks++;
    if (!this.enabled) { this.worked++; return true; }
    if (this.#paused) return false;
    if (dragging) this.wake(now);
    if (now < this.#fullUntil || now - this.#lastWork >= this.#lowMs) {
      this.#lastWork = now;
      this.worked++;
      return true;
    }
    return false;
  }
}
