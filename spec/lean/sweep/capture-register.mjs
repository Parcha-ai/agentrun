// Preloaded with --import while the repository's tests run: every import of the DSL's
// public entry point is served by capture-dsl.mjs, which records the workflows passed to
// validateWorkflow, runWorkflow, runWorkflowSlice and dryRunWorkflow. The hooks run in the
// test's own thread: off-thread ones (module.register) made a DSL test file about a third slower.
import { registerHooks } from "node:module";
import { resolve } from "./capture-hooks.mjs";
registerHooks({ resolve });
