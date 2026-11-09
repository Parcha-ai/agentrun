// The harness conformance suite over Codex through the runner: Codex's adapter on the kernel's generic adapter loop, on the
// Codex stand-in with its model the provider's. Every case pi passes, park on ask and resume on the command row, and the
// fault cases among them, must pass here: the gate asked before a call's intent (gate, cap, flush, hands), on the kernel's
// shared tool bridge.
import { after, test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { closeOpenSessions, codexSubject } from "./conformance-codex.mjs";
import { PG_URL } from "./store-target.mjs";

// On the test Postgres when AGENTRUN_TEST_PG_URL names one, handed to the suite by hand; else SQLite.
registerHarnessConformance(codexSubject, { test, storeUrl: PG_URL });
// The crash cases' frozen loops never close their sessions: their app-servers and model proxies close here.
after(closeOpenSessions);
