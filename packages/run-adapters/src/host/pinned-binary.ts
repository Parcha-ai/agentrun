// A harness's binary, checked against its pins (codex's, claude-agent's, opencode's): its sha256 read a chunk at a time,
// and each check that passed kept for the process by what the binary is. A binary is hundreds of MiB; read whole, each
// check held all of it in memory, and a host that checks it again for each model it resolves held it again each time.
// Here a process holds one chunk at most, and checks a binary once per identity: its path, the file it names (device and
// inode), its size and its modification and change times, with the pins it met. Replaced or touched, it is checked
// again; a check that failed is never kept, so the next one runs again.
//
// A check is written once, as the steps it reads of the binary (BinaryCheck: its sha256, what it prints when run), and
// run either synchronously (checkedOnce: an adapter's own guard as it is made) or without holding the event loop
// (checkedOnceAsync: a host's, while it goes on answering), each passed check kept for both.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

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

/** sha256OfFile without holding the event loop: each chunk is read off it, and the loop goes on between chunks. Rejects
 *  as `open` and `read` do. */
export async function sha256OfFileAsync(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await open(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, CHUNK, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

/** What a binary's check reads of it: its sha256, or what it prints on stdout when run (`args`, `env` alone, in `cwd`,
 *  killed past `timeoutMs`). */
export type BinaryProbe =
  | { readonly kind: "sha256"; readonly path: string }
  | { readonly kind: "run"; readonly path: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly cwd?: string; readonly timeoutMs: number };

/** A binary's check, written once as the steps it reads: each step yields a probe and is given back its answer, or has
 *  the probe's error thrown in (a file that cannot be read, a binary that cannot be run or does not end in time). It
 *  answers its result. */
export type BinaryCheck<T> = () => Generator<BinaryProbe, T, string>;

type RunProbe = Extract<BinaryProbe, { kind: "run" }>;
const runOptions = (probe: RunProbe) => ({ env: probe.env, ...(probe.cwd ? { cwd: probe.cwd } : {}), encoding: "utf8" as const, timeout: probe.timeoutMs });

/** `check` run with each probe answered synchronously. */
function checkSync<T>(check: BinaryCheck<T>): T {
  const steps = check();
  for (let step = steps.next(); ; ) {
    if (step.done) return step.value;
    let answer: string;
    try {
      const probe = step.value;
      answer = probe.kind === "sha256" ? sha256OfFile(probe.path) : execFileSync(probe.path, [...probe.args], runOptions(probe));
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(answer);
  }
}

/** One run of a binary, its stdout: rejects as execFileSync throws (a spawn that failed, a nonzero exit, its timeout). */
const runChild = (probe: RunProbe): Promise<string> =>
  new Promise((resolve, reject) => execFile(probe.path, [...probe.args], runOptions(probe), (error, stdout) => (error ? reject(error) : resolve(stdout))));

/** `check` run with each probe answered without holding the event loop. */
async function checkOffLoop<T>(check: BinaryCheck<T>): Promise<T> {
  const steps = check();
  for (let step = steps.next(); ; ) {
    if (step.done) return step.value;
    let answer: string;
    try {
      const probe = step.value;
      answer = probe.kind === "sha256" ? await sha256OfFileAsync(probe.path) : await runChild(probe);
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(answer);
  }
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
/** Each check running without holding the loop, by the binary's identity: a second asks for the same answer. */
const checking = new Map<string, Promise<unknown>>();

/** `check`'s result for the binary at `path` against `pins`, run once per identity in this process: a result `ok` calls
 *  passed is kept, and answered again at once while the binary stays the same file, unchanged; any other is never kept.
 *  A binary that changed while it was checked is not kept, and is checked again next time. Its reads hold the event
 *  loop: a host checks with checkedOnceAsync first, and this answers from what that kept. */
export function checkedOnce<T>(path: string, pins: string, check: BinaryCheck<T>, ok: (result: T) => boolean): T {
  const identity = identityOf(path, pins);
  if (identity !== undefined && passed.has(identity)) return passed.get(identity) as T;
  const result = checkSync(check);
  if (identity !== undefined && ok(result) && identityOf(path, pins) === identity) passed.set(identity, result);
  return result;
}

/** checkedOnce without holding the event loop: the sha256 read a chunk at a time off it, the binary run as a child the
 *  loop does not wait on. A check of the same binary already running is the one answered; one that passed is kept for
 *  checkedOnce too. */
export function checkedOnceAsync<T>(path: string, pins: string, check: BinaryCheck<T>, ok: (result: T) => boolean): Promise<T> {
  const identity = identityOf(path, pins);
  if (identity !== undefined && passed.has(identity)) return Promise.resolve(passed.get(identity) as T);
  const running = identity !== undefined ? checking.get(identity) : undefined;
  if (running) return running as Promise<T>;
  const result = checkOffLoop(check).then((value) => {
    if (identity !== undefined && ok(value) && identityOf(path, pins) === identity) passed.set(identity, value);
    return value;
  });
  if (identity !== undefined) {
    checking.set(identity, result);
    const done = () => void checking.delete(identity);
    result.then(done, done);
  }
  return result;
}
