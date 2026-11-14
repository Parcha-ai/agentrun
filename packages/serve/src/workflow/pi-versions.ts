// What the workflow code and the runner hold pi-durable to about a tool result, a failed Session and a wait, in one place
// (pi-durable 1.5).
//
// A tool result's blocks are its `output` (pi 1.1 read `content`). A storage error fails the Session, and its later
// calls reject with `SessionFailed` whose cause is that error. A wait (a submission's, Harness.waitForTask) is handed a
// signal that never aborts (durableWait).
import { type Context, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

export type TextBlock = { type: "text"; text: string };

/** A tool result pi-durable reads as `blocks`: the blocks under `output`, each its own copy. */
export function toolResult(blocks: readonly TextBlock[], fields: Omit<ToolExecutionResult, "content" | "output"> = {}): ToolExecutionResult {
  return { ...fields, output: blocks.map((block) => ({ ...block })) } as unknown as ToolExecutionResult;
}

/** The storage error behind a Session that failed at one (`SessionFailed`, matched by name), else the error. */
export function storageError(error: unknown): unknown {
  return error instanceof Error && error.name === "SessionFailed" && error.cause !== undefined ? error.cause : error;
}

/**
 * `wait(context)` settled, or `context`'s signal aborted, whichever is first: rejected with the abort's reason on the
 * abort, as pi-durable's own wait rejects. The wait itself runs on `context` with its signal swapped for one that never
 * aborts.
 *
 * pi-durable (1.5.0, and 1.5.2 unchanged) makes a submission's or a task's waiter while the Session's line reads its
 * record (harness/util.js Waiters.add, from harness/submissions.js wait and harness/scheduler.js waitForTask), and hands
 * it back only when the line delivers that read, after every commit before it is published. Until then the waiter is
 * held by pi-durable alone, and it rejects there in two ways:
 * - registered after its context's signal aborted, it is a promise rejected at once;
 * - when the Session closes (a storage error fails it), every waiter rejects (Waiters.rejectAll), and a waiter whose
 *   context has no signal has no handler; the failed Session's line then never hands it back.
 * Either way Node reports a rejection nothing handles: the runner process exits on it (runner/main.ts lastResort), its
 * claims left to lapse, and a runner beside the server takes the server down with it. A runner's close or a lost claim
 * while a resumed loop opens its session is the first; a commit failing under a runner that lost its claim the second.
 *
 * So the wait gets a signal of its own that never aborts: Waiters.add never sees an abort, and it handles every waiter it
 * makes (its listener detach). The caller's signal is watched here: an abort answers with its reason, a wait asked once
 * it has aborted is never started, and the wait's later outcome is handled and dropped (its waiter settles when its
 * submission or task does, or when its Session closes).
 */
export function durableWait<T>(wait: (context: Context) => Promise<T>, context: Context): Promise<T> {
  const signal = context.abortSignal;
  const unabortable = withAbortSignal(new AbortController().signal, withoutAbortSignal(context));
  if (signal === undefined) return wait(unabortable);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const settled = () => signal.removeEventListener("abort", onAbort);
    let waiting: Promise<T>;
    try {
      waiting = wait(unabortable);
    } catch (error) {
      settled();
      reject(error);
      return;
    }
    waiting.then(
      (value) => {
        settled();
        resolve(value);
      },
      (error: unknown) => {
        settled();
        reject(error);
      },
    );
  });
}
