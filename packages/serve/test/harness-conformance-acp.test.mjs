// The harness conformance suite over the ACP adapter through the runner, on the fake ACP agent playing Goose: it resumes
// with session/load, takes our tools over HTTP, and asks permission before each. Every case the adapter's facts do not
// rule out must pass, the process cases among them.
import { after, test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { acpSubject, closeOpenSessions } from "./conformance-acp.mjs";
import { PG_URL } from "./store-target.mjs";

registerHarnessConformance(acpSubject, { test, storeUrl: PG_URL });
// The crash cases' frozen loops never close their sessions: their agents close here.
after(closeOpenSessions);
