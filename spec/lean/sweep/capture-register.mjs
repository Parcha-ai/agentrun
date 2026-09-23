// Preloaded with --import while the repository's tests run: every import of the DSL's
// public entry point is served by capture-dsl.mjs, which records the workflows passed to
// validateWorkflow, runWorkflow, runWorkflowSlice and dryRunWorkflow.
import { register } from "node:module";
register("./capture-hooks.mjs", import.meta.url);
