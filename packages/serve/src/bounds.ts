// The bounds of a run's model requests (cap.ts BOUND_FIELD: the most a cache miss can make one cost beyond what its cap
// held it at), as its root's entries say them: what the run's cost serves as in flight (overshoot_bound_usd), and what the
// over-cap row and the run's end read as the bound of the requests that ended since its cost last fit its cap.
//
// The server reads a run's entries live and then again whole (a reconnect's snapshot, the settle's and a load's full read
// of the store): each entry changes the bounds once, by its id, as turns.ts reads them. A harness request (its start mark
// names its session `key` and `request`, harness-app.ts) closes when its own answer is booked, by the BOOKED marker that
// names it, in whatever order answers come; one booked before its cost came in stays open until its late cost does. pi's
// generation requests go one at a time on the root: one closes on its end mark or its answer (a second close, a stopped
// request's aborted entry after its end mark, closes nothing), and a start while one is still open says that one was cut
// (a crash: the next process sends the next request). Its side requests (a label for `request`) and a refusal's own start
// mark hold no bound.
import { REQUEST_COST_LATE, REQUEST_ENDED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { BOUND_FIELD, CAP_REFUSED_FIELD } from "./cap.js";
import { ADAPTER_API, BOOKED } from "./turn-end.js";
import { isObject, type Json } from "./validate.js";

const boundOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

export class RequestBounds {
  /** The newest entry read, by id: an entry at or before it is read again, and changes nothing. */
  private seen = -Infinity;
  /** Each harness request in flight, by `<key>:<request>`: its bound. */
  private harness = new Map<string, number>();
  /** pi's one generation request in flight: its bound. */
  private pi: number | undefined;
  /** The bounds of the requests that ended since the run's cost last fit its cap (fit), together. */
  private since = 0;

  /** Reads `entries` of the run's root, each once. */
  note(entries: readonly unknown[]): void {
    for (const value of entries) {
      if (!isObject(value)) continue;
      if (typeof value.id === "number") {
        if (value.id <= this.seen) continue;
        this.seen = value.id;
      }
      this.noteOne(value);
    }
  }

  private noteOne(value: Json): void {
    const data = isObject(value.data) ? value.data : {};
    const harnessKey = typeof data.key === "string" && typeof data.request === "number" ? `${data.key}:${data.request}` : undefined;
    const side = typeof data.request === "string";
    const message = Array.isArray(value.model) && isObject(value.model[0]) ? value.model[0] : undefined;
    if (value.kind === REQUEST_STARTED) {
      if (data[CAP_REFUSED_FIELD] === true || side) return;
      if (harnessKey) this.harness.set(harnessKey, boundOf(data[BOUND_FIELD]));
      // A pi request still open when the next starts was cut by a crash: booked at its hold, it ends with no cost of its own.
      else this.pi = boundOf(data[BOUND_FIELD]);
    } else if (value.kind === BOOKED && harnessKey) {
      if (data.unpriced !== true) this.closeHarness(harnessKey);
    } else if (value.kind === REQUEST_COST_LATE && harnessKey) this.closeHarness(harnessKey);
    else if (value.kind === REQUEST_ENDED && !side && !harnessKey) this.closePi();
    // A harness answer is closed by its BOOKED marker; pi's answer (or pi's error for a request that never left, which
    // finds none open) closes pi's.
    else if (value.kind === "pi.assistant" && message && message.api !== ADAPTER_API) this.closePi();
  }

  private closeHarness(key: string): void {
    const bound = this.harness.get(key);
    if (bound === undefined) return;
    this.harness.delete(key);
    this.since += bound;
  }

  private closePi(): void {
    if (this.pi === undefined) return;
    this.since += this.pi;
    this.pi = undefined;
  }

  /** The bounds of the requests in flight, together. */
  inFlight(): number {
    return [...this.harness.values()].reduce((sum, usd) => sum + usd, this.pi ?? 0);
  }

  /** The bounds of the requests that ended since the run's cost last fit its cap, together: how far a cache miss among
   *  them may have taken the run past its cap. */
  ended(): number {
    return this.since;
  }

  /** The run's cost fits its cap: the requests that ended so far explain no overshoot to come. */
  fit(): void {
    this.since = 0;
  }
}
