import { BrowserFailureError } from "./custody.js";
import { browserFailure, type BrowserFailure } from "./failures.js";

/** Who is acting on the browser. `person`: input arrived from the viewer within the idle window. `agent`: a model browser call is in flight,
 *  and viewer input is discarded (never queued, so a keystroke is not replayed into a page the model has since moved). */
export type DriveState = "idle" | "person" | "agent";

/** The person/model mutex for one browser (core/driving.ts, keyed by the session's lease tag). Person input and a model's browser call never
 *  interleave: while a call is in flight the viewer's input is discarded with a notice, and while a person drives a model call is refused. */
export type DrivingGate = {
  state(): DriveState;
  /** Viewer input arrived: `driving` marks the person as driving until the idle window passes; `agent_acting` means a model call is in flight. */
  input(): "driving" | "agent_acting";
  /** A model browser call is about to start: a release function, or `person_driving` when a person is driving. */
  model(): { release(): void } | "person_driving";
  /** Called with the new state at every change. Returns the unsubscribe. */
  onChange(listener: (state: DriveState) => void): () => void;
  /** True while an AUTHENTICATED viewer is connected to this session's live view, whether or not it has touched anything lately: `person` lasts only the idle window
   *  after the last input, and a person mid-sign-in can sit still longer than that with the viewer open. Custody reads it before it releases a session on its own. */
  viewing(): boolean;
  /** The live view's server sets it when a viewer's hello is accepted and clears it when that viewer's socket closes or the session is released. */
  setViewing(on: boolean): void;
  /** The session was released: listeners dropped, the gate forgotten, no viewer. */
  end(): void;
};
export type DrivingGates = (tag: string) => DrivingGate;

/** The typed marker a refused model call opens its message with, as #1000's busy refusals open theirs with `browser_busy (fill)`. */
export const PERSON_DRIVING = "person_driving";

/** The failure a model browser call gets while a person drives: `refused`, retryable (the person's turn ends), nothing was done. */
export const personDrivingFailure = (): BrowserFailure => browserFailure("refused",
  `${PERSON_DRIVING}: a person is driving this browser through the live view, and the agent does not act while they do. Wait a moment and try the call again.`, { retryable: true });

export type Timers = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };

export type DrivingOptions = {
  /** A person keeps driving this long after their last input, then the model may act again. Default 3 s. */
  idleMs?: number;
  /** For tests: the timer functions. */
  timers?: Timers;
};

const NODE_TIMERS: Timers = { set: (run, ms) => { const handle = setTimeout(run, ms); handle.unref?.(); return handle; }, clear: (handle) => clearTimeout(handle as NodeJS.Timeout) };

/** One browser's mutex. The state is `{ model, person }` (the model's calls in flight, and whether a person is driving), the shape of #1000's per-browser busy
 *  record (`{ code, fill }`): folding the two in means adding `person` to that record and asking `model()` and `input()` beside its fill/code checks. */
class Gate implements DrivingGate {
  private model_ = 0;
  private person = false;
  private idle: unknown;
  private viewing_ = false;
  private readonly listeners = new Set<(state: DriveState) => void>();
  constructor(private readonly timers: Timers, private readonly idleMs: number, private readonly forget: (gate: Gate) => void) {}

  state(): DriveState { return this.model_ > 0 ? "agent" : this.person ? "person" : "idle"; }

  /** Viewer input: discarded (never queued) while the model acts, so a keystroke is not replayed into a page the model has since moved. */
  input(): "driving" | "agent_acting" {
    if (this.model_ > 0) return "agent_acting";
    const before = this.state();
    this.person = true;
    if (this.idle !== undefined) this.timers.clear(this.idle);
    this.idle = this.timers.set(() => this.stopDriving(), this.idleMs);
    if (before !== "person") this.announce("person");
    return "driving";
  }

  model(): { release(): void } | "person_driving" {
    if (this.person) return PERSON_DRIVING;
    const before = this.state();
    this.model_ += 1;
    if (before !== "agent") this.announce("agent");
    let released = false;
    return { release: () => { if (released) return; released = true; this.model_ -= 1; if (this.model_ === 0) { this.announce(this.state()); this.settle(); } } };
  }

  viewing(): boolean { return this.viewing_; }

  setViewing(on: boolean): void { this.viewing_ = on; if (!on) this.settle(); }

  onChange(listener: (state: DriveState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); this.settle(); }; }

  end(): void {
    if (this.idle !== undefined) this.timers.clear(this.idle);
    this.idle = undefined;
    this.person = false;
    this.viewing_ = false;
    this.model_ = 0;
    this.listeners.clear();
    this.forget(this);
  }

  private stopDriving(): void {
    this.idle = undefined;
    if (!this.person) return;
    this.person = false;
    this.announce(this.state());
    this.settle();
  }

  /** A gate that no call, person, viewer or listener holds is dropped from the registry, so a long-running host does not keep one per session it ever ran: whoever asks again gets an
   *  identical one. A gate in use stays the same object. */
  private settle(): void {
    if (this.model_ === 0 && !this.person && !this.viewing_ && this.listeners.size === 0) this.forget(this);
  }

  private announce(state: DriveState): void {
    for (const listener of [...this.listeners]) { try { listener(state); } catch { /* a viewer that throws cannot stop the model */ } }
  }
}

/** The person/model mutex for every browser: `gates(tag)` is the tag's gate (the same object each time while anything holds it: a call, a person, a viewer or a listener, and until its `end()`). */
export function createDrivingGates(options: DrivingOptions = {}): DrivingGates {
  const idleMs = options.idleMs ?? 3000;
  const timers = options.timers ?? NODE_TIMERS;
  const byTag = new Map<string, Gate>();
  return (tag) => {
    let gate = byTag.get(tag);
    if (!gate) {
      const made: Gate = new Gate(timers, idleMs, (ended) => { if (byTag.get(tag) === ended) byTag.delete(tag); });
      byTag.set(tag, made);
      gate = made;
    }
    return gate;
  };
}

/** Runs `work` as one model browser call on `gate`: refused, typed, while a person drives; released whatever the work does. */
export async function withModelCall<T>(gate: DrivingGate, work: () => Promise<T>): Promise<T> {
  const call = gate.model();
  if (call === PERSON_DRIVING) throw new BrowserFailureError(personDrivingFailure());
  try { return await work(); } finally { call.release(); }
}

/** The process's own registry: the model side (where the toolset is registered) and the live view's default (`options.gates ?? drivingGates`) share the SAME gate per
 *  session tag without any plumbing. A test that wants an isolated one calls `createDrivingGates()`. */
export const drivingGates: DrivingGates = createDrivingGates();

/** Why custody keeps a session it would otherwise release on its own (an idle window, a connection it cannot get back): a
 *  person drives it, or watches it, through the live view. Null when no person is on it. */
export const keptFor = (gate: DrivingGate): "person_driving" | "viewing" | null => gate.state() === "person" ? "person_driving" : gate.viewing() ? "viewing" : null;

/** The session's gate when a person drives or watches it through the live view, else null. The registry makes a gate on its
 *  first lookup, so a gate nobody holds is let go again here (an unsubscribe settles it: a gate in use, a call, a person, a
 *  viewer or a listener, stays), and custody's own check never leaves one behind. */
export function personOn(gates: DrivingGates, tag: string): DrivingGate | null {
  const gate = gates(tag);
  if (keptFor(gate) !== null) return gate;
  gate.onChange(() => {})();
  return null;
}

/** A session custody kept for a person is released one idle window after they leave: the gate is polled (setViewing and end
 *  announce nothing), and the moment nobody is on it `rearm` starts the idle window again. Stops once `alive` says the session
 *  is gone; the returned function stops it at once (a release, a close). */
export function rearmWhenLeft(gate: DrivingGate, alive: () => boolean, rearm: () => void, idleMs: number): () => void {
  const every = Math.max(25, Math.min(1000, Math.round(idleMs / 4)));
  const poll = setInterval(() => {
    if (!alive()) { clearInterval(poll); return; }
    if (keptFor(gate) === null) { clearInterval(poll); rearm(); }
  }, every);
  poll.unref?.();
  return () => clearInterval(poll);
}
