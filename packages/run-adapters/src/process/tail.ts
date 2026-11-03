// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/tail.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, patches: 002-message-prefix
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * A line-complete tail of an append-only file (a JSONL transcript, a
 * rollout): `read()` returns the lines completed since the last read and
 * keeps a partial last line for the next one. For mirroring a native
 * session file into the journal as the harness writes it.
 */
export class FileTail {
  constructor(
    readonly path: string,
    /** Byte offset already consumed (the length of what the journal already holds). */
    public offset = 0
  ) {}

  /**
   * The complete lines appended since the last read. Throws if the file is
   * now shorter than what was read: it was rewritten, not appended to, and
   * the journal can no longer mirror it line by line.
   */
  read(): string[] {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) throw new Error(`agentrun-kernel: ${this.path} shrank from ${this.offset} to ${size} bytes`);
      if (size === this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      const last = buf.lastIndexOf(0x0a);
      if (last < 0) return [];
      this.offset += last + 1;
      return buf.subarray(0, last).toString('utf8').split('\n');
    } finally {
      closeSync(fd);
    }
  }
}
