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
    return this.state.now + (performance.now() - this.receivedAt);
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
    this.lastId = Number(res.headers.get("x-last-event-id") ?? -1);
    this.receivedAt = performance.now();
    this.notify(null);
    const es = new EventSource(`/api/events?after=${this.lastId}`);
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
