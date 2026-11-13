import { refusedError } from "../core/custody.js";
import { profileHoldings } from "./shared.js";

const writers = profileHoldings.writers;
const WAIT_MS = 20_000;
const PROBE_MS = 2_000;

/** True when `work` finishes within `ms`; false at the deadline; rejects when `signal` aborts, leaving `work` to finish alone. */
async function waitFor(work: Promise<void>, signal: AbortSignal | undefined, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); }),
      new Promise<boolean>((_, reject) => { if (signal) { abort = () => reject(signal.reason); if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); } }),
    ]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}

/** A profile keeps the last writer's state and nothing locks it, so within this process one session at a time may save to a
 *  profile. A holder that is no longer running is replaced; the same owner's successor (a relaunch asks for its replacement
 *  while the old session is still being released) waits for the release; anyone else is refused. */
export async function claimWriter(key: string, name: string, tag: string, owner: string, signal?: AbortSignal): Promise<void> {
  for (const end = Date.now() + WAIT_MS; ; ) {
    const held = writers.get(key);
    if (!held || held.tag === tag) { writers.set(key, { tag, owner }); return; }
    if (held.running && !(await held.running(AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(PROBE_MS)])).catch(() => true))) {
      if (held.settle && !(await waitFor(held.settle(), signal, end - Date.now()))) throw refusedError(`browser profile "${name}": the session that was saving to it is still ending. Try again in a moment. No session was started.`);
      if (writers.get(key) === held) writers.delete(key);
      continue;
    }
    if (held.owner !== owner) throw refusedError(`browser profile "${name}": one session at a time may save to a profile, and another session is saving to it now. Wait for it to end, or start without saving. No session was started.`);
    if (Date.now() > end) throw refusedError(`browser profile "${name}": the session that was saving to it is still ending. Try again in a moment. No session was started.`);
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** `running` says whether the session still runs (a probe that cannot answer in time counts as running); `settle` is what a new
 *  saver must wait out after finding it stopped, when the provider is still writing its state back. */
export function noteWriter(tag: string, running: (signal: AbortSignal) => Promise<boolean>, settle?: () => Promise<void>): void {
  for (const held of writers.values()) if (held.tag === tag) Object.assign(held, { running, ...(settle ? { settle } : {}) });
}

export function freeWriter(tag: string): void {
  for (const [key, held] of writers) if (held.tag === tag) writers.delete(key);
}

export function isWriter(tag: string): boolean {
  for (const held of writers.values()) if (held.tag === tag) return true;
  return false;
}
