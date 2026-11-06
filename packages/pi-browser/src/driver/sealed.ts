// The steps of attaching a sealed Stagehand that can fail on their own: saying what failed (never where), and stopping a
// cancelled attach without leaving anything attached to the browser.
import { AttachFailureError } from "../core/failures.js";

/** A failed attach step says what failed, never where: the host it went to (a local browser's loopback port, a vendor's
 *  connect host) goes to the operator's log and stays in the cause (failures.ts AttachFailureError). Stagehand reports a
 *  failed open as "[object Object]", and the socket's error has no address. */
export const attachStep = (host: string) => <T>(step: Promise<T>): Promise<T> => step.catch((error) => {
  throw new AttachFailureError(error, host);
});

const cancelled = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : Object.assign(new Error("the attach was cancelled"), { name: "AbortError" });

/** A cancelled call never starts a step of its own, however the wait ended. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled(signal);
}

/** `step`, or the cancel when `signal` ends first: the call stops at once, and a step that still succeeds later is handed to
 *  `release` (Stagehand's own steps take no signal, and one left attached would refuse the next attach). */
export function untilCancelled<T>(step: Promise<T>, signal: AbortSignal | undefined, release: (late: T) => unknown): Promise<T> {
  if (!signal) return step;
  if (signal.aborted) {
    step.then((late) => release(late), () => undefined).catch(() => undefined);
    return Promise.reject(cancelled(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let over = false;
    const onAbort = () => { over = true; reject(cancelled(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
    step.then(
      (value) => { signal.removeEventListener("abort", onAbort); if (over) Promise.resolve().then(() => release(value)).catch(() => undefined); else resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); if (!over) reject(error); },
    );
  });
}
