// The harness conformance suite over the ACP adapter through the runner, on the fake ACP agent with no session/load and
// our tools over stdio: a crash mid-turn restarts the turn with the recovery note on a new agent session. Every case the
// adapter's facts do not rule out must pass, the process cases among them.
import { after, test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { acpNoLoadSubject, closeOpenSessions } from "./conformance-acp.mjs";
import { PG_URL } from "./store-target.mjs";

registerHarnessConformance(acpNoLoadSubject, { test, storeUrl: PG_URL });
after(closeOpenSessions);
