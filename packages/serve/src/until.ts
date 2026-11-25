/** `work`'s answer, or `signal`'s reason as soon as it aborts: a wait shared by callers (a connection, a piece being
 *  pulled) is never held by one that stopped. */
export function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
