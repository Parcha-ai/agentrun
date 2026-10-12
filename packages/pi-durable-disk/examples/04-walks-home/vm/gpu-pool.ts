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

export type BoxState = "creating" | "ready" | "busy" | "failed" | "removed";

export interface PoolStatus {
  readonly size: number;
  readonly closing: boolean;
  readonly boxes: readonly { readonly index: number; readonly state: BoxState; readonly id?: string; readonly thread?: string; readonly createMs?: number; readonly error?: string }[];
}

export interface GpuPoolOptions {
  /** How many boxes. */
  readonly size: number;
  /** Create box `index` and wait until it can run work. Rejecting means this box failed. `signal` aborts when the pool closes (a create that cannot be cancelled may ignore it). */
  readonly create: (index: number, signal: AbortSignal) => Promise<PoolBox>;
  /** Remove a box. True when it is gone. */
  readonly remove: (box: PoolBox) => Promise<boolean>;
  readonly log: Log;
  /** How long close() waits for creates in flight (default 60 s). */
  readonly closeWaitMs?: number;
  /** Called with the status after every change, for the stage's pool card. */
  readonly onChange?: (status: PoolStatus) => void;
}

type Slot = { index: number; state: BoxState; box?: PoolBox; thread?: string; createMs?: number; error?: string; creating?: Promise<void> };
type Waiter = { thread: string; resolve: (box: PoolBox) => void; reject: (error: Error) => void; onAbort?: () => void; signal?: AbortSignal };

export class GpuPool {
  readonly #options: GpuPoolOptions;
  readonly #slots: Slot[];
  readonly #waiting: Waiter[] = [];
  readonly #abort = new AbortController();
  #closing = false;
  #started = false;

  constructor(options: GpuPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) throw new Error("the pool needs at least one box");
    this.#options = options;
    this.#slots = Array.from({ length: options.size }, (_, index) => ({ index, state: "creating" as BoxState }));
  }

  status(): PoolStatus {
    return {
      size: this.#options.size,
      closing: this.#closing,
      boxes: this.#slots.map((s) => ({ index: s.index, state: s.state, ...(s.box ? { id: s.box.id } : {}), ...(s.thread ? { thread: s.thread } : {}), ...(s.createMs !== undefined ? { createMs: s.createMs } : {}), ...(s.error ? { error: s.error } : {}) })),
    };
  }

  /** Start creating every box, in parallel. Resolves when each has either come up or failed (one failure does not stop the others). */
  async start(): Promise<void> {
    if (this.#started) throw new Error("the pool was already started");
    this.#started = true;
    for (const slot of this.#slots) slot.creating = this.#create(slot);
    await Promise.all(this.#slots.map((s) => s.creating));
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
        await this.#remove(slot);
        return;
      }
      slot.box = box;
      slot.state = "ready";
      this.#options.log("pool.box-ready", { index: slot.index, box: box.name, ms: slot.createMs });
      this.#changed();
      this.#serve();
    } catch (error) {
      slot.state = "failed";
      slot.error = (error as Error).message;
      this.#options.log("pool.box-failed", { index: slot.index, error: slot.error });
      this.#changed();
      this.#failWaitersIfHopeless();
    }
  }

  /** The box this thread works on: waits for a free one when all are busy or still coming up. Rejects when the pool closes or no box can come up. */
  acquire(thread: string, signal?: AbortSignal): Promise<PoolBox> {
    if (this.#closing) return Promise.reject(new Error("the pool is closing"));
    // Idempotent per thread: a thread that comes back (a restart reruns its acquire phase) gets the box it already holds.
    const held = this.#slots.find((s) => s.thread === thread && s.box);
    if (held) return Promise.resolve(held.box!);
    return new Promise<PoolBox>((resolve, reject) => {
      const waiter: Waiter = { thread, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        if (signal.aborted) return reject(new Error("the wait for a box was cancelled"));
        waiter.onAbort = () => {
          const i = this.#waiting.indexOf(waiter);
          if (i >= 0) this.#waiting.splice(i, 1);
          reject(new Error("the wait for a box was cancelled"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiting.push(waiter);
      this.#serve();
      this.#failWaitersIfHopeless();
    });
  }

  /** The thread is done with its box; it goes to the next waiting thread, or back to the pool. */
  release(thread: string): void {
    const slot = this.#slots.find((s) => s.thread === thread);
    if (!slot) return;
    delete slot.thread;
    if (slot.state === "busy") slot.state = "ready";
    this.#changed();
    this.#serve();
  }

  #serve(): void {
    while (this.#waiting.length > 0) {
      const slot = this.#slots.find((s) => s.state === "ready");
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
    if (this.#slots.some((s) => s.state === "creating" || s.state === "ready" || s.state === "busy")) return;
    for (const w of this.#waiting.splice(0)) {
      if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
      w.reject(new Error("no GPU box came up"));
    }
  }

  async #remove(slot: Slot): Promise<boolean> {
    if (!slot.box) return true;
    const gone = await this.#options.remove(slot.box).catch((error: Error) => {
      this.#options.log("pool.remove-failed", { index: slot.index, error: error.message });
      return false;
    });
    if (gone) {
      slot.state = "removed";
      delete slot.thread;
    }
    this.#changed();
    return gone;
  }

  /** Remove every box: refuse new work, cancel waiting threads, wait (bounded) for creates in flight, remove what exists, again for what would not go. Reports what is left. */
  async close(): Promise<{ left: number }> {
    this.#closing = true;
    this.#abort.abort();
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
      const todo = this.#slots.filter((s) => s.box && s.state !== "removed");
      if (todo.length === 0) break;
      await Promise.all(todo.map((s) => this.#remove(s)));
      if (this.#slots.some((s) => s.box && s.state !== "removed")) await new Promise((r) => setTimeout(r, 500));
    }
    const left = this.#slots.filter((s) => s.box && s.state !== "removed").length;
    if (left > 0) this.#options.log("pool.close-left", { left });
    return { left };
  }

  #changed(): void {
    this.#options.onChange?.(this.status());
  }
}
