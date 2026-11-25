// Under --faux only: Parallel's API as faux-parallel.mjs answers it, each request's path and body kept on
// globalThis.fauxParallelBodies (the run's Web runs in the test's own process), so a test reads what was sent.
import fakeParallel from "./faux-parallel.mjs";

export default async function fauxParallelBodies(url, init = {}) {
  (globalThis.fauxParallelBodies ??= []).push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init.body ?? "{}")) });
  return fakeParallel(url, init);
}
