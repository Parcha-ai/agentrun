/** Whether the console can reach the server it is served from, and a fetch that rides out the server going away (a
 *  restart, a laptop asleep): a read waits and is sent again once the server answers, so a page keeps what it shows and
 *  carries on; a write is refused at once with Unreachable, since only the person can say whether to send it again.
 *  While away, one probe at a time (GET /v2/health, which needs no session) asks again on a backoff. */

export type Link =
  | { state: "online" }
  /** `attempt`: the probes failed so far; `retryAt`: when the next one goes (ms since the epoch). */
  | { state: "offline"; attempt: number; retryAt: number }
  /** Back after being away, for `resumedMs`; then online again. */
  | { state: "resumed" };

/** A write the server could not be reached for. Its message is the person's, as the page shows it. */
export class Unreachable extends Error {
  constructor() {
    super("Can't reach agentrun-serve. Try again once it's back.");
    this.name = "Unreachable";
  }
}

/** The wait before probe `attempt` (from 0): 1, 2, 4 and 8 s, then every 10 s. */
export const backoffMs = (attempt: number) => Math.min(10_000, 1000 * 2 ** attempt);

/** An answer from something in front of the server (a proxy, the dev server) rather than from it: a 5xx without the
 *  server's JSON error. The server's own 500 or 503 carries JSON, and is an answer. */
const inFront = (res: Response) => res.status >= 500 && !(res.headers.get("content-type") ?? "").includes("json");
const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";
const aborted = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));

export type Connection = ReturnType<typeof createConnection>;

export function createConnection({ fetch: f = (input, init) => globalThis.fetch(input, init), probe = "/v2/health", resumedMs = 5000 }: { fetch?: typeof fetch; probe?: string; resumedMs?: number } = {}) {
  let link: Link = { state: "online" };
  const watchers = new Set<() => void>();
  const resumes = new Set<() => void>();
  let waiting: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probing = false;
  const set = (next: Link) => { link = next; for (const w of [...watchers]) w(); };
  const schedule = (attempt: number) => {
    const ms = backoffMs(attempt);
    clearTimeout(timer);
    set({ state: "offline", attempt, retryAt: Date.now() + ms });
    timer = setTimeout(() => void probeNow(), ms);
  };
  const lost = () => { if (link.state !== "offline") schedule(0); };
  const back = () => {
    if (link.state !== "offline") return;
    clearTimeout(timer);
    set({ state: "resumed" });
    const go = waiting;
    waiting = [];
    for (const g of go) g();
    for (const r of [...resumes]) r();
    timer = setTimeout(() => { if (link.state === "resumed") set({ state: "online" }); }, resumedMs);
  };
  async function probeNow() {
    if (link.state !== "offline" || probing) return;
    clearTimeout(timer);
    probing = true;
    let answered = false;
    try { answered = !inFront(await f(probe, { method: "GET", cache: "no-store", credentials: "same-origin" })); } catch { answered = false; }
    probing = false;
    if (link.state !== "offline") return;
    if (answered) back();
    else schedule(link.attempt + 1);
  }
  /** Resolves once the server is back; rejects when `signal` aborts first. */
  const untilBack = (signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(aborted(signal));
    const stop = () => { waiting = waiting.filter((w) => w !== go); reject(aborted(signal!)); };
    const go = () => { signal?.removeEventListener("abort", stop); resolve(); };
    waiting.push(go);
    signal?.addEventListener("abort", stop, { once: true });
  });

  const watched: typeof fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const read = method === "GET" || method === "HEAD";
    for (;;) {
      let res: Response | undefined;
      try { res = await f(input, init); } catch (e) { if (init?.signal?.aborted || isAbort(e)) throw e; }
      if (res && !inFront(res)) { back(); return res; }
      lost();
      if (!read) throw new Unreachable();
      await untilBack(init?.signal);
    }
  };

  return {
    fetch: watched,
    link: () => link,
    /** Calls `fn` on every change of the link; returns its unsubscribe. */
    subscribe: (fn: () => void) => { watchers.add(fn); return () => { watchers.delete(fn); }; },
    /** Calls `fn` each time the server is back after being away; returns its unsubscribe. */
    onResume: (fn: () => void) => { resumes.add(fn); return () => { resumes.delete(fn); }; },
    /** Probes now, not at the next backoff (Retry now). */
    retryNow: () => void probeNow(),
  };
}
