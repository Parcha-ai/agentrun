// The steps of attaching a sealed Stagehand that can fail on their own: naming where a failed step went, stopping a
// cancelled attach, and creating the instance once more when the extension is still running an earlier attach's init.
import { BrowserFailureError } from "../core/custody.js";
import { browserFailure } from "../core/failures.js";

/** What Stagehand's extension answers an init while another is still running in it. */
export const INIT_IN_PROGRESS = "Stagehand initialization is already in progress";
/** Stagehand's own init deadline: an init the extension is still running has ended by then. */
export const IN_FLIGHT_INIT_MS = 60_000;

/** The extension refused an init because another is still running in it (its JSON-RPC error, as Stagehand's cause). */
export const initInProgress = (error: unknown): boolean => {
  const cause = (error as { cause?: unknown } | null)?.cause as { code?: unknown; message?: unknown } | undefined;
  return !!cause && typeof cause === "object" && typeof cause.code === "number" && cause.message === INIT_IN_PROGRESS;
};

/** A failed attach step names where it went: Stagehand reports a failed open as "[object Object]", and the socket's error
 *  has no address. */
export const attachStep = (host: string) => <T>(step: Promise<T>): Promise<T> => step.catch((error) => {
  throw new Error(`attaching to the browser at ${host} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
});

/** A cancelled call never starts an init of its own, however the wait ended. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error("the attach was cancelled"), { name: "AbortError" });
}

/** The sealed Stagehand, created once more when the extension is still running an earlier attach's init: an attach that
 *  gave up (a dropped connection, a deadline) left its init running there, and `waitForThatInit` (a close, which queues
 *  behind that init, so its reply means the init has ended) waits it out first. A second refusal is the browser still
 *  busy, retryable. */
export async function createSealed<S>(create: () => Promise<S>, waitForThatInit: () => Promise<unknown>, host: string, signal?: AbortSignal): Promise<S> {
  try {
    return await create();
  } catch (error) {
    if (!initInProgress(error)) throw error;
  }
  throwIfCancelled(signal);
  await waitForThatInit();
  throwIfCancelled(signal);
  try {
    return await create();
  } catch (again) {
    if (!initInProgress(again)) throw again;
    throw new BrowserFailureError(browserFailure("browser_unavailable", `The browser at ${host} is still finishing an earlier connection after ${IN_FLIGHT_INIT_MS / 1_000} s. Call again in a moment, or call browser_relaunch for a fresh session.`, { retryable: true }));
  }
}
