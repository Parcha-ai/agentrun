import { BrowserFailureError, FenceRefusal, type BrowserDriver, type CustodyPort, type ToolOutput } from "./custody.js";
import { drivingGates, epochOf, isHeld, isSettling, personDrivingFailure, PERSON_DRIVING, type DrivingGate, type DrivingGates } from "./driving.js";
import { asPartial, browserFailure, classifyBrowserError, PARTIAL } from "./failures.js";
import type { ToolCall, ToolImpl } from "./tools.js";

/** Told to the model's next call once a person has driven the session through the live view: the page can change without its URL changing. */
export const PERSON_DROVE = "A person used this browser through the live view since your last call, so the page may have changed even where its address did not: take a snapshot before you act on an element by its id.";
/** Told, before PERSON_DROVE, to a call that waited while the person held the browser. */
export const PERSON_HAD = "This call waited while the person had the browser: they took it over through the live view and have handed it back.";
/** Told, instead, to a call that waited through a take the person did not use: no input of theirs reached the page, so the
 *  snapshot stands and nothing says the page changed. */
export const PERSON_HAD_UNUSED = "This call waited while the person had the browser: they took it over through the live view and handed it back without using it, so the page is as you left it.";

/** The mark (in a call's result details) of an act the person's take made stale: the person drove the session through the
 *  live view while the call waited, so the snapshot its element ids came from no longer stands. Its timeline row reads
 *  neutral, in plain words (pi-durable-agent's timeline), never as a failure. */
export const PAGE_CHANGED_WHILE_HELD = "page_changed_while_held";
/** Told to the model by such an act: nothing was done, and its next step is a snapshot. */
export const PAGE_CHANGED_FOR_MODEL = "The person changed the page while they had the browser, so this action was not done. Take a snapshot first, then act on the page as it is now.";

/** The body of a failed result whose failure is a stale snapshot, or undefined: what an act the person's take made stale
 *  answers before it is said otherwise. */
function staleFailureOf(out: ToolOutput): Record<string, unknown> | undefined {
  const first = out.isError ? out.content[0] : undefined;
  if (first?.type !== "text") return undefined;
  try {
    const body = JSON.parse(first.text) as unknown;
    return body !== null && typeof body === "object" && (body as { code?: unknown }).code === "stale_snapshot" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** An act that failed on the snapshot the person's take made stale, said as what it is: no error (the call did nothing,
 *  and the agent takes a new look), the model told to snapshot first, the notice it was given kept, and the result marked
 *  PAGE_CHANGED_WHILE_HELD for its timeline row. Its details as the tool gave them, beside the mark. */
const pageChanged = (out: ToolOutput, failure: Record<string, unknown>): ToolOutput => ({
  content: [{ type: "text", text: JSON.stringify({ ...(typeof failure.notice === "string" ? { notice: failure.notice } : {}), done: false, page_changed: true, next: "snapshot", message: PAGE_CHANGED_FOR_MODEL }) }],
  details: { ...out.details, [PAGE_CHANGED_WHILE_HELD]: true },
  ...(out.usage ? { usage: out.usage } : {}),
});

/** What a model call that was under way when the person took the browser is told at its next act on it: nothing more of it reached the page. */
export const personTookFailure = (acted: boolean, batch?: { completed: number; of: number }) => {
  const failure = browserFailure("refused",
    `The person took over this browser through the live view while this call ran, so the rest of it was not done${batch ? ` (${batch.completed} of the ${batch.of} actions ran)` : ""}. Your next browser call waits until they hand the browser back; the page may have changed by then, so take a snapshot before you act.`,
    { retryable: true, effect: batch && batch.completed > 0 ? "partial" : acted ? "possibly_effected" : "none" });
  return batch && batch.completed > 0 ? { ...failure, completed: batch.completed } : failure;
};

/** A run of several actions that failed at one after others ran: the failure it would have been, said to be partial, with
 *  how many ran (the facade's batch, once sent, never said which). */
function partway(error: unknown, completed: number, of: number): unknown {
  // A dropped connection stays the error it is, marked: the call's own handling lets its driver go (port.dropped), so the next
  // call reconnects, and says the run was partial.
  if (!(error instanceof BrowserFailureError) && error !== null && typeof error === "object" && classifyBrowserError(error, true, {}).code === "browser_unavailable") {
    return Object.assign(error, { [PARTIAL]: { completed, of } });
  }
  const failure = error instanceof BrowserFailureError ? error.failure : classifyBrowserError(error, true, {});
  return new BrowserFailureError(asPartial(failure, { completed, of }));
}

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
          // Every action checked first, as the batch checked them before it sent any: a stale id anywhere sends none.
          const check = (target as { checkActions?: (actions: unknown[]) => Promise<void> }).checkActions;
          if (typeof check === "function") await check.call(target, list);
          let completed = 0;
          let url: unknown;
          for (const [index, action] of list.entries()) {
            if (moved()) throw new FenceRefusal(personTookFailure(acted, { completed, of: list.length }));
            acted = true;
            let answer: { completed?: unknown; url?: unknown } | undefined;
            try {
              // The batch was checked as one before any was sent, as the browser's own batch checks it once: an action after
              // the first is not refused because the page's address moved under the batch's own earlier actions (a
              // same-page link). The person's take-over is still fenced before each one, above.
              answer = (await value.call(target, index === 0 ? { actions: [action] } : { actions: [action], checked: true })) as typeof answer;
            } catch (error) {
              if (completed > 0) throw partway(error, completed, list.length);
              throw error;
            }
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

/** How long a call waited for the person to hand the browser back, in its result's details: a host's timeline says the
 *  call waited, and for how long, so a call row that spans a take-over does not read as the agent acting meanwhile. */
export const WAITED_FOR_PERSON = "waited_for_person_ms";

/** One browser tool as a model call on its session's driving gate: it is refused, typed and before it has done anything, while a person drives that session
 *  through the live view, and it holds the gate for as long as it runs, so the viewer's input is held meanwhile. The session is known when the tool first
 *  asks its port for it (`session()` or `relaunch()`), which is every tool's first act on the browser. */
export function drivingGuard<D extends BrowserDriver, A = unknown>(impl: ToolImpl<D, A>, gates: DrivingGates = drivingGates, options: { early?: boolean; now?: () => number } = {}): ToolImpl<D, A> {
  const now = options.now ?? Date.now;
  return async (args: A, port: CustodyPort<D>, call: ToolCall): Promise<ToolOutput> => {
    let held: { tag: string; release(): void; gate: DrivingGate; epoch: number } | null = null;
    /** How long this call waited for the person, all told (ms), and whether it was stopped while it waited: then nothing
     *  was done, and its result claims no wait that ended in an act. */
    let waitedMs = 0;
    let stopped = false;
    /** Whether the person's own hand drove this call's session through the live view since the model's last call (their
     *  input reached it, not only a take): its snapshot's ids were dropped for it (told), so an act on them is one their hand
     *  made stale. */
    let personDrove = false;
    /** Takes the tag's gate for the model, first waiting (inside the call, never failing it) while the person holds the browser; `drove` when a person
     *  has driven that session since the model's last call, `waited` when this call waited for the person to hand it back. */
    const enter = async (tag: string): Promise<{ drove: boolean; waited: boolean; handled: boolean }> => {
      if (held?.tag === tag) return { drove: false, waited: false, handled: false };
      let waited = false;
      for (;;) {
        const gate = gates(tag);
        // Held, or handed back with the person's last command still settling: the call waits for both.
        if (isHeld(gate) || isSettling(gate)) {
          waited = true;
          const from = now();
          try { await gate.untilFree?.(call?.signal); } catch { stopped = true; throw STOPPED_WAITING(); } finally { waitedMs += Math.max(0, now() - from); }
          continue;
        }
        const entered = gate.model();
        // A BrowserFailureError is what a tool already turns into a typed failure result, as it does for its own refusals.
        if (entered === PERSON_DRIVING) throw new BrowserFailureError(personDrivingFailure());
        held?.release();
        held = { tag, release: entered.release, gate, epoch: epochOf(gate) };
        return { drove: entered.drove === true, waited, handled: entered.handled };
      }
    };
    /** A person drove: the session's snapshot ids are dropped (an old id then fails as a stale snapshot, whatever the URL), the call is told why,
     *  and only then is the gate told. A take the person did not use (no input of theirs reached the page) keeps the ids: the page
     *  is as the agent left it, so its next act just works, and the call is told only that it waited, if it did. A call that took
     *  the gate without its session (release, relaunch) tells nothing and uses nothing up. */
    const told = <S extends { tag: string; driver: D; notice?: string | null }>(attached: S, entered: { drove: boolean; waited: boolean; handled: boolean }): S => {
      if (!entered.drove && !entered.waited) return attached;
      if (entered.handled) {
        try { void Promise.resolve((attached.driver as { forgetSnapshots?: () => unknown }).forgetSnapshots?.()).catch(() => undefined); } catch { /* a driver without snapshot ids has none to drop */ }
      }
      gates(attached.tag).told();
      const said = entered.handled ? [entered.waited ? PERSON_HAD : null, PERSON_DROVE] : [entered.waited ? PERSON_HAD_UNUSED : null];
      const notice = [attached.notice, ...said].filter(Boolean).join(" ");
      return notice === (attached.notice ?? "") ? attached : { ...attached, notice };
    };
    /** The session's driver as this call holds it: refused once the browser changes hands. */
    const fenced = <S extends { tag: string; driver: D }>(attached: S): S => (held?.tag === attached.tag && typeof attached.driver === "object" && attached.driver !== null ? { ...attached, driver: epochFenced(attached.driver, held.gate, held.epoch) } : attached);
    // Every other member runs on the real port (`this` is the port, so a class-based port's own state is written to it, not to a copy).
    const overrides: Record<string | symbol, unknown> = {
      session: async (signal?: AbortSignal) => { const attached = await port.session(signal); const entered = await enter(attached.tag); personDrove ||= entered.handled; return fenced(told(attached, entered)); },
      relaunch: async (o: Parameters<CustodyPort<D>["relaunch"]>[0]) => { const attached = await port.relaunch(o); await enter(attached.tag); return fenced(attached); },
    };
    const guarded = new Proxy(port, { get(target, key) { if (key in overrides) return overrides[key]; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
    try {
      // A tool that ends the session (release, relaunch) does not ask for it first: the gate is taken for the session that is attached now.
      if (options.early) { const tag = await port.current?.(); if (tag) await enter(tag); }
      const given = await impl(args, guarded, call);
      // An act on the snapshot the person's hand made stale (they drove the session while this call waited, or since the
      // last one) failed only because the page moved under it: it did nothing, and the next step is a new look.
      const stale = personDrove ? staleFailureOf(given) : undefined;
      const out = stale ? pageChanged(given, stale) : given;
      return waitedMs > 0 && !stopped ? { ...out, details: { ...out.details, [WAITED_FOR_PERSON]: Math.round(waitedMs) } } : out;
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

