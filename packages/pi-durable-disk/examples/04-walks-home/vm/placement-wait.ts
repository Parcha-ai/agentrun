// Waiting for a GPU box's create to place. Modal queues a create it has no capacity for and places it when capacity comes (code9: three requests placed 449, 546 and 569 s after they were made), and a
// cancelled-and-recreated request is a new request in the same queue. So a slow create is never given up on: after `slowAfterMs` it is only reported once, and the same request keeps waiting until it places
// (the box then joins the pool like any other) or the pool closes (the caller then terminates the box if it ever lands).

export type PlacementOutcome<T> = { readonly placed: true; readonly value: T; readonly waitedMs: number } | { readonly abandoned: true };

export async function awaitPlacement<T>(creating: Promise<T>, options: { slowAfterMs: number; signal: AbortSignal; onSlow: (waitedMs: number) => void }): Promise<PlacementOutcome<T>> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const slow = new Promise<never>(() => {
    timer = setTimeout(() => options.onSlow(Date.now() - t0), options.slowAfterMs); // reported once; the wait goes on
  });
  const aborted = new Promise<{ abandoned: true }>((resolve) => {
    if (options.signal.aborted) return resolve({ abandoned: true });
    onAbort = () => resolve({ abandoned: true });
    options.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([creating.then((value) => ({ placed: true as const, value, waitedMs: Date.now() - t0 })), aborted, slow]);
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal.removeEventListener("abort", onAbort);
  }
}
