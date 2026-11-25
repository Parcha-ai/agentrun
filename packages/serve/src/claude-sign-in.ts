// The CLI's own sign-in this server started (POST /settings/claude-login/login), kept for as long as this process runs,
// so GET /settings/claude-login can say what became of it, after a reload too: waiting for the browser since its start,
// ended signed in, stopped at its limit, ended without signing in (the CLI's exit code), or never started. One at a time:
// while it waits, the CLI holds a localhost port for the browser's answer, so a second start ends a waiting one first and
// waits for it to go. Nothing of the sign-in is read here but how its process ended (the harness's startClaudeLogin).
import type { ClaudeSignIn, ClaudeSignInEnd } from "@parcha/agentrun-harness-claude";

/** How long a sign-in waits for its browser by default: the harness's own limit. */
export const SIGN_IN_LIMIT_MS = 10 * 60_000;

/** A sign-in as GET /settings/claude-login says it. `state`: `waiting` (for the browser, since `started_at`),
 *  `signed_in` (the CLI exited 0), `timed_out` (ended after `limit_ms` with no answer from the browser), `failed` (the
 *  CLI ended without signing in: `exit_code`, or the `signal` that ended it), `not_started` (the CLI could not be
 *  started: `error`). */
export type SignInView = {
  state: "waiting" | "signed_in" | "timed_out" | "failed" | "not_started";
  started_at: string;
  ended_at?: string;
  limit_ms: number;
  exit_code?: number;
  signal?: string;
  error?: string;
};

const words = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 200);

/** The view of a sign-in that ended as `end`. */
function endedView(started: Omit<SignInView, "state">, end: ClaudeSignInEnd, at: string): SignInView {
  const ended = { ...started, ended_at: at };
  switch (end.end) {
    case "exited":
      if (end.code === 0) return { ...ended, state: "signed_in" };
      return { ...ended, state: "failed", ...(end.code !== null ? { exit_code: end.code } : {}), ...(end.signal ? { signal: end.signal } : {}) };
    case "timed_out":
      return { ...ended, state: "timed_out" };
    case "failed":
      return { ...ended, state: "not_started", error: end.message };
    case "stopped":
      // Only this server stops one, and it forgets it as it does (a turn's stop), so this view is never kept.
      return { ...ended, state: "failed" };
  }
}

/** What a turn on the sign-ins' queue (ClaudeSignIns.serial) does to the sign-in, at once, as the turn holds the queue:
 *  end the one that waits and start another (`start`), or end it and forget it (`stop`). */
export type SignInTurn = {
  start(begin: (limitMs: number) => ClaudeSignIn): Promise<SignInView>;
  stop(): Promise<void>;
};

/** The one sign-in this server started, and its start and stop. `limitMs`: how long a sign-in waits for its browser
 *  (SIGN_IN_LIMIT_MS by default; a test's is short). `now`: the clock its times are read from. */
export class ClaudeSignIns {
  readonly limitMs: number;
  readonly #now: () => number;
  #current: { view: SignInView; handle?: ClaudeSignIn } | undefined;
  // Each start or stop counts one: an end that arrives after a later start or stop is not kept.
  #epoch = 0;
  // The turns (serial), one after another, so two presses at once never leave two CLIs waiting on one port, and a change
  // of the login's setting never lands between a sign-in's read of it and its start.
  #queue: Promise<unknown> = Promise.resolve();
  // Set at the server's stop (close): no start after it spawns a CLI.
  #closed = false;
  // The turns asked and not yet ended (busy).
  #turns = 0;

  constructor(options: { limitMs?: number; now?: () => number } = {}) {
    this.limitMs = options.limitMs ?? SIGN_IN_LIMIT_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Whether a turn holds the queue now, or waits for one, so a turn asked now waits (the server logs it: server.ts
   *  loginNow). */
  get busy(): boolean {
    return this.#turns > 0;
  }

  /** The sign-in as it stands, or undefined when none was started here (or it was stopped). */
  view(): SignInView | undefined {
    return this.#current ? { ...this.#current.view } : undefined;
  }

  /** One turn on the queue: `work` runs alone, after every turn asked before it and before every one asked after, and
   *  starts or ends the sign-in through its `turn`. Every change of the login's setting and every start of a sign-in is a
   *  turn (claude-login.ts: the turn-on, the turn-off, the sign-in's start and the drop at the server's start), each
   *  reading the setting inside it, so none lands between another's read and its start or save. A turn lasts while it
   *  decides and starts: a sign-in's wait for its browser is no turn's. A turn that throws rejects its own answer alone;
   *  the next turn runs as if it had ended. A sign-in starts and ends only through a turn's `start` and `stop`: there is no
   *  start or stop beside them, since one called inside a turn would wait for that turn to end, for ever. */
  serial<T>(work: (turn: SignInTurn) => Promise<T>): Promise<T> {
    this.#turns += 1;
    const next = this.#queue.then(() => work({ start: (begin) => this.#start(begin), stop: () => this.#end() }));
    const ended = () => void (this.#turns -= 1);
    this.#queue = next.then(ended, ended);
    return next;
  }

  /** The server's stop: a turn that ends a sign-in that waits and forgets it, resolving once its CLI is gone; a start
   *  asked after it (a request still in flight) spawns nothing. A CLI left waiting would keep the browser's callback port
   *  from the next server's sign-in. */
  close(): Promise<void> {
    this.#closed = true;
    return this.serial((turn) => turn.stop());
  }

  async #start(begin: (limitMs: number) => ClaudeSignIn): Promise<SignInView> {
    await this.#end();
    const epoch = ++this.#epoch;
    const started = { started_at: new Date(this.#now()).toISOString(), limit_ms: this.limitMs };
    if (this.#closed) {
      this.#current = { view: { ...started, state: "not_started", ended_at: started.started_at, error: "this server is stopping" } };
      return this.view()!;
    }
    let handle: ClaudeSignIn;
    try {
      handle = begin(this.limitMs);
    } catch (error) {
      this.#current = { view: { ...started, state: "not_started", ended_at: started.started_at, error: words(error) } };
      return this.view()!;
    }
    this.#current = { view: { ...started, state: "waiting" }, handle };
    void handle.ended.then((end) => {
      if (epoch === this.#epoch) this.#current = { view: endedView(started, end, new Date(this.#now()).toISOString()) };
    });
    return this.view()!;
  }

  async #end(): Promise<void> {
    const current = this.#current;
    this.#epoch++;
    this.#current = undefined;
    if (current?.view.state !== "waiting" || !current.handle) return;
    current.handle.stop();
    await current.handle.ended;
  }
}
