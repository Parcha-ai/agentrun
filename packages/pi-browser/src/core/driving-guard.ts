import { BrowserFailureError, type BrowserDriver, type CustodyPort, type ToolOutput } from "./custody.js";
import { drivingGates, personDrivingFailure, PERSON_DRIVING, type DrivingGates } from "./driving.js";
import type { ToolCall, ToolImpl } from "./tools.js";

/** One browser tool as a model call on its session's driving gate: it is refused, typed and before it has done anything, while a person drives that session
 *  through the live view, and it holds the gate for as long as it runs, so the viewer's input is held meanwhile. The session is known when the tool first
 *  asks its port for it (`session()` or `relaunch()`), which is every tool's first act on the browser. */
export function drivingGuard<D extends BrowserDriver, A = unknown>(impl: ToolImpl<D, A>, gates: DrivingGates = drivingGates, options: { early?: boolean } = {}): ToolImpl<D, A> {
  return async (args: A, port: CustodyPort<D>, call: ToolCall): Promise<ToolOutput> => {
    let held: { tag: string; release(): void } | null = null;
    const enter = (tag: string): void => {
      if (held?.tag === tag) return;
      const entered = gates(tag).model();
      // A BrowserFailureError is what a tool already turns into a typed failure result, as it does for its own refusals.
      if (entered === PERSON_DRIVING) throw new BrowserFailureError(personDrivingFailure());
      held?.release();
      held = { tag, release: entered.release };
    };
    // Every other member runs on the real port (`this` is the port, so a class-based port's own state is written to it, not to a copy).
    const overrides: Record<string | symbol, unknown> = {
      session: async () => { const attached = await port.session(); enter(attached.tag); return attached; },
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

