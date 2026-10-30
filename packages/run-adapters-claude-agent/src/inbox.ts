// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-claude-code/src/inbox.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, patches: 002-names
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
    if (this.ended) throw new Error('agentrun-claude-agent: the input is closed');
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
