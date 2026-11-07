// Preloaded into a run's process (NODE_OPTIONS=--import) by workflow-resume-paid.test.mjs: the app's open hook (onOpen)
// waits until the run's workflow ended the call node AGENTRUN_TEST_OPEN_AFTER_EFFECT names (its node log's effect.end),
// or 20 s. A reopened run's workflow resumes when its harness does, before onOpen, so whichever of the two reaches its
// next effect first is a race; this makes the workflow win it, as it can in production. It writes
// AGENTRUN_TEST_OPEN_AFTER_SIGNAL once onOpen has waited, so the test knows the hook ran.
import { register } from "node:module";

if (process.env.AGENTRUN_TEST_OPEN_AFTER_EFFECT) register(new URL("./open-after-effect-hooks.mjs", import.meta.url));
