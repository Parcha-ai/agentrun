// A Workspace write bigger than a channel frame, from a run's own process. In Mode 2 the run's process holds its runner's
// Workspace of the run's folder by handle (held.ts archil, archil-claim.ts archilWhereHeld), and a call carries all its
// arguments in one frame of the run's channel (run-channel.ts MAX_FRAME): a write of a file past that would fail after
// the bytes were made (web_save's download, up to SAVE_MAX_BYTES). So a write of more than one piece does not cross as one
// call: the runner, handed the length, pulls the bytes from the run's process a piece at a time, each piece of exactly
// the length it asked for, into one buffer allocated at that length, and makes the one atomic write itself, on the same
// Workspace the run's process would have written through. A piece that is not the length asked, a length past
// BIG_WRITE_MAX, the run's signal, a piece not answered in PIECE_MS, or the run's channel ending writes nothing.
//
// The runner holds each assembled file in memory until its write returns, so it bounds them: at most BIG_WRITES at once
// across its runs (BIG_WRITE_SLOTS, a gate of its own, never web_save's download slots, so a run that holds a download
// slot never waits on itself), the rest waiting under their call's signal, and at most BIG_WRITES_PER_RUN held or waiting
// per run. Every wait and hold of a run is let go when its channel ends (save-slots.ts does the same for its slots). The
// runner only copies bytes and calls the Workspace: it reads nothing of them and dials nothing.
import { ClaimRefused } from "./loop-contract.js";
import { ChannelClosed } from "./run-channel.js";
import { saveSlots, SAVE_MAX_BYTES, type SaveSlots } from "../web-save.js";
import type { Pieces, WritePieces } from "../workspace/pieced.js";
import { type Workspace, WorkspaceError } from "../workspace/workspace.js";

export type { Pieces, PullPiece, WritePieces } from "../workspace/pieced.js";
export { piecedWorkspace } from "../workspace/pieced.js";

const MIB = 1024 * 1024;
/** The most bytes one piece carries over the channel: well under its MAX_FRAME (32 MiB). A write of at most this many
 *  bytes crosses as one call, as before. */
export const PIECE_BYTES = 8 * MIB;
/** The most bytes one pieced write may have: web_save's cap. */
export const BIG_WRITE_MAX = SAVE_MAX_BYTES;
/** How long the runner waits for one piece before the write fails. */
export const PIECE_MS = 60_000;
/** The most pieced writes a runner assembles at once, across its runs: with BIG_WRITE_MAX, what they hold in memory. */
export const BIG_WRITES = 4;
/** The most pieced writes one run may have held or waiting at once: its waiters live in the runner. */
export const BIG_WRITES_PER_RUN = 8;
/** The runner's one gate for pieced writes. */
export const BIG_WRITE_SLOTS: SaveSlots = saveSlots(BIG_WRITES);

export type BigWritesOptions = {
  /** Default BIG_WRITE_SLOTS. */
  readonly gate?: SaveSlots;
  /** Default PIECE_BYTES. */
  readonly piece?: number;
  /** Default PIECE_MS. */
  readonly pieceMs?: number;
};

/** One run's pieced writes on its runner: `pieces(ws)` is what is handed beside `ws`; `close()`, called when the run's
 *  channel ends (or its claim is released), lets every wait and hold of the run go. */
export interface RunBigWrites {
  pieces(ws: Workspace): Pieces;
  close(): void;
}

/** `work`'s answer, or `signal`'s reason as soon as it aborts. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function runBigWrites(options: BigWritesOptions = {}): RunBigWrites {
  const gate = options.gate ?? BIG_WRITE_SLOTS;
  const piece = options.piece ?? PIECE_BYTES;
  const pieceMs = options.pieceMs ?? PIECE_MS;
  /** Each write of the run, waiting or held: aborted when the run's channel ends. */
  const live = new Set<AbortController>();
  let closed = false;
  const writeOn = (ws: Workspace): WritePieces => async (path, size, pull, signal) => {
    if (closed) throw new ChannelClosed("the run's channel ended");
    if (typeof path !== "string") throw new TypeError("a pieced write names its path");
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("a pieced write's size is a whole number of bytes");
    // Before anything is taken or allocated.
    if (size > BIG_WRITE_MAX) throw new WorkspaceError("TOO_LARGE", `a write from a run's process is at most ${BIG_WRITE_MAX} bytes, not ${size}`, { path });
    if (typeof pull !== "function") throw new TypeError("a pieced write is pulled through a function");
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("a pieced write runs under the call's signal");
    if (live.size >= BIG_WRITES_PER_RUN) throw new ClaimRefused(`this run already has ${BIG_WRITES_PER_RUN} big writes held or waiting`);
    const left = new AbortController();
    live.add(left);
    const under = signal ? AbortSignal.any([signal, left.signal]) : left.signal;
    try {
      const release = await gate.take(under);
      try {
        const bytes = new Uint8Array(size);
        for (let at = 0; at < size; ) {
          const want = Math.min(piece, size - at);
          const got = await until(Promise.resolve().then(() => pull(at, want)), AbortSignal.any([under, AbortSignal.timeout(pieceMs)]));
          if (!(got instanceof Uint8Array) || got.length !== want) {
            throw new WorkspaceError("REFUSED", `the piece at ${at} of a write is ${got instanceof Uint8Array ? `${got.length} bytes` : "not bytes"}, not the ${want} asked for: nothing was written`, { path });
          }
          bytes.set(got, at);
          at += want;
        }
        // The run's end while the last piece came: nothing is written for it.
        under.throwIfAborted();
        await ws.write(path, bytes);
      } finally {
        release();
      }
    } finally {
      live.delete(left);
    }
  };
  return {
    pieces: (ws) => ({ write: writeOn(ws), piece }),
    close() {
      if (closed) return;
      closed = true;
      for (const write of live) write.abort(new ChannelClosed("the run's channel ended"));
    },
  };
}
