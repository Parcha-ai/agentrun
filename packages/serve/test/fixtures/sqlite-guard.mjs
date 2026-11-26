// A test's write to the store a live serve() still owns goes through raw() (store-target.mjs), never a DatabaseSync of its
// own. node:sqlite waits for a write lock synchronously, and the in-process server or runner holding that lock commits from
// this same thread: the wait can never end before its busy timeout ("database is locked" at any timeout, however long).
// raw() runs its statements on a worker, so nothing blocks here.
//
// How it holds: sqlite-guard-register.mjs (the serve package's test script runs node with --import of it) installs a resolve
// hook that gives every module under packages/serve/test this module in place of node:sqlite. Its DatabaseSync refuses to
// open a SQLite file under the data directory of a server running now (support.mjs's serve() holds it, holdStore) unless it
// is readOnly: a WAL reader takes no write lock. A store with no running server (a closed one, a fixture's own) opens as
// before. The registry is this module's, on the main thread; raw()'s worker has a node:sqlite of its own, and that is how
// raw() writes.
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as sqlite from "node:sqlite";

export * from "node:sqlite";

export const GUARD_MESSAGE = "write a live server's store through raw() (store-target.mjs): a DatabaseSync of its own waits for the lock on the thread the server commits from";

/** Data directories of the servers running now, with how many each has (a restart on the same data holds it twice). */
const held = new Map();

/** `dir` held as a running server's data directory: the release to call once that server has closed. */
export function holdStore(dir) {
  const key = resolve(dir);
  held.set(key, (held.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (held.get(key) ?? 1) - 1;
    if (left > 0) held.set(key, left);
    else held.delete(key);
  };
}

const pathOf = (file) => {
  if (typeof file === "string") return file;
  if (file instanceof URL) return fileURLToPath(file);
  if (Buffer.isBuffer(file)) return file.toString();
  return undefined;
};

/** A live server's store file: a SQLite file under a held data directory. */
function liveStore(file) {
  const path = pathOf(file);
  if (path === undefined || path === ":memory:" || path === "" || !path.endsWith(".sqlite")) return false;
  const full = resolve(path);
  for (const dir of held.keys()) if (full.startsWith(dir + sep)) return true;
  return false;
}

/**
 * The real class behind a construct trap, not a subclass: its prototype is the real one, so a test that patches
 * DatabaseSync.prototype (to refuse a write, say) still reaches the instances dist code opens. `guarded` marks it:
 * sqlite-guard.test.mjs reads it to say the hook is not installed.
 */
export const DatabaseSync = new Proxy(sqlite.DatabaseSync, {
  get: (target, key, receiver) => (key === "guarded" ? true : Reflect.get(target, key, receiver)),
  construct(target, args, newTarget) {
    const [file, options] = args;
    if (options?.readOnly !== true && liveStore(file)) throw new Error(`${GUARD_MESSAGE}: ${pathOf(file)}`);
    return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
  },
});
const proxy = DatabaseSync;
