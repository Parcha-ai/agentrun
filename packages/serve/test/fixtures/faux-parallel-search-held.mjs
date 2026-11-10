// Under --faux only: Parallel's search, held. Each request is counted on globalThis.fauxParallelSearches (the runner runs
// in the test's own process) and never answered: it settles only when its caller aborts it (a run's stop cutting the
// call), so a test can stop a run while its paid search is in flight.
export default function fauxParallelHeld(url, init = {}) {
  globalThis.fauxParallelSearches = (globalThis.fauxParallelSearches ?? 0) + 1;
  void url;
  const signal = init.signal;
  if (!signal) throw new Error("the held search needs its request's abort signal");
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}
