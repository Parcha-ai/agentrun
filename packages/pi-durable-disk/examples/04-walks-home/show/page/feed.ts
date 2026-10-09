// The page's view of the feed: one snapshot, then the events after it, folded by the same reducer the server uses.
// Invariant: `state` is always fold(events up to lastId); a reconnect resumes after lastId, never from scratch, unless
// the server says it reset.
import { emptyState, reduce } from "../reduce.ts";
import type { ShowCommand, ShowEvent, ShowState } from "../types.ts";

export class Feed {
  state: ShowState = emptyState();
  lost = false;
  private lastId = -1;
  private receivedAt = performance.now();
  private floor = 0;
  private es: EventSource | null = null;
  private listeners = new Set<(event: ShowEvent | null) => void>();

  onChange(fn: (event: ShowEvent | null) => void): void {
    this.listeners.add(fn);
  }

  private notify(event: ShowEvent | null): void {
    for (const fn of this.listeners) fn(event);
  }

  /**
   * Time for expiring captions: the last event's time plus the wall time since it arrived, not capped. A feed with no
   * ticks (a pipe) would otherwise leave its newest caption up forever.
   */
  captionNow(): number {
    // Never backwards between events: a quiet feed's next event can carry a time the page clock has already run past, and a note the page
    // stamped from this clock (the stage's own, such as "Wi-Fi is off") must not end up in the future. A reset starts the clock over.
    this.floor = Math.max(this.floor, this.state.now + (performance.now() - this.receivedAt));
    return this.floor;
  }

  /** A new run (or a restarted script): its time is its own, so the clock may start from the beginning. */
  resetClock(): void {
    this.floor = 0;
  }

  /** Scenario time now, in ms: the last event's time plus the time since it arrived, capped so a stalled feed does not run ahead. */
  liveNow(): number {
    return this.state.now + Math.min(performance.now() - this.receivedAt, 1500);
  }

  async connect(): Promise<void> {
    this.es?.close();
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) throw new Error(`state: HTTP ${res.status}`);
    this.state = (await res.json()) as ShowState;
    this.resetClock();
    // The snapshot says which event it ends at. A feed that does not say gets the stream's live tail, never a replay from the
    // start: replaying events the snapshot already holds would apply every narration line twice.
    const header = res.headers.get("x-last-event-id");
    this.lastId = header === null ? -1 : Number(header);
    this.receivedAt = performance.now();
    this.notify(null);
    const es = new EventSource(header === null ? "/api/events" : `/api/events?after=${this.lastId}`);
    this.es = es;
    es.onopen = () => {
      this.lost = false;
      this.notify(null);
    };
    es.onmessage = (m) => {
      const event = JSON.parse(m.data) as ShowEvent;
      this.state = reduce(this.state, event);
      this.lastId = Number(m.lastEventId || this.lastId + 1);
      this.receivedAt = performance.now();
      this.notify(event);
    };
    es.addEventListener("reset", () => void this.connect());
    es.onerror = () => {
      this.lost = true;
      this.notify(null);
    };
  }

  /** A refusal carries its reason as `message` (scripted feed) or `error` (D1's driver); both are shown the same way. */
  async command(cmd: ShowCommand): Promise<{ ok: boolean; message?: string }> {
    const res = await fetch("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cmd) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    return { ok: res.ok && body.ok !== false, message: body.message ?? body.error ?? (res.ok ? undefined : `HTTP ${res.status}`) };
  }
}
