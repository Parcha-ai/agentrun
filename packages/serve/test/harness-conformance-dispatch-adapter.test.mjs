// The harness conformance suite over pi AS THE RUNNER RUNS IT: through the dispatch loop (runner/dispatch.ts), which reads
// the run's launch, picks harness "pi", and runs it on the kernel's adapter loop. Every case must pass through the
// dispatch, not only on the adapter loop on its own.
import { after, test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";
import { dispatchAdapterSubject } from "./conformance-dispatch-adapter.mjs";
import { PG_URL } from "./store-target.mjs";

// On the test Postgres when AGENTRUN_TEST_PG_URL names one, handed to the suite by hand; else SQLite.
registerHarnessConformance(dispatchAdapterSubject, { test, storeUrl: PG_URL });
// The crash cases' frozen loops never close their sessions: their model proxies close here, so the file can exit.
after(closeOpenSessions);
