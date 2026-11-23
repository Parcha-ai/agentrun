// A run file's cut (redactSecrets) off the server's event loop: one worker thread (cut-worker.ts), kept for the next read,
// that cuts one text at a time. A read waits for its cut at most its deadline, counted from its call, its wait behind
// another read's cut included. Past it the read's cut is refused (CutUnserved), never answered with the text uncut: a cut
// still queued is dropped, and a cut running is stopped by terminating its worker, which the next cut makes anew. A
// worker that fails or stops refuses the cut it held. Kept, the worker cost a cut about 6 ms where a worker made for each
// read cost about 65 ms (50 files of 20 KiB, 20 values). It never holds a process open: it is unref'd, and a cut waiting
// on it is held by its own timer.
import { Worker } from "node:worker_threads";
import type { CutJob, CutReply } from "./cut-worker.js";

/** How long a run file read waits for its cut before refusing it (503): under a template eval grader's 10 s per read. */
export const CUT_MS = 5_000;

/** A cut not made: past its deadline, or its worker failed or stopped. Its message names why, never the text. */
export class CutUnserved extends Error {
  override readonly name = "CutUnserved";
}

type Pending = {
  readonly job: CutJob;
  readonly resolve: (text: string) => void;
  readonly reject: (error: CutUnserved) => void;
  timer?: NodeJS.Timeout;
};

export class CutPool {
  readonly #url: URL;
  #worker: Worker | undefined;
  #running: Pending | undefined;
  readonly #queue: Pending[] = [];
  #next = 1;

  constructor(url: URL) {
    this.#url = url;
  }

  /** `text` cut as redactSecrets(text, values, max, held) cuts it, in the worker, or CutUnserved past `timeMs`. */
  cut(text: string, values: readonly string[], max: number, held: readonly (readonly [number, number])[], timeMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const pending: Pending = { job: { id: this.#next++, text, values, max, held }, resolve, reject };
      pending.timer = setTimeout(() => this.#late(pending, timeMs), timeMs);
      this.#queue.push(pending);
      this.#pump();
    });
  }

  #late(pending: Pending, timeMs: number): void {
    const at = this.#queue.indexOf(pending);
    if (at >= 0) this.#queue.splice(at, 1);
    else if (this.#running === pending) {
      // The only way to stop a cut mid-run: the worker goes with it, and the next cut makes a new one.
      this.#running = undefined;
      const stopped = this.#worker;
      this.#worker = undefined;
      void stopped?.terminate();
    } else return;
    pending.reject(new CutUnserved(`the cut did not finish within ${timeMs} ms`));
    this.#pump();
  }

  #pump(): void {
    if (this.#running || this.#queue.length === 0) return;
    const pending = this.#queue.shift()!;
    this.#running = pending;
    this.#worker ??= this.#make();
    this.#worker.postMessage(pending.job);
  }

  #settle(error: CutUnserved | undefined, text?: string): void {
    const done = this.#running!;
    this.#running = undefined;
    clearTimeout(done.timer);
    if (error) done.reject(error);
    else done.resolve(text!);
    this.#pump();
  }

  #make(): Worker {
    // No process flags: the worker needs none, and some it would inherit refuse a worker started from a file.
    const made = new Worker(this.#url, { execArgv: [] });
    made.on("message", (reply: CutReply) => {
      if (made !== this.#worker || this.#running?.job.id !== reply.id) return;
      if ("text" in reply) this.#settle(undefined, reply.text);
      else this.#settle(new CutUnserved(`the cut failed (${reply.failed})`));
    });
    const lost = (why: string) => {
      // A worker this pool already let go (terminated at a deadline) says nothing of the cuts after it.
      if (made !== this.#worker) return;
      this.#worker = undefined;
      if (this.#running) this.#settle(new CutUnserved(why));
    };
    made.on("error", (error) => lost(`its worker failed (${error.name})`));
    made.on("exit", () => lost("its worker stopped"));
    // Unref'd after its listeners: a "message" listener refs the worker again, and one unref'd before it held the process
    // open for good. A cut waiting on it is held by its own deadline timer.
    made.unref();
    return made;
  }
}

const pool = new CutPool(new URL("./cut-worker.js", import.meta.url));

/** `text` cut as redactSecrets cuts it, in the server's one cut worker, or CutUnserved past `timeMs`. */
export function cutInWorker(text: string, values: readonly string[], max: number, held: readonly (readonly [number, number])[] = [], timeMs = CUT_MS): Promise<string> {
  return pool.cut(text, values, max, held, timeMs);
}
