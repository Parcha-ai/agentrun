// A harness's binary, checked against its pins (codex's, claude-agent's): its sha256 read a chunk at a time, and each
// check that passed kept for the process by what the binary is. A binary is hundreds of MiB; read whole, each check held
// all of it in memory, and a host that checks it again for each model it resolves held it again each time. Here a process
// holds one chunk at most, and checks a binary once per identity: its path, the file it names (device and inode), its
// size and its modification and change times, with the pins it met. Replaced or touched, it is checked again; a check
// that failed is never kept, so the next one runs again.
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** The bytes read at a time. */
const CHUNK = 1 << 20;

/** The sha256 of the file at `path`, as hex, read a chunk at a time. Throws as `openSync` and `readSync` do. */
export function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (let read: number; (read = readSync(fd, chunk, 0, CHUNK, null)) > 0; ) hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** What the file at `path` is, for `pins` (any text that names them): undefined when it cannot be read. */
function identityOf(path: string, pins: string): string | undefined {
  try {
    const file = statSync(path, { bigint: true });
    return [path, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs, pins].join("\0");
  } catch {
    return undefined;
  }
}

/** What each check that passed answered, by the binary's identity. */
const passed = new Map<string, unknown>();

/** `check`'s result for the binary at `path` against `pins`, run once per identity in this process: a result `ok` calls
 *  passed is kept, and answered again at once while the binary stays the same file, unchanged; any other is never kept.
 *  A binary that changed while it was checked is not kept, and is checked again next time. */
export function checkedOnce<T>(path: string, pins: string, check: () => T, ok: (result: T) => boolean): T {
  const identity = identityOf(path, pins);
  if (identity !== undefined && passed.has(identity)) return passed.get(identity) as T;
  const result = check();
  if (identity !== undefined && ok(result) && identityOf(path, pins) === identity) passed.set(identity, result);
  return result;
}
