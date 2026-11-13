// The harness conformance suite over pi THROUGH the adapter contract (B2c): the one pi path. Cases 5 and 6 (a faulted
// task never runs its effect twice; a task that faults every time is restarted at most MAX_RESTARTS times, then the run
// fails) must pass here, with the gate and the rule before a side effect on the kernel's shared host-tool path.
import { after, test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { closeOpenSessions, piAdapterSubject } from "./conformance-pi-adapter.mjs";
import { PG_URL } from "./store-target.mjs";

// On the test Postgres when AGENTRUN_TEST_PG_URL names one, handed to the suite by hand; else SQLite.
registerHarnessConformance(piAdapterSubject, { test, storeUrl: PG_URL });
// The crash cases' frozen loops never close their sessions: their model proxies close here, so the file can exit.
after(closeOpenSessions);
