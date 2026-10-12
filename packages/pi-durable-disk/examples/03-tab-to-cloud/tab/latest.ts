// "Only the latest request counts": a slow earlier read that finishes after a newer one must not draw over it.
export class Latest {
  #n = 0;
  /** Start a request; the returned number is its identity. */
  next(): number {
    return ++this.#n;
  }
  /** Whether this is still the most recent request. */
  current(n: number): boolean {
    return n === this.#n;
  }
}
