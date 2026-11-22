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
    // Cancellation requests a stop; it is never evidence that an already dispatched write actually stopped.
    await Promise.allSettled([...this.#active]);
    signal.throwIfAborted();
  }
}
