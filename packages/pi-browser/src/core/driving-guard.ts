import { BrowserFailureError, FenceRefusal, type BrowserDriver, type CustodyPort, type ToolOutput } from "./custody.js";
import { drivingGates, epochOf, isHeld, personDrivingFailure, PERSON_DRIVING, type DrivingGate, type DrivingGates } from "./driving.js";
import { browserFailure } from "./failures.js";
import type { ToolCall, ToolImpl } from "./tools.js";

/** Told to the model's next call once a person has driven the session through the live view: the page can change without its URL changing. */
export const PERSON_DROVE = "A person used this browser through the live view since your last call, so the page may have changed even where its address did not: take a snapshot before you act on an element by its id.";
/** Told, before PERSON_DROVE, to a call that waited while the person held the browser. */
export const PERSON_HAD = "This call waited while the person had the browser: they took it over through the live view and have handed it back.";

/** What a model call that was under way when the person took the browser is told at its next act on it: nothing more of it reached the page. */
export const personTookFailure = (acted: boolean) => browserFailure("refused",
  "The person took over this browser through the live view while this call ran, so the rest of it was not done. Your next browser call waits until they hand the browser back; the page may have changed by then, so take a snapshot before you act.",
  { retryable: true, effect: acted ? "possibly_effected" : "none" });

/** The driver as a model call holds it: each of its acts is refused once the gate's epoch has moved past the one the call entered at (the
 *  person took the browser, or a hold ended, since). A refusal is a FenceRefusal, so an action none of whose acts got through is known not sent. */
function epochFenced<D extends BrowserDriver>(driver: D, gate: DrivingGate, epoch: number): D {
  let acted = false;
  const moved = () => epochOf(gate) !== epoch;
  return new Proxy(driver, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      // A run of several actions is one batch inside the browser, out of reach once it is sent: it is sent one action at
      // a time, each checked here first, so none after the person took over reaches the page. Their answers are summed
      // as the batch's would be: how many completed, and the page's address after the last.
      const actions = key === "run" ? (arguments_: unknown[]) => (arguments_[0] as { actions?: unknown } | undefined)?.actions : () => undefined;
      return (...args: unknown[]) => {
        if (moved()) return Promise.reject(new FenceRefusal(personTookFailure(acted)));
        const list = actions(args);
        if (!Array.isArray(list) || list.length < 2) {
          acted = true;
          return value.apply(target, args);
        }
        return (async () => {
          let completed = 0;
          let url: unknown;
          for (const action of list) {
            if (moved()) throw new FenceRefusal(personTookFailure(acted));
            acted = true;
            const answer = (await value.call(target, { actions: [action] })) as { completed?: unknown; url?: unknown } | undefined;
            completed += typeof answer?.completed === "number" ? answer.completed : 1;
            url = answer?.url;
          }
          return { completed, url };
        })();
      };
    },
  });
}

/** The abort of a call that waited for the person and was stopped meanwhile: nothing was done. */
const STOPPED_WAITING = () => new BrowserFailureError(browserFailure("aborted", "The call was stopped while it waited for the person to hand the browser back; nothing was done."));

/** One browser tool as a model call on its session's driving gate: it is refused, typed and before it has done anything, while a person drives that session
 *  through the live view, and it holds the gate for as long as it runs, so the viewer's input is held meanwhile. The session is known when the tool first
 *  asks its port for it (`session()` or `relaunch()`), which is every tool's first act on the browser. */
export function drivingGuard<D extends BrowserDriver, A = unknown>(impl: ToolImpl<D, A>, gates: DrivingGates = drivingGates, options: { early?: boolean } = {}): ToolImpl<D, A> {
  return async (args: A, port: CustodyPort<D>, call: ToolCall): Promise<ToolOutput> => {
    let held: { tag: string; release(): void; gate: DrivingGate; epoch: number } | null = null;
    /** Takes the tag's gate for the model, first waiting (inside the call, never failing it) while the person holds the browser; `drove` when a person
     *  has driven that session since the model's last call, `waited` when this call waited for the person to hand it back. */
    const enter = async (tag: string): Promise<{ drove: boolean; waited: boolean }> => {
      if (held?.tag === tag) return { drove: false, waited: false };
      let waited = false;
      for (;;) {
        const gate = gates(tag);
        if (isHeld(gate)) {
          waited = true;
          try { await gate.untilFree?.(call?.signal); } catch { throw STOPPED_WAITING(); }
          continue;
        }
        const entered = gate.model();
        // A BrowserFailureError is what a tool already turns into a typed failure result, as it does for its own refusals.
        if (entered === PERSON_DRIVING) throw new BrowserFailureError(personDrivingFailure());
        held?.release();
        held = { tag, release: entered.release, gate, epoch: epochOf(gate) };
        return { drove: entered.drove === true, waited };
      }
    };
    /** A person drove: the session's snapshot ids are dropped (an old id then fails as a stale snapshot, whatever the URL), the call is told why,
     *  and only then is the gate told. A call that took the gate without its session (release, relaunch) tells nothing and uses nothing up. */
    const told = <S extends { tag: string; driver: D; notice?: string | null }>(attached: S, entered: { drove: boolean; waited: boolean }): S => {
      if (!entered.drove && !entered.waited) return attached;
      try { void Promise.resolve((attached.driver as { forgetSnapshots?: () => unknown }).forgetSnapshots?.()).catch(() => undefined); } catch { /* a driver without snapshot ids has none to drop */ }
      gates(attached.tag).told();
      return { ...attached, notice: [attached.notice, entered.waited ? PERSON_HAD : null, PERSON_DROVE].filter(Boolean).join(" ") };
    };
    /** The session's driver as this call holds it: refused once the browser changes hands. */
    const fenced = <S extends { tag: string; driver: D }>(attached: S): S => (held?.tag === attached.tag && typeof attached.driver === "object" && attached.driver !== null ? { ...attached, driver: epochFenced(attached.driver, held.gate, held.epoch) } : attached);
    // Every other member runs on the real port (`this` is the port, so a class-based port's own state is written to it, not to a copy).
    const overrides: Record<string | symbol, unknown> = {
      session: async (signal?: AbortSignal) => { const attached = await port.session(signal); return fenced(told(attached, await enter(attached.tag))); },
      relaunch: async (o: Parameters<CustodyPort<D>["relaunch"]>[0]) => { const attached = await port.relaunch(o); await enter(attached.tag); return fenced(attached); },
    };
    const guarded = new Proxy(port, { get(target, key) { if (key in overrides) return overrides[key]; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
    try {
      // A tool that ends the session (release, relaunch) does not ask for it first: the gate is taken for the session that is attached now.
      if (options.early) { const tag = await port.current?.(); if (tag) await enter(tag); }
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

