// The harness conformance suite over pi AS THE RUNNER RUNS IT: through the dispatch loop (runner/dispatch.ts), which reads
// the run's launch, picks harness "pi", and runs it on the pi loop. Every case (crash before/after intent, in-process and
// as a killed process, replay-safe rerun, steer, stop, park on the command row, the approval and fault cases) must pass
// through the dispatch, not only on the pi loop on its own.
import { test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { dispatchPiSubject } from "./conformance-dispatch-pi.mjs";

registerHarnessConformance(dispatchPiSubject, { test });
