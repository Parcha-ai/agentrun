// The wake file: a SQLite store's command wire (command-wake.ts) to the other processes on its file. It lies beside the
// store's file (`<file>.wake`, as the owner lock is `<file>.owner`). A process appends one line per wake, in one write;
// a process that listens watches the file (fs.watch, inotify on Linux, so the file is on local disk as the store's is)
// and reads what was appended since its last read. It stays small: a writer that finds it past WAKE_FILE_MAX empties it
// before its line, and a reader that finds it shorter than where it read to reads it from the start. Only hints go
// through it: a line lost to a race, or a watch that failed, costs a reader its poll.
import { closeSync, type FSWatcher, fstatSync, openSync, watch } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { CommandWire } from "../command-wake.js";

/** The size past which the next writer empties the wake file (bytes): a few hundred wakes. */
export const WAKE_FILE_MAX = 64 * 1024;
/** How long a listener's watch waits to start again after it failed, or after its file was removed (ms). */
export const WAKE_REWATCH_MS = 1_000;

/** The wake file of the store file at `file` (its real path). */
export const wakeFileOf = (file: string): string => `${file}.wake`;

export class WakeFile implements CommandWire {
  readonly #path: string;
  /** The writer's handle, opened at the first send (append). */
  #writer: Promise<FileHandle> | undefined;
  /** The sends in order, one after another: a line is one write, and emptying the file never cuts between two. */
  #writing: Promise<void> = Promise.resolve();
  readonly #hearers = new Set<(text: string) => void>();
  #watcher: FSWatcher | undefined;
  #rewatch: NodeJS.Timeout | undefined;
  /** How far this reader has read, and the start of a line not yet whole. */
  #offset = 0;
  #rest = "";
  #reading = false;
  #again = false;
  #closed = false;

  constructor(path: string) {
    this.#path = path;
  }

  send(text: string): void {
    if (this.#closed) return;
    const line = Buffer.from(`${text}\n`);
    this.#writing = this.#writing.then(async () => {
      const handle = await (this.#writer ??= open(this.#path, "a"));
      if ((await handle.stat()).size > WAKE_FILE_MAX) await handle.truncate(0);
      await handle.write(line);
    }).catch(() => {
      // A file this process cannot write: the next send opens it again.
      const writer = this.#writer;
      this.#writer = undefined;
      void writer?.then((handle) => handle.close()).catch(() => undefined);
    });
  }

  listen(hear: (text: string) => void): () => void {
    this.#hearers.add(hear);
    if (this.#hearers.size === 1) this.#watch();
    return () => {
      if (!this.#hearers.delete(hear) || this.#hearers.size > 0) return;
      this.#unwatch();
    };
  }

  /** Watches the file from its end now (what was written before is old news), making it when it is missing. */
  #watch(): void {
    if (this.#closed || this.#watcher !== undefined || this.#hearers.size === 0) return;
    try {
      const fd = openSync(this.#path, "a");
      try {
        this.#offset = fstatSync(fd).size;
      } finally {
        closeSync(fd);
      }
      this.#rest = "";
      // Not persistent: a watch alone never keeps the process up.
      const watcher = watch(this.#path, { persistent: false }, (kind) => (kind === "rename" ? this.#lost(watcher) : this.#read()));
      watcher.on("error", () => this.#lost(watcher));
      this.#watcher = watcher;
    } catch {
      this.#watchLater();
    }
  }

  /** The watch ended (its file removed or replaced, or the watch failed): started again in a while. */
  #lost(watcher: FSWatcher): void {
    if (this.#watcher !== watcher) return;
    watcher.close();
    this.#watcher = undefined;
    this.#watchLater();
  }

  #watchLater(): void {
    if (this.#closed || this.#rewatch !== undefined || this.#hearers.size === 0) return;
    this.#rewatch = setTimeout(() => {
      this.#rewatch = undefined;
      this.#watch();
    }, WAKE_REWATCH_MS);
    this.#rewatch.unref();
  }

  #unwatch(): void {
    clearTimeout(this.#rewatch);
    this.#rewatch = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  /** Reads what was appended since the last read; a change while it reads reads again after it. */
  #read(): void {
    if (this.#reading) {
      this.#again = true;
      return;
    }
    this.#reading = true;
    void (async () => {
      try {
        do {
          this.#again = false;
          await this.#readOnce();
        } while (this.#again && this.#watcher !== undefined);
      } catch {
        // A read that failed: the next change reads again.
      } finally {
        this.#reading = false;
      }
    })();
  }

  async #readOnce(): Promise<void> {
    const handle = await open(this.#path, "r");
    let text: string;
    try {
      const { size } = await handle.stat();
      // Emptied by a writer since the last read: what is in it now is new.
      if (size < this.#offset) {
        this.#offset = 0;
        this.#rest = "";
      }
      if (size === this.#offset) return;
      const buffer = Buffer.alloc(size - this.#offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.#offset);
      this.#offset += bytesRead;
      text = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
    const lines = (this.#rest + text).split("\n");
    this.#rest = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") continue;
      for (const hear of [...this.#hearers]) hear(line);
    }
  }

  /** Stops the watch and lets the writer's handle go, after the sends in flight. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unwatch();
    this.#hearers.clear();
    await this.#writing;
    const writer = this.#writer;
    this.#writer = undefined;
    await writer?.then((handle) => handle.close()).catch(() => undefined);
  }
}
