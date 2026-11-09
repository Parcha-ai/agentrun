import { BrowserFailureError } from "./custody.js";
import { browserFailure, type BrowserFailure } from "./failures.js";

/** Who is acting on the browser. `person`: input arrived from the viewer within the idle window, or the person holds the browser (`take`).
 *  `agent`: a model browser call is in flight, and viewer input is discarded (never queued, so a keystroke is not replayed into a page the model
 *  has since moved). */
export type DriveState = "idle" | "person" | "agent";

/** Why a person's hold ended: they handed the browser back (`given`), the agent's ask was answered (`answered`), the host's spend cap had no room
 *  for more of their time (`cap`), no input came for the hold's idle window (`idle`), the viewer was gone for its away window (`away`), or the
 *  session was released (`released`). */
export type HoldEnd = "given" | "answered" | "cap" | "idle" | "away" | "released";

/** The person/model mutex for one browser (core/driving.ts, keyed by the session's lease tag). Person input and a model's browser call never
 *  interleave: while a call is in flight the viewer's input is discarded with a notice, and while a person drives a model call is refused. */
export type DrivingGate = {
  state(): DriveState;
  /** Viewer input arrived: `driving` marks the person as driving until the idle window passes; `agent_acting` means a model call is in flight. */
  input(): "driving" | "agent_acting";
  /** A model browser call is about to start: a release function, or `person_driving` when a person is driving. `drove` is true when a person has driven
   *  this session and the model has not yet been told (`told`): the page may have changed under the model's last snapshot, whatever its URL says. */
  model(): { release(): void; drove: boolean; handled?: boolean } | "person_driving";
  /** The model's call has been told a person drove (its snapshot ids dropped, the notice given): `drove` is false until a person drives again. */
  told(): void;
  /** Called with the new state at every change. Returns the unsubscribe. */
  onChange(listener: (state: DriveState) => void): () => void;
  /** True while an AUTHENTICATED viewer is connected to this session's live view, whether or not it has touched anything lately: `person` lasts only the idle window
   *  after the last input, and a person mid-sign-in can sit still longer than that with the viewer open. Custody reads it before it releases a session on its own. */
  viewing(): boolean;
  /** The live view's server sets it when a viewer's hello is accepted and clears it when that viewer's socket closes or the session is released. */
  setViewing(on: boolean): void;
  /** The person's hold, below (take, give, held, epoch, setPresent, untilFree): optional, so a registry of the host's own that
   *  predates them still works. A gate without them is never held (no call waits) and its epoch never moves; the live view's
   *  takeOver needs them.
   *
   *  The person takes the browser (the live view's Take over): a sticky hold that lasts until `give`, `idleMs` of the hold with no input, or
   *  `awayMs` with no viewer present (`setPresent`), or the session's end. While held the person's input is the only input, every model call
   *  waits (`untilFree`), and the epoch moves, so a driver a model call took before the take acts no more. `onEnd` is called once, when the hold
   *  ends, with why (and the host's words, when it gave them). False when the browser is already held (nothing changes). */
  take?(onEnd?: (why: HoldEnd, message?: string) => void, onStart?: () => void): boolean;
  /** Ends the hold (`given`: the person handed back; `answered`: the agent's ask was answered; `cap`: the host's spend cap has no room for more of
   *  the person's time, `message` its words). False when nothing was held. */
  give?(why?: "given" | "answered" | "cap", message?: string): boolean;
  /** True from a take until the hold ends: no model call starts meanwhile. A take while a model call runs is held at once
   *  (the epoch moves, so that call acts no more after its current act) but goes live, the person's input taken and
   *  `onStart` called, only once the call returns: the person never drives while the agent's act is still under way. */
  held?(): boolean;
  /** True while the person's hold is live: their input is taken. */
  holding?(): boolean;
  /** Moves at each change of hands (a take, a hold's end): a model call checks it before each act on the browser. */
  epoch?(): number;
  /** The take-over viewer is connected (true) or gone (false): while held with no viewer, the hold ends after the away window. */
  setPresent?(on: boolean): void;
  /** Resolves once nobody holds the browser and the person's last command has settled (at once when neither); rejects with `signal`'s reason when
   *  it aborts first. */
  untilFree?(signal?: AbortSignal): Promise<void>;
  /** One command of the person's (an input, a nav, a dialog answer) starts on the browser: `done` when it returns, whatever it did. A hold that ends
   *  while one runs (handed back, the ask answered, the cap, idle, away) wakes no model call until it returns, or until `settleMs` passes: past
   *  that the command is let go, `live()` false from then on, and a command of several steps (Back reads the history, then moves) checks it before each. */
  command?(): { live(): boolean; done(): void };
  /** True from a hold's end until the person's last command has settled (or was let go): no model call starts meanwhile. */
  settling?(): boolean;
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
  /** A person's hold (`take`) ends after this long with no input from them. Default 15 minutes. */
  holdIdleMs?: number;
  /** A person's hold ends after its viewer has been gone this long. Default 2 minutes. */
  holdAwayMs?: number;
  /** After a hold ends, model calls wait at most this long for the person's command still running to return; past it the command is let go. Default 10 s. */
  settleMs?: number;
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
  /** A person has driven and the model has not been told yet; kept (and the gate with it) until a call has been told. */
  private drove_ = false;
  /** The person's own input reached the session since the model was last told (a take alone sets `drove_`, this only their
   *  hand): what can have changed the page under the model's snapshot. */
  private handled_ = false;
  /** The person's hold, while there is one: its end's listener, its idle timer and, while no viewer is present, its away timer. */
  private hold: { onEnd?: (why: HoldEnd, message?: string) => void; onStart?: () => void; pending: boolean; idle: unknown; away: unknown } | null = null;
  private epoch_ = 0;
  private present_ = false;
  /** The person's commands running on the browser now. */
  private readonly commands = new Set<object>();
  /** Set from a hold's end while a command of the person's still runs: the bound's timer. Model calls wait until it clears. */
  private settling_: { timer: unknown } | null = null;
  /** Model calls waiting for the hold to end. */
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(state: DriveState) => void>();
  constructor(private readonly timers: Timers, private readonly idleMs: number, private readonly forget: (gate: Gate) => void, private readonly holdIdleMs = 15 * 60_000, private readonly holdAwayMs = 2 * 60_000, private readonly settleMs = 10_000) {}

  state(): DriveState { return this.hold && !this.hold.pending ? "person" : this.model_ > 0 ? "agent" : this.person || this.hold || this.settling_ ? "person" : "idle"; }

  /** Viewer input: discarded (never queued) while the model acts, so a keystroke is not replayed into a page the model has since moved. While the
   *  person holds the browser it is always theirs: a model call that was in flight at the take acts no more (the epoch moved). */
  input(): "driving" | "agent_acting" {
    if (this.hold) {
      // Taken while the agent's call ran: the person drives once it returns.
      if (this.hold.pending) return "agent_acting";
      this.timers.clear(this.hold.idle);
      this.hold.idle = this.timers.set(() => this.endHold("idle"), this.holdIdleMs);
      this.drove_ = true;
      this.handled_ = true;
      return "driving";
    }
    // Handed back, the person's last command still settling: it is theirs, and it starts no new driving window.
    if (this.settling_) return "driving";
    if (this.model_ > 0) return "agent_acting";
    const before = this.state();
    this.person = true;
    this.drove_ = true;
    this.handled_ = true;
    if (this.idle !== undefined) this.timers.clear(this.idle);
    this.idle = this.timers.set(() => this.stopDriving(), this.idleMs);
    if (before !== "person") this.announce("person");
    return "driving";
  }

  model(): { release(): void; drove: boolean; handled?: boolean } | "person_driving" {
    if (this.person || this.hold || this.settling_) return PERSON_DRIVING;
    const drove = this.drove_;
    const handled = this.handled_;
    const before = this.state();
    this.model_ += 1;
    if (before !== "agent") this.announce("agent");
    let released = false;
    return { drove, handled, release: () => {
      if (released) return;
      released = true;
      this.model_ -= 1;
      if (this.model_ > 0) return;
      // A take that waited for this call goes live now.
      if (this.hold?.pending) return this.startHold();
      this.announce(this.state());
      this.settle();
    } };
  }

  told(): void { this.drove_ = false; this.handled_ = false; this.settle(); }

  viewing(): boolean { return this.viewing_; }

  setViewing(on: boolean): void { this.viewing_ = on; if (!on) this.settle(); }

  onChange(listener: (state: DriveState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); this.settle(); }; }

  take(onEnd?: (why: HoldEnd, message?: string) => void, onStart?: () => void): boolean {
    if (this.hold) return false;
    this.epoch_ += 1;
    this.drove_ = true;
    this.hold = { onEnd, onStart, pending: this.model_ > 0, idle: this.timers.set(() => this.endHold("idle"), this.holdIdleMs), away: undefined };
    if (!this.present_) this.hold.away = this.timers.set(() => this.endHold("away"), this.holdAwayMs);
    if (!this.hold.pending) this.startHold();
    return true;
  }

  /** The hold goes live: the person's input is taken from here, and its idle window starts now. */
  private startHold(): void {
    const hold = this.hold;
    if (!hold) return;
    hold.pending = false;
    this.timers.clear(hold.idle);
    hold.idle = this.timers.set(() => this.endHold("idle"), this.holdIdleMs);
    this.announce("person");
    try { hold.onStart?.(); } catch { /* a host's listener that throws cannot keep the person from the browser */ }
  }

  holding(): boolean { return this.hold !== null && !this.hold.pending; }

  give(why: "given" | "answered" | "cap" = "given", message?: string): boolean {
    if (!this.hold) return false;
    this.endHold(why, message);
    return true;
  }

  held(): boolean { return this.hold !== null; }

  epoch(): number { return this.epoch_; }

  setPresent(on: boolean): void {
    this.present_ = on;
    if (this.hold) {
      if (this.hold.away !== undefined) this.timers.clear(this.hold.away);
      this.hold.away = on ? undefined : this.timers.set(() => this.endHold("away"), this.holdAwayMs);
    }
    if (!on) this.settle();
  }

  command(): { live(): boolean; done(): void } {
    const mark = {};
    this.commands.add(mark);
    return {
      live: () => this.commands.has(mark),
      done: () => {
        if (!this.commands.delete(mark)) return;
        if (this.settling_ && this.commands.size === 0) this.settled();
        else this.settle();
      },
    };
  }

  settling(): boolean { return this.settling_ !== null; }

  untilFree(signal?: AbortSignal): Promise<void> {
    if (!this.hold && !this.settling_) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => { this.waiters.delete(done); reject(signal?.reason ?? new Error("aborted")); this.settle(); };
      const done = (): void => { signal?.removeEventListener("abort", abort); resolve(); };
      if (signal?.aborted) { abort(); return; }
      this.waiters.add(done);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  end(): void {
    this.endHold("released");
    this.commands.clear();
    this.settled();
    if (this.idle !== undefined) this.timers.clear(this.idle);
    this.idle = undefined;
    this.person = false;
    this.viewing_ = false;
    this.drove_ = false;
    this.model_ = 0;
    this.listeners.clear();
    this.forget(this);
  }

  /** The hold ends: the epoch moves, the person's driving window with it (they let go), the waiting model calls go on, and its listener is told why. */
  private endHold(why: HoldEnd, message?: string): void {
    const hold = this.hold;
    if (!hold) return;
    this.hold = null;
    this.timers.clear(hold.idle);
    if (hold.away !== undefined) this.timers.clear(hold.away);
    this.epoch_ += 1;
    this.person = false;
    if (this.idle !== undefined) this.timers.clear(this.idle);
    this.idle = undefined;
    // A command of the person's still running (a Back between reading the history and moving, a navigation under way) would move the page under
    // the agent's next call: the waiting calls go on once it returns, or once the bound passes and it is let go.
    if (this.commands.size > 0 && why !== "released") {
      if (this.settling_) this.timers.clear(this.settling_.timer);
      this.settling_ = { timer: this.timers.set(() => { this.commands.clear(); this.settled(); }, this.settleMs) };
    } else this.wake();
    this.announce(this.state());
    try { hold.onEnd?.(why, message); } catch { /* a host's listener that throws cannot keep the hold */ }
    this.settle();
  }

  /** The person's last command has returned, or was let go: the waiting model calls go on. */
  private settled(): void {
    if (this.settling_) { this.timers.clear(this.settling_.timer); this.settling_ = null; this.announce(this.state()); }
    this.wake();
    this.settle();
  }

  private wake(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
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
    if (this.model_ === 0 && !this.person && !this.drove_ && !this.viewing_ && !this.hold && !this.present_ && !this.settling_ && this.commands.size === 0 && this.waiters.size === 0 && this.listeners.size === 0) this.forget(this);
  }

  private announce(state: DriveState): void {
    for (const listener of [...this.listeners]) { try { listener(state); } catch { /* a viewer that throws cannot stop the model */ } }
  }
}

/** The person/model mutex for every browser: `gates(tag)` is the tag's gate (the same object each time while anything holds it: a call, a person, a viewer or a listener, and until its `end()`). */
export function createDrivingGates(options: DrivingOptions = {}): DrivingGates {
  const idleMs = options.idleMs ?? 3000;
  const timers = options.timers ?? NODE_TIMERS;
  const holdIdleMs = options.holdIdleMs ?? 15 * 60_000;
  const holdAwayMs = options.holdAwayMs ?? 2 * 60_000;
  const settleMs = options.settleMs ?? 10_000;
  const byTag = new Map<string, Gate>();
  return (tag) => {
    let gate = byTag.get(tag);
    if (!gate) {
      const made: Gate = new Gate(timers, idleMs, (ended) => { if (byTag.get(tag) === ended) byTag.delete(tag); }, holdIdleMs, holdAwayMs, settleMs);
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

/** Why custody must not release a session on its own, or null: a session held for a person is theirs, and so is one a person drives or
 *  watches through the live view. */
export function keptReason(record: { state: string; tag: string }, gates: DrivingGates): "held" | "person_driving" | "viewing" | null {
  if (record.state === "held") return "held";
  const person = personOn(gates, record.tag);
  return person && keptFor(person);
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

/** Whether `gate`'s person hold is live (their input taken): false for a gate without holds. */
export const isHolding = (gate: DrivingGate): boolean => typeof gate.holding === "function" ? gate.holding() : isHeld(gate);
/** Whether `gate`'s hold has ended with the person's last command still settling: false for a gate without holds. */
export const isSettling = (gate: DrivingGate): boolean => typeof gate.settling === "function" && gate.settling();
/** Whether `gate` is held for a person now: false for a gate without holds (a registry that predates them). */
export const isHeld = (gate: DrivingGate): boolean => typeof gate.held === "function" && gate.held();
/** `gate`'s epoch: 0, unmoving, for a gate without holds. */
export const epochOf = (gate: DrivingGate): number => (typeof gate.epoch === "function" ? gate.epoch() : 0);
