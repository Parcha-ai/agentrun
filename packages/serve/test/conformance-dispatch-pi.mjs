// The harness conformance suite's pi subject, run THROUGH the runner's dispatch loop (runner/dispatch.ts): the dispatch
// reads the run's launch, sees harness "pi", and runs the run on createPiLoop's loop (conformance-pi.mjs's piSpec). This
// proves every conformance case for pi as the runner actually runs it — the launch read, the harness choice and the
// buffering of commands and stop in front of it — not just the pi loop on its own. The launch read is stubbed to a pi
// launch body (the suite's run is created with no launch row); the store's own launch read is pinned elsewhere.
import { piSpec, piSubject } from "./conformance-pi.mjs";

const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createPiLoop } = await import("../dist/runner/loop.js");

/** A pi launch body, as the server writes one for a run on the default harness. */
const PI_LAUNCH = { body: { place: { mode: "runner" }, harness: "pi" } };

/** The subject the suite runs: the runner's dispatch loop, resolving harness "pi" to the pi loop for `setup`. */
export const dispatchPiSubject = {
  name: "pi (through the runner's dispatch)",
  process: { module: import.meta.url, export: "dispatchPiSubject" },
  ...(piSubject.unsupported ? { unsupported: piSubject.unsupported } : {}),
  createLoop: (setup) =>
    createDispatchLoop({
      launchOf: async () => PI_LAUNCH,
      resolve: (harness) => (harness === "pi" ? createPiLoop(piSpec(setup)) : undefined),
    }),
};
