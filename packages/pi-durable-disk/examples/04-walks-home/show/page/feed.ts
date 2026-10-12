// The page's view of the feed: one snapshot, then the events after it, folded by the same reducer the server uses.
// Invariant: `state` is always fold(events up to lastId); a reconnect resumes after lastId, never from scratch, unless
// the server says it reset.
import { emptyState, reduce } from "../reduce.ts";
import { apiUrl } from "./api-base.ts";
import { LocalEvents, type EventStore } from "./local-events.ts";
import type { ShowCommand, ShowEvent, ShowState } from "../types.ts";

export class Feed {
  state: ShowState = emptyState();
  lost = false;
  private lastId = -1;
  private receivedAt = performance.now();
  private floor = 0;
  /** Counts each time the feed starts over (a first connection, a reset, a retake): what the page remembers about one timeline is not true of the next. */
  generation = 0;
  private es: EventSource | null = null;
  /** What the page folded in itself (the tab's own messages), replayed over each snapshot. */
  private local: LocalEvents;
  private listeners = new Set<(event: ShowEvent | null) => void>();
  /** Where the API lives (an absolute URL ending in a slash): the origin's root by default; a page served under a path, or given `?api=`, says otherwise. */
  private readonly given: string | undefined;

  constructor(root?: string, store?: EventStore) {
    this.given = root;
    this.local = new LocalEvents(200, store);
  }

  /** After a reload of the page: the tab's events kept in the session, back in the state before any feed is reachable (offline there is none). */
  restore(): void {
    this.local.restore();
    this.state = this.local.replay(this.state);
  }

  /** Read when used, not when built: the origin's root is only known in a page. */
  private get root(): string {
    return this.given ?? new URL("/", location.href).toString();
  }

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
    this.generation++;
  }

  /** Scenario time now, in ms: the last event's time plus the time since it arrived, capped so a stalled feed does not run ahead. */
  liveNow(): number {
    return this.state.now + Math.min(performance.now() - this.receivedAt, 1500);
  }

  async connect(): Promise<void> {
    this.es?.close();
    const res = await fetch(apiUrl(this.root, "api/state"), { cache: "no-store" });
    if (!res.ok) throw new Error(`state: HTTP ${res.status}`);
    this.state = this.local.replay((await res.json()) as ShowState);
    this.resetClock();
    // The snapshot says which event it ends at. A feed that does not say gets the stream's live tail, never a replay from the
    // start: replaying events the snapshot already holds would apply every narration line twice.
    const header = res.headers.get("x-last-event-id");
    this.lastId = header === null ? -1 : Number(header);
    this.receivedAt = performance.now();
    this.notify(null);
    const es = new EventSource(apiUrl(this.root, header === null ? "api/events" : `api/events?after=${this.lastId}`));
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

  /** An event the page itself heard (the tab's message), folded in like the server's and kept across reconnects. */
  inject(event: ShowEvent): void {
    this.state = this.local.apply(this.state, event);
    // One source of time: the event was stamped from this clock (state.now plus the time since the last event), so the time since the last event starts over from it.
    this.receivedAt = performance.now();
    this.notify(event);
  }

  /** A refusal carries its reason as `message` (scripted feed) or `error` (D1's driver); both are shown the same way. */
  async command(cmd: ShowCommand): Promise<{ ok: boolean; message?: string }> {
    const res = await fetch(apiUrl(this.root, "api/command"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cmd) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    return { ok: res.ok && body.ok !== false, message: body.message ?? body.error ?? (res.ok ? undefined : `HTTP ${res.status}`) };
  }
}
