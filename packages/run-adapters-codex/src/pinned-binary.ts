// The codex adapter's copy of the kernel's pinned-binary (@parcha/agentrun-kernel/host, whose twin claude-agent's adapter
// uses): a harness's binary checked against its pins, its sha256 read a chunk at a time, and each check that passed kept
// for the process by what the binary is (its path, device, inode, size, and modification and change times, with the pins).
// Replaced or touched, a binary is checked again; a check that failed is never kept. A copy, not an import: verify.ts may
// import nothing outside this package, since serve's image check (docker/image-check.sh) runs it in a tree that holds
// this package and Codex alone. Its code is the kernel's, line for line (test/pinned-binary.test.mjs).
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
