// The bounds of a run's model requests (cap.ts BOUND_FIELD: the most a cache miss can make one cost beyond what its cap
// held it at), as its root's entries say them: what the run's cost serves as in flight (overshoot_bound_usd), and what the
// over-cap row and the run's end read as the bound of the requests that ended since its cost last fit its cap.
//
// The server reads a run's entries live and then again whole (a reconnect's snapshot, the settle's and a load's full read
// of the store): each entry changes the bounds once, by its id, as turns.ts reads them. A harness request (its start mark
// names its session `key` and `request`, harness-app.ts) closes when its own answer is booked, by the BOOKED marker that
// names it, in whatever order answers come; one booked before its cost came in stays open until its late cost does. pi's
// generation requests go one at a time on the root: one closes on its end mark or its answer (a second close, a stopped
// request's aborted entry after its end mark, closes nothing), never on a lost attempt's end mark (`lost`, written before
// pi-ai tries again within the same request: its answer, or its own end, still comes), and a start while one is still
// open says that one was cut
// (a crash: the next process sends the next request): pi-agent-core's loop awaits each answer before it runs that
// answer's tool calls and sends the next (agent-loop.js runLoop). pi's side requests (a label for `request`: a summary, a
// hosted search's, a learned workflow node's) run inside tool calls, which pi runs side by side (agent.js toolExecution
// "parallel"): each closes by its own `requestId`, on its end mark or its cost. A refusal's own start mark holds none.
//
// A request that will never end must not pin the bounds for the run's life. A pi side request is over once the run sends
// its next turn or harness request: pi-agent-core awaits the turn's tool calls (agent-loop.js:165, `await
// executeToolCalls`, inside which every side request runs) before it sends the next (:141), so one still open then died
// with its process (an OOM kill inside the tool call, before its cost mark): its hold is booked, it has no cost to come, and
// its bound is dropped, never summed. A harness request booked before its cost is no longer in flight (its answer is in):
// its bound waits apart for its late cost, and joins the ended bounds in the very entry that brings that cost, so it
// counts when, and only when, its cost does, whatever came between (harness answers and late costs come in any order).
//
// The bounds that ended count from the newest entry at which what the run had spent (the cap's own reading of an entry's
// cost, cap.ts costOf) fit its cap with no request in flight: read live or whole after a restart, the same entries keep
// the same bounds.
import { REQUEST_COST, REQUEST_COST_LATE, REQUEST_ENDED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { BOUND_FIELD, CAP_REFUSED_FIELD, costOf, FIT_TOLERANCE } from "./cap.js";
import { ADAPTER_API, BOOKED } from "./turn-end.js";
import { isObject, type Json } from "./validate.js";

const boundOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

export class RequestBounds {
  /** The newest entry read, by id: an entry at or before it is read again, and changes nothing. */
  private seen = -Infinity;
  /** Each request in flight that names itself: a harness request, by `<key>:<request>`, and a pi side request, by
   *  `side:<requestId>`; its bound. */
  private harness = new Map<string, number>();
  /** Each harness request booked before its cost, by `<key>:<request>`: its bound, until its late cost comes. */
  private awaiting = new Map<string, number>();
  /** pi's one generation request in flight: its bound. */
  private pi: number | undefined;
  /** The bounds of the requests that ended since the run's cost last fit its cap, together. */
  private since = 0;
  /** What the run has spent by the entries read, as the cap reads each entry's cost. */
  private spent = 0;

  /** Reads `entries` of the run's root, each once, against the run's `cap` (none: no overshoot to explain). */
  note(entries: readonly unknown[], cap?: number): void {
    for (const value of entries) {
      if (!isObject(value)) continue;
      if (typeof value.id === "number") {
        if (value.id <= this.seen) continue;
        this.seen = value.id;
      }
      this.noteOne(value);
      this.spent += costOf(value as never);
      // The run's cost fits its cap here, and no request is in flight whose cost is still to come: the bounds that ended so
      // far explain no overshoot to come.
      if (cap === undefined || (this.spent <= cap + FIT_TOLERANCE && this.pi === undefined && this.harness.size === 0)) this.since = 0;
    }
  }

  private noteOne(value: Json): void {
    const data = isObject(value.data) ? value.data : {};
    const side = typeof data.request === "string";
    const harnessKey = typeof data.key === "string" && typeof data.request === "number" ? `${data.key}:${data.request}` : side && typeof data.requestId === "string" ? `side:${data.requestId}` : undefined;
    const message = Array.isArray(value.model) && isObject(value.model[0]) ? value.model[0] : undefined;
    if (value.kind === REQUEST_STARTED) {
      if (data[CAP_REFUSED_FIELD] === true) return;
      // A turn or harness request: every side request still open died with its process (above).
      if (!side) for (const key of [...this.harness.keys()]) if (key.startsWith("side:")) this.harness.delete(key);
      if (harnessKey) this.harness.set(harnessKey, boundOf(data[BOUND_FIELD]));
      else if (side) return;
      // A pi request still open when the next starts was cut by a crash: booked at its hold, it ends with no cost of its own.
      else this.pi = boundOf(data[BOUND_FIELD]);
    } else if (value.kind === BOOKED && harnessKey) {
      if (data.unpriced !== true) this.closeHarness(harnessKey);
      else if (this.harness.has(harnessKey)) {
        this.awaiting.set(harnessKey, this.harness.get(harnessKey)!);
        this.harness.delete(harnessKey);
      }
    } else if (value.kind === REQUEST_COST_LATE && harnessKey && this.awaiting.has(harnessKey)) {
      this.since += this.awaiting.get(harnessKey)!;
      this.awaiting.delete(harnessKey);
    } else if ((value.kind === REQUEST_COST_LATE || value.kind === REQUEST_COST || value.kind === REQUEST_ENDED) && harnessKey) this.closeHarness(harnessKey);
    else if (value.kind === REQUEST_ENDED && !side && !harnessKey && data.lost !== true) this.closePi();
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

}
