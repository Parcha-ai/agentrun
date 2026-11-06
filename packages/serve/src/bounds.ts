// The bounds of a run's model requests (cap.ts BOUND_FIELD: the most a cache miss can make one cost beyond what its cap
// held it at), as its root's entries say them: what the run's cost serves as in flight (overshoot_bound_usd), and what the
// over-cap row and the run's end read as the bound of the requests that ended.
import { REQUEST_CONTINUED, REQUEST_ENDED, REQUEST_REFUSED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { BOUND_FIELD, CAP_REFUSED_FIELD } from "./cap.js";
import { isObject, type Json } from "./validate.js";

/** The bounds of a run's generation requests in flight, oldest first (0 for one whose start mark has none), and the bound
 *  of the newest one that ended. Its error entries that answer no request (a refusal of its cap's, which has a start mark
 *  of its own, or its cancel's) and a harness answer's continuation close none. */
export class RequestBounds {
  private open: number[] = [];
  private last = 0;
  private skipErrors = 0;
  private continued = 0;

  /** Reads `entries` of the run's root: a generation request's start opens its bound, and its end or answer closes the
   *  oldest open, as the requests of a run answer in order. */
  note(entries: readonly unknown[]): void {
    for (const value of entries) if (isObject(value)) this.noteOne(value);
  }

  private noteOne(value: Json): void {
    const data = isObject(value.data) ? value.data : {};
    const side = typeof data.request === "string";
    const message = Array.isArray(value.model) && isObject(value.model[0]) ? value.model[0] : undefined;
    const close = () => void (this.open.length && (this.last = this.open.shift()!));
    if (value.kind === REQUEST_STARTED && data[CAP_REFUSED_FIELD] === true) this.skipErrors += 1;
    else if (value.kind === REQUEST_STARTED && !side) this.open.push(typeof data[BOUND_FIELD] === "number" && Number.isFinite(data[BOUND_FIELD]) && (data[BOUND_FIELD] as number) > 0 ? (data[BOUND_FIELD] as number) : 0);
    else if (value.kind === REQUEST_REFUSED) this.skipErrors += 1;
    else if (value.kind === REQUEST_CONTINUED) this.continued += 1;
    else if (value.kind === REQUEST_ENDED && !side) close();
    else if (value.kind === "pi.assistant" && message) {
      if (this.continued > 0) this.continued -= 1;
      else if (message.stopReason === "error" && this.skipErrors > 0) this.skipErrors -= 1;
      else close();
    }
  }

  /** The bounds of the requests in flight, together. */
  inFlight(): number {
    return this.open.reduce((sum, usd) => sum + usd, 0);
  }

  /** The bound the over-cap row and the run's end read: the newest ended request's. */
  ended(): number {
    return this.last;
  }

  /** The run's cost fits its cap: the bounds that ended so far explain no overshoot to come. */
  fit(): void {}
}
