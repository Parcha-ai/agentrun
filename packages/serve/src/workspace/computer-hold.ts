// A person's hold on a run's desktop or phone, in the run's process (the runner's, beside the computer): who drives it
// now, the agent or its owner. The owner takes it (the run view's take-over, or the viewer's own Take over) and hands it
// back; the agent asks for them (computer_request_handoff) and waits for their answer.
//
// Three states: `agent` (the agent drives); `pending` (the owner took it while an agent call was in flight: that call is
// waited out, so the gate never cuts an action in half, and new agent calls are parked); `person` (the owner drives,
// and the agent's calls are parked). A take ends in one of five ways: `given` (handed back), `answered` (the agent's ask
// was answered while the owner held it), `idle` (no input from the owner for HOLD_IDLE_MS), `away` (the viewer closed or
// lost its socket: back at once) or `released` (the computer's session ended). At the hand-back a parked look (a
// screenshot, the app list) runs on the screen as the person left it; a parked act (input, a tap, a swipe, typing,
// opening an app) is not done: the model is told the person had the computer, and to look again first. exec, files and
// processes are not the person's: they pass through.
//
// The agent's ask (`ask`): one at a time; it waits until the owner answers (done or cancelled), until it expires
// (HOLD_ASK_MAX_MS at most), or until its signal aborts. A hand-back while the owner holds the computer answers it done.
//
// Every change is an event (`on`): the run's journal records them (runner/computer-journal.ts), which is what the server
// reads (computer-view.ts). The hold itself keeps nothing beyond this process.
import { randomBytes } from "node:crypto";
import type { Hands } from "./hands.js";

/** How long a take lasts with no input from the person before the computer goes back to the agent. */
export const HOLD_IDLE_MS = 15 * 60_000;
/** The longest an agent's ask waits for the person. */
export const HOLD_ASK_MAX_MS = 15 * 60_000;

/** Who drives the computer now. */
export type HoldState = "agent" | "pending" | "person";
/** How a take ended. */
export type HoldEnd = "given" | "answered" | "idle" | "away" | "released";
/** How an ask ended. */
export type AskOutcome = "done" | "cancelled" | "expired";

/** What the agent asks the person to do. */
export type HandoffRequest = { readonly instruction: string; readonly completion_condition: string; readonly expires_at?: string };
/** An open ask, as the run's journal and the server's read have it. */
export type HoldAsk = { readonly id: string; readonly instruction: string; readonly completion_condition: string; readonly asked_at: string; readonly expires_at: string };

/** One change of the hold, at its own time (`at`, ms), with who drives after it (`state`: every event has it, as the
 *  viewer's listener reads it, tl-browser's ViewerHold). `take` names the take a state belongs to; `by`, the command row
 *  that made the change (a take-over's, a hand-back's), when one did. */
export type HoldEvent =
  | { readonly type: "state"; readonly state: HoldState; readonly take: string; readonly ended?: HoldEnd; readonly by?: number; readonly at: number }
  | { readonly type: "asked"; readonly state: HoldState; readonly ask: HoldAsk; readonly at: number }
  | { readonly type: "answered"; readonly state: HoldState; readonly id: string; readonly outcome: AskOutcome; readonly by?: number; readonly at: number };

/** The agent's ask, as the kernel registry's handoff port takes it (run-adapters kernel/registry Hands.handoff). */
export type Handoff = { ask(request: HandoffRequest, signal?: AbortSignal): Promise<{ readonly outcome: AskOutcome }> };

/** One run's computer, held or not by a person. Its viewer side (state, take, give, away, touched, on, asked) is the
 *  shape tl-browser's run-side viewer calls (computer-live REGISTRATION.md ViewerHold). */
export type ComputerHold = {
  state(): HoldState;
  /** The current take's name, while one is pending or held. */
  current(): string | undefined;
  /** The person takes it: pending while an agent call is in flight, then theirs. False (nothing changes) when a take is
   *  pending or held already, or the hold is closed. `by`: the command row that asked. */
  take(options?: { readonly by?: number }): boolean;
  /** The take ends (`given` by default): false when there was none. A hand-back while the agent's ask is open answers it
   *  done, and the take ends `answered`. */
  give(why?: HoldEnd, options?: { readonly by?: number }): boolean;
  /** The viewer closed or lost its socket: the computer goes back to the agent at once. */
  away(): void;
  /** Input from the person while they hold it: the idle bound starts again. */
  touched(): void;
  /** The agent's open ask, if any. */
  asked(): HoldAsk | undefined;
  /** The agent asks for the person: one ask at a time. */
  ask: Handoff["ask"];
  /** The person's answer to ask `id`: false when it is not the open ask. */
  answer(id: string, outcome: "done" | "cancelled", options?: { readonly by?: number }): boolean;
  /** An agent call through the hold's ports: resolves once the agent drives, then counts the call as in flight until the
   *  returned function is called. Rejects with `signal`'s reason when it aborts first. */
  enter(signal?: AbortSignal): Promise<() => void>;
  /** Moves at each change of hands. */
  epoch(): number;
  /** Called with every change. Returns the unsubscribe. */
  on(listener: (event: HoldEvent) => void): () => void;
  /** The computer's session is over: a take ends `released`, an open ask is let go, and nothing new is taken. */
  close(): void;
};

export type Timers = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
const NODE_TIMERS: Timers = { set: (run, ms) => { const handle = setTimeout(run, ms); (handle as { unref?(): void }).unref?.(); return handle; }, clear: (handle) => clearTimeout(handle as NodeJS.Timeout) };

/** The agent's second ask while one is open, in words. */
export const ASK_WAITING = "the agent's hand-over is already waiting for the person";
/** An ask let go because the computer's session ended. */
const ASK_CLOSED = "the run's computer was let go before the person answered";

/** A run's computer's hold. `timers` and `now` are the test's own clock. */
export function computerHold(options: { readonly idleMs?: number; readonly askMaxMs?: number; readonly timers?: Timers; readonly now?: () => number } = {}): ComputerHold {
  const idleMs = options.idleMs ?? HOLD_IDLE_MS;
  const askMaxMs = options.askMaxMs ?? HOLD_ASK_MAX_MS;
  const timers = options.timers ?? NODE_TIMERS;
  const now = options.now ?? Date.now;
  let state: HoldState = "agent";
  let take: string | undefined;
  let idle: unknown;
  let inFlight = 0;
  let epoch = 0;
  let closed = false;
  let open: { ask: HoldAsk; timer: unknown; settle(outcome: AskOutcome): void; fail(error: unknown): void } | undefined;
  const waiters = new Set<() => void>();
  const listeners = new Set<(event: HoldEvent) => void>();
  const emit = (event: HoldEvent): void => {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* a listener's error is not the hold's */ }
    }
  };
  const armIdle = (): void => {
    if (idle !== undefined) timers.clear(idle);
    idle = timers.set(() => void give("idle"), idleMs);
  };
  const toPerson = (by?: number): void => {
    state = "person";
    armIdle();
    emit({ type: "state", state, take: take!, ...(by !== undefined ? { by } : {}), at: now() });
  };
  const settleAsk = (outcome: AskOutcome, by?: number): void => {
    const asked = open!;
    open = undefined;
    timers.clear(asked.timer);
    emit({ type: "answered", state, id: asked.ask.id, outcome, ...(by !== undefined ? { by } : {}), at: now() });
    asked.settle(outcome);
  };
  function endTake(why: HoldEnd, ended: string, by?: number): void {
    if (idle !== undefined) timers.clear(idle);
    idle = undefined;
    state = "agent";
    take = undefined;
    epoch++;
    emit({ type: "state", state, take: ended, ended: why, ...(by !== undefined ? { by } : {}), at: now() });
    for (const waiter of [...waiters]) waiter();
  }
  function give(why: HoldEnd = "given", { by }: { readonly by?: number } = {}): boolean {
    if (state === "agent") return false;
    // A hand-back while the agent's ask is open answers it done: the take ends answered.
    if (why === "given" && open) {
      endTake("answered", take!, by);
      settleAsk("done", by);
      return true;
    }
    endTake(why, take!, by);
    return true;
  }
  return {
    state: () => state,
    current: () => take,
    take({ by } = {}) {
      if (closed || state !== "agent") return false;
      take = by !== undefined ? `c${by}` : `v${now()}-${randomBytes(3).toString("hex")}`;
      epoch++;
      if (inFlight > 0) {
        state = "pending";
        emit({ type: "state", state, take, ...(by !== undefined ? { by } : {}), at: now() });
      } else toPerson(by);
      return true;
    },
    give,
    away: () => void give("away"),
    touched() {
      if (state === "person") armIdle();
    },
    asked: () => open?.ask,
    ask(request, signal) {
      if (closed) return Promise.reject(new Error(ASK_CLOSED));
      if (open) return Promise.reject(new Error(ASK_WAITING));
      if (signal?.aborted) return Promise.reject(signal.reason);
      const at = now();
      const wanted = request.expires_at !== undefined ? Date.parse(request.expires_at) : Number.NaN;
      const expiresAt = Number.isFinite(wanted) ? Math.min(wanted, at + askMaxMs) : at + askMaxMs;
      const ask: HoldAsk = { id: randomBytes(16).toString("base64url"), instruction: request.instruction, completion_condition: request.completion_condition, asked_at: new Date(at).toISOString(), expires_at: new Date(expiresAt).toISOString() };
      return new Promise((resolve, reject) => {
        const aborted = (): void => {
          if (open?.ask.id !== ask.id) return;
          timers.clear(open.timer);
          open = undefined;
          reject(signal!.reason);
        };
        open = {
          ask,
          timer: timers.set(() => void (open?.ask.id === ask.id && settleAsk("expired")), Math.max(0, expiresAt - at)),
          settle: (outcome) => { signal?.removeEventListener("abort", aborted); resolve({ outcome }); },
          fail: (error) => { signal?.removeEventListener("abort", aborted); reject(error); },
        };
        signal?.addEventListener("abort", aborted, { once: true });
        emit({ type: "asked", state, ask, at });
      });
    },
    answer(id, outcome, { by } = {}) {
      if (open?.ask.id !== id) return false;
      // Answered while the person holds the computer: the take ends with it.
      if (state !== "agent") endTake("answered", take!, by);
      settleAsk(outcome, by);
      return true;
    },
    async enter(signal) {
      while (state !== "agent") {
        if (signal?.aborted) throw signal.reason;
        await new Promise<void>((resolve, reject) => {
          const done = (): void => { cleanup(); resolve(); };
          const aborted = (): void => { cleanup(); reject(signal!.reason); };
          const cleanup = (): void => { waiters.delete(done); signal?.removeEventListener("abort", aborted); };
          waiters.add(done);
          signal?.addEventListener("abort", aborted, { once: true });
        });
      }
      inFlight++;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        inFlight--;
        // The call the take waited for is over: the person drives.
        if (inFlight === 0 && state === "pending") toPerson();
      };
    },
    epoch: () => epoch,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      if (state !== "agent") endTake("released", take!);
      if (open) {
        const asked = open;
        open = undefined;
        timers.clear(asked.timer);
        asked.fail(new Error(ASK_CLOSED));
      }
    },
  };
}

/** What the model is told of an act it asked for while the person had the computer: not done, look again. */
export const personHadWords = (computer: "desktop" | "phone", act: string): string =>
  `The person had this ${computer}: they took it over from the run's view and have handed it back, so this ${act} was not done. The screen may have changed: take a screenshot before you act again.`;

/** The code a parked act throws, as the kernel's ports throw a refusal: the registry's executors answer it in its words. */
export const TAKEN_OVER = "taken_over";

const refusal = (computer: "desktop" | "phone", act: string): Error =>
  Object.assign(new Error(personHadWords(computer, act)), { code: TAKEN_OVER });

/** The port method `method` of `port`, a look: parked while the person has the computer, then run (as the agent's call
 *  in flight, which a take waits out). */
function look<P extends object, K extends keyof P>(port: P, method: K, hold: ComputerHold): P[K] {
  const original = port[method] as unknown as (...args: unknown[]) => unknown;
  return (async (...args: unknown[]) => {
    const leave = await hold.enter();
    try {
      return await original.apply(port, args);
    } finally {
      leave();
    }
  }) as unknown as P[K];
}

/** The port method `method` of `port`, an act: made with the agent driving, it runs (in flight, so a take waits it out);
 *  made while the person has the computer, it waits for the hand-back and is not done. */
function act<P extends object, K extends keyof P>(port: P, method: K, hold: ComputerHold, computer: "desktop" | "phone", what: string): P[K] {
  const original = port[method] as unknown as (...args: unknown[]) => unknown;
  return (async (...args: unknown[]) => {
    const parked = hold.state() !== "agent";
    const leave = await hold.enter();
    if (parked) {
      leave();
      throw refusal(computer, what);
    }
    try {
      return await original.apply(port, args);
    } finally {
      leave();
    }
  }) as unknown as P[K];
}

/** The kernel's narrow ports a desktop and a phone have, as heldHands needs them (run-adapters kernel/registry Hands). */
type ScreenPort = { shot(...args: never[]): Promise<unknown> };
type InputPort = { actions(...args: never[]): Promise<unknown> };
type PhonePort = {
  shot(...args: never[]): Promise<unknown>;
  tree?(...args: never[]): Promise<unknown>;
  tap(...args: never[]): Promise<unknown>;
  swipe(...args: never[]): Promise<unknown>;
  type(...args: never[]): Promise<unknown>;
  key?(...args: never[]): Promise<unknown>;
  apps: { list(...args: never[]): Promise<unknown>; open(...args: never[]): Promise<unknown> };
};
type WithPorts = Partial<Hands> & { readonly screen?: ScreenPort; readonly input?: InputPort; readonly phone?: PhonePort };

/** `hands` with its screen, input and phone ports parked while the person has the computer, and the agent's ask
 *  (`handoff`) through the hold; everything else as it is. */
export function heldHands<H extends WithPorts>(hands: H, hold: ComputerHold): H & { readonly handoff: Handoff } {
  const computer = hands.phone ? "phone" : "desktop";
  return {
    ...hands,
    ...(hands.screen ? { screen: { ...hands.screen, shot: look(hands.screen, "shot", hold) } } : {}),
    ...(hands.input ? { input: { ...hands.input, actions: act(hands.input, "actions", hold, computer, "input") } } : {}),
    ...(hands.phone ? {
      phone: {
        ...hands.phone,
        shot: look(hands.phone, "shot", hold),
        // A phone that does not offer its tree or its keys keeps none: the tool says so in words.
        ...(hands.phone.tree ? { tree: look(hands.phone as Required<PhonePort>, "tree", hold) } : {}),
        tap: act(hands.phone, "tap", hold, "phone", "tap"),
        swipe: act(hands.phone, "swipe", hold, "phone", "swipe"),
        type: act(hands.phone, "type", hold, "phone", "typing"),
        ...(hands.phone.key ? { key: act(hands.phone as Required<PhonePort>, "key", hold, "phone", "key press") } : {}),
        apps: { ...hands.phone.apps, list: look(hands.phone.apps, "list", hold), open: act(hands.phone.apps, "open", hold, "phone", "app opening") },
      },
    } : {}),
    handoff: { ask: (request, signal) => hold.ask(request, signal) },
  };
}
