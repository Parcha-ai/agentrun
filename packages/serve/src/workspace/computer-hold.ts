// A person's hold on a run's desktop or phone: the owner takes the computer over from the run's view (POST
// /v2/runs/{id}/computer/take-over) and hands it back (.../hand-back), as a browser's live view does (pi-browser's
// driving gate, core/driving.ts). While a person holds it, the run's screen, input and phone tools are parked: each call
// waits until the hand-back. Then a look (a screenshot, the app list) runs on the screen as the person left it, and an
// act (input, a tap, a swipe, typing, opening an app) is not done: the model is told the person had the computer and to
// look again before acting, since the screen it decided on is gone. A hold ends at the hand-back, after HOLD_MAX_MS with
// no hand-back (the person's time is bounded, as a browser's is), or at the run's end. exec, files and processes are not
// the person's: they pass through.
//
// heldHands wraps a run's Hands (the kernel registry's narrow ports: screen, input, phone) with the hold; the run's
// tools for a desktop or a phone are built on what it returns (runTools' `hold`). The hold is per run and lives in the
// process that holds the run's computer.
import type { Hands } from "./hands.js";

/** How long a person may hold a run's computer before it goes back to the agent, unless they hand it back first. */
export const HOLD_MAX_MS = 15 * 60_000;

/** Why a hold ended: handed back, past HOLD_MAX_MS, or the run ended. */
export type HoldEnd = "given" | "expired" | "ended";

/** One run's computer, held or not by a person. */
export type ComputerHold = {
  /** Whether a person holds it now, and since when (ms since the epoch). */
  state(): { readonly held: false } | { readonly held: true; readonly since: number; readonly until: number };
  /** The person takes it: true when this took it, false when it was already held (nothing changes). */
  take(): boolean;
  /** The hold ends: false when nothing was held. */
  give(why?: HoldEnd): boolean;
  /** Moves at each change of hands: an act started before a take sees it moved. */
  epoch(): number;
  /** Resolves once nobody holds the computer (at once when nobody does); rejects with `signal`'s reason when it aborts first. */
  untilFree(signal?: AbortSignal): Promise<void>;
  /** Called with why at the end of each hold. Returns the unsubscribe. */
  onEnd(listener: (why: HoldEnd) => void): () => void;
};

export type Timers = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
const NODE_TIMERS: Timers = { set: (run, ms) => { const handle = setTimeout(run, ms); (handle as { unref?(): void }).unref?.(); return handle; }, clear: (handle) => clearTimeout(handle as NodeJS.Timeout) };

/** A run's computer's hold. `timers` and `now` are the test's own clock; `maxMs` the longest a hold lasts. */
export function computerHold(options: { readonly maxMs?: number; readonly timers?: Timers; readonly now?: () => number } = {}): ComputerHold {
  const maxMs = options.maxMs ?? HOLD_MAX_MS;
  const timers = options.timers ?? NODE_TIMERS;
  const now = options.now ?? Date.now;
  let hold: { since: number; until: number; timer: unknown } | undefined;
  let epoch = 0;
  const waiters = new Set<() => void>();
  const listeners = new Set<(why: HoldEnd) => void>();
  const give = (why: HoldEnd = "given"): boolean => {
    if (!hold) return false;
    timers.clear(hold.timer);
    hold = undefined;
    epoch++;
    for (const wake of [...waiters]) wake();
    for (const listener of [...listeners]) {
      try { listener(why); } catch { /* a listener's error is not the hold's */ }
    }
    return true;
  };
  return {
    state: () => (hold ? { held: true, since: hold.since, until: hold.until } : { held: false }),
    take() {
      if (hold) return false;
      const since = now();
      hold = { since, until: since + maxMs, timer: timers.set(() => give("expired"), maxMs) };
      epoch++;
      return true;
    },
    give,
    epoch: () => epoch,
    untilFree(signal) {
      if (!hold) return Promise.resolve();
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise<void>((resolve, reject) => {
        const wake = (): void => { cleanup(); resolve(); };
        const aborted = (): void => { cleanup(); reject(signal!.reason); };
        const cleanup = (): void => { waiters.delete(wake); signal?.removeEventListener("abort", aborted); };
        waiters.add(wake);
        signal?.addEventListener("abort", aborted, { once: true });
      });
    },
    onEnd(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
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

/** The port method `method` of `port`, a look: while held it waits for the hand-back, then runs. */
function look<P extends object, K extends keyof P>(port: P, method: K, hold: ComputerHold): P[K] {
  const original = port[method] as unknown as (...args: unknown[]) => unknown;
  return (async (...args: unknown[]) => {
    await hold.untilFree();
    return original.apply(port, args);
  }) as unknown as P[K];
}

/** The port method `method` of `port`, an act: while held it waits for the hand-back, then is refused (not done); one
 *  made with nobody holding runs. */
function act<P extends object, K extends keyof P>(port: P, method: K, hold: ComputerHold, computer: "desktop" | "phone", what: string): P[K] {
  const original = port[method] as unknown as (...args: unknown[]) => unknown;
  return (async (...args: unknown[]) => {
    if (hold.state().held) {
      await hold.untilFree();
      throw refusal(computer, what);
    }
    return original.apply(port, args);
  }) as unknown as P[K];
}

/** The kernel's narrow ports a desktop and a phone have, as heldHands needs them (run-adapters kernel/registry Hands). */
type ScreenPort = { shot(...args: never[]): Promise<unknown> };
type InputPort = { actions(...args: never[]): Promise<unknown> };
type PhonePort = {
  shot(...args: never[]): Promise<unknown>;
  tap(...args: never[]): Promise<unknown>;
  swipe(...args: never[]): Promise<unknown>;
  type(...args: never[]): Promise<unknown>;
  apps: { list(...args: never[]): Promise<unknown>; open(...args: never[]): Promise<unknown> };
};
type WithPorts = Hands & { readonly screen?: ScreenPort; readonly input?: InputPort; readonly phone?: PhonePort };

/** `hands` with its screen, input and phone ports parked while `hold` is held; everything else as it is. */
export function heldHands<H extends WithPorts>(hands: H, hold: ComputerHold): H {
  const computer = hands.phone ? "phone" : "desktop";
  return {
    ...hands,
    ...(hands.screen ? { screen: { ...hands.screen, shot: look(hands.screen, "shot", hold) } } : {}),
    ...(hands.input ? { input: { ...hands.input, actions: act(hands.input, "actions", hold, computer, "input") } } : {}),
    ...(hands.phone ? {
      phone: {
        ...hands.phone,
        shot: look(hands.phone, "shot", hold),
        tap: act(hands.phone, "tap", hold, "phone", "tap"),
        swipe: act(hands.phone, "swipe", hold, "phone", "swipe"),
        type: act(hands.phone, "type", hold, "phone", "typing"),
        apps: { ...hands.phone.apps, list: look(hands.phone.apps, "list", hold), open: act(hands.phone.apps, "open", hold, "phone", "app opening") },
      },
    } : {}),
  };
}
