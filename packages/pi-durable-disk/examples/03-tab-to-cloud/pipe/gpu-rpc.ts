// The VM's way to its GPU boxes, over the link it already has to the server. The Modal key stays with the server; the VM (where the agent's
// bash runs) can only ask for a box and run commands in the box it was given. Frames, both ways, on the link's WebSocket:
//   VM -> server   gpu-acquire {id, thread}      gpu-release {id, thread}      gpu-poll {id, box}
//                  gpu-exec {id, box, argv, timeoutMs?}   gpu-stdin {id, data}   gpu-stdin-end {id}
//   server -> VM   gpu-ok {id, box?, code?}      gpu-data {id, stream, data}   gpu-exit {id, code}      gpu-err {id, message}
// `data` is base64. A box is reachable only while a thread holds it (the server checks `holds`). When the link or a box goes away every
// call in flight rejects at once, so a thread gets a tool error and never waits on a box that is gone.
//
// `GpuServer` is what the server implements (over the pool of Modal sandboxes); `GpuClient` is the VM's end; `linkBox` shapes one box as the
// `RemoteBox` that the remote ExecutionEnv expects (exec with streams, poll).

export type GpuFrame =
  | { t: "gpu-acquire"; id: number; thread: string }
  | { t: "gpu-release"; id: number; thread: string }
  | { t: "gpu-poll"; id: number; box: string }
  | { t: "gpu-exec"; id: number; box: string; argv: string[]; timeoutMs?: number }
  | { t: "gpu-stdin"; id: number; data: string }
  | { t: "gpu-stdin-end"; id: number }
  | { t: "gpu-ok"; id: number; box?: string; code?: number | null }
  | { t: "gpu-data"; id: number; stream: "stdout" | "stderr"; data: string }
  | { t: "gpu-exit"; id: number; code: number }
  | { t: "gpu-err"; id: number; message: string };

export const isGpuFrame = (frame: { t?: unknown }): frame is GpuFrame => typeof frame.t === "string" && frame.t.startsWith("gpu-");

export interface GpuProcess {
  stdin: { writeBytes(bytes: Uint8Array): Promise<void>; close(): Promise<void> };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  wait(): Promise<number>;
  /** Stop the command (its process group on the box). Called when the link that asked for it is gone: nobody can read its output any more. */
  kill?(): Promise<void>;
}

/** What the server offers a VM. `box` ids are the server's own: the VM treats them as opaque. */
export interface GpuServer {
  /** A box for this thread (waits its turn). Rejects when none can come up or the server is closing; `signal` cancels the wait (the link that asked is gone). */
  acquire(thread: string, signal?: AbortSignal): Promise<string>;
  release(thread: string): void;
  /** Whether a thread of this run holds the box: only then may it run commands there. */
  holds(box: string): boolean;
  /** Start a command in the box. Rejects when the box is gone. */
  exec(box: string, argv: string[], options: { timeoutMs?: number }): Promise<GpuProcess>;
  /** Null while the box lives, its exit code once it ended; rejects when the server knows it is gone. */
  poll(box: string): Promise<number | null>;
}

type Send = (frame: GpuFrame) => void;
/** The most input a command may have held or in flight at once (a VM that writes faster than the box takes it, or before the command starts, cannot grow the server's memory without bound). */
export const GPU_STDIN_MAX_BYTES = 16 * 1024 * 1024;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

/**
 * The server's end of one link: answers the VM's gpu frames from `server`. Returns `handle(frame)` for the frames that are the VM's requests,
 * and `close()` to end every command in flight when the link goes (a command of a dropped link is killed: nobody can read it any more).
 */
export function serveGpu(server: GpuServer, send: Send, log: (event: string, data?: Record<string, unknown>) => void = () => undefined): { handle(frame: GpuFrame): void; close(): void } {
  /** One command asked for: its stdin is held until the box has started it (the VM writes and closes without waiting for that). */
  type Entry = { proc?: GpuProcess; held: (Uint8Array | null)[]; closed: boolean; writes: Promise<unknown>; queued: number };
  /** Set when the link goes: waits for boxes end, and a box that is acquired after that is released at once. */
  const gone = new AbortController();
  const running = new Map<number, Entry>();
  const fail = (id: number, error: unknown) => send({ t: "gpu-err", id, message: (error as Error)?.message ?? String(error) });
  const pump = async (id: number, stream: "stdout" | "stderr", source: AsyncIterable<Uint8Array>) => {
    for await (const chunk of source) send({ t: "gpu-data", id, stream, data: b64(chunk) });
  };
  /** Stdin in order: a chunk (or the end, null) goes to the command once it exists. */
  const feed = (id: number, entry: Entry, item: Uint8Array | null) => {
    const size = item?.length ?? 0;
    if (entry.queued + size > GPU_STDIN_MAX_BYTES) {
      // Past the bound the command is refused and ended: the VM is writing faster than the box takes it (or the command never started).
      entry.closed = true;
      running.delete(id);
      if (entry.proc) stop(entry.proc);
      log("gpu.stdin-too-large", { id, queued: entry.queued });
      fail(id, new Error(`the command's input is over ${GPU_STDIN_MAX_BYTES} bytes at once`));
      return;
    }
    entry.queued += size;
    if (!entry.proc) {
      entry.held.push(item);
      return;
    }
    const proc = entry.proc;
    entry.writes = entry.writes
      .then(() => (item === null ? proc.stdin.close() : proc.stdin.writeBytes(item)))
      .catch((e) => log("gpu.stdin-failed", { error: (e as Error).message }))
      .finally(() => void (entry.queued -= size));
  };
  const stop = (proc: GpuProcess) => {
    void proc.stdin.close().catch(() => undefined);
    void proc.kill?.().catch((e: Error) => log("gpu.kill-failed", { error: e.message }));
  };
  return {
    handle(frame) {
      switch (frame.t) {
        case "gpu-acquire":
          server.acquire(frame.thread, gone.signal).then(
            (box) => {
              // The link went while the thread waited: nobody will use this box, so it goes back at once.
              if (gone.signal.aborted) {
                server.release(frame.thread);
                return;
              }
              send({ t: "gpu-ok", id: frame.id, box });
            },
            (e) => fail(frame.id, e),
          );
          return;
        case "gpu-release":
          try {
            server.release(frame.thread);
            send({ t: "gpu-ok", id: frame.id });
          } catch (e) {
            fail(frame.id, e);
          }
          return;
        case "gpu-poll":
          if (!server.holds(frame.box)) return fail(frame.id, new Error("no thread of this run holds that box"));
          server.poll(frame.box).then((code) => send({ t: "gpu-ok", id: frame.id, code }), (e) => fail(frame.id, e));
          return;
        case "gpu-exec": {
          if (!server.holds(frame.box)) return fail(frame.id, new Error("no thread of this run holds that box"));
          if (!Array.isArray(frame.argv) || frame.argv.length === 0 || !frame.argv.every((a) => typeof a === "string")) return fail(frame.id, new Error("argv is a non-empty list of strings"));
          const entry: Entry = { held: [], closed: false, writes: Promise.resolve(), queued: 0 };
          running.set(frame.id, entry);
          const started = Date.now();
          const what = frame.argv.slice(0, 4).join(" ").slice(0, 100);
          server.exec(frame.box, frame.argv, frame.timeoutMs === undefined ? {} : { timeoutMs: frame.timeoutMs }).then(
            (proc) => {
              if (entry.closed) {
                // The link went while the box was still starting the command: nobody will read it, so it is stopped at once.
                running.delete(frame.id);
                stop(proc);
                return;
              }
              log("gpu.exec", { box: frame.box, id: frame.id, what, startedMs: Date.now() - started });
              entry.proc = proc;
              const heldItems = entry.held.splice(0);
              entry.queued = 0;
              for (const item of heldItems) feed(frame.id, entry, item);
              Promise.all([pump(frame.id, "stdout", proc.stdout), pump(frame.id, "stderr", proc.stderr)])
                .then(() => proc.wait())
                .then(
                  (code) => {
                    log("gpu.exit", { box: frame.box, id: frame.id, what, code, ms: Date.now() - started });
                    send({ t: "gpu-exit", id: frame.id, code });
                  },
                  (e) => {
                    log("gpu.exec-failed", { box: frame.box, id: frame.id, what, error: (e as Error).message });
                    fail(frame.id, e);
                  },
                )
                .finally(() => running.delete(frame.id));
            },
            (e) => {
              running.delete(frame.id);
              log("gpu.exec-failed", { box: frame.box, id: frame.id, what, error: (e as Error).message });
              fail(frame.id, e);
            },
          );
          return;
        }
        case "gpu-stdin": {
          const entry = running.get(frame.id);
          if (entry && !entry.closed) feed(frame.id, entry, unb64(frame.data));
          return;
        }
        case "gpu-stdin-end": {
          const entry = running.get(frame.id);
          if (entry && !entry.closed) feed(frame.id, entry, null);
          return;
        }
        default:
          return;
      }
    },
    close() {
      gone.abort();
      for (const entry of running.values()) {
        entry.closed = true;
        if (entry.proc) stop(entry.proc);
      }
      running.clear();
    },
  };
}

export interface GpuClient {
  acquire(thread: string): Promise<string>;
  release(thread: string): Promise<void>;
  /** One box as the remote execution environment's transport. */
  linkBox(box: string): { readonly sandboxId: string; exec(argv: string[], p: { mode: "binary"; timeoutMs?: number }): Promise<GpuProcess>; poll(): Promise<number | null> };
  /** A frame from the server. True when it was a gpu frame. */
  handle(frame: { t?: unknown }): boolean;
  /** The link went away: every call in flight rejects now. */
  lose(reason: string): void;
}

/** The VM's end. `send` returns false when there is no link right now (the call then rejects at once). */
export function createGpuClient(send: (frame: GpuFrame) => boolean): GpuClient {
  let next = 1;
  const calls = new Map<number, { resolve(frame: Extract<GpuFrame, { t: "gpu-ok" }>): void; reject(error: Error): void }>();
  const procs = new Map<number, { out: Queue; err: Queue; exit: { resolve(code: number): void; reject(error: Error): void } }>();
  const lost = (reason: string) => new Error(reason);

  const call = (build: (id: number) => GpuFrame): Promise<Extract<GpuFrame, { t: "gpu-ok" }>> =>
    new Promise((resolve, reject) => {
      const id = next++;
      calls.set(id, { resolve, reject });
      if (!send(build(id))) {
        calls.delete(id);
        reject(lost("no link to the server"));
      }
    });

  return {
    async acquire(thread) {
      const ok = await call((id) => ({ t: "gpu-acquire", id, thread }));
      if (!ok.box) throw new Error("the server gave no box");
      return ok.box;
    },
    async release(thread) {
      await call((id) => ({ t: "gpu-release", id, thread }));
    },
    linkBox(box) {
      return {
        sandboxId: box,
        async poll() {
          return (await call((id) => ({ t: "gpu-poll", id, box }))).code ?? null;
        },
        async exec(argv, p) {
          const id = next++;
          const out = new Queue();
          const err = new Queue();
          let exit!: { resolve(code: number): void; reject(error: Error): void };
          const done = new Promise<number>((resolve, reject) => (exit = { resolve, reject }));
          done.catch(() => undefined);
          procs.set(id, { out, err, exit });
          if (!send({ t: "gpu-exec", id, box, argv, ...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs }) })) {
            procs.delete(id);
            throw lost("no link to the server");
          }
          return {
            stdin: {
              async writeBytes(bytes) {
                if (!send({ t: "gpu-stdin", id, data: b64(bytes) })) throw lost("no link to the server");
              },
              async close() {
                send({ t: "gpu-stdin-end", id });
              },
            },
            stdout: out,
            stderr: err,
            wait: () => done,
          };
        },
      };
    },
    handle(frame) {
      if (!isGpuFrame(frame)) return false;
      if (frame.t === "gpu-ok" || (frame.t === "gpu-err" && calls.has(frame.id))) {
        const c = calls.get(frame.id);
        calls.delete(frame.id);
        if (frame.t === "gpu-ok") c?.resolve(frame);
        else c?.reject(new Error(frame.message));
        return true;
      }
      const p = procs.get((frame as { id: number }).id);
      if (!p) return true;
      if (frame.t === "gpu-data") (frame.stream === "stdout" ? p.out : p.err).push(unb64(frame.data));
      else if (frame.t === "gpu-exit") {
        p.out.end();
        p.err.end();
        procs.delete(frame.id);
        p.exit.resolve(frame.code);
      } else if (frame.t === "gpu-err") {
        p.out.end();
        p.err.end();
        procs.delete(frame.id);
        p.exit.reject(new Error(frame.message));
      }
      return true;
    },
    lose(reason) {
      for (const c of calls.values()) c.reject(lost(reason));
      calls.clear();
      for (const p of procs.values()) {
        p.out.end();
        p.err.end();
        p.exit.reject(lost(reason));
      }
      procs.clear();
    },
  };
}

/** A queue of chunks read as an async iterable (one reader). */
class Queue implements AsyncIterable<Uint8Array> {
  #chunks: Uint8Array[] = [];
  #waiting: ((r: IteratorResult<Uint8Array>) => void) | undefined;
  #ended = false;
  push(chunk: Uint8Array): void {
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = undefined;
      w({ value: chunk, done: false });
    } else this.#chunks.push(chunk);
  }
  end(): void {
    this.#ended = true;
    if (this.#waiting && this.#chunks.length === 0) {
      const w = this.#waiting;
      this.#waiting = undefined;
      w({ value: undefined, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const chunk = this.#chunks.shift();
        if (chunk) return Promise.resolve({ value: chunk, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.#waiting = resolve));
      },
    };
  }
}
