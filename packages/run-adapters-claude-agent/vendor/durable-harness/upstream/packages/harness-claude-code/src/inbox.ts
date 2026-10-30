/**
 * The streaming input `query()` reads: an async iterable the drive pushes
 * user messages into. `end()` closes it, which closes the CLI's stdin, and
 * the CLI exits once it is idle.
 */
export class MessageQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private ended = false;
  private wake: (() => void) | undefined;

  push(item: T): void {
    if (this.ended) throw new Error('harness-world-claude-code: the input is closed');
    this.items.push(item);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  get closed(): boolean {
    return this.ended;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}
