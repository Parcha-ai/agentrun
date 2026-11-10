// The conformance suite's paused-process case lets its runner process go on only once that process is stopped, never on its
// word that it is about to stop: here the process pauses between writing "stopping" and stopping itself (child.ts's test
// hook, AGENTRUN_TEST_STOP_GAP_MS), as a loaded box can make it, and a SIGCONT sent on the word alone would arrive before the
// stop and be lost, leaving the process stopped for good. Only that one case runs here, over the reference loop.
import { test } from "node:test";
import { registerHarnessConformance } from "../dist/runner/conformance/harness.js";
import { referenceSubject } from "./conformance-reference.mjs";

process.env.AGENTRUN_TEST_STOP_GAP_MS = "2000";
const only = (name, options, fn) => (/paused past its lease/.test(name) ? test(name, options, fn) : undefined);
registerHarnessConformance(referenceSubject, { test: only });
