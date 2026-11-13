// What the workflow code and the runner hold pi-durable to about a tool result, a failed Session and a wait, in one place
// (pi-durable 1.5).
//
// A tool result's blocks are its `output` (pi 1.1 read `content`). A storage error fails the Session, and its later
// calls reject with `SessionFailed` whose cause is that error. A wait (a submission's, Harness.waitForTask) is never
// handed a signal that can abort (durableWait).
import { type Context, withoutAbortSignal } from "@earendil-works/chord/context";
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
 * abort, as pi-durable's own wait rejects. The wait itself runs on `context` without its signal (withoutAbortSignal).
 *
 * pi-durable 1.5.0 answers a wait registered after its context's signal aborted with a promise it rejects at once
 * (harness/util.js Waiters.add), and hands that promise back only when the Session's line delivers the read that
 * registered it (harness/submissions.js wait, harness/scheduler.js waitForTask), after every commit before it is
 * published. While one publishes (a store's round trip), the rejection has no handler and Node reports it unhandled: the
 * runner process exits on it (runner/main.ts lastResort), its claims left to lapse, and a runner beside the server takes
 * the server down with it. A runner's close or a lost claim while a resumed loop opens its session is that case.
 *
 * So pi-durable never makes a rejection nothing handles: a wait asked once the signal has aborted is never started, and
 * a wait's own later outcome, once the abort has answered, is handled and dropped (the waiter it registered settles when
 * its submission or task does, or when its Session closes).
 */
export function durableWait<T>(wait: (context: Context) => Promise<T>, context: Context): Promise<T> {
  const signal = context.abortSignal;
  if (signal === undefined) return wait(context);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const settled = () => signal.removeEventListener("abort", onAbort);
    let waiting: Promise<T>;
    try {
      waiting = wait(withoutAbortSignal(context));
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
