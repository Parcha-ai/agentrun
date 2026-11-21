/** A moved project's dispatch fence within one claim. The store still fences journal commits; this only ensures
 * project capture cannot race host/tool calls admitted by this loop. It never retries an interrupted effect. */
export class ProjectDrain {
  #closed = false;
  #active = new Set<Promise<unknown>>();
  get closed(): boolean { return this.#closed; }
  async run<T>(call: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("The project's dispatch has closed for checkpoint capture.");
    const pending = Promise.resolve().then(call); this.#active.add(pending);
    try { return await pending; } finally { this.#active.delete(pending); }
  }
  async close(signal: AbortSignal): Promise<void> {
    this.#closed = true;
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.#active]), new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { if (abort) signal.removeEventListener("abort", abort); }
    signal.throwIfAborted();
  }
}
