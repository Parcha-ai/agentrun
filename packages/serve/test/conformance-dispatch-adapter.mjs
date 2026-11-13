// pi THROUGH THE RUNNER'S DISPATCH, on the adapter path: the dispatch (runner/dispatch.ts) reads the run's launch, sees
// harness "pi", and runs the run on the kernel's adapter loop with B2c's pi adapter (conformance-pi-adapter.mjs). This
// proves every conformance case for pi as the runner actually runs it now — the launch read, the harness choice and the
// buffering of commands and stop in front of it — on the adapter loop, not the old createPiLoop. The launch read is
// stubbed to a pi launch body (the suite's run has no launch row); the store's own launch read is pinned elsewhere.
import { piAdapterSpec, piAdapterSubject } from "./conformance-pi-adapter.mjs";

const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

/** A pi launch body, as the server writes one for a run on the default harness. */
const PI_LAUNCH = { body: { place: { mode: "runner" }, harness: "pi" } };

/** The subject the suite runs: the runner's dispatch loop, resolving harness "pi" to the adapter loop for `setup`. */
export const dispatchAdapterSubject = {
  name: "pi through the dispatch (adapter loop)",
  process: { module: import.meta.url, export: "dispatchAdapterSubject" },
  ...(piAdapterSubject.unsupported ? { unsupported: piAdapterSubject.unsupported } : {}),
  createLoop: (setup) =>
    createDispatchLoop({
      launchOf: async () => PI_LAUNCH,
      resolve: (harness) => (harness === "pi" ? createAdapterLoop(piAdapterSpec(setup), { restartLimit: MAX_RESTARTS }) : undefined),
    }),
};
