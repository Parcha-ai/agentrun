// A descriptor this process hands out by number, as `/proc/self/fd/<n>`, is closed by its owner's close() only, never by a
// collection. A FileHandle the collector finds unreachable is closed, and its number is then free for the next open: a
// path built on it names whatever that open is. The confinement (confine.ts) reaches a pinned directory through that path,
// so each handle it names is held here until it is closed.
import type { EventEmitter } from "node:events";
import type { FileHandle } from "node:fs/promises";

const HELD = new Set<FileHandle>();

/** Keeps `handle` reachable until it is closed. A handle held and never closed stays open until the process exits. */
export function hold(handle: FileHandle): FileHandle {
  if (!HELD.has(handle)) {
    HELD.add(handle);
    // A FileHandle is an EventEmitter that emits `close` once closed (Node's typings leave that out).
    (handle as unknown as EventEmitter).once("close", () => HELD.delete(handle));
  }
  return handle;
}

/** `/proc/self/fd/<n>` for `handle`, held until it is closed (`hold`). */
export function fdPath(handle: FileHandle): string {
  return `/proc/self/fd/${hold(handle).fd}`;
}
