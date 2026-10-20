import { BrowserFailureError, type BrowserDriver, type CustodyPort, type ToolOutput } from "./custody.js";
import { drivingGates, personDrivingFailure, PERSON_DRIVING, type DrivingGates } from "./driving.js";
import type { ToolCall, ToolImpl } from "./tools.js";

/** Told to the model's next call once a person has driven the session through the live view: the page can change without its URL changing. */
export const PERSON_DROVE = "A person used this browser through the live view since your last call, so the page may have changed even where its address did not: take a snapshot before you act on an element by its id.";

/** One browser tool as a model call on its session's driving gate: it is refused, typed and before it has done anything, while a person drives that session
 *  through the live view, and it holds the gate for as long as it runs, so the viewer's input is held meanwhile. The session is known when the tool first
 *  asks its port for it (`session()` or `relaunch()`), which is every tool's first act on the browser. */
export function drivingGuard<D extends BrowserDriver, A = unknown>(impl: ToolImpl<D, A>, gates: DrivingGates = drivingGates, options: { early?: boolean } = {}): ToolImpl<D, A> {
  return async (args: A, port: CustodyPort<D>, call: ToolCall): Promise<ToolOutput> => {
    let held: { tag: string; release(): void } | null = null;
    /** Takes the tag's gate for the model; true when a person has driven that session since the model's last call. */
    const enter = (tag: string): boolean => {
      if (held?.tag === tag) return false;
      const entered = gates(tag).model();
      // A BrowserFailureError is what a tool already turns into a typed failure result, as it does for its own refusals.
      if (entered === PERSON_DRIVING) throw new BrowserFailureError(personDrivingFailure());
      held?.release();
      held = { tag, release: entered.release };
      return entered.drove === true;
    };
    /** A person drove: the session's snapshot ids are dropped (an old id then fails as a stale snapshot, whatever the URL), the call is told why,
     *  and only then is the gate told. A call that took the gate without its session (release, relaunch) tells nothing and uses nothing up. */
    const told = <S extends { tag: string; driver: D; notice?: string | null }>(attached: S, drove: boolean): S => {
      if (!drove) return attached;
      try { void Promise.resolve((attached.driver as { forgetSnapshots?: () => unknown }).forgetSnapshots?.()).catch(() => undefined); } catch { /* a driver without snapshot ids has none to drop */ }
      gates(attached.tag).told();
      return { ...attached, notice: [attached.notice, PERSON_DROVE].filter(Boolean).join(" ") };
    };
    // Every other member runs on the real port (`this` is the port, so a class-based port's own state is written to it, not to a copy).
    const overrides: Record<string | symbol, unknown> = {
      session: async (signal?: AbortSignal) => { const attached = await port.session(signal); return told(attached, enter(attached.tag)); },
      relaunch: async (o: Parameters<CustodyPort<D>["relaunch"]>[0]) => { const attached = await port.relaunch(o); enter(attached.tag); return attached; },
    };
    const guarded = new Proxy(port, { get(target, key) { if (key in overrides) return overrides[key]; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
    try {
      // A tool that ends the session (release, relaunch) does not ask for it first: the gate is taken for the session that is attached now.
      if (options.early) { const tag = await port.current?.(); if (tag) enter(tag); }
      return await impl(args, guarded, call);
    } finally {
      (held as { release(): void } | null)?.release();
    }
  };
}

/** The tools that end the live session they find, so they are checked against it before they act, not at their first `session()`. */
const ENDS_SESSION = new Set(["browser_release", "browser_relaunch"]);

/** Every implementation of a toolset guarded as above. */
export function drivingGuarded<D extends BrowserDriver>(impls: Partial<Record<string, ToolImpl<D>>>, gates?: DrivingGates): Partial<Record<string, ToolImpl<D>>> {
  return Object.fromEntries(Object.entries(impls).map(([name, impl]) => [name, impl && drivingGuard(impl, gates, { early: ENDS_SESSION.has(name) })]));
}

