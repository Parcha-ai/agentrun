// A pool of GPU boxes for the robot cluster beat: N sandboxes created in parallel before anyone asks, handed one per thread, and all of them
// removed at the end. Creating the boxes (the Modal create, the image, the readiness wait) and removing one are the caller's functions, so this
// file holds only the rules that cost money when they are wrong:
//   - a box that is being created when the pool closes removes itself the moment it lands (no box after close);
//   - close() waits, bounded, for creates in flight, then removes every box it knows, trying again; what it could not remove is reported;
//   - a thread gets one box at a time (asking again returns the same box), threads that cannot have one yet wait their turn (first come, first served), and a box that is
//     released goes to the next waiting thread;
//   - a box that failed to come up is reported, and a pool with no box left to wait for fails its waiting threads instead of hanging them.
type Log = (event: string, data?: Record<string, unknown>) => void;

export interface PoolBox {
  readonly id: string;
  readonly name: string;
  /** Its place in the pool, 0-based (the stage shows "GPU 3" from it). */
  readonly index: number;
}

export type BoxState = "creating" | "ready" | "busy" | "failed" | "removed" | "idle";

export interface PoolStatus {
  readonly size: number;
  readonly closing: boolean;
  readonly boxes: readonly { readonly index: number; readonly state: BoxState; readonly id?: string; readonly thread?: string; readonly createMs?: number; readonly error?: string; readonly attempt?: number; readonly retrying?: boolean }[];
}

export interface GpuPoolOptions {
  /** How many boxes are needed: `start()` resolves once this many are ready (or every create has settled). */
  readonly size: number;
  /** Extra boxes created alongside (default 0): a straggler among them cannot hold up the start, and a spare stands in for a box that ended. They cost like any other box. */
  readonly spares?: number;
  /** Create box `index` and wait until it can run work. Rejecting means this box failed. `signal` aborts when the pool closes (a create that cannot be cancelled may ignore it). */
  readonly create: (index: number, signal: AbortSignal) => Promise<PoolBox>;
  /** Remove a box. True when it is gone. */
  readonly remove: (box: PoolBox) => Promise<boolean>;
  readonly log: Log;
  /** How long close() waits for creates in flight (default 60 s). */
  readonly closeWaitMs?: number;
  /** Called with the status after every change, for the stage's pool card. */
  readonly onChange?: (status: PoolStatus) => void;
  /** Whether a box still lives (its sandbox has not ended: TTL, preemption, death). Checked before a released box is handed out again and every `watchMs`. */
  readonly alive?: (box: PoolBox) => Promise<boolean>;
  /** How often the live boxes are checked with `alive` (default 20 s; 0: never). */
  readonly watchMs?: number;
  /**
   * How long the pool may sit unused (no thread holds a box, nobody waits, no command ran) before its boxes are removed so a forgotten run cannot leave GPUs
   * running (default 0: never). The pool stays usable: the next `acquire` creates the boxes again (it costs the creation time), and says so in the log.
   */
  readonly idleMs?: number;
  /** The clock the idle timeout reads (tests drive it); default Date.now. */
  readonly now?: () => number;
  /** How long one `alive` check may take (default 10 s): a Modal call that does not answer says nothing, and the box stays available. */
  readonly aliveTimeoutMs?: number;
  /**
   * A box whose create failed (it never placed, it was not ready in time) is created again, with a fresh request, after `delays[attempt]` ms (the last delay repeats), until it is up or the pool closes;
   * each attempt is logged (`pool.box-retry`). Threads asking meanwhile keep waiting for the boxes that are up or on their way. Absent or empty: a failed box stays failed.
   */
  readonly retryDelaysMs?: readonly number[];
}

type Slot = { index: number; state: BoxState; attempt?: number; retrying?: boolean; retryTimer?: NodeJS.Timeout; box?: PoolBox; thread?: string; createMs?: number; error?: string; creating?: Promise<void>; checking?: boolean; gone?: boolean; removing?: boolean };
type Waiter = { thread: string; promise: Promise<PoolBox>; resolve: (box: PoolBox) => void; reject: (error: Error) => void; onAbort?: () => void; signal?: AbortSignal };

export class GpuPool {
  readonly #options: GpuPoolOptions;
  readonly #slots: Slot[];
  readonly #waiting: Waiter[] = [];
  readonly #abort = new AbortController();
  #closing = false;
  #started = false;
  #watch: NodeJS.Timeout | undefined;
  #onSettle: (() => void) | undefined;
  #idle: NodeJS.Timeout | undefined;
  #lastActive = 0;

  constructor(options: GpuPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) throw new Error("the pool needs at least one box");
    this.#options = options;
    this.#lastActive = this.#clock();
    this.#slots = Array.from({ length: options.size + (options.spares ?? 0) }, (_, index) => ({ index, state: "creating" as BoxState }));
  }

  #clock(): number {
    return (this.#options.now ?? Date.now)();
  }

  status(): PoolStatus {
    return {
      size: this.#options.size,
      closing: this.#closing,
      boxes: this.#slots.map((s) => ({ index: s.index, state: s.state, ...(s.box ? { id: s.box.id } : {}), ...(s.thread ? { thread: s.thread } : {}), ...(s.createMs !== undefined ? { createMs: s.createMs } : {}), ...(s.attempt && s.attempt > 1 ? { attempt: s.attempt } : {}), ...(s.retrying ? { retrying: true } : {}), ...(s.error ? { error: s.error } : {}) })),
    };
  }

  /** Start creating every box, in parallel. Resolves when each has either come up or failed (one failure does not stop the others). */
  async start(): Promise<void> {
    if (this.#started) throw new Error("the pool was already started");
    this.#started = true;
    this.#lastActive = this.#clock(); // the idle clock runs from the boxes' creation, not from when the pool was built
    for (const slot of this.#slots) slot.creating = this.#create(slot);
    const every = this.#options.watchMs ?? 20_000;
    if (this.#options.alive && every > 0) {
      this.#watch = setInterval(() => void this.#verifyAll(), every);
      this.#watch.unref();
    }
    // Ready when `size` boxes are up (a spare that is still coming does not hold this up), or when every create has settled.
    const idleMs = this.#options.idleMs ?? 0;
    if (idleMs > 0) {
      this.#idle = setInterval(() => void this.#idleCheck(), Math.max(50, Math.min(30_000, Math.floor(idleMs / 2))));
      this.#idle.unref();
    }
    await new Promise<void>((resolve) => {
      const check = () => {
        const up = this.#slots.filter((s) => s.state === "ready" || s.state === "busy").length;
        if (up >= this.#options.size || this.#slots.every((s) => s.state !== "creating")) resolve();
      };
      this.#onSettle = check;
      check();
    });
    this.#onSettle = undefined;
  }

  async #create(slot: Slot): Promise<void> {
    const t0 = Date.now();
    try {
      const box = await this.#options.create(slot.index, this.#abort.signal);
      slot.createMs = Date.now() - t0;
      if (this.#closing) {
        // The pool closed while this box was being made: its sweep has passed, so it is removed here.
        this.#options.log("pool.late-box", { index: slot.index, box: box.name });
        slot.box = box;
        // Nobody sweeps after close: this box is removed here, again if Modal would not take it the first time.
        for (let attempt = 0; attempt < 4 && !(await this.#remove(slot)); attempt++) await new Promise((r) => setTimeout(r, 500));
        if (slot.state !== "removed") this.#options.log("pool.late-box-left", { index: slot.index, box: box.name });
        this.#onSettle?.();
        return;
      }
      slot.box = box;
      slot.state = "ready";
      this.#options.log("pool.box-ready", { index: slot.index, box: box.name, ms: slot.createMs });
      this.#changed();
      this.#serve();
      this.#onSettle?.();
    } catch (error) {
      slot.state = "failed";
      slot.error = (error as Error).message;
      this.#options.log("pool.box-failed", { index: slot.index, error: slot.error, attempt: slot.attempt ?? 1 });
      this.#scheduleRetry(slot);
      this.#changed();
      this.#failWaitersIfHopeless();
      this.#onSettle?.();
    }
  }

  /** A failed create is tried again after a delay (the pool's retry option), with a fresh request, until the box is up or the pool closes. */
  #scheduleRetry(slot: Slot): void {
    const delays = this.#options.retryDelaysMs;
    if (this.#closing || !delays || delays.length === 0) return;
    const attempt = slot.attempt ?? 1;
    const afterMs = delays[Math.min(attempt - 1, delays.length - 1)]!;
    slot.retrying = true;
    this.#options.log("pool.box-retry", { index: slot.index, attempt: attempt + 1, afterMs, previous: slot.error });
    slot.retryTimer = setTimeout(() => {
      slot.retryTimer = undefined;
      if (this.#closing) return;
      slot.attempt = attempt + 1;
      slot.retrying = false;
      slot.state = "creating";
      delete slot.error;
      this.#changed();
      slot.creating = this.#create(slot);
    }, afterMs);
  }

  /**
   * The box this thread works on: waits for a free one when all are busy or still coming up. Rejects when the pool closes or no box can come up.
   * Idempotent per thread: asking again returns the box the thread holds, or shares the wait it already has (a restart reruns its acquire phase), so
   * one thread never ends up holding or queueing for two boxes. A second caller's `signal` does not cancel the shared wait.
   */
  acquire(thread: string, signal?: AbortSignal): Promise<PoolBox> {
    if (this.#closing) return Promise.reject(new Error("the pool is closing"));
    this.#lastActive = this.#clock();
    const held = this.#slots.find((s) => s.thread === thread && s.box);
    if (held) return Promise.resolve(held.box!);
    const waiting = this.#waiting.find((w) => w.thread === thread);
    if (waiting) return waiting.promise;
    let resolve!: (box: PoolBox) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PoolBox>((res, rej) => ((resolve = res), (reject = rej)));
    const waiter: Waiter = { thread, promise, resolve, reject, ...(signal ? { signal } : {}) };
    if (signal) {
      if (signal.aborted) return Promise.reject(new Error("the wait for a box was cancelled"));
      waiter.onAbort = () => {
        const i = this.#waiting.indexOf(waiter);
        if (i >= 0) this.#waiting.splice(i, 1);
        reject(new Error("the wait for a box was cancelled"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    this.#waiting.push(waiter);
    this.#wake();
    this.#serve();
    this.#failWaitersIfHopeless();
    return promise;
  }

  /** The thread is done with its box; it goes to the next waiting thread, or back to the pool. */
  release(thread: string): void {
    const slot = this.#slots.find((s) => s.thread === thread);
    if (!slot) return;
    delete slot.thread;
    this.#lastActive = this.#clock();
    if (slot.state === "busy") slot.state = "ready";
    this.#changed();
    if (this.#options.alive) {
      // A box that ended while a thread held it is not handed to the next one: it is checked first.
      slot.checking = true;
      void this.#verify(slot).finally(() => {
        slot.checking = false;
        this.#serve();
      });
      return;
    }
    this.#serve();
  }

  /** Something used the pool (a command ran in a box): the idle clock restarts. */
  touch(): void {
    this.#lastActive = this.#clock();
  }

  async #idleCheck(): Promise<void> {
    const idleMs = this.#options.idleMs ?? 0;
    if (this.#closing || idleMs <= 0 || this.#clock() - this.#lastActive < idleMs) return;
    if (this.#waiting.length > 0 || this.#slots.some((x) => x.state === "busy" || x.state === "creating")) return;
    const ready = this.#slots.filter((x) => x.state === "ready" && x.box);
    if (ready.length === 0) return;
    this.#options.log("pool.idle-timeout", { idleMs, boxes: ready.length });
    for (const slot of ready) {
      slot.state = "idle";
      slot.removing = true;
    }
    await Promise.all(
      ready.map(async (slot) => {
        const gone = await this.#remove(slot, true);
        slot.gone = false;
        slot.removing = false;
        if (gone) slot.box = undefined;
        // A box that would not go is still running: it is ready again (a request can use it, and the next idle check tries again), not lost.
        else {
          slot.state = "ready";
          this.#lastActive = this.#clock();
          this.#options.log("pool.idle-remove-failed", { index: slot.index, box: slot.box?.name });
        }
      }),
    );
    this.#changed();
    // A thread that asked while the boxes were going is served by one that would not go, and by new ones for the rest.
    this.#serve();
    if (this.#waiting.length > 0) this.#wake();
    this.#failWaitersIfHopeless();
  }

  /**
   * Threads asked while the boxes were released for idleness: boxes are made again, as many as the demand needs beyond the ones that are ready or already on
   * their way (one box that would not be removed is still ready and serves one thread; the others get new ones).
   */
  #wake(): void {
    if (this.#slots.some((x) => x.removing)) return; // the removal in progress calls this again when it ends
    const sleeping = this.#slots.filter((x) => x.state === "idle");
    if (sleeping.length === 0) return;
    const supply = this.#slots.filter((x) => (x.state === "ready" && !x.checking) || x.state === "creating").length;
    const need = this.#waiting.length - supply;
    if (need <= 0) return;
    const wake = sleeping.slice(0, need);
    this.#options.log("pool.wake", { boxes: wake.length, waiting: this.#waiting.length });
    for (const slot of wake) {
      slot.state = "creating";
      delete slot.error;
      slot.creating = this.#create(slot);
    }
    this.#changed();
  }

  /** The box has ended (its sandbox is gone): it is never handed out again, and what is waiting for a box is told if none can come up any more. */
  markDead(boxId: string, reason: string): void {
    const slot = this.#slots.find((s) => s.box?.id === boxId);
    if (!slot || slot.state === "failed" || slot.state === "removed") return;
    slot.state = "failed";
    slot.error = `the box ended: ${reason}`;
    delete slot.thread;
    this.#options.log("pool.box-dead", { index: slot.index, box: slot.box?.name, reason });
    this.#changed();
    void this.#remove(slot, true);
    this.#failWaitersIfHopeless();
  }

  async #verify(slot: Slot): Promise<void> {
    const alive = this.#options.alive;
    if (!alive || !slot.box || (slot.state !== "ready" && slot.state !== "busy")) return;
    // A check that itself fails, or does not answer in time, says nothing: the box stays available (the next watch asks again). An answer that comes
    // late is not thrown away: a box found dead after the deadline is marked dead then.
    let timer: NodeJS.Timeout | undefined;
    const box = slot.box;
    const asked = alive(box).catch(() => true);
    void asked.then((late) => {
      if (!late && (slot.state === "ready" || slot.state === "busy")) this.markDead(box.id, "its sandbox is no longer running");
    });
    const ok = await Promise.race([asked, new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), this.#options.aliveTimeoutMs ?? 10_000)))]);
    clearTimeout(timer);
    void ok; // a dead answer (in time or late) is acted on by the handler above
  }

  async #verifyAll(): Promise<void> {
    await Promise.all(this.#slots.map((s) => this.#verify(s)));
  }

  #serve(): void {
    while (this.#waiting.length > 0) {
      const slot = this.#slots.find((s) => s.state === "ready" && !s.checking);
      if (!slot) return;
      const waiter = this.#waiting.shift()!;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      slot.state = "busy";
      slot.thread = waiter.thread;
      this.#options.log("pool.acquired", { index: slot.index, thread: waiter.thread });
      this.#changed();
      waiter.resolve(slot.box!);
    }
  }

  #failWaitersIfHopeless(): void {
    // Nothing is ready, busy or on its way: waiting longer cannot help.
    if (this.#slots.some((s) => s.state === "creating" || s.state === "ready" || s.state === "busy" || s.state === "idle" || s.retrying)) return;
    for (const w of this.#waiting.splice(0)) {
      if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
      w.reject(new Error(this.#slots.some((s) => s.error?.startsWith("the box ended")) ? "every GPU box ended" : "no GPU box came up"));
    }
  }

  async #remove(slot: Slot, keepState = false): Promise<boolean> {
    if (!slot.box) return true;
    const gone = await this.#options.remove(slot.box).catch((error: Error) => {
      this.#options.log("pool.remove-failed", { index: slot.index, error: error.message });
      return false;
    });
    if (gone) {
      if (!keepState) slot.state = "removed";
      slot.gone = true;
      delete slot.thread;
    }
    this.#changed();
    return gone;
  }

  /** Remove every box: refuse new work, cancel waiting threads, wait (bounded) for creates in flight, remove what exists, again for what would not go. Reports what is left. */
  async close(): Promise<{ left: number }> {
    this.#closing = true;
    this.#abort.abort();
    clearInterval(this.#watch);
    clearInterval(this.#idle);
    for (const slot of this.#slots) if (slot.retryTimer) (clearTimeout(slot.retryTimer), (slot.retryTimer = undefined), (slot.retrying = false));
    for (const w of this.#waiting.splice(0)) {
      if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
      w.reject(new Error("the pool is closing"));
    }
    const inFlight = this.#slots.filter((s) => s.state === "creating").map((s) => s.creating!);
    if (inFlight.length > 0) {
      const waitMs = this.#options.closeWaitMs ?? 60_000;
      let timer: NodeJS.Timeout | undefined;
      const settled = await Promise.race([Promise.allSettled(inFlight).then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), waitMs)))]);
      clearTimeout(timer);
      if (!settled) this.#options.log("pool.close-pending", { creating: this.#slots.filter((s) => s.state === "creating").length, waitMs });
    }
    for (let round = 0; round < 3; round++) {
      const todo = this.#slots.filter((s) => s.box && !s.gone && s.state !== "removed");
      if (todo.length === 0) break;
      await Promise.all(todo.map((s) => this.#remove(s)));
      if (this.#slots.some((s) => s.box && !s.gone && s.state !== "removed")) await new Promise((r) => setTimeout(r, 500));
    }
    const left = this.#slots.filter((s) => s.box && !s.gone && s.state !== "removed").length;
    if (left > 0) this.#options.log("pool.close-left", { left });
    return { left };
  }

  #changed(): void {
    this.#options.onChange?.(this.status());
  }
}
