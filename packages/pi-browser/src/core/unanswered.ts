// A host call the browser does not answer within its deadline counts as a dropped connection (browser_unavailable): a
// read reconnects and runs once more on a fresh driver. Nothing cancels the call itself, so whatever the browser answers
// later settles a promise nobody reads.

/** The name a host call that passed its deadline unanswered fails with. */
export const UNANSWERED_CALL = "UnansweredHostCallError";

export async function withinDeadline<T>(call: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} had no answer from the browser within ${ms} ms`), { name: UNANSWERED_CALL })), ms);
  });
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
